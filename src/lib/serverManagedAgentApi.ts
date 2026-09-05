import type { AgentApiResult } from './agentApi'
import type { TaskParams } from '../types'

export interface ServerAgentPendingImage {
  toolCallId: string
  batchCallId?: string
  batchItemId?: string
  prompt: string
  status: 'running' | 'error'
  error?: string
}

export interface ServerAgentTaskProgress {
  revision: number
  imageRevision: number
  text: string
  outputItems: AgentApiResult['outputItems']
  pendingImages: ServerAgentPendingImage[]
  images?: AgentApiResult['images']
}

type ServerAgentTaskResponse = {
  task_id?: string
  status?: 'queued' | 'running' | 'done' | 'error'
  error?: { message?: string } | string
  progress?: ServerAgentTaskProgress
  result?: AgentApiResult
}

class ServerAgentTaskRequestError extends Error {
  retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'ServerAgentTaskRequestError'
    this.retryable = retryable
  }
}

function getErrorMessage(payload: ServerAgentTaskResponse, fallback: string) {
  if (typeof payload.error === 'string') return payload.error
  if (payload.error?.message) return payload.error.message
  return fallback
}

async function readResponse(response: Response): Promise<ServerAgentTaskResponse> {
  try {
    return await response.json() as ServerAgentTaskResponse
  } catch {
    return {}
  }
}

async function fetchTask(taskId: string, signal: AbortSignal | undefined, path: string) {
  const controller = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, 30_000)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}api-agent-tasks/${encodeURIComponent(taskId)}${path}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    const payload = await readResponse(response)
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
      throw new ServerAgentTaskRequestError(getErrorMessage(payload, `查询 Agent 异步任务失败：HTTP ${response.status}`), retryable)
    }
    if (!payload.status) throw new ServerAgentTaskRequestError('服务端 Agent 任务状态响应无效', true)
    return payload
  } catch (err) {
    if (timedOut && !signal?.aborted) throw new ServerAgentTaskRequestError('查询 Agent 异步任务超时，稍后重试', true)
    throw err
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abort)
  }
}

function waitForNextPoll(signal: AbortSignal | undefined, delayMs: number) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, delayMs)
    const abort = () => {
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', abort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function isRetryableTaskRequestError(err: unknown) {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return false
  if (err instanceof ServerAgentTaskRequestError) return err.retryable
  if (err instanceof TypeError) return /fetch|network|load failed|networkerror/i.test(err.message)
  return false
}

function getRetryDelay(attempt: number, baseDelayMs: number) {
  return Math.min(15_000, baseDelayMs * 2 ** Math.min(attempt, 3))
}

function ensureResult(payload: ServerAgentTaskResponse): AgentApiResult {
  if (!payload.result || !Array.isArray(payload.result.outputItems)) {
    throw new Error('服务端 Agent 任务完成，但没有返回有效响应')
  }
  return payload.result
}

export async function callServerManagedAgentApi(opts: {
  taskId: string
  input: unknown[]
  instructions: string
  params: TaskParams
  roundIndex: number
  maxToolRounds: number
  enableWebSearch: boolean
  signal?: AbortSignal
  pollIntervalMs?: number
  onProgress?: (progress: ServerAgentTaskProgress) => void | Promise<void>
}): Promise<AgentApiResult> {
  const response = await fetch(`${import.meta.env.BASE_URL}api-agent-tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      task_id: opts.taskId,
      input: opts.input,
      instructions: opts.instructions,
      params: opts.params,
      round_index: opts.roundIndex,
      max_tool_rounds: opts.maxToolRounds,
      enable_web_search: opts.enableWebSearch,
    }),
    signal: opts.signal,
  })
  const created = await readResponse(response)
  if (!response.ok || !created.task_id) {
    throw new Error(getErrorMessage(created, `创建 Agent 异步任务失败：HTTP ${response.status}`))
  }

  const baseDelayMs = Math.max(0, opts.pollIntervalMs ?? 800)
  let retryAttempt = 0
  let progressRevision = 0
  let imageRevision = 0

  const publishProgress = async (payload: ServerAgentTaskResponse) => {
    const progress = payload.progress
    if (!progress || progress.revision <= progressRevision) return

    if (progress.imageRevision > imageRevision) {
      const imagePayload = await fetchTask(created.task_id!, opts.signal, '/progress')
      if (imagePayload.progress) {
        progressRevision = imagePayload.progress.revision
        imageRevision = imagePayload.progress.imageRevision
        await opts.onProgress?.(imagePayload.progress)
        return
      }
    }

    progressRevision = progress.revision
    imageRevision = progress.imageRevision
    await opts.onProgress?.(progress)
  }

  while (true) {
    try {
      const payload = await fetchTask(created.task_id, opts.signal, '?meta=1')
      retryAttempt = 0
      await publishProgress(payload)
      if (payload.status === 'done') {
        let resultRetryAttempt = 0
        while (true) {
          try {
            const resultPayload = await fetchTask(created.task_id, opts.signal, '/result')
            return ensureResult(resultPayload)
          } catch (err) {
            if (!isRetryableTaskRequestError(err)) throw err
            await waitForNextPoll(opts.signal, getRetryDelay(resultRetryAttempt, baseDelayMs))
            resultRetryAttempt += 1
          }
        }
      }
      if (payload.status === 'error') throw new Error(getErrorMessage(payload, '服务端 Agent 异步任务失败'))
      await waitForNextPoll(opts.signal, baseDelayMs)
    } catch (err) {
      if (!isRetryableTaskRequestError(err)) throw err
      await waitForNextPoll(opts.signal, getRetryDelay(retryAttempt, baseDelayMs))
      retryAttempt += 1
    }
  }
}
