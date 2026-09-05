import type { ApiProfile } from '../types'
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

function ensureResult(payload: ServerTaskResponse): CallApiResult {
  if (!payload.result || !Array.isArray(payload.result.images) || payload.result.images.length === 0) {
    throw new Error('服务端任务完成，但没有返回图片')
  }
  return payload.result
}

export async function callServerManagedImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  let taskId = opts.serverTaskId
  if (!taskId) {
    const response = await fetch(`${import.meta.env.BASE_URL}api-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        prompt: opts.prompt,
        params: opts.params,
        inputImages: opts.inputImageDataUrls,
        maskDataUrl: opts.maskDataUrl,
        profileId: profile.id,
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
        if (payload.result) return ensureResult(payload)
        const resultController = new AbortController()
        const resultTimeoutId = setTimeout(() => resultController.abort(), 120_000)
        try {
          const resultPayload = await fetchTask(taskId, resultController.signal, true)
          return ensureResult(resultPayload)
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
