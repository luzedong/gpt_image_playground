import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'

const DATA_DIR = process.env.ASYNC_TASK_DATA_DIR || '/var/lib/gpt-image-playground/tasks'
const MAX_BODY_BYTES = 600 * 1024 * 1024
const MAX_INPUT_BYTES = 512 * 1024 * 1024
const MAX_1K_PIXELS = 1_572_864
const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000
const CONCURRENCY = Math.max(1, Number(process.env.ASYNC_TASK_CONCURRENCY) || 2)
const activeTasks = new Set()
const pendingTasks = []
const agentTaskCreationLocks = new Map()

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function taskPath(id) {
  return join(DATA_DIR, `${id}.json`)
}

async function saveTask(task) {
  const path = taskPath(task.id)
  const tempPath = `${path}.${process.pid}.tmp`
  await writeFile(tempPath, JSON.stringify(task), 'utf8')
  await rename(tempPath, path)
}

async function loadTask(id) {
  try {
    return JSON.parse(await readFile(taskPath(id), 'utf8'))
  } catch {
    return null
  }
}

function getAgentProgress(task) {
  return task.progress || {
    revision: 0,
    imageRevision: 0,
    text: '',
    outputItems: [],
    pendingImages: [],
    images: [],
  }
}

function getPublicAgentOutputItems(outputItems) {
  return outputItems.map((item) => {
    if (item?.type !== 'image_generation_call' || !Object.prototype.hasOwnProperty.call(item, 'result')) return item
    const { result: _result, ...withoutImageResult } = item
    return withoutImageResult
  })
}

function publicAgentProgress(task, includeImages = false) {
  const progress = getAgentProgress(task)
  return {
    revision: progress.revision,
    imageRevision: progress.imageRevision,
    text: progress.text,
    outputItems: getPublicAgentOutputItems(progress.outputItems),
    pendingImages: progress.pendingImages,
    ...(includeImages ? { images: progress.images } : {}),
  }
}

function publicTask(task, includeResult = false) {
  return {
    id: task.id,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt ?? null,
    error: task.error ?? null,
    ...(task.kind === 'agent' ? { progress: publicAgentProgress(task) } : {}),
    ...(includeResult && task.result ? { result: task.result } : {}),
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length'] || 0)
    if (contentLength > MAX_BODY_BYTES) {
      reject(new Error('请求体过大'))
      req.resume()
      return
    }

    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(dataUrl)
  if (!match) throw new Error('输入图片格式无效')
  const mime = match[1] || 'image/png'
  const bytes = match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'utf8')
  return new Blob([bytes], { type: mime })
}

function dataUrlByteLength(dataUrl) {
  const match = /^data:[^,]+,([\s\S]*)$/i.exec(dataUrl)
  if (!match) return 0
  return Buffer.byteLength(match[1], 'utf8')
}

function normalizeTaskParams(params) {
  if (!params || typeof params !== 'object') throw new Error('生成参数无效')
  return {
    size: typeof params.size === 'string' ? params.size : 'auto',
    quality: params.quality === 'low' || params.quality === 'medium' || params.quality === 'high' ? params.quality : 'auto',
    output_format: params.output_format === 'jpeg' || params.output_format === 'webp' ? params.output_format : 'png',
    output_compression: typeof params.output_compression === 'number' && Number.isFinite(params.output_compression)
      ? Math.min(100, Math.max(0, Math.trunc(params.output_compression)))
      : null,
    moderation: params.moderation === 'low' ? 'low' : 'auto',
    n: Math.min(4, Math.max(1, Math.trunc(Number(params.n) || 1))),
    transparent_output: params.transparent_output === true,
  }
}

function normalizeTaskInput(input) {
  if (!input || typeof input !== 'object') throw new Error('任务格式无效')
  const body = input
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) throw new Error('提示词不能为空')
  const params = normalizeTaskParams(body.params)
  const inputImages = Array.isArray(body.inputImages) ? body.inputImages : []
  const maskDataUrl = typeof body.maskDataUrl === 'string' && body.maskDataUrl.startsWith('data:') ? body.maskDataUrl : undefined
  const imageDataUrls = [...inputImages, ...(maskDataUrl ? [maskDataUrl] : [])]
  if (imageDataUrls.some((item) => typeof item !== 'string' || !item.startsWith('data:'))) throw new Error('输入图片格式无效')
  const inputBytes = imageDataUrls.reduce((sum, item) => sum + dataUrlByteLength(item), 0)
  if (inputBytes > MAX_INPUT_BYTES) throw new Error('输入图片总大小超过 512 MiB')

  return {
    prompt,
    params,
    inputImages,
    maskDataUrl,
    nativeTransparentBackground: body.nativeTransparentBackground === true,
  }
}

