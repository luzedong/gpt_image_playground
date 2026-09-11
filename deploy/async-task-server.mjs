import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

const DATA_DIR = process.env.ASYNC_TASK_DATA_DIR || '/var/lib/gpt-image-playground/tasks'
const MAX_BODY_BYTES = 600 * 1024 * 1024
const MAX_INPUT_BYTES = 512 * 1024 * 1024
const MAX_AGENT_ASSET_BYTES = 64 * 1024 * 1024
const MAX_AUDIO_BASE64_BYTES = 10 * 1024 * 1024
const MAX_1K_PIXELS = 1_572_864
const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000
const CONCURRENCY = Math.max(1, Number(process.env.ASYNC_TASK_CONCURRENCY) || 2)
const UPSTREAM_RETRY_ATTEMPTS = 3
const UPSTREAM_PROXY_URL = (process.env.UPSTREAM_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim()
const AGENT_CAPTION_INSTRUCTION = 'Image generation is complete. Write a concise final response for the user without calling any tools.'

if (UPSTREAM_PROXY_URL) {
  setGlobalDispatcher(new EnvHttpProxyAgent({
    httpProxy: UPSTREAM_PROXY_URL,
    httpsProxy: UPSTREAM_PROXY_URL,
    noProxy: process.env.NO_PROXY || '127.0.0.1,localhost,::1',
  }))
  let proxyHost = 'configured'
  try {
    proxyHost = new URL(UPSTREAM_PROXY_URL).host
  } catch {
    // 启动日志只输出可确认的代理主机，避免暴露可能存在的认证信息。
  }
  console.log(JSON.stringify({ type: 'upstream_proxy', enabled: true, host: proxyHost }))
}

const activeTasks = new Set()
const pendingTasks = []
const agentTaskCreationLocks = new Map()
const imageTaskCreationLocks = new Map()
const agentEventClients = new Map()
const upstreamLocks = new Map()
const AGENT_IMAGE_DIR = join(DATA_DIR, 'agent-images')
const AGENT_ASSET_DIR = join(DATA_DIR, 'agent-assets')

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

function agentProgressPath(id) {
  return join(DATA_DIR, `${id}.progress.json`)
}

function agentContextPath(id) {
  return join(DATA_DIR, `${id}.context.json`)
}

function agentImagePath(taskId, index) {
  return join(AGENT_IMAGE_DIR, `${taskId}-${index}.bin`)
}

function agentAssetPath(id) {
  return join(AGENT_ASSET_DIR, `${id}.bin`)
}

function dataUrlToBuffer(dataUrl) {
  const match = /^data:[^;,]+;base64,([\s\S]+)$/i.exec(dataUrl)
  if (!match) throw new Error('生成图片格式无效')
  return Buffer.from(match[1], 'base64')
}

async function resolveAgentAssetInput(value) {
  if (Array.isArray(value)) return Promise.all(value.map(resolveAgentAssetInput))
  if (!value || typeof value !== 'object') return value
  if (value.type === 'input_image' && typeof value.image_asset_id === 'string') {
    const id = value.image_asset_id
    const mime = typeof value.image_mime === 'string' && /^image\/[A-Za-z0-9.+-]+$/.test(value.image_mime)
      ? value.image_mime
      : 'image/png'
    if (!/^(?:[a-f0-9]{64}|fallback-[a-f0-9]{16})$/i.test(id)) throw new Error('Agent 图片资产 ID 无效')
    const data = await readFile(agentAssetPath(id))
    const { image_asset_id: _assetId, image_mime: _imageMime, ...rest } = value
    return { ...rest, image_url: `data:${mime};base64,${data.toString('base64')}` }
  }
  const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolveAgentAssetInput(item)]))
  return Object.fromEntries(entries)
}

async function writeJsonFile(path, value) {
  const tempPath = `${path}.${process.pid}.tmp`
  await writeFile(tempPath, JSON.stringify(value), 'utf8')
  await rename(tempPath, path)
}

async function saveTask(task) {
  const { progress: _progress, input: _input, instructions: _instructions, captionContext: _captionContext, ...snapshot } = task
  await writeJsonFile(taskPath(task.id), snapshot)
  if (task.kind !== 'agent') return
  await writeJsonFile(agentProgressPath(task.id), task.progress || getAgentProgress(task))
}

async function saveAgentProgress(task) {
  if (task.kind !== 'agent') return
  await writeJsonFile(agentProgressPath(task.id), task.progress || getAgentProgress(task))
}

async function saveAgentContext(task) {
  if (task.kind !== 'agent') return
  await writeJsonFile(agentContextPath(task.id), {
    input: task.input,
    instructions: task.instructions,
  })
}

async function loadTask(id) {
  try {
    const task = JSON.parse(await readFile(taskPath(id), 'utf8'))
    if (task.kind !== 'agent') return task
    try {
      task.progress = JSON.parse(await readFile(agentProgressPath(id), 'utf8'))
    } catch {
      // 兼容拆分存储前的旧任务文件。
    }
    try {
      const context = JSON.parse(await readFile(agentContextPath(id), 'utf8'))
      task.input ??= context.input
      task.instructions ??= context.instructions
    } catch {
      // 兼容拆分存储前的旧任务文件。
    }
    return task
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
    captionState: progress.captionState || task.captionState || 'idle',
    ...(includeImages ? {
      images: progress.images.map((image, index) => {
        const { dataUrl: _dataUrl, ...metadata } = image
        return { ...metadata, imageUrl: `/api-agent-tasks/${task.id}/images/${index}` }
      }),
    } : {}),
  }
}

