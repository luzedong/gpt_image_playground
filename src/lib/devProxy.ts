import { readRuntimeEnv } from './runtimeEnv'

export interface DevProxyConfig {
  enabled: boolean
  prefix: string
  target: string
  changeOrigin: boolean
  secure: boolean
}

const DEFAULT_PROXY_PREFIX = '/api-proxy'
const MAX_1K_PIXELS = 1_572_864

export type ApiProxyRoute = 'default' | 'chat' | 'image-1k' | 'image-4k' | 'image-pixel-1k' | 'image-pixel-4k' | 'image-ailink-1k' | 'image-ailink-4k'

export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) return ''

  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  try {
    const url = new URL(input)
    if (trimmed.endsWith('/')) return `${url.origin}${url.pathname.replace(/\/+$/, '/')}`

    const pathSegments = url.pathname.split('/').filter(Boolean)
    const v1Index = pathSegments.indexOf('v1')
    const normalizedSegments = v1Index >= 0
      ? pathSegments.slice(0, v1Index + 1)
      : pathSegments.length
        ? [...pathSegments, 'v1']
        : []
    const pathname = normalizedSegments.length ? `/${normalizedSegments.join('/')}` : ''
    return `${url.origin}${pathname}`
  } catch {
    return trimmed.replace(/\/+$/, '')
  }
}

export function normalizeDevProxyConfig(input: unknown): DevProxyConfig | null {
  if (!input || typeof input !== 'object') return null

  const record = input as Record<string, unknown>
  const target = normalizeBaseUrl(typeof record.target === 'string' ? record.target : '')
  if (!target) return null

  const rawPrefix = typeof record.prefix === 'string' ? record.prefix : DEFAULT_PROXY_PREFIX
  const trimmedPrefix = rawPrefix.trim().replace(/^\/+/, '').replace(/\/+$/, '')
  const prefix = trimmedPrefix ? `/${trimmedPrefix}` : DEFAULT_PROXY_PREFIX

  return {
    enabled: Boolean(record.enabled),
    prefix,
    target,
    changeOrigin: record.changeOrigin !== false,
    secure: Boolean(record.secure),
  }
}

export function buildApiUrl(
  baseUrl: string,
  path: string,
  proxyConfig?: DevProxyConfig | null,
  useApiProxy = false,
  proxyRoute: ApiProxyRoute = 'default',
): string {
  const trimmedBaseUrl = baseUrl.trim()
  const endpointPath = path.replace(/^\/+/, '')

  if (useApiProxy) {
    const routePath = proxyRoute === 'default' ? endpointPath : `${proxyRoute}/${endpointPath}`
    return `${proxyConfig?.prefix ?? DEFAULT_PROXY_PREFIX}/${routePath}`
  }

  const normalizedBaseUrl = normalizeBaseUrl(trimmedBaseUrl)
  if (trimmedBaseUrl.endsWith('/')) {
    return `${normalizedBaseUrl.replace(/\/+$/, '')}/${endpointPath}`
  }

  const apiPath = normalizedBaseUrl.endsWith('/v1')
    ? endpointPath
    : ['v1', endpointPath].join('/')

  return normalizedBaseUrl ? `${normalizedBaseUrl}/${apiPath}` : `/${apiPath}`
}

export function resolveDevProxyConfig(input: unknown, isDev: boolean): DevProxyConfig | null {
  if (!isDev) return null
  return normalizeDevProxyConfig(input)
}

export function readClientDevProxyConfig(): DevProxyConfig | null {
  return resolveDevProxyConfig(
    typeof __DEV_PROXY_CONFIG__ === 'undefined' ? null : __DEV_PROXY_CONFIG__,
    import.meta.env.DEV,
  )
}

export function isApiProxyAvailable(proxyConfig: DevProxyConfig | null = readClientDevProxyConfig()): boolean {
  return isServerManagedApiConfigEnabled() || readRuntimeEnv(import.meta.env.VITE_API_PROXY_AVAILABLE) === 'true' || Boolean(proxyConfig?.enabled)
}

export function isServerManagedApiConfigEnabled(): boolean {
  return readRuntimeEnv(import.meta.env.VITE_SERVER_MANAGED_API_CONFIG) === 'true'
}

export function getImageApiProxyRoute(size: string, profileId = ''): ApiProxyRoute {
  if (!isServerManagedApiConfigEnabled()) return 'default'
  const match = size.match(/^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/)
  const highResolution = Boolean(match && Number(match[1]) * Number(match[2]) > MAX_1K_PIXELS)
  const provider = profileId === 'default-ailink-image' ? 'ailink' : 'pixel'
  return `image-${provider}-${highResolution ? '4k' : '1k'}` as ApiProxyRoute
}

export function isApiProxyLocked(proxyConfig: DevProxyConfig | null = readClientDevProxyConfig()): boolean {
  return readRuntimeEnv(import.meta.env.VITE_API_PROXY_LOCKED) === 'true' && isApiProxyAvailable(proxyConfig)
}

export function shouldUseApiProxy(apiProxy: boolean, proxyConfig: DevProxyConfig | null = readClientDevProxyConfig()): boolean {
  return isApiProxyAvailable(proxyConfig) && (apiProxy || isApiProxyLocked(proxyConfig))
}
