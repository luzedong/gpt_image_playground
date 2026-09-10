import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { callServerManagedAgentApi } from './serverManagedAgentApi'

afterEach(() => {
  vi.restoreAllMocks()
})

async function sha256Id(dataUrl: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dataUrl))
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

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
      imageProfileId: 'default-ailink-image',
      imageModel: 'test-image-model',
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
      image_profile_id: 'default-ailink-image',
      image_model: 'test-image-model',
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
      '/api-agent-tasks/agent-task-4/events',
      '/api-agent-tasks/agent-task-4?meta=1',
      '/api-agent-tasks/agent-task-4?meta=1',
      '/api-agent-tasks/agent-task-4/result',
    ])
  })

  it('returns the persisted upstream error after an event stream reports failure', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'agent-task-5', status: 'queued' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'agent-task-5', status: 'running' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('event: progress\ndata: {"id":"agent-task-5","status":"error","error":"Concurrency limit exceeded"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'agent-task-5',
        status: 'error',
        error: 'Concurrency limit exceeded',
      }), { status: 200 }))

    await expect(callServerManagedAgentApi({
      taskId: 'agent-task-5',
      input: [],
      instructions: 'show upstream error',
      params: DEFAULT_PARAMS,
      roundIndex: 1,
      maxToolRounds: 15,
      enableWebSearch: true,
      pollIntervalMs: 0,
    })).rejects.toThrow('Concurrency limit exceeded')
  })

  it('uploads missing reference assets once and sends only asset IDs', async () => {
    const dataUrl = `data:image/png;base64,${btoa('reference-image')}`
    const assetId = await sha256Id(dataUrl)
    const input = [{ type: 'input_image', image_url: dataUrl }]
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ missing: [assetId] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: assetId }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'asset-task-1', status: 'done' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'asset-task-1', status: 'done' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'asset-task-1',
        status: 'done',
        result: { text: '完成', images: [], outputItems: [] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'asset-task-2', status: 'done' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'asset-task-2', status: 'done' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'asset-task-2',
        status: 'done',
        result: { text: '复用完成', images: [], outputItems: [] },
      }), { status: 200 }))

    const call = (taskId: string, text: string) => callServerManagedAgentApi({
      taskId,
      input,
      instructions: 'reuse asset',
      params: DEFAULT_PARAMS,
      roundIndex: 1,
      maxToolRounds: 15,
      enableWebSearch: false,
      pollIntervalMs: 0,
    }).then((result) => expect(result.text).toBe(text))

    await call('asset-task-1', '完成')
    await call('asset-task-2', '复用完成')

    expect(fetchMock.mock.calls[0][0]).toBe('/api-agent-assets/check')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ ids: [assetId] })
    expect(fetchMock.mock.calls[1][0]).toBe(`/api-agent-assets/${assetId}`)
    const firstTaskBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body))
    expect(firstTaskBody.input).toEqual([{ type: 'input_image', image_asset_id: assetId, image_mime: 'image/png' }])
    expect(JSON.stringify(firstTaskBody)).not.toContain(dataUrl)
    expect(fetchMock).toHaveBeenCalledTimes(8)
    expect(fetchMock.mock.calls.slice(5).map(([url]) => url)).not.toContain(`/api-agent-assets/${assetId}`)
  })

  it('keeps original reference input when the asset endpoint is unavailable', async () => {
    const dataUrl = `data:image/jpeg;base64,${btoa('legacy-reference')}`
    const input = [{ type: 'input_image', image_url: dataUrl }]
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'asset-task-3', status: 'done' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'asset-task-3', status: 'done' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'asset-task-3',
        status: 'done',
        result: { text: '兼容完成', images: [], outputItems: [] },
      }), { status: 200 }))

    const result = await callServerManagedAgentApi({
      taskId: 'asset-task-3',
      input,
      instructions: 'legacy compatibility',
      params: DEFAULT_PARAMS,
      roundIndex: 1,
      maxToolRounds: 15,
      enableWebSearch: false,
      pollIntervalMs: 0,
    })

    expect(result.text).toBe('兼容完成')
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body)).input).toEqual(input)
  })

  it('reconstructs appended SSE text deltas before completion', async () => {
    const progress = vi.fn()
    const eventStream = [
      'event: progress',
      `data: ${JSON.stringify({ id: 'delta-task', status: 'running', progress_delta: { revision: 2, text_delta: 'B' } })}`,
      '',
      'event: progress',
      `data: ${JSON.stringify({
        id: 'delta-task',
        status: 'done',
        progress: { revision: 3, imageRevision: 0, text: 'ABC', outputItems: [], pendingImages: [] },
      })}`,
      '',
    ].join('\n')
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'delta-task', status: 'running' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'delta-task',
        status: 'running',
        progress: { revision: 1, imageRevision: 0, text: 'A', outputItems: [], pendingImages: [] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(eventStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'delta-task',
        status: 'done',
        result: { text: 'ABC', images: [], outputItems: [] },
      }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({
        id: 'delta-task',
        status: 'done',
        result: { text: 'ABC', images: [], outputItems: [] },
      }), { status: 200 }))

    const result = await callServerManagedAgentApi({
      taskId: 'delta-task',
      input: [],
      instructions: 'delta',
      params: DEFAULT_PARAMS,
      roundIndex: 1,
      maxToolRounds: 15,
      enableWebSearch: false,
      pollIntervalMs: 0,
      onProgress: progress,
    })

    expect(result.text).toBe('ABC')
    expect(progress.mock.calls.map(([item]) => item.text)).toEqual(['A', 'AB'])
  })
})