function broadcastAgentEvent(task) {
  const clients = agentEventClients.get(task.id)
  if (!clients?.size) return
  const current = publicAgentProgress(task, true)
  for (const client of clients) {
    try {
      const previous = client.progress
      const textOnlyAppend = previous
        && current.revision > previous.revision
        && current.text.startsWith(previous.text)
        && current.imageRevision === previous.imageRevision
        && JSON.stringify(current.outputItems) === JSON.stringify(previous.outputItems)
        && JSON.stringify(current.pendingImages) === JSON.stringify(previous.pendingImages)
        && JSON.stringify(current.images) === JSON.stringify(previous.images)
        && task.status === client.status
        && (task.error ?? null) === client.error
      const payload = textOnlyAppend
        ? {
            id: task.id,
            status: task.status,
            error: task.error ?? null,
            progress_delta: {
              revision: current.revision,
              text_delta: current.text.slice(previous.text.length),
            },
          }
        : {
            id: task.id,
            status: task.status,
            error: task.error ?? null,
            progress: current,
          }
      client.res.write(`event: progress\ndata: ${JSON.stringify(payload)}\n\n`)
      client.progress = current
      client.status = task.status
      client.error = task.error ?? null
    } catch {
      clients.delete(client)
    }
  }
}

function addAgentEventClient(task, req, res) {
  const clients = agentEventClients.get(task.id) || new Set()
  const progress = publicAgentProgress(task, true)
  const client = { res, progress, status: task.status, error: task.error ?? null }
  clients.add(client)
  agentEventClients.set(task.id, clients)
  res.write(`event: progress\ndata: ${JSON.stringify({
    id: task.id,
    status: task.status,
    error: task.error ?? null,
    progress,
  })}\n\n`)
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      clearInterval(heartbeat)
    }
  }, 15_000)
  const cleanup = () => {
    clearInterval(heartbeat)
    clients.delete(client)
    if (!clients.size) agentEventClients.delete(task.id)
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
}