function is4K(size) {
  const match = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/.exec(size)
  return Boolean(match && Number(match[1]) * Number(match[2]) > MAX_1K_PIXELS)
}

function isPixelApiUrl(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return hostname === 'ai-pixel.online' || hostname.endsWith('.ai-pixel.online')
  } catch {
    return /(^|\/\/)(?:api\.)?ai-pixel\.online(?:\/|$)/i.test(baseUrl)
  }
}

function getUpstreamConfig(size) {
  const isHighResolution = is4K(size)
  const baseUrl = (isHighResolution
    ? process.env.IMAGE_4K_API_URL || process.env.API_URL
    : process.env.IMAGE_1K_API_URL || process.env.API_URL || '').replace(/\/+$/, '')
  return {
    baseUrl,
    isPixel: isPixelApiUrl(baseUrl),
    apiKey: isHighResolution
      ? process.env.IMAGE_4K_API_KEY || process.env.API_KEY || ''
      : process.env.IMAGE_1K_API_KEY || process.env.API_KEY || '',
    model: isHighResolution ? process.env.IMAGE_4K_MODEL || 'gpt-image-2' : process.env.IMAGE_1K_MODEL || 'gpt-image-2',
  }
}

function getOutputMime(format) {
  return format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png'
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 600_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function readApiPayload(response) {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { error: { message: text || `HTTP ${response.status}` } }
  }
}

async function imageUrlToDataUrl(url) {
  const response = await fetchWithTimeout(url)
  if (!response.ok) throw new Error(`下载生成图片失败：HTTP ${response.status}`)
  const mime = response.headers.get('content-type')?.split(';')[0] || 'image/png'
  return `data:${mime};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`
}

async function normalizeImageResult(payload, outputFormat) {
  const data = Array.isArray(payload?.data) ? payload.data : []
  const rawImageUrls = []
  const images = []
  for (const item of data) {
    if (typeof item?.b64_json === 'string' && item.b64_json.trim()) {
      images.push(item.b64_json.startsWith('data:') ? item.b64_json : `data:${getOutputMime(outputFormat)};base64,${item.b64_json}`)
      continue
    }
    if (typeof item?.url === 'string' && /^https?:\/\//i.test(item.url)) {
      rawImageUrls.push(item.url)
      images.push(await imageUrlToDataUrl(item.url))
    }
  }
  if (!images.length) throw new Error(payload?.error?.message || '接口未返回图片数据')
  return { images, rawImageUrls: rawImageUrls.length ? rawImageUrls : undefined }
}

