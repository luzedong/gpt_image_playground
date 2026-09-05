export const AWESOME_PROMPT_REPOSITORY = 'https://github.com/freestylefly/awesome-gpt-image-2'
export const AWESOME_PROMPT_LIBRARY_BASE = `${import.meta.env.BASE_URL}prompt-library`.replace(/\/$/, '')
export const AWESOME_PROMPT_MANIFEST_URL = `${AWESOME_PROMPT_LIBRARY_BASE}/cases.json`
export const AWESOME_PROMPT_DISCLAIMER_URL = `${AWESOME_PROMPT_LIBRARY_BASE}/disclaimer.md`

export interface AwesomePromptCase {
  id: number
  title: string
  image: string
  imageAlt: string
  sourceLabel: string
  sourceUrl: string
  prompt: string
  promptOriginal?: string
  promptPreview: string
  category: string
  styles: string[]
  scenes: string[]
  featured: boolean
  githubUrl: string
}

export interface AwesomePromptManifest {
  repository: string
  totalCases: number
  categories: string[]
  styles: string[]
  scenes: string[]
  cases: AwesomePromptCase[]
}

export interface AwesomePromptLibraryOptions {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  manifestUrl?: string
  timeoutMs?: number
}

let manifestPromise: Promise<AwesomePromptManifest> | null = null
const AWESOME_PROMPT_MANIFEST_CACHE_KEY = 'gpt-image-playground:prompt-library-manifest'
const AWESOME_PROMPT_FAVORITES_KEY = 'gpt-image-playground:prompt-library-favorites'

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
}

function asPositiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value)
}

function normalizeCase(value: unknown): AwesomePromptCase | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const id = asPositiveNumber(item.id)
  const title = asString(item.title)
  const prompt = asString(item.prompt)
  const image = asString(item.image)
  if (!id || !title || !prompt || !image) return null

  const sourceUrl = asString(item.sourceUrl)
  const githubUrl = asString(item.githubUrl)
  const promptOriginal = asString(item.promptOriginal)
  return {
    id,
    title,
    image,
    imageAlt: asString(item.imageAlt, title),
    sourceLabel: asString(item.sourceLabel, '公开案例'),
    sourceUrl: isHttpUrl(sourceUrl) ? sourceUrl : '',
    prompt,
    ...(promptOriginal ? { promptOriginal } : {}),
    promptPreview: asString(item.promptPreview, prompt.replace(/\s+/g, ' ').slice(0, 220)),
    category: asString(item.category, '其他应用场景'),
    styles: asStringArray(item.styles),
    scenes: asStringArray(item.scenes),
    featured: item.featured === true,
    githubUrl: isHttpUrl(githubUrl) ? githubUrl : `${AWESOME_PROMPT_REPOSITORY}/tree/main`,
  }
}

export function normalizeAwesomePromptManifest(value: unknown): AwesomePromptManifest {
  if (!value || typeof value !== 'object') throw new Error('素材库清单格式无效')
  const source = value as Record<string, unknown>
  const cases = Array.isArray(source.cases)
    ? source.cases.map(normalizeCase).filter((item): item is AwesomePromptCase => Boolean(item))
    : []
  if (!cases.length) throw new Error('素材库清单没有可用案例')

  return {
    repository: isHttpUrl(asString(source.repository)) ? asString(source.repository) : AWESOME_PROMPT_REPOSITORY,
    totalCases: asPositiveNumber(source.totalCases) || cases.length,
    categories: asStringArray(source.categories),
    styles: asStringArray(source.styles),
    scenes: asStringArray(source.scenes),
    cases,
  }
}

export function getAwesomePromptImageUrl(item: Pick<AwesomePromptCase, 'id' | 'image'>) {
  const path = item.image.replace(/^\/+/, '')
  const fileName = path.split('/').pop() || `case${item.id}.jpg`
  if (!/^case\d+\.(?:jpe?g|png|webp)$/i.test(fileName)) return `${AWESOME_PROMPT_LIBRARY_BASE}/images/case${item.id}.jpg`
  return `${AWESOME_PROMPT_LIBRARY_BASE}/images/${fileName}`
}

export function filterAwesomePromptCases(cases: AwesomePromptCase[], query: string, category = 'all') {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return cases.filter((item) => {
    if (category !== 'all' && item.category !== category) return false
    if (!normalizedQuery) return true
    const searchable = [item.title, item.prompt, item.promptOriginal, item.promptPreview, item.category, ...item.styles, ...item.scenes].filter(Boolean).join(' ').toLocaleLowerCase()
    return searchable.includes(normalizedQuery)
  })
}

export function clearAwesomePromptManifestCache() {
  manifestPromise = null
}

export function readAwesomePromptManifestCache() {
  try {
    const value = window.localStorage.getItem(AWESOME_PROMPT_MANIFEST_CACHE_KEY)
    if (!value) return null
    return normalizeAwesomePromptManifest(JSON.parse(value))
  } catch {
    return null
  }
}

export function writeAwesomePromptManifestCache(manifest: AwesomePromptManifest) {
  try {
    window.localStorage.setItem(AWESOME_PROMPT_MANIFEST_CACHE_KEY, JSON.stringify(manifest))
  } catch {
    // 存储空间不足或隐私模式禁用时，仍可正常使用网络素材库。
  }
}

export function readAwesomePromptFavoriteIds(): number[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(AWESOME_PROMPT_FAVORITES_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter((id): id is number => Number.isInteger(id) && id > 0)
  } catch {
    return []
  }
}

export function writeAwesomePromptFavoriteIds(ids: number[]) {
  try {
    window.localStorage.setItem(AWESOME_PROMPT_FAVORITES_KEY, JSON.stringify([...new Set(ids)].sort((a, b) => a - b)))
  } catch {
    // 某些隐私模式下 localStorage 不可用，不影响素材库使用。
  }
}

export async function fetchAwesomePromptManifest(options: AwesomePromptLibraryOptions = {}) {
  if (!options.fetchImpl && !options.manifestUrl && manifestPromise) return manifestPromise

  const fetchImpl = options.fetchImpl ?? fetch
  const request = async () => {
    const controller = new AbortController()
    const timeout = globalThis.setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
    const abort = () => controller.abort()
    if (options.signal?.aborted) controller.abort()
    else options.signal?.addEventListener('abort', abort, { once: true })

    try {
      const response = await fetchImpl(options.manifestUrl ?? AWESOME_PROMPT_MANIFEST_URL, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`素材库请求失败：HTTP ${response.status}`)
      return normalizeAwesomePromptManifest(await response.json())
    } finally {
      globalThis.clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
    }
  }

  if (options.fetchImpl || options.manifestUrl) return request()
  manifestPromise = request()
  try {
    return await manifestPromise
  } catch (error) {
    manifestPromise = null
    throw error
  }
}
