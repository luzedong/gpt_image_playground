import type { AgentApiResult } from './agentApi'
import type { TaskParams } from '../types'

type ServerAgentTaskResponse = {
  task_id?: string
  status?: 'queued' | 'running' | 'done' | 'error'
  error?: { message?: string } | string
  result?: AgentApiResult
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

async function fetchTask(taskId: string, signal?: AbortSignal) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30_000)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}api-agent-tasks/${encodeURIComponent(taskId)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    const payload = await readResponse(response)
    if (!response.ok) throw new Error(getErrorMessage(payload, `查询 Agent 异步任务失败：HTTP ${response.status}`))
    return payload
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abort)
  }
}

function waitForNextPoll(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, 2_000)
    const abort = () => {
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', abort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
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

  const deadline = Date.now() + 30 * 60 * 1000
  while (Date.now() < deadline) {
    const payload = await fetchTask(created.task_id, opts.signal)
    if (payload.status === 'done') return ensureResult(payload)
    if (payload.status === 'error') throw new Error(getErrorMessage(payload, '服务端 Agent 异步任务失败'))
    await waitForNextPoll(opts.signal)
  }

  throw new Error('服务端 Agent 异步任务超时，请稍后重新打开对话')
}