async function executeUpstream(task) {
  const config = getUpstreamConfig(task.params.size)
  if (!config.baseUrl || !config.apiKey) throw new Error('服务端图像 API 配置不完整')
  const headers = { Authorization: `Bearer ${config.apiKey}` }
  const isPixel = config.isPixel
  const inputImages = isPixel ? task.inputImages.slice(0, 1) : task.inputImages
  const isEdit = inputImages.length > 0
  let response
  if (isEdit) {
    const form = new FormData()
    form.append('model', config.model)
    form.append('prompt', task.prompt)
    if (task.params.size !== 'auto') form.append('size', task.params.size)
    if (!isPixel) {
      form.append('output_format', task.params.output_format)
      form.append('moderation', task.params.moderation)
      form.append('quality', task.params.quality)
      if (task.nativeTransparentBackground) form.append('background', 'transparent')
      if (task.params.output_format !== 'png' && task.params.output_compression != null) {
        form.append('output_compression', String(task.params.output_compression))
      }
    }
    if (task.params.n > 1) form.append('n', String(task.params.n))
    for (let index = 0; index < inputImages.length; index++) {
      const blob = dataUrlToBlob(inputImages[index])
      const extension = blob.type.split('/')[1] || 'png'
      form.append(isPixel ? 'image' : 'image[]', blob, `input-${index + 1}.${extension}`)
    }
    if (task.maskDataUrl) form.append('mask', dataUrlToBlob(task.maskDataUrl), 'mask.png')
    response = await fetchWithTimeout(`${config.baseUrl}/images/edits`, { method: 'POST', headers, body: form })
  } else {
    const body = {
      model: config.model,
      prompt: task.prompt,
      ...(task.params.size !== 'auto' ? { size: task.params.size } : {}),
      ...(!isPixel ? {
        output_format: task.params.output_format,
        moderation: task.params.moderation,
        quality: task.params.quality,
        ...(task.nativeTransparentBackground ? { background: 'transparent' } : {}),
        ...(task.params.output_format !== 'png' && task.params.output_compression != null
          ? { output_compression: task.params.output_compression }
          : {}),
      } : {}),
      ...(task.params.n > 1 ? { n: task.params.n } : {}),
    }
    response = await fetchWithTimeout(`${config.baseUrl}/images/generations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  const payload = await readApiPayload(response)
  if (!response.ok) throw new Error(payload?.error?.message || `上游 API 返回 HTTP ${response.status}`)
  return normalizeImageResult(payload, task.params.output_format)
}

function normalizeAgentTaskInput(input) {
  if (!input || typeof input !== 'object') throw new Error('Agent 任务格式无效')
  const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : ''
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(taskId)) throw new Error('Agent 任务 ID 无效')
  if (!Array.isArray(input.input)) throw new Error('Agent 输入格式无效')
  if (Buffer.byteLength(JSON.stringify(input.input), 'utf8') > MAX_INPUT_BYTES) throw new Error('Agent 输入图片总大小超过 512 MiB')
  const instructions = typeof input.instructions === 'string' ? input.instructions.trim() : ''
  if (!instructions) throw new Error('Agent 指令不能为空')

  return {
    taskId,
    input: input.input,
    instructions,
    params: normalizeTaskParams(input.params),
    roundIndex: Math.min(1000, Math.max(1, Math.trunc(Number(input.round_index) || 1))),
    maxToolRounds: Math.min(30, Math.max(1, Math.trunc(Number(input.max_tool_rounds) || 15))),
    enableWebSearch: input.enable_web_search === true,
  }
}

function createAgentTools(enableWebSearch) {
  const tools = [
    {
      type: 'function',
      name: 'generate_image',
      description: 'Generate one image through the app image API. Include XML ref tags inside the prompt when an existing image is required.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          prompt: { type: 'string' },
        },
        required: ['id', 'prompt'],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: 'function',
      name: 'generate_image_batch',
      description: 'Generate multiple independent images concurrently. Include XML ref tags inside prompts when needed.',
      parameters: {
        type: 'object',
        properties: {
          images: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                prompt: { type: 'string' },
              },
              required: ['id', 'prompt'],
              additionalProperties: false,
            },
          },
        },
        required: ['images'],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: 'function',
      name: 'continue_generation',
      description: 'Request another round only after a prerequisite image was generated and dependent images remain.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
        additionalProperties: false,
      },
      strict: true,
    },
  ]
  if (enableWebSearch) tools.push({ type: 'web_search' })
  return tools
}

function getAgentResponseText(payload) {
  const chunks = []
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type !== 'message') continue
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if ((part?.type === 'output_text' || part?.type === 'text') && typeof part.text === 'string') chunks.push(part.text)
      if (part?.type === 'refusal' && typeof part.refusal === 'string') chunks.push(part.refusal)
    }
  }
  return chunks.join('\n').trim()
}

function getAgentResponseOutput(payload) {
  return Array.isArray(payload?.output) ? payload.output.filter((item) => item && typeof item === 'object') : []
}

async function readAgentStreamPayload(response, onTextDelta) {
  if (!response.body) throw new Error('聊天 API 未返回流式响应体')

  let buffer = ''
  let completedPayload = null
  let fallbackOutput = []
  let fallbackResponseId
  const decoder = new TextDecoder()

  const mergeOutputItems = (items, outputIndices) => {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (!item || typeof item !== 'object') continue
      const outputIndex = outputIndices?.[index]
      let targetIndex = typeof item.id === 'string'
        ? fallbackOutput.findIndex((existing) => existing?.id === item.id)
        : -1
      if (targetIndex < 0 && Number.isInteger(outputIndex) && outputIndex >= 0) {
        const candidate = fallbackOutput[outputIndex]
        if (!candidate || candidate.type === item.type) targetIndex = outputIndex
      }
      if (targetIndex < 0 && !item.id && item.type) {
        const sameTypeIndices = fallbackOutput
          .map((existing, currentIndex) => existing?.type === item.type ? currentIndex : -1)
          .filter((currentIndex) => currentIndex >= 0)
        if (sameTypeIndices.length === 1) targetIndex = sameTypeIndices[0]
      }
      if (targetIndex >= 0) fallbackOutput[targetIndex] = item
      else fallbackOutput.push(item)
    }
  }

  const processEvent = async (block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (!data || data === '[DONE]') return

    let event
    try {
      event = JSON.parse(data)
    } catch {
      return
    }
    if (event?.error) {
      throw new Error(event.error.message || event.error.code || '聊天 API 流式响应失败')
    }

    const type = typeof event?.type === 'string' ? event.type : ''
    if (type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta) {
      await onTextDelta?.(event.delta)
      return
    }

    if (event.response && typeof event.response === 'object') {
      if (typeof event.response.id === 'string') fallbackResponseId = event.response.id
      if (Array.isArray(event.response.output)) {
        mergeOutputItems(
          event.response.output,
          type === 'response.completed' ? event.response.output.map((_, index) => index) : undefined,
        )
      }
      if (type === 'response.completed') completedPayload = event.response
      return
    }

    if (event.item && typeof event.item === 'object') {
      mergeOutputItems(
        [event.item],
        [Number.isInteger(event.output_index) ? event.output_index : undefined],
      )
    }
  }

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() || ''
    for (const block of blocks) await processEvent(block)
  }
  buffer += decoder.decode()
  if (buffer.trim()) await processEvent(buffer)

  const payload = completedPayload
    ? { ...completedPayload, output: fallbackOutput.length ? fallbackOutput.filter(Boolean) : completedPayload.output }
    : { id: fallbackResponseId, output: fallbackOutput.filter(Boolean) }
  if (!Array.isArray(payload.output)) throw new Error('聊天 API 未返回有效响应')
  return payload
}

async function callAgentUpstream(input, instructions, tools, onTextDelta) {
  const baseUrl = (process.env.CHAT_API_URL || process.env.API_URL || '').replace(/\/+$/, '')
  const apiKey = process.env.CHAT_API_KEY || process.env.API_KEY || ''
  const model = process.env.CHAT_MODEL || 'gpt-5.6-luna'
  if (!baseUrl || !apiKey) throw new Error('服务端聊天 API 配置不完整')
  const response = await fetchWithTimeout(`${baseUrl}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, instructions, input, tools, stream: true }),
  })
  if (response.ok && response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    return readAgentStreamPayload(response, onTextDelta)
  }
  const payload = await readApiPayload(response)
  if (!response.ok) throw new Error(payload?.error?.message || `聊天 API 返回 HTTP ${response.status}`)
  if (!Array.isArray(payload?.output)) throw new Error('聊天 API 未返回有效响应')
  return payload
}