async function handleAgentEvents(req, res, taskId) {
  const task = await loadTask(taskId)
  if (!task || task.kind !== 'agent') {
    json(res, 404, { error: { message: 'Agent 任务不存在' } })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  addAgentEventClient(task, req, res)
  if (task.status === 'done' || task.status === 'error') {
    setTimeout(() => res.end(), 0)
  }
}

async function persistAgentImages(task, images) {
  await mkdir(AGENT_IMAGE_DIR, { recursive: true })
  await mkdir(AGENT_ASSET_DIR, { recursive: true })
  await Promise.all(images.map(async (image, index) => {
    image.mime = image.dataUrl.match(/^data:([^;,]+)/i)?.[1] || 'image/png'
    const data = dataUrlToBuffer(image.dataUrl)
    const canonicalDataUrl = `data:${image.mime};base64,${data.toString('base64')}`
    image.assetId = createHash('sha256').update(canonicalDataUrl).digest('hex')
    await Promise.all([
      writeFile(agentImagePath(task.id, index), data),
      writeFile(agentAssetPath(image.assetId), data),
    ])
  }))
}

async function handleAgentImage(req, res, taskId, index) {
  const task = await loadTask(taskId)
  if (!task || task.kind !== 'agent') {
    json(res, 404, { error: { message: 'Agent 任务不存在' } })
    return
  }
  const image = getAgentProgress(task).images[Number(index)]
  if (!image) {
    json(res, 404, { error: { message: '图片不存在' } })
    return
  }
  const mime = image.mime || image.dataUrl?.match(/^data:([^;,]+)/i)?.[1] || 'image/png'
  try {
    const data = await readFile(agentImagePath(task.id, Number(index)))
    const etag = `"${task.id}-${index}-${data.byteLength}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'public, max-age=31536000, immutable' })
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': data.byteLength,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: etag,
    })
    res.end(data)
  } catch {
    if (!image.dataUrl) {
      json(res, 404, { error: { message: '图片资源不存在' } })
      return
    }
    const data = dataUrlToBuffer(image.dataUrl)
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': data.byteLength,
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
    res.end(data)
  }
}

function publicTask(task, includeResult = false) {
  const result = task.kind === 'agent' && task.result
    ? {
        ...task.result,
        images: task.result.images.map((image, index) => {
          const { dataUrl: _dataUrl, ...metadata } = image
          return { ...metadata, imageUrl: `/api-agent-tasks/${task.id}/images/${index}` }
        }),
      }
    : task.result
  return {
    id: task.id,
    status: task.status,
    captionState: task.kind === 'agent' ? task.captionState || 'idle' : undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt ?? null,
    error: task.error ?? null,
    ...(task.kind === 'agent' ? { progress: publicAgentProgress(task) } : {}),
    ...(includeResult && result ? { result } : {}),
  }
}

function readRequestBuffer(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length'] || 0)
    if (contentLength > maxBytes) {
      reject(new Error('请求体过大'))
      req.resume()
      return
    }

    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readRequestBody(req) {
  return (await readRequestBuffer(req)).toString('utf8')
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const STRIPPED_PNG_CHUNKS = new Set(['caBX', 'c2pa'])

function stripPngMetadataChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return buffer
  const chunks = [buffer.subarray(0, 8)]
  let offset = 8
  let removed = false
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > buffer.length) break
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    if (STRIPPED_PNG_CHUNKS.has(type)) {
      removed = true
    } else {
      chunks.push(buffer.subarray(offset, end))
    }
    offset = end
    if (type === 'IEND') break
  }
  if (!removed) return buffer
  if (offset < buffer.length) chunks.push(buffer.subarray(offset))
  return Buffer.concat(chunks)
}

async function sanitizeImageBlobForUpstream(blob) {
  if (blob.type !== 'image/png') return blob
  const buffer = Buffer.from(await blob.arrayBuffer())
  const sanitized = stripPngMetadataChunks(buffer)
  if (sanitized === buffer) return blob
  return new Blob([sanitized], { type: 'image/png' })
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

function normalizeImageModel(value) {
  if (value == null || value === '') return ''
  if (typeof value !== 'string') throw new Error('图像模型 ID 无效')
  const model = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)) throw new Error('图像模型 ID 无效')
  return model
}

function normalizeClientTaskId(value) {
  if (value == null || value === '') return ''
  if (typeof value !== 'string') throw new Error('客户端任务 ID 无效')
  const taskId = value.trim()
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(taskId)) throw new Error('客户端任务 ID 无效')
  return taskId
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
    profileId: body.profileId === 'default-ailink-image' ? 'default-ailink-image' : 'default-openai',
    model: normalizeImageModel(body.model),
    clientTaskId: normalizeClientTaskId(body.client_task_id),
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

function getUpstreamConfig(size, profileId = '', requestedModel = '') {
  const isHighResolution = is4K(size)
  const isAilink = profileId === 'default-ailink-image'
  const upstreamBaseUrl = isAilink
    ? (isHighResolution ? process.env.IMAGE_AILINK_4K_API_URL : process.env.IMAGE_AILINK_1K_API_URL)
    : (isHighResolution ? process.env.IMAGE_PIXEL_4K_API_URL : process.env.IMAGE_PIXEL_1K_API_URL)
    || (isHighResolution ? process.env.IMAGE_4K_API_URL : process.env.IMAGE_1K_API_URL)
    || process.env.API_URL || ''
  const baseUrl = upstreamBaseUrl.replace(/\/+$/, '')
  return {
    baseUrl,
    isPixel: isPixelApiUrl(baseUrl),
    apiKey: isAilink
      ? (isHighResolution ? process.env.IMAGE_AILINK_4K_API_KEY : process.env.IMAGE_AILINK_1K_API_KEY)
      : (isHighResolution ? process.env.IMAGE_PIXEL_4K_API_KEY : process.env.IMAGE_PIXEL_1K_API_KEY)
        || (isHighResolution ? process.env.IMAGE_4K_API_KEY : process.env.IMAGE_1K_API_KEY)
        || process.env.API_KEY || '',
    model: requestedModel || (isAilink
      ? (isHighResolution ? process.env.IMAGE_AILINK_4K_MODEL : process.env.IMAGE_AILINK_1K_MODEL) || 'gpt-image-2'
      : (isHighResolution ? process.env.IMAGE_PIXEL_4K_MODEL : process.env.IMAGE_PIXEL_1K_MODEL) || 'gpt-image-2.5-flare'),
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

function isRetryableUpstreamFailure(status, message = '', imageRequest = false) {
  if (status === 408 || status === 425 || status === 429) return true
  if (imageRequest) return /concurrency limit|rate limit|too many requests|gateway routing budget expired/i.test(message)
  return status >= 500 || /temporarily unavailable|try again|concurrency limit|rate limit|too many requests|gateway routing budget expired/i.test(message)
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchUpstreamWithRetry(url, options = {}, timeoutMs = 600_000, imageRequest = false) {
  let lastError
  for (let attempt = 0; attempt < UPSTREAM_RETRY_ATTEMPTS; attempt += 1) {
    let response
    try {
      response = await fetchWithTimeout(url, options, timeoutMs)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (imageRequest || (message && !/aborted|abort|fetch failed|network|socket|timeout|temporarily unavailable|try again|concurrency limit|rate limit|too many requests|gateway routing budget expired/i.test(message))) throw error
      lastError = error instanceof Error ? error : new Error(message)
      if (attempt === UPSTREAM_RETRY_ATTEMPTS - 1) throw lastError
      await waitMs(1500 * (attempt + 1))
      continue
    }
    if (response.ok) return response
    const payload = await readApiPayload(response)
    const message = payload?.error?.message || `上游 API 返回 HTTP ${response.status}`
    if (!isRetryableUpstreamFailure(response.status, message, imageRequest) || attempt === UPSTREAM_RETRY_ATTEMPTS - 1) throw new Error(message)
    lastError = new Error(message)
    await waitMs(1500 * (attempt + 1))
  }
  throw lastError || new Error('上游 API 请求失败')
}

async function withUpstreamLock(key, operation) {
  const previous = upstreamLocks.get(key) || Promise.resolve()
  let release
  const current = new Promise((resolve) => { release = resolve })
  upstreamLocks.set(key, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (upstreamLocks.get(key) === current) upstreamLocks.delete(key)
  }
}

function extractSpeechText(payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) return content.map((item) => typeof item === 'string' ? item : item?.text || '').join('').trim()
  return typeof payload?.text === 'string' ? payload.text.trim() : ''
}

async function handleSpeechToText(req, res) {
  try {
    const body = JSON.parse(await readRequestBody(req))
    const audioData = typeof body.audioData === 'string' ? body.audioData : ''
    const match = /^data:(audio\/(?:wav|x-wav|mpeg|mp3));base64,([\s\S]+)$/i.exec(audioData)
    if (!match) throw new Error('录音格式无效，仅支持 WAV 或 MP3')
    if (Buffer.byteLength(match[2], 'utf8') > MAX_AUDIO_BASE64_BYTES) throw new Error('录音文件不能超过 10 MB')
    const baseUrl = (process.env.MIMO_API_URL || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '')
    const apiKey = process.env.MIMO_API_KEY || ''
    const model = process.env.MIMO_ASR_MODEL || 'mimo-v2.5-asr'
    if (!apiKey) throw new Error('服务端语音 API 配置不完整')
    const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: audioData } }],
        }],
        asr_options: { language: typeof body.language === 'string' ? body.language : 'zh' },
      }),
    }, 120_000)
    const payload = await readApiPayload(response)
    if (!response.ok) throw new Error(payload?.error?.message || `语音 API 返回 HTTP ${response.status}`)
    const text = extractSpeechText(payload)
    if (!text) throw new Error('语音 API 未返回识别文字')
    json(res, 200, { text })
  } catch (error) {
    json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } })
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
  const startedAt = Date.now()
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
  return {
    images,
    rawImageUrls: rawImageUrls.length ? rawImageUrls : undefined,
    imageSource: rawImageUrls.length ? 'url' : 'b64_json',
    imageDownloadDurationMs: rawImageUrls.length ? Date.now() - startedAt : 0,
  }
}

async function executeUpstream(task) {
  const config = getUpstreamConfig(task.params.size, task.profileId, task.model)
  if (!config.baseUrl || !config.apiKey) throw new Error('服务端图像 API 配置不完整')
  return withUpstreamLock(config.baseUrl, () => executeUpstreamRequest(task, config))
}

async function executeUpstreamRequest(task, config) {
  const headers = { Authorization: `Bearer ${config.apiKey}` }
  const isPixel = config.isPixel
  const inputImages = task.inputImages
  const isEdit = inputImages.length > 0
  const imageField = isPixel && inputImages.length === 1 ? 'image' : 'image[]'
  const requestStartedAt = Date.now()
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
      const blob = await sanitizeImageBlobForUpstream(dataUrlToBlob(inputImages[index]))
      const extension = blob.type.split('/')[1] || 'png'
      form.append(imageField, blob, `input-${index + 1}.${extension}`)
    }
    if (task.maskDataUrl) form.append('mask', await sanitizeImageBlobForUpstream(dataUrlToBlob(task.maskDataUrl)), 'mask.png')
    if (!isPixel) form.append('response_format', 'b64_json')
    response = await fetchUpstreamWithRetry(`${config.baseUrl}/images/edits`, { method: 'POST', headers, body: form }, 600_000, true)
  } else {
    const body = {
      model: config.model,
      prompt: task.prompt,
      response_format: 'b64_json',
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
    response = await fetchUpstreamWithRetry(`${config.baseUrl}/images/generations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 600_000, true)
  }
  const responseReceivedAt = Date.now()
  const payload = await readApiPayload(response)
  const payloadReadAt = Date.now()
  const result = await normalizeImageResult(payload, task.params.output_format)
  console.log(JSON.stringify({
    type: 'image_upstream_timing',
    taskId: task.id,
    kind: task.kind,
    profileId: task.profileId || null,
    model: config.model,
    action: isEdit ? 'edit' : 'generate',
    requestMs: responseReceivedAt - requestStartedAt,
    responseBodyMs: payloadReadAt - responseReceivedAt,
    imageDownloadMs: result.imageDownloadDurationMs,
    imageSource: result.imageSource,
    totalMs: Date.now() - requestStartedAt,
  }))
  return result
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
    profileId: input.image_profile_id === 'default-ailink-image' ? 'default-ailink-image' : 'default-openai',
    model: normalizeImageModel(input.image_model),
    roundIndex: Math.min(1000, Math.max(1, Math.trunc(Number(input.round_index) || 1))),
    maxToolRounds: Math.min(30, Math.max(1, Math.trunc(Number(input.max_tool_rounds) || 15))),
    enableWebSearch: true,
  }
}

