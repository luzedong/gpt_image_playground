import type { ApiProfile } from '../types'
import { normalizeImageDataUrlForApi } from './canvasImage'
import { blobToDataUrl } from './dataUrl'
import type { CallApiOptions, CallApiResult } from './imageApiShared'

type ServerTaskResponse = {
  task_id?: string
  status?: 'queued' | 'running' | 'done' | 'error'
  error?: { message?: string } | string
  result?: CallApiResult
}

function getErrorMessage(payload: ServerTaskResponse, fallback: string) {
  if (typeof payload.error === 'string') return payload.error
  if (payload.error?.message) return payload.error.message
  return fallback
}

async function readResponse(response: Response): Promise<ServerTaskResponse> {
  try {
    return await response.json() as ServerTaskResponse
  } catch {
    return {}
  }
}

async function fetchTask(taskId: string, signal: AbortSignal, includeResult = false) {
  const query = includeResult ? '' : '?meta=1'
  const response = await fetch(`${import.meta.env.BASE_URL}api-tasks/${encodeURIComponent(taskId)}${query}`, {
    cache: 'no-store',
    signal,
  })
  const payload = await readResponse(response)
  if (!response.ok) throw new Error(getErrorMessage(payload, `查询异步任务失败：HTTP ${response.status}`))
  return payload
}

async function ensureResult(payload: ServerTaskResponse, signal?: AbortSignal): Promise<CallApiResult> {
  const result = payload.result
  if (!result || !Array.isArray(result.images) || result.images.length === 0) {
    throw new Error('服务端任务完成，但没有返回图片')
  }
  // 服务端现在只回图片 URL，这里按需下载成 dataURL（少传 33% 的 base64，且不用解析大 JSON）。
  // 旧版服务端直接返回 dataURL 字符串，保留兼容。
  const first = (result.images as unknown[])[0]
  if (typeof first === 'string') return result
  const images = await Promise.all((result.images as unknown[]).map(async (item) => {
    const imageUrl = typeof item === 'object' && item !== null ? (item as { imageUrl?: string }).imageUrl : ''
    if (!imageUrl) throw new Error('服务端任务完成，但没有返回图片')
    const response = await fetch(`${import.meta.env.BASE_URL}${imageUrl.replace(/^\//, '')}`, { cache: 'no-store', signal })
    if (!response.ok) throw new Error(`下载生成图片失败：HTTP ${response.status}`)
    return blobToDataUrl(await response.blob(), 'image/png')
  }))
  return { ...result, images }
}

export async function callServerManagedImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  let taskId = opts.serverTaskId
  if (!taskId) {
    const inputImages = await Promise.all(opts.inputImageDataUrls.map((dataUrl) => normalizeImageDataUrlForApi(dataUrl)))
    const response = await fetch(`${import.meta.env.BASE_URL}api-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        prompt: opts.prompt,
        params: opts.params,
        inputImages,
        maskDataUrl: opts.maskDataUrl,
        profileId: profile.id,
        model: profile.model,
        client_task_id: opts.clientTaskId,
      }),
    })
    const payload = await readResponse(response)
    if (!response.ok || !payload.task_id) {
      throw new Error(getErrorMessage(payload, `创建异步任务失败：HTTP ${response.status}`))
    }
    taskId = payload.task_id
    await opts.onServerTaskEnqueued?.({ taskId })
  }

  const deadline = Date.now() + Math.max(30 * 60 * 1000, profile.timeout * 1000 + 60_000)
  while (Date.now() < deadline) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 30_000)
    try {
      const payload = await fetchTask(taskId, controller.signal)
      if (payload.status) opts.onServerTaskStatus?.(payload.status)
      if (payload.status === 'done') {
        // 兼容尚未更新的服务端：旧接口会在状态响应中直接带 result。
        if (payload.result) return await ensureResult(payload, opts.signal)
        const resultController = new AbortController()
        const resultTimeoutId = setTimeout(() => resultController.abort(), 120_000)
        try {
          const resultPayload = await fetchTask(taskId, resultController.signal, true)
          return await ensureResult(resultPayload, opts.signal)
        } finally {
          clearTimeout(resultTimeoutId)
        }
      }
      if (payload.status === 'error') throw new Error(getErrorMessage(payload, '服务端异步生图失败'))
    } finally {
      clearTimeout(timeoutId)
    }
    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>
      const cleanup = () => opts.signal?.removeEventListener('abort', abort)
      const abort = () => {
        clearTimeout(timeout)
        cleanup()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      timeout = setTimeout(() => {
        cleanup()
        resolve()
      }, 2_000)
      opts.signal?.addEventListener('abort', abort, { once: true })
    })
  }
  throw new Error('服务端异步生图超时，请稍后在任务列表中重试')
}