function getAgentReferenceIds(text) {
  return Array.from(String(text || '').matchAll(/<ref\b[^>]*\bid=(['"])([^'"]+)\1[^>]*\/?\s*>/gi), (match) => match[2])
}

function collectAgentReferenceImages(input) {
  const references = new Map()
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== 'object') return
    const content = value.content
    if (Array.isArray(content)) {
      const images = content
        .filter((part) => part?.type === 'input_image' && typeof part.image_url === 'string' && part.image_url.startsWith('data:'))
        .map((part) => part.image_url)
      const refs = content.flatMap((part) => part?.type === 'input_text' && typeof part.text === 'string' ? getAgentReferenceIds(part.text) : [])
      for (let index = 0; index < Math.min(images.length, refs.length); index++) references.set(refs[index], images[index])
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'content') visit(child)
    }
  }
  visit(input)
  return references
}

function stripAgentReferenceTags(prompt) {
  return String(prompt || '').replace(/<ref\b[^>]*\/?\s*>/gi, '').replace(/<removed_ref\b[^>]*\/?\s*>/gi, '').trim()
}

function escapeXmlAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function createAgentGeneratedImagesInput(images) {
  if (images.length === 0) return null
  const content = []
  for (const image of images) {
    content.push({ type: 'input_image', image_url: image.dataUrl })
    content.push({
      type: 'input_text',
      text: `<ref id="${image.referenceId}" prompt="${escapeXmlAttribute(image.prompt)}" />`,
    })
  }
  return { role: 'user', content }
}

function parseAgentFunctionArguments(item) {
  try {
    const value = JSON.parse(item.arguments || '{}')
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function getAgentPendingImages(outputItems, images) {
  const generatedToolCallIds = new Set(images.map((image) => image.toolCallId).filter(Boolean))
  const functionOutputs = new Map(
    outputItems
      .filter((item) => item?.type === 'function_call_output' && typeof item.call_id === 'string')
      .map((item) => {
        try {
          return [item.call_id, JSON.parse(item.output || '{}')]
        } catch {
          return [item.call_id, null]
        }
      }),
  )
  const pending = []

  for (const item of outputItems) {
    if (item?.type !== 'function_call' || typeof item.call_id !== 'string') continue
    const args = parseAgentFunctionArguments(item)
    if (item.name === 'generate_image') {
      if (generatedToolCallIds.has(item.call_id)) continue
      const output = functionOutputs.get(item.call_id)
      pending.push({
        toolCallId: item.call_id,
        prompt: typeof args?.prompt === 'string' ? args.prompt : '',
        status: output?.status === 'error' ? 'error' : 'running',
        ...(output?.error ? { error: output.error } : {}),
      })
      continue
    }
    if (item.name !== 'generate_image_batch') continue

    const output = functionOutputs.get(item.call_id)
    const outputItemsById = new Map(
      Array.isArray(output?.images)
        ? output.images.map((result) => [result.id, result])
        : [],
    )
    for (const [index, batchItem] of (Array.isArray(args?.images) ? args.images : []).entries()) {
      const itemId = typeof batchItem?.id === 'string' ? batchItem.id : String(index + 1)
      const toolCallId = `${item.call_id}:${itemId}`
      if (generatedToolCallIds.has(toolCallId)) continue
      const result = outputItemsById.get(itemId)
      pending.push({
        toolCallId,
        batchCallId: item.call_id,
        batchItemId: itemId,
        prompt: typeof batchItem?.prompt === 'string' ? batchItem.prompt : '',
        status: result?.status === 'error' ? 'error' : 'running',
        ...(result?.error ? { error: result.error } : {}),
      })
    }
  }
  return pending
}

function createAgentProgressReporter(task) {
  let lastPersistedAt = 0
  let saveChain = Promise.resolve()

  const queueSave = () => {
    saveChain = saveChain.then(() => saveTask(task))
    return saveChain
  }

  const report = ({ text, outputItems, images, pendingImages }, force = false) => {
    const previous = getAgentProgress(task)
    const nextImages = images ?? previous.images
    const imageChanged = nextImages.length !== previous.images.length
    task.progress = {
      revision: previous.revision + 1,
      imageRevision: previous.imageRevision + (imageChanged ? 1 : 0),
      text: text ?? previous.text,
      outputItems: outputItems ?? previous.outputItems,
      pendingImages: pendingImages ?? previous.pendingImages,
      images: nextImages,
    }
    task.updatedAt = Date.now()
    const now = Date.now()
    if (!force && now - lastPersistedAt < 250) return Promise.resolve()
    lastPersistedAt = now
    return queueSave()
  }

  return {
    report,
    flush: () => queueSave(),
  }
}

async function executeAgentImage(task, toolCallId, prompt, references, metadata = {}) {
  const cleanPrompt = stripAgentReferenceTags(prompt)
  if (!cleanPrompt) throw new Error('图像提示词不能为空')
  const result = await executeUpstream({
    params: { ...task.params, n: 1 },
    prompt: cleanPrompt,
    inputImages: references,
    nativeTransparentBackground: false,
  })
  return result.images.map((dataUrl, index) => ({
    dataUrl,
    toolCallId: metadata.batchCallId ? `${metadata.batchCallId}:${metadata.batchItemId || index + 1}` : toolCallId,
    ...(metadata.batchCallId ? { batchCallId: metadata.batchCallId, batchItemId: metadata.batchItemId } : {}),
    prompt: cleanPrompt,
    referenceIds: getAgentReferenceIds(prompt),
    actualParams: { ...task.params, n: 1 },
    revisedPrompt: cleanPrompt,
    action: references.length > 0 ? 'edit' : 'generate',
  }))
}

async function executeAgentUpstream(task) {
  let input = task.input
  const tools = createAgentTools(task.enableWebSearch)
  const references = collectAgentReferenceImages(input)
  const outputItems = []
  const images = []
  const textSegments = []
  const progress = createAgentProgressReporter(task)
  let responseId

  for (let responseRound = 0; responseRound < task.maxToolRounds; responseRound++) {
    let streamedText = ''
    const payload = await callAgentUpstream(input, task.instructions, tools, async (delta) => {
      streamedText += delta
      await progress.report({
        text: [...textSegments, streamedText].filter(Boolean).join('\n\n'),
        outputItems,
        images,
        pendingImages: [],
      })
    })
    responseId = typeof payload.id === 'string' ? payload.id : responseId
    const currentOutput = getAgentResponseOutput(payload)
    outputItems.push(...currentOutput)
    const text = getAgentResponseText(payload) || streamedText.trim()
    if (text) textSegments.push(text)

    await progress.report({
      text: textSegments.join('\n\n').trim(),
      outputItems,
      images,
      pendingImages: getAgentPendingImages(outputItems, images),
    }, true)

    const functionCalls = currentOutput.filter((item) =>
      item.type === 'function_call' &&
      (item.name === 'generate_image' || item.name === 'generate_image_batch' || item.name === 'continue_generation'),
    )
    if (functionCalls.length === 0) break

    const functionOutputs = []
    const generatedThisRound = []
    for (const functionCall of functionCalls) {
      const callId = typeof functionCall.call_id === 'string' && functionCall.call_id ? functionCall.call_id : `server-call-${responseRound + 1}`
      const args = parseAgentFunctionArguments(functionCall)
      if (functionCall.name === 'continue_generation') {
        functionOutputs.push({ type: 'function_call_output', call_id: callId, output: JSON.stringify({ status: 'continued' }) })
        continue
      }
      if (functionCall.name === 'generate_image') {
        const prompt = typeof args?.prompt === 'string' ? args.prompt : ''
        const refs = getAgentReferenceIds(prompt).map((id) => references.get(id)).filter((value) => typeof value === 'string')
        try {
          const generated = await executeAgentImage(task, callId, prompt, refs)
          generated.forEach((image) => {
            image.referenceId = `round-${task.roundIndex}-image-${images.length + 1}`
            images.push(image)
            generatedThisRound.push(image)
            references.set(image.referenceId, image.dataUrl)
          })
          functionOutputs.push({ type: 'function_call_output', call_id: callId, output: JSON.stringify({ id: typeof args?.id === 'string' ? args.id : 'image', status: 'done' }) })
        } catch (error) {
          functionOutputs.push({ type: 'function_call_output', call_id: callId, output: JSON.stringify({ id: typeof args?.id === 'string' ? args.id : 'image', status: 'error', error: error instanceof Error ? error.message : String(error) }) })
        }
        continue
      }

      const batchItems = Array.isArray(args?.images) ? args.images : []
      const batchResults = await Promise.all(batchItems.map(async (item, index) => {
        const prompt = typeof item?.prompt === 'string' ? item.prompt : ''
        const refs = getAgentReferenceIds(prompt).map((id) => references.get(id)).filter((value) => typeof value === 'string')
        const itemId = typeof item?.id === 'string' ? item.id : String(index + 1)
        try {
          const generated = await executeAgentImage(task, `${callId}:${itemId}`, prompt, refs, {
            batchCallId: callId,
            batchItemId: itemId,
          })
          return { id: itemId, status: 'done', generated }
        } catch (error) {
          return { id: itemId, status: 'error', error: error instanceof Error ? error.message : String(error), generated: [] }
        }
      }))
      // 请求可以乱序完成，但 Agent 的引用编号必须保持模型给出的批量顺序。
      for (const batchResult of batchResults) {
        for (const image of batchResult.generated) {
          image.referenceId = `round-${task.roundIndex}-image-${images.length + 1}`
          images.push(image)
          generatedThisRound.push(image)
          references.set(image.referenceId, image.dataUrl)
        }
      }
      const publicBatchResults = batchResults.map(({ generated: _generated, ...result }) => result)
      functionOutputs.push({ type: 'function_call_output', call_id: callId, output: JSON.stringify({ images: publicBatchResults }) })
    }

    outputItems.push(...functionOutputs)
    await progress.report({
      text: textSegments.join('\n\n').trim(),
      outputItems,
      images,
      pendingImages: getAgentPendingImages(outputItems, images),
    }, true)
    input = [...input, ...currentOutput, ...functionOutputs]
    const generatedInput = createAgentGeneratedImagesInput(generatedThisRound)
    if (generatedInput) input.push(generatedInput)
  }

  await progress.flush()

  return {
    responseId,
    text: textSegments.join('\n\n').trim(),
    images,
    outputItems,
    rawResponsePayload: JSON.stringify({ output: outputItems }, null, 2),
  }
}

async function runTask(task) {
  activeTasks.add(task.id)
  try {
    task.status = 'running'
    task.updatedAt = Date.now()
    await saveTask(task)
    try {
      task.result = task.kind === 'agent' ? await executeAgentUpstream(task) : await executeUpstream(task)
      task.status = 'done'
      task.error = null
    } catch (error) {
      task.status = 'error'
      task.error = error instanceof Error ? error.message : String(error)
    }
    task.inputImages = undefined
    task.maskDataUrl = undefined
    task.input = undefined
    task.instructions = undefined
    task.finishedAt = Date.now()
    task.updatedAt = task.finishedAt
    await saveTask(task)
  } catch (error) {
    task.status = 'error'
    task.error = error instanceof Error ? error.message : String(error)
    task.inputImages = undefined
    task.maskDataUrl = undefined
    task.input = undefined
    task.instructions = undefined
    task.finishedAt = Date.now()
    task.updatedAt = task.finishedAt
    try {
      await saveTask(task)
    } catch (saveError) {
      console.error('保存异步任务失败', saveError)
    }
  } finally {
    activeTasks.delete(task.id)
    pumpQueue()
  }
}

function pumpQueue() {
  while (activeTasks.size < CONCURRENCY && pendingTasks.length) {
    const task = pendingTasks.shift()
    if (task) void runTask(task)
  }
}

async function cleanupTasks() {
  const now = Date.now()
  for (const name of await readdir(DATA_DIR)) {
    if (!name.endsWith('.json')) continue
    const path = join(DATA_DIR, name)
    try {
      const task = JSON.parse(await readFile(path, 'utf8'))
      if ((task.status === 'done' || task.status === 'error') && now - (task.updatedAt || task.createdAt) > TASK_TTL_MS) await unlink(path)
    } catch {
      // 忽略单个损坏或正在替换的任务文件。
    }
  }
}

async function restoreTasks() {
  for (const name of await readdir(DATA_DIR)) {
    if (!name.endsWith('.json')) continue
    try {
      const task = JSON.parse(await readFile(join(DATA_DIR, name), 'utf8'))
      if (task.status === 'queued' || task.status === 'running') {
        task.status = 'queued'
        task.updatedAt = Date.now()
        await saveTask(task)
        pendingTasks.push(task)
      }
    } catch {
      // 忽略单个损坏任务，不阻塞服务启动。
    }
  }
  pumpQueue()
}

async function handleCreate(req, res) {
  try {
    const body = normalizeTaskInput(JSON.parse(await readRequestBody(req)))
    const task = {
      id: randomUUID(),
      status: 'queued',
      prompt: body.prompt,
      params: body.params,
      inputImages: body.inputImages,
      maskDataUrl: body.maskDataUrl,
      nativeTransparentBackground: body.nativeTransparentBackground,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: null,
    }
    await saveTask(task)
    pendingTasks.push(task)
    pumpQueue()
    json(res, 202, { task_id: task.id, status: task.status })
  } catch (error) {
    json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } })
  }
}