function createAgentTools() {
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
  tools.push({ type: 'web_search' })
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

async function readAgentStreamPayload(response, onTextDelta, onReasoningDelta, onOutputItems) {
  if (!response.body) throw new Error('聊天 API 未返回流式响应体')

  let buffer = ''
  let completedPayload = null
  let fallbackOutput = []
  let fallbackResponseId
  let streamCompleted = false
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

  const emitOutputItems = async () => {
    await onOutputItems?.(fallbackOutput.filter(Boolean))
  }

  const processEvent = async (block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (!data) return
    if (data === '[DONE]') {
      streamCompleted = true
      return
    }

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
    if (
      (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') &&
      typeof event.delta === 'string' &&
      event.delta
    ) {
      await onReasoningDelta?.(event.delta)
      return
    }

    if (type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta) {
      await onTextDelta?.(event.delta)
      return
    }

    if (event.response && typeof event.response === 'object') {
      if (typeof event.response.id === 'string') fallbackResponseId = event.response.id
      if (Array.isArray(event.response.output)) {
        mergeOutputItems(
          event.response.output,
          type === 'response.completed' || type === 'response.done'
            ? event.response.output.map((_, index) => index)
            : undefined,
        )
      }
      await emitOutputItems()
      const responseStatus = typeof event.response.status === 'string' ? event.response.status : ''
      if (type === 'response.completed' || type === 'response.done' || responseStatus === 'completed') {
        completedPayload = event.response
        streamCompleted = true
      }
      return
    }

    if (event.item && typeof event.item === 'object') {
      mergeOutputItems(
        [event.item],
        [Number.isInteger(event.output_index) ? event.output_index : undefined],
      )
      await emitOutputItems()
      return
    }

    if (type === 'response.function_call_arguments.delta' && typeof event.item_id === 'string') {
      const index = fallbackOutput.findIndex((item) => item?.id === event.item_id)
      if (index >= 0) {
        const current = fallbackOutput[index]
        fallbackOutput[index] = {
          ...current,
          arguments: `${typeof current.arguments === 'string' ? current.arguments : ''}${typeof event.delta === 'string' ? event.delta : ''}`,
        }
        await emitOutputItems()
      }
      return
    }

    if (type === 'response.function_call_arguments.done' && typeof event.item_id === 'string') {
      const index = fallbackOutput.findIndex((item) => item?.id === event.item_id)
      if (index >= 0) {
        fallbackOutput[index] = {
          ...fallbackOutput[index],
          arguments: typeof event.arguments === 'string' ? event.arguments : fallbackOutput[index].arguments,
        }
        await emitOutputItems()
      }
    }
  }

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() || ''
    for (const block of blocks) {
      await processEvent(block)
      if (streamCompleted) break
    }
    if (streamCompleted) break
  }
  if (!streamCompleted) {
    buffer += decoder.decode()
    if (buffer.trim()) await processEvent(buffer)
  }

  const payload = completedPayload
    ? { ...completedPayload, output: fallbackOutput.length ? fallbackOutput.filter(Boolean) : completedPayload.output }
    : { id: fallbackResponseId, output: fallbackOutput.filter(Boolean) }
  if (!Array.isArray(payload.output)) throw new Error('聊天 API 未返回有效响应')
  return payload
}

async function callAgentUpstream(input, instructions, tools, onTextDelta, onReasoningDelta, onOutputItems, onRetry) {
  const baseUrl = (process.env.CHAT_API_URL || process.env.API_URL || '').replace(/\/+$/, '')
  const apiKey = process.env.CHAT_API_KEY || process.env.API_KEY || ''
  const model = process.env.CHAT_MODEL || 'gpt-5.6-luna'
  const reasoningEffort = (process.env.CHAT_REASONING_EFFORT || '').trim()
  if (!baseUrl || !apiKey) throw new Error('服务端聊天 API 配置不完整')
  const body = JSON.stringify({
    model,
    instructions,
    input,
    tools,
    stream: true,
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
  })
  let lastError
  for (let attempt = 0; attempt < UPSTREAM_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
      })
      if (!response.ok) {
        const payload = await readApiPayload(response)
        const message = payload?.error?.message || `聊天 API 返回 HTTP ${response.status}`
        if (isRetryableUpstreamFailure(response.status, message)) throw new Error(`可重试：${message}`)
        throw new Error(message)
      }
      if (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
        return await readAgentStreamPayload(response, onTextDelta, onReasoningDelta, onOutputItems)
      }
      const payload = await readApiPayload(response)
      if (!Array.isArray(payload?.output)) throw new Error('聊天 API 未返回有效响应')
      return payload
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isRetryableUpstreamFailure(0, message) && !message.startsWith('可重试：')) throw error
      if (attempt === UPSTREAM_RETRY_ATTEMPTS - 1) {
        throw new Error(message.replace(/^可重试：/, ''))
      }
      lastError = error instanceof Error ? error : new Error(message)
      await onRetry?.()
      await waitMs(1500 * (attempt + 1))
    }
  }
  throw lastError || new Error('聊天 API 请求失败')
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
      const prompt = typeof args?.prompt === 'string' ? args.prompt : ''
      if (!prompt) continue
      pending.push({
        toolCallId: item.call_id,
        prompt,
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
    saveChain = saveChain.then(async () => {
      await saveTask(task)
      broadcastAgentEvent(task)
    })
    return saveChain
  }

  const report = ({ text, outputItems, images, pendingImages }, force = false) => {
    const previous = getAgentProgress(task)
    const nextImages = images ?? previous.images
    const imageChanged = nextImages.length !== previous.images.length
    const nextOutputItems = outputItems ?? previous.outputItems
    const nextPendingImages = pendingImages ?? previous.pendingImages
    task.progress = {
      revision: previous.revision + 1,
      imageRevision: previous.imageRevision + (imageChanged ? 1 : 0),
      text: text ?? previous.text,
      // 进度快照不能直接引用执行中的数组，否则后续 push 会改写旧快照，导致版本比较失效。
      outputItems: nextOutputItems.map((item) => ({ ...item })),
      pendingImages: nextPendingImages.map((item) => ({ ...item })),
      // 流式快照只保存元数据，原图单独放在 agent-images，避免每个增量重复写入 Base64。
      images: nextImages.map(({ dataUrl: _dataUrl, ...image }) => ({ ...image })),
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

async function completeAgentCaption(task, context) {
  const { input, instructions, textSegments, outputItems } = context
  const baseText = textSegments.join('\n\n').trim()
  task.captionState = 'running'
  const previousStart = getAgentProgress(task)
  task.progress = {
    ...previousStart,
    captionState: 'running',
  }
  task.updatedAt = Date.now()
  await saveAgentProgress(task)
  broadcastAgentEvent(task)

  let streamedText = ''
  let payload
  try {
    payload = await callAgentUpstream(
      input,
      `${instructions}\n\n${AGENT_CAPTION_INSTRUCTION}`,
      [],
      async (delta) => {
        streamedText += delta
        const previous = getAgentProgress(task)
        task.progress = {
          ...previous,
          revision: previous.revision + 1,
          text: [baseText, streamedText].filter(Boolean).join('\n\n'),
        }
        task.updatedAt = Date.now()
        await saveAgentProgress(task)
        broadcastAgentEvent(task)
      },
      async () => {},
      async () => {},
      async () => {
        streamedText = ''
        const previous = getAgentProgress(task)
        task.progress = {
          ...previous,
          revision: previous.revision + 1,
          text: baseText,
        }
        task.updatedAt = Date.now()
        await saveAgentProgress(task)
        broadcastAgentEvent(task)
      },
    )
  } catch (error) {
    console.warn('Agent 图片文案整理失败', error)
    task.captionState = 'done'
    const previousError = getAgentProgress(task)
    task.progress = {
      ...previousError,
      captionState: 'done',
    }
    task.updatedAt = Date.now()
    await saveTask(task)
    broadcastAgentEvent(task)
    return
  }

  const currentOutput = getAgentResponseOutput(payload)
  const captionText = getAgentResponseText(payload) || streamedText.trim()
  const finalText = [baseText, captionText].filter(Boolean).join('\n\n') || '图片已生成。'
  const finalOutputItems = [...outputItems, ...currentOutput]
  const previous = getAgentProgress(task)
  task.result = {
    ...task.result,
    responseId: typeof payload.id === 'string' ? payload.id : task.result.responseId,
    text: finalText,
    outputItems: finalOutputItems,
    rawResponsePayload: JSON.stringify({ output: finalOutputItems }, null, 2),
  }
  task.progress = {
    ...previous,
    revision: previous.revision + 1,
    text: finalText,
    outputItems: finalOutputItems,
    pendingImages: [],
    captionState: 'done',
  }
  task.captionState = 'done'
  task.updatedAt = Date.now()
  await saveTask(task)
  broadcastAgentEvent(task)
}

async function executeAgentImage(task, toolCallId, prompt, references, metadata = {}) {
  const cleanPrompt = stripAgentReferenceTags(prompt)
  if (!cleanPrompt) throw new Error('图像提示词不能为空')
  const startedAt = Date.now()
  const result = await executeUpstream({
    params: { ...task.params, n: 1 },
    prompt: cleanPrompt,
    inputImages: references,
    profileId: task.profileId,
    model: task.model,
    nativeTransparentBackground: false,
  })
  const finishedAt = Date.now()
  return result.images.map((dataUrl, index) => ({
    dataUrl,
    toolCallId: metadata.batchCallId ? `${metadata.batchCallId}:${metadata.batchItemId || index + 1}` : toolCallId,
    ...(metadata.batchCallId ? { batchCallId: metadata.batchCallId, batchItemId: metadata.batchItemId } : {}),
    prompt: cleanPrompt,
    referenceIds: getAgentReferenceIds(prompt),
    actualParams: { ...task.params, n: 1 },
    revisedPrompt: cleanPrompt,
    action: references.length > 0 ? 'edit' : 'generate',
    startedAt,
    finishedAt,
  }))
}

async function executeAgentUpstream(task) {
  let input = await resolveAgentAssetInput(task.input)
  const tools = createAgentTools()
  const references = collectAgentReferenceImages(input)
  const outputItems = []
  const images = []
  const textSegments = []
  const progress = createAgentProgressReporter(task)
  let responseId

  for (let responseRound = 0; responseRound < task.maxToolRounds; responseRound++) {
    let streamedText = ''
    let thinkingText = ''
    let payload
    try {
      payload = await callAgentUpstream(input, task.instructions, tools, async (delta) => {
        thinkingText = ''
        streamedText += delta
        await progress.report({
          text: [...textSegments, streamedText].filter(Boolean).join('\n\n'),
          outputItems,
          images,
          pendingImages: [],
        })
      }, async () => {
        if (streamedText || thinkingText) return
        thinkingText = '正在思考...'
        await progress.report({
          text: [...textSegments, thinkingText].filter(Boolean).join('\n\n'),
          outputItems,
          images,
          pendingImages: [],
        }, true)
      }, async (streamedOutputItems) => {
        const visibleItems = [
          ...outputItems,
          ...streamedOutputItems.filter((item) =>
            !item?.id || !outputItems.some((existing) => existing?.id === item.id),
          ),
        ]
        await progress.report({
          text: [...textSegments, streamedText || thinkingText].filter(Boolean).join('\n\n'),
          outputItems: visibleItems,
          images,
          pendingImages: getAgentPendingImages(visibleItems, images),
        }, true)
      }, async () => {
        streamedText = ''
        thinkingText = ''
        await progress.report({
          text: textSegments.join('\n\n').trim(),
          outputItems,
          images,
          pendingImages: [],
        }, true)
      })
    } catch (error) {
      if (images.length === 0) throw error
      const message = error instanceof Error ? error.message : String(error)
      textSegments.push(`图片已生成，但回复整理失败：${message}`)
      await progress.report({
        text: textSegments.join('\n\n').trim(),
        outputItems,
        images,
        pendingImages: [],
      }, true)
      break
    }
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
    await persistAgentImages(task, images)
    await progress.report({
      text: textSegments.join('\n\n').trim(),
      outputItems,
      images,
      pendingImages: getAgentPendingImages(outputItems, images),
    }, true)
    const nextInput = [...input, ...currentOutput, ...functionOutputs]
    const generatedInput = createAgentGeneratedImagesInput(generatedThisRound)
    if (generatedInput) nextInput.push(generatedInput)

    const shouldDetachCaption = generatedThisRound.length > 0
      && functionCalls.length === 1
      && functionCalls[0].name === 'generate_image'
    if (shouldDetachCaption) {
      task.captionState = 'pending'
      task.captionContext = {
        input: nextInput,
        instructions: task.instructions,
        textSegments: [...textSegments],
        outputItems: [...outputItems],
      }
      break
    }

    input = nextInput
  }

  await progress.flush()

  const result = {
    responseId,
    text: textSegments.join('\n\n').trim(),
    images,
    outputItems,
    rawResponsePayload: JSON.stringify({ output: outputItems }, null, 2),
  }
  return {
    result,
    startCaption: task.captionContext
      ? () => completeAgentCaption(task, task.captionContext)
      : null,
  }
}

async function runTask(task) {
  activeTasks.add(task.id)
  try {
    task.status = 'running'
    task.updatedAt = Date.now()
    await saveTask(task)
    broadcastAgentEvent(task)
    let startCaption = null
    try {
      const execution = task.kind === 'agent'
        ? await executeAgentUpstream(task)
        : { result: await executeUpstream(task), startCaption: null }
      task.result = execution.result
      startCaption = execution.startCaption
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
    broadcastAgentEvent(task)
    if (startCaption) void startCaption()
    if (task.kind === 'agent') await unlink(agentContextPath(task.id)).catch(() => {})
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
      broadcastAgentEvent(task)
      if (task.kind === 'agent') await unlink(agentContextPath(task.id)).catch(() => {})
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
    if (!name.endsWith('.json') || name.endsWith('.progress.json') || name.endsWith('.context.json')) continue
    const path = join(DATA_DIR, name)
    try {
      const task = JSON.parse(await readFile(path, 'utf8'))
      if ((task.status === 'done' || task.status === 'error') && now - (task.updatedAt || task.createdAt) > TASK_TTL_MS) {
        await unlink(path)
        await Promise.all([
          unlink(agentProgressPath(task.id)).catch(() => {}),
          unlink(agentContextPath(task.id)).catch(() => {}),
        ])
      }
    } catch {
      // 忽略单个损坏或正在替换的任务文件。
    }
  }
}

async function recoverAgentPartialResult(task) {
  if (task.kind !== 'agent' || task.status !== 'error' || task.result) return false
  const progress = getAgentProgress(task)
  if (!progress.images.length) return false
  try {
    await Promise.all(progress.images.map((_, index) => access(agentImagePath(task.id, index))))
  } catch {
    return false
  }

  const error = task.error || '回复整理失败'
  const fallbackText = `图片已生成，但回复整理失败：${error}`
  const text = progress.text ? `${progress.text}\n\n${fallbackText}` : fallbackText
  task.result = {
    text,
    images: progress.images,
    outputItems: progress.outputItems,
    rawResponsePayload: JSON.stringify({ output: progress.outputItems }, null, 2),
  }
  task.progress = {
    ...progress,
    revision: progress.revision + 1,
    text,
    pendingImages: [],
  }
  task.status = 'done'
  task.error = null
  task.updatedAt = Date.now()
  return true
}

async function restoreTasks() {
  for (const name of await readdir(DATA_DIR)) {
    if (!name.endsWith('.json') || name.endsWith('.progress.json') || name.endsWith('.context.json')) continue
    try {
      const task = await loadTask(name.slice(0, -'.json'.length))
      if (!task) continue
      if (task.kind === 'agent' && task.status === 'done' && task.captionState && task.captionState !== 'done') {
        task.captionState = 'done'
        task.progress = {
          ...getAgentProgress(task),
          captionState: 'done',
        }
        await saveTask(task)
        continue
      }
      if (await recoverAgentPartialResult(task)) {
        await saveTask(task)
        continue
      }
      if (task.status === 'queued' || task.status === 'running') {
        task.status = 'queued'
        task.updatedAt = Date.now()
        await saveAgentContext(task)
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
    const createTask = async () => {
      if (body.clientTaskId) {
        const existing = await loadTask(body.clientTaskId)
        if (existing) {
          if (existing.kind === 'agent') throw new Error('客户端任务 ID 已被占用')
          return existing
        }
      }
      const task = {
        id: body.clientTaskId || randomUUID(),
        status: 'queued',
        prompt: body.prompt,
        params: body.params,
        profileId: body.profileId,
        model: body.model,
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
      return task
    }
    const task = body.clientTaskId
      ? await (() => {
          let creation = imageTaskCreationLocks.get(body.clientTaskId)
          if (!creation) {
            creation = createTask().finally(() => {
              if (imageTaskCreationLocks.get(body.clientTaskId) === creation) {
                imageTaskCreationLocks.delete(body.clientTaskId)
              }
            })
            imageTaskCreationLocks.set(body.clientTaskId, creation)
          }
          return creation
        })()
      : await createTask()
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
          profileId: body.profileId,
          model: body.model,
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
        await saveAgentContext(task)
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

async function handleCheckAgentAssets(req, res) {
  try {
    const body = JSON.parse(await readRequestBody(req))
    if (!Array.isArray(body?.ids) || body.ids.length > 1000) throw new Error('Agent 图片资产列表无效')
    const ids = [...new Set(body.ids)]
    if (ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) {
      throw new Error('Agent 图片资产 ID 无效')
    }
    const missing = []
    for (const id of ids) {
      try {
        await access(agentAssetPath(id))
      } catch {
        missing.push(id)
      }
    }
    json(res, 200, { missing })
  } catch (error) {
    json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } })
  }
}

async function handlePutAgentAsset(req, res, id) {
  try {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Agent 图片资产 ID 无效')
    const mime = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
    if (!/^image\/[a-z0-9.+-]+$/.test(mime)) throw new Error('Agent 图片资产格式无效')
    const data = await readRequestBuffer(req, MAX_AGENT_ASSET_BYTES)
    if (data.byteLength === 0) throw new Error('Agent 图片资产不能为空')
    const canonicalDataUrl = `data:${mime};base64,${data.toString('base64')}`
    const actualId = createHash('sha256').update(canonicalDataUrl).digest('hex')
    if (actualId !== id) throw new Error('Agent 图片资产校验失败')
    await mkdir(AGENT_ASSET_DIR, { recursive: true })
    await writeFile(agentAssetPath(id), data)
    json(res, 201, { id })
  } catch (error) {
    json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } })
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const match = url.pathname.match(/^\/api-tasks\/([a-f0-9-]+)$/i)
  const agentAssetMatch = url.pathname.match(/^\/api-agent-assets\/([a-f0-9]{64})$/)
  const agentProgressMatch = url.pathname.match(/^\/api-agent-tasks\/([A-Za-z0-9_-]+)\/progress$/)
  const agentEventsMatch = url.pathname.match(/^\/api-agent-tasks\/([A-Za-z0-9_-]+)\/events$/)
  const agentResultMatch = url.pathname.match(/^\/api-agent-tasks\/([A-Za-z0-9_-]+)\/result$/)
  const agentMatch = url.pathname.match(/^\/api-agent-tasks\/([A-Za-z0-9_-]+)$/)
  if (req.method === 'POST' && url.pathname === '/api-agent-tasks') {
    await handleCreateAgent(req, res)
    return
  }
  if (req.method === 'POST' && url.pathname === '/api-agent-assets/check') {
    await handleCheckAgentAssets(req, res)
    return
  }
  if (req.method === 'PUT' && agentAssetMatch) {
    await handlePutAgentAsset(req, res, agentAssetMatch[1])
    return
  }
  if (req.method === 'POST' && url.pathname === '/api-speech-to-text') {
    await handleSpeechToText(req, res)
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
  if (req.method === 'GET' && agentEventsMatch) {
    await handleAgentEvents(req, res, agentEventsMatch[1])
    return
  }
  const agentImageMatch = url.pathname.match(/^\/api-agent-tasks\/([A-Za-z0-9_-]+)\/images\/(\d+)$/)
  if (req.method === 'GET' && agentImageMatch) {
    await handleAgentImage(req, res, agentImageMatch[1], agentImageMatch[2])
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
    // 轮询默认只返回轻量状态；前端确认完成后再单独请求图片结果，避免恢复时阻塞在大段 base64 传输。
    json(res, 200, publicTask(task, url.searchParams.get('meta') !== '1'))
    return
  }
  json(res, 404, { error: { message: 'Not Found' } })
})

await mkdir(DATA_DIR, { recursive: true })
await mkdir(AGENT_IMAGE_DIR, { recursive: true })
await mkdir(AGENT_ASSET_DIR, { recursive: true })
await cleanupTasks()
await restoreTasks()
setInterval(() => void cleanupTasks(), 6 * 60 * 60 * 1000)
server.listen(3000, '127.0.0.1', () => console.log('Async image task server listening on 127.0.0.1:3000'))
