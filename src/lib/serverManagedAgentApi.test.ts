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
      }), { status: 200 }))
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
      pollIntervalMs: 0,
    })

    expect(result.text).toBe('完成')
    expect(fetchMock).toHaveBeenCalledTimes(3)
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
      }), { status: 200 }))
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
      pollIntervalMs: 0,
    })

    expect(result.text).toBe('恢复完成')
    expect(fetchMock.mock.calls[0][0]).toBe('/api-agent-tasks')
    expect(fetchMock.mock.calls[1][0]).toBe('/api-agent-tasks/agent-task-2?meta=1')
    expect(fetchMock.mock.calls[2][0]).toBe('/api-agent-tasks/agent-task-2/result')
  })

  it('retries transient status and result failures without a client deadline', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'agent-task-3', status: 'queued' }), { status: 202 }))
      .mockResolvedValueOnce(new Response('gateway unavailable', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'agent-task-3', status: 'done' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('temporary result failure', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'agent-task-3',
        status: 'done',
        result: { text: '最终完成', images: [], outputItems: [] },
      }), { status: 200 }))

    const result = await callServerManagedAgentApi({
      taskId: 'agent-task-3',
      input: [],
      instructions: 'resume forever',
      params: DEFAULT_PARAMS,
      roundIndex: 1,
      maxToolRounds: 15,
      enableWebSearch: false,
      pollIntervalMs: 0,
    })

    expect(result.text).toBe('最终完成')
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('publishes persisted text and image-generation progress before completion', async () => {
    const progress = vi.fn()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'agent-task-4', status: 'queued' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'agent-task-4',
        status: 'running',
        progress: {
          revision: 1,
          imageRevision: 0,
          text: '我先准备生成',
          outputItems: [],
          pendingImages: [],
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'agent-task-4',
        status: 'running',
        progress: {
          revision: 2,
          imageRevision: 1,
          text: '我先准备生成',
          outputItems: [{ type: 'function_call', call_id: 'call-1', name: 'generate_image', arguments: '{"id":"cover","prompt":"一张封面"}' }],
          pendingImages: [{ toolCallId: 'call-1', prompt: '一张封面', status: 'running' }],
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'agent-task-4',
        status: 'running',
        progress: {
          revision: 2,
          imageRevision: 1,
          text: '我先准备生成',
          outputItems: [],
          pendingImages: [{ toolCallId: 'call-1', prompt: '一张封面', status: 'running' }],
          images: [{ dataUrl: 'data:image/png;base64,AAAA', toolCallId: 'call-1' }],
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'agent-task-4',
        status: 'done',
        progress: {
          revision: 3,
          imageRevision: 1,
          text: '完成',
          outputItems: [],
          pendingImages: [],
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'agent-task-4',
        status: 'done',
        result: { text: '完成', images: [], outputItems: [] },
      }), { status: 200 }))

    const result = await callServerManagedAgentApi({
      taskId: 'agent-task-4',
      input: [],
      instructions: 'progress',
      params: DEFAULT_PARAMS,
      roundIndex: 1,
      maxToolRounds: 15,
      enableWebSearch: false,
      pollIntervalMs: 0,
      onProgress: progress,
    })

    expect(result.text).toBe('完成')
    expect(progress).toHaveBeenCalledTimes(3)
    expect(progress.mock.calls[0][0].text).toBe('我先准备生成')
    expect(progress.mock.calls[1][0].pendingImages[0].status).toBe('running')
    expect(progress.mock.calls[1][0].images[0].dataUrl).toContain('data:image/png')
    expect(progress.mock.calls[2][0].text).toBe('完成')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api-agent-tasks',
      '/api-agent-tasks/agent-task-4?meta=1',
      '/api-agent-tasks/agent-task-4?meta=1',
      '/api-agent-tasks/agent-task-4/progress',
      '/api-agent-tasks/agent-task-4?meta=1',
      '/api-agent-tasks/agent-task-4/result',
    ])
  })
})
