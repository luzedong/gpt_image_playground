import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { callServerManagedAgentApi } from './serverManagedAgentApi'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('server managed Agent API', () => {
  it('creates a durable Agent task and reads its completed result', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'agent-task-1', status: 'queued' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'agent-task-1',
        status: 'done',
        result: { text: '完成', images: [], outputItems: [{ type: 'message' }] },
      }), { status: 200 }))

    const result = await callServerManagedAgentApi({
      taskId: 'agent-task-1',
      input: [{ role: 'user', content: '生成一张图' }],
      instructions: 'use the image tool',
      params: DEFAULT_PARAMS,
      roundIndex: 1,
      maxToolRounds: 15,
      enableWebSearch: false,
    })

    expect(result.text).toBe('完成')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      task_id: 'agent-task-1',
      round_index: 1,
      max_tool_rounds: 15,
      enable_web_search: false,
    })
  })

  it('reuses the same task ID after the page is reopened', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'agent-task-2', status: 'done' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'agent-task-2',
        status: 'done',
        result: { text: '恢复完成', images: [], outputItems: [] },
      }), { status: 200 }))

    const result = await callServerManagedAgentApi({
      taskId: 'agent-task-2',
      input: [],
      instructions: 'resume',
      params: DEFAULT_PARAMS,
      roundIndex: 2,
      maxToolRounds: 15,
      enableWebSearch: false,
    })

    expect(result.text).toBe('恢复完成')
    expect(fetchMock.mock.calls[0][0]).toBe('/api-agent-tasks')
    expect(fetchMock.mock.calls[1][0]).toBe('/api-agent-tasks/agent-task-2')
  })
})
