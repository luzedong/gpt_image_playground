import { describe, expect, it, vi } from 'vitest'
import {
  AWESOME_PROMPT_MANIFEST_URL,
  filterAwesomePromptCases,
  fetchAwesomePromptManifest,
  getAwesomePromptImageUrl,
  normalizeAwesomePromptManifest,
} from './awesomePromptLibrary'

const manifest = {
  repository: 'https://github.com/example/repo',
  totalCases: 2,
  categories: ['UI & Interfaces', 'Posters & Typography'],
  styles: ['UI', 'Poster'],
  scenes: ['Tech'],
  cases: [
    {
      id: 1,
      title: '城市仪表盘',
      image: '/images/case1.jpg',
      prompt: 'A precise urban dashboard',
      category: 'UI & Interfaces',
      styles: ['UI'],
      scenes: ['Tech'],
      sourceUrl: 'javascript:alert(1)',
    },
    {
      id: 2,
      title: '夏日海报',
      image: '/images/case2.jpg',
      prompt: 'A bright summer poster',
      category: 'Posters & Typography',
      styles: ['Poster'],
      scenes: ['Creative'],
    },
  ],
}

describe('awesomePromptLibrary', () => {
  it('normalizes external fields and rejects unsafe source links', () => {
    const normalized = normalizeAwesomePromptManifest(manifest)

    expect(normalized.cases).toHaveLength(2)
    expect(normalized.cases[0]?.sourceUrl).toBe('')
    expect(normalized.cases[0]?.imageAlt).toBe('城市仪表盘')
  })

  it('maps repository image paths to raw case assets', () => {
    expect(getAwesomePromptImageUrl({ id: 8, image: '/images/case8.jpg' })).toBe('https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/main/data/images/case8.jpg')
    expect(getAwesomePromptImageUrl({ id: 8, image: '/unknown/image.svg' })).toContain('/data/images/case8.jpg')
  })

  it('filters by category and searchable prompt text', () => {
    const cases = normalizeAwesomePromptManifest(manifest).cases
    expect(filterAwesomePromptCases(cases, 'dashboard')).toHaveLength(1)
    expect(filterAwesomePromptCases(cases, '', 'Posters & Typography')[0]?.id).toBe(2)
  })

  it('fetches and validates a manifest through an injected fetch implementation', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(manifest), { status: 200 }))
    const result = await fetchAwesomePromptManifest({ fetchImpl })

    expect(fetchImpl).toHaveBeenCalledWith(AWESOME_PROMPT_MANIFEST_URL, expect.objectContaining({ headers: { Accept: 'application/json' } }))
    expect(result.totalCases).toBe(2)
  })

  it('reports HTTP failures clearly', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }))

    await expect(fetchAwesomePromptManifest({ fetchImpl })).rejects.toThrow('素材库请求失败：HTTP 503')
  })

  it('aborts a request that exceeds the configured timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))

    await expect(fetchAwesomePromptManifest({ fetchImpl, timeoutMs: 5 })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
