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

function publicTask(task) {
  return {
    id: task.id,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt ?? null,
    error: task.error ?? null,
    result: task.result,
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

function normalizeTaskInput(input) {
  if (!input || typeof input !== 'object') throw new Error('任务格式无效')
  const body = input
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) throw new Error('提示词不能为空')
  const params = body.params
  if (!params || typeof params !== 'object') throw new Error('生成参数无效')
  const inputImages = Array.isArray(body.inputImages) ? body.inputImages : []
  const maskDataUrl = typeof body.maskDataUrl === 'string' && body.maskDataUrl.startsWith('data:') ? body.maskDataUrl : undefined
  const imageDataUrls = [...inputImages, ...(maskDataUrl ? [maskDataUrl] : [])]
  if (imageDataUrls.some((item) => typeof item !== 'string' || !item.startsWith('data:'))) throw new Error('输入图片格式无效')
  const inputBytes = imageDataUrls.reduce((sum, item) => sum + dataUrlByteLength(item), 0)
  if (inputBytes > MAX_INPUT_BYTES) throw new Error('输入图片总大小超过 512 MiB')

  return {
    prompt,
    params: {
      size: typeof params.size === 'string' ? params.size : 'auto',
      quality: params.quality === 'low' || params.quality === 'medium' || params.quality === 'high' ? params.quality : 'auto',
      output_format: params.output_format === 'jpeg' || params.output_format === 'webp' ? params.output_format : 'png',
      output_compression: typeof params.output_compression === 'number' && Number.isFinite(params.output_compression)
        ? Math.min(100, Math.max(0, Math.trunc(params.output_compression)))
        : null,
      moderation: params.moderation === 'low' ? 'low' : 'auto',
      n: Math.min(4, Math.max(1, Math.trunc(Number(params.n) || 1))),
      transparent_output: params.transparent_output === true,
    },
    inputImages,
    maskDataUrl,
    nativeTransparentBackground: body.nativeTransparentBackground === true,
  }
}

function is4K(size) {
  const match = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/.exec(size)
  return Boolean(match && Number(match[1]) * Number(match[2]) > MAX_1K_PIXELS)
}

function getUpstreamConfig(size) {
  const isHighResolution = is4K(size)
  return {
    baseUrl: (isHighResolution
      ? process.env.IMAGE_4K_API_URL || process.env.API_URL
      : process.env.IMAGE_1K_API_URL || process.env.API_URL || '').replace(/\/+$/, ''),
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
  const isHighResolution = is4K(task.params.size)
  const isPixel = !isHighResolution
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

async function runTask(task) {
  activeTasks.add(task.id)
  task.status = 'running'
  task.updatedAt = Date.now()
  await saveTask(task)
  try {
    task.result = await executeUpstream(task)
    task.status = 'done'
    task.error = null
  } catch (error) {
    task.status = 'error'
    task.error = error instanceof Error ? error.message : String(error)
  }
  task.inputImages = undefined
  task.maskDataUrl = undefined
  task.finishedAt = Date.now()
  task.updatedAt = task.finishedAt
  await saveTask(task)
  activeTasks.delete(task.id)
  pumpQueue()
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const match = url.pathname.match(/^\/api-tasks\/([a-f0-9-]+)$/i)
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
