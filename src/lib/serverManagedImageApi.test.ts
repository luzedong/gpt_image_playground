import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { callServerManagedImageApi } from './serverManagedImageApi'

afterEach(() => {
  vi.restoreAllMocks()
})

const profile = {
  id: 'default-openai',
  name: 'Pixel API',
  provider: 'openai' as const,
  baseUrl: '',
  apiKey: '',
  model: 'gpt-image-2',
  timeout: 600,
  apiMode: 'images' as const,
  codexCli: false,
  apiProxy: true,
  transparentBackgroundMethod: 'api' as const,
}

describe('server managed image API', () => {
  it('creates a server task and reads its completed result', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-1', status: 'queued' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'task-1',
        status: 'done',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'task-1',
        status: 'done',
        result: { images: ['data:image/png;base64,AAAA'] },
      }), { status: 200 }))
    const enqueued = vi.fn()

    const result = await callServerManagedImageApi({
      settings: {} as never,
      prompt: '一只猫',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [],
      onServerTaskEnqueued: enqueued,
    }, profile)

    expect(result.images).toEqual(['data:image/png;base64,AAAA'])
    expect(enqueued).toHaveBeenCalledWith({ taskId: 'task-1' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1][0]).toBe('/api-tasks/task-1?meta=1')
    expect(fetchMock.mock.calls[2][0]).toBe('/api-tasks/task-1')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      prompt: '一只猫',
      inputImages: [],
    })
  })

  it('continues polling an existing task after the browser reloads', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'task-2',
      status: 'done',
    }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'task-2',
      status: 'done',
      result: { images: ['data:image/png;base64,BBBB'] },
    }), { status: 200 }))

    const result = await callServerManagedImageApi({
      settings: {} as never,
      prompt: 'ignored',
      params: DEFAULT_PARAMS,
      inputImageDataUrls: [],
      serverTaskId: 'task-2',
    }, profile)

    expect(result.images).toEqual(['data:image/png;base64,BBBB'])
  })
})