async function handleCreateAgent(req, res) {
  let taskId = ''
  try {
    const body = normalizeAgentTaskInput(JSON.parse(await readRequestBody(req)))
    taskId = body.taskId
    let creation = agentTaskCreationLocks.get(body.taskId)
    if (!creation) {
      creation = (async () => {
        const existing = await loadTask(body.taskId)
        if (existing) return existing

        const task = {
          id: body.taskId,
          kind: 'agent',
          status: 'queued',
          input: body.input,
          instructions: body.instructions,
          params: body.params,
          roundIndex: body.roundIndex,
          maxToolRounds: body.maxToolRounds,
          enableWebSearch: body.enableWebSearch,
          progress: {
            revision: 0,
            imageRevision: 0,
            text: '',
            outputItems: [],
            pendingImages: [],
            images: [],
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
          error: null,
        }
        await saveTask(task)
        pendingTasks.push(task)
        pumpQueue()
        return task
      })()
      agentTaskCreationLocks.set(body.taskId, creation)
    }

    const task = await creation
    agentTaskCreationLocks.delete(body.taskId)
    if (task.kind !== 'agent') {
      json(res, 409, { error: { message: 'Agent 任务 ID 已被其他任务使用' } })
      return
    }
    json(res, 202, { task_id: task.id, status: task.status })
  } catch (error) {
    if (taskId) agentTaskCreationLocks.delete(taskId)
    json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } })
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const match = url.pathname.match(/^\/api-tasks\/([a-f0-9-]+)$/i)
  const agentProgressMatch = url.pathname.match(/^\/api-agent-tasks\/([A-Za-z0-9_-]+)\/progress$/)
  const agentResultMatch = url.pathname.match(/^\/api-agent-tasks\/([A-Za-z0-9_-]+)\/result$/)
  const agentMatch = url.pathname.match(/^\/api-agent-tasks\/([A-Za-z0-9_-]+)$/)
  if (req.method === 'POST' && url.pathname === '/api-agent-tasks') {
    await handleCreateAgent(req, res)
    return
  }
  if (req.method === 'GET' && agentResultMatch) {
    const task = await loadTask(agentResultMatch[1])
    if (!task || task.kind !== 'agent') {
      json(res, 404, { error: { message: 'Agent 任务不存在' } })
      return
    }
    if (task.status !== 'done') {
      json(res, 409, publicTask(task))
      return
    }
    json(res, 200, publicTask(task, true))
    return
  }
  if (req.method === 'GET' && agentProgressMatch) {
    const task = await loadTask(agentProgressMatch[1])
    if (!task || task.kind !== 'agent') {
      json(res, 404, { error: { message: 'Agent 任务不存在' } })
      return
    }
    json(res, 200, {
      id: task.id,
      status: task.status,
      progress: publicAgentProgress(task, true),
    })
    return
  }
  if (req.method === 'GET' && agentMatch) {
    const task = await loadTask(agentMatch[1])
    if (!task || task.kind !== 'agent') {
      json(res, 404, { error: { message: 'Agent 任务不存在' } })
      return
    }
    // 保留默认返回完整结果，兼容已经打开的旧版前端；新版使用 meta=1 避免轮询携带图片。
    json(res, 200, publicTask(task, url.searchParams.get('meta') !== '1'))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api-tasks') {
    await handleCreate(req, res)
    return
  }
  if (req.method === 'GET' && match) {
    const task = await loadTask(match[1])
    if (!task) {
      json(res, 404, { error: { message: '任务不存在' } })
      return
    }
    json(res, 200, publicTask(task))
    return
  }
  json(res, 404, { error: { message: 'Not Found' } })
})

await mkdir(DATA_DIR, { recursive: true })
await cleanupTasks()
await restoreTasks()
setInterval(() => void cleanupTasks(), 6 * 60 * 60 * 1000)
server.listen(3000, '127.0.0.1', () => console.log('Async image task server listening on 127.0.0.1:3000'))
