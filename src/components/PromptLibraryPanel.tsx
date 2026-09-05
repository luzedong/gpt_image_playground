import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AWESOME_PROMPT_DISCLAIMER_URL,
  AWESOME_PROMPT_REPOSITORY,
  clearAwesomePromptManifestCache,
  fetchAwesomePromptManifest,
  filterAwesomePromptCases,
  getAwesomePromptImageUrl,
  readAwesomePromptManifestCache,
  writeAwesomePromptManifestCache,
  type AwesomePromptCase,
  type AwesomePromptManifest,
} from '../lib/awesomePromptLibrary'

interface PromptLibraryPanelProps {
  canImportImage: boolean
  importingId: number | null
  onImportImage: (item: AwesomePromptCase) => void
  onUsePrompt: (item: AwesomePromptCase) => void
}

const PAGE_SIZE = 18
const PROMPT_LIBRARY_VISIBLE_COUNT_KEY = 'gpt-image-playground:prompt-library-visible-count'

function readVisibleCount() {
  try {
    const value = Number(window.localStorage.getItem(PROMPT_LIBRARY_VISIBLE_COUNT_KEY))
    return Number.isInteger(value) && value >= PAGE_SIZE ? value : PAGE_SIZE
  } catch {
    return PAGE_SIZE
  }
}

function writeVisibleCount(value: number) {
  try {
    window.localStorage.setItem(PROMPT_LIBRARY_VISIBLE_COUNT_KEY, String(value))
  } catch {
    // 某些隐私模式下 localStorage 不可用，不影响素材库使用。
  }
}

function LibraryIcon({ type, className = 'h-4 w-4' }: { type: 'search' | 'refresh' | 'download' | 'external' | 'sparkles' | 'close' | 'eye'; className?: string }) {
  const paths = {
    search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
    refresh: <><path d="M20 11a8 8 0 0 0-14.9-4L3 10" /><path d="M3 4v6h6" /><path d="M4 13a8 8 0 0 0 14.9 4L21 14" /><path d="M21 20v-6h-6" /></>,
    download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 20h16" /></>,
    external: <><path d="M14 4h6v6" /><path d="m20 4-9 9" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>,
    sparkles: <><path d="m12 3-1.2 3.2L7.5 7.5l3.3 1.3L12 12l1.2-3.2 3.3-1.3-3.3-1.3L12 3Z" /><path d="m5 13-.8 2.2L2 16l2.2.8L5 19l.8-2.2L5 13Z" /></>,
    close: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>,
    eye: <><path d="M2.5 12s3.5-5 9.5-5 9.5 5 9.5 5-3.5 5-9.5 5-9.5-5-9.5-5Z" /><circle cx="12" cy="12" r="2.5" /></>,
  }

  return <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">{paths[type]}</svg>
}

function LibrarySkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2" aria-label="正在加载素材库" aria-busy="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50 dark:border-white/[0.06] dark:bg-white/[0.02]">
          <div className="aspect-[4/3] animate-pulse bg-gray-200 dark:bg-white/[0.06]" />
          <div className="space-y-2 p-2.5">
            <div className="h-3 animate-pulse rounded bg-gray-200 dark:bg-white/[0.06]" />
            <div className="h-2.5 w-2/3 animate-pulse rounded bg-gray-100 dark:bg-white/[0.04]" />
          </div>
        </div>
      ))}
    </div>
  )
}

function PromptCaseCard({
  item,
  canImportImage,
  importing,
  onImportImage,
  onUsePrompt,
  onOpenDetails,
}: {
  item: AwesomePromptCase
  canImportImage: boolean
  importing: boolean
  onImportImage: () => void
  onUsePrompt: () => void
  onOpenDetails: () => void
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const imageUrl = getAwesomePromptImageUrl(item)

  return (
    <article className="group overflow-hidden rounded-xl border border-gray-200/80 bg-white transition duration-200 hover:border-violet-300 hover:shadow-md dark:border-white/[0.07] dark:bg-[#0d1015] dark:hover:border-violet-400/30 dark:hover:bg-[#111621]">
      <button type="button" onClick={onOpenDetails} className="relative block aspect-[4/3] w-full overflow-hidden bg-gray-100 text-left dark:bg-[#171c27] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-violet-400/70" aria-label={`查看「${item.title}」详情`} title="查看详情">
        {imageFailed ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-[10px] text-gray-500 dark:text-gray-600">
            <LibraryIcon type="sparkles" className="h-5 w-5 text-gray-400 dark:text-gray-700" />
            <span>预览暂不可用</span>
          </div>
        ) : (
          <img
            src={imageUrl}
            alt={item.imageAlt}
            loading="lazy"
            decoding="async"
            width="320"
            height="240"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
            onError={() => setImageFailed(true)}
          />
        )}
        {item.featured && <span className="absolute left-2 top-2 rounded-md bg-violet-600/90 px-1.5 py-1 text-[9px] font-semibold text-white shadow-lg">精选</span>}
        <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-1.5 py-1 font-mono text-[9px] text-gray-300 backdrop-blur-sm">#{item.id}</span>
        <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-1 text-[9px] text-white opacity-0 backdrop-blur-sm transition group-hover:opacity-100 group-focus-within:opacity-100"><LibraryIcon type="eye" className="h-3 w-3" />查看详情</span>
      </button>
      <div className="p-2.5">
        <h3 className="line-clamp-2 min-h-8 text-[11px] font-semibold leading-4 text-gray-800 dark:text-gray-200" title={item.title}>{item.title}</h3>
        <p className="mt-1.5 line-clamp-2 min-h-8 text-[10px] leading-4 text-gray-500 dark:text-gray-500" title={item.promptPreview}>{item.promptPreview}</p>
        <div className="mt-2 flex min-h-4 flex-wrap gap-1">
          <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[9px] text-violet-300">{item.category}</span>
          {item.styles.slice(0, 1).map((style) => <span key={style} className="rounded bg-gray-100 px-1.5 py-0.5 text-[9px] text-gray-500 dark:bg-white/[0.05]">{style}</span>)}
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-1.5">
          <button type="button" onClick={onUsePrompt} className="flex h-11 w-full items-center justify-center gap-1 rounded-lg bg-violet-600/90 px-1 text-[10px] font-semibold text-white transition hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-400/60" title="将完整 Prompt 填入输入框">
            <LibraryIcon type="sparkles" className="h-3.5 w-3.5" />填入 Prompt
          </button>
          <button type="button" onClick={onImportImage} disabled={!canImportImage || importing || imageFailed} className="flex h-11 w-full items-center justify-center gap-1 rounded-lg border border-cyan-200 bg-cyan-50 px-1 text-[10px] font-medium text-cyan-700 transition hover:bg-cyan-100 focus:outline-none focus:ring-2 focus:ring-cyan-400/60 disabled:cursor-not-allowed disabled:opacity-40 dark:border-cyan-400/15 dark:bg-cyan-500/[0.06] dark:text-cyan-200 dark:hover:bg-cyan-500/[0.12]" title={canImportImage ? '下载单张案例图并加入当前编辑素材' : '参考图数量已达上限'}>
            <LibraryIcon type="download" className="h-3.5 w-3.5" />{importing ? '导入中…' : canImportImage ? '导入为参考图' : '素材已满'}
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-[9px] text-gray-500 dark:text-gray-600">
          <span className="truncate" title={item.sourceLabel}>来源：{item.sourceLabel}</span>
          <a href={item.sourceUrl || item.githubUrl} target="_blank" rel="noopener noreferrer" className="flex h-11 shrink-0 items-center gap-1 rounded-md px-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.05] dark:hover:text-gray-300" aria-label={`打开「${item.title}」来源`}>
            <LibraryIcon type="external" className="h-3 w-3" />来源
          </a>
        </div>
      </div>
    </article>
  )
}

export default function PromptLibraryPanel({ canImportImage, importingId, onImportImage, onUsePrompt }: PromptLibraryPanelProps) {
  const [manifest, setManifest] = useState<AwesomePromptManifest | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [visibleCount, setVisibleCount] = useState(readVisibleCount)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedCase, setSelectedCase] = useState<AwesomePromptCase | null>(null)
  const filterInitialized = useRef(false)

  useEffect(() => {
    if (!selectedCase) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedCase(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedCase])

  const loadManifest = useCallback(async () => {
    const cachedManifest = readAwesomePromptManifestCache()
    if (cachedManifest) {
      setManifest(cachedManifest)
      setLoading(false)
    } else {
      setLoading(true)
    }
    setError('')
    try {
      const nextManifest = await fetchAwesomePromptManifest()
      setManifest(nextManifest)
      writeAwesomePromptManifestCache(nextManifest)
    } catch (err) {
      setError(err instanceof DOMException && err.name === 'AbortError' ? '素材请求超时，请刷新页面或检查部署资源' : err instanceof Error ? err.message : '素材库加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadManifest()
  }, [loadManifest])

  const filteredCases = useMemo(
    () => manifest ? filterAwesomePromptCases(manifest.cases, query, category) : [],
    [category, manifest, query],
  )
  const visibleCases = filteredCases.slice(0, visibleCount)
  const categories = manifest?.categories ?? []

  useEffect(() => {
    if (!filterInitialized.current) {
      filterInitialized.current = true
      return
    }
    setVisibleCount(PAGE_SIZE)
    writeVisibleCount(PAGE_SIZE)
  }, [category, query])

  useEffect(() => {
    writeVisibleCount(visibleCount)
  }, [visibleCount])

  return (
    <div className="space-y-3" data-prompt-library>
      <div className="rounded-xl border border-violet-200 bg-violet-50/80 p-3 dark:border-violet-400/15 dark:bg-violet-500/[0.06]">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300"><LibraryIcon type="sparkles" className="h-4 w-4" /></span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-violet-900 dark:text-violet-100">GPT-Image Prompt 灵感库</p>
            <p className="mt-1 text-[10px] leading-4 text-violet-800/70 dark:text-violet-200/60">案例清单与图片由本站提供。使用 Prompt 可直接开始创作，导入图片会读取单张参考图。</p>
          </div>
        </div>
        <p className="mt-2 text-[9px] leading-4 text-gray-500 dark:text-gray-500">案例来自公开社区，仅作灵感预览；请保留来源并遵守<a href={AWESOME_PROMPT_DISCLAIMER_URL} target="_blank" rel="noopener noreferrer" className="ml-1 text-gray-600 underline decoration-gray-400 underline-offset-2 hover:text-gray-900 dark:text-gray-400 dark:decoration-gray-600 dark:hover:text-gray-200">上游免责声明</a>。</p>
      </div>

      <label className="relative block">
        <span className="sr-only">搜索 Prompt 案例</span>
        <LibraryIcon type="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-600" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、风格或 Prompt" className="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 pl-9 pr-3 text-xs text-gray-800 outline-none transition placeholder:text-gray-400 focus:border-violet-400/70 focus:bg-white focus:ring-2 focus:ring-violet-500/10 dark:border-white/[0.08] dark:bg-[#0d1015] dark:text-gray-200 dark:placeholder:text-gray-700 dark:focus:bg-[#0d1015]" />
      </label>

      <div className="flex gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">筛选案例分类</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)} disabled={!manifest} className="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 text-xs text-gray-700 outline-none transition focus:border-violet-400/70 focus:bg-white disabled:opacity-50 dark:border-white/[0.08] dark:bg-[#0d1015] dark:text-gray-300 dark:focus:bg-[#0d1015]">
            <option value="all">全部分类</option>
            {categories.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => { clearAwesomePromptManifestCache(); void loadManifest() }} disabled={loading} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-gray-50 text-gray-500 transition hover:border-gray-300 hover:bg-white hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-violet-400/60 dark:border-white/[0.08] dark:bg-white/[0.025] dark:hover:border-white/[0.18] dark:hover:bg-white/[0.05] dark:hover:text-gray-200 disabled:animate-pulse disabled:opacity-50" aria-label="重新加载素材库" title="重新加载素材库">
          <LibraryIcon type="refresh" />
        </button>
      </div>

      {loading && <LibrarySkeleton />}

      {!loading && error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-center dark:border-red-400/20 dark:bg-red-500/[0.06]">
          <p className="text-xs font-medium text-red-700 dark:text-red-200">素材库暂时无法加载</p>
          <p className="mt-1 text-[10px] leading-4 text-red-600/70 dark:text-red-200/60">{error}</p>
          <button type="button" onClick={() => { clearAwesomePromptManifestCache(); void loadManifest() }} className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-red-200 px-3 text-xs text-red-700 transition hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-300/60 dark:border-red-300/20 dark:text-red-100 dark:hover:bg-red-500/10"><LibraryIcon type="refresh" className="h-4 w-4" />重试</button>
        </div>
      )}

      {!loading && !error && manifest && (
        <>
          <div className="flex items-center justify-between gap-2 text-[10px] text-gray-500 dark:text-gray-600">
            <span>显示 {visibleCases.length} / {filteredCases.length} 个案例</span>
            <a href={AWESOME_PROMPT_REPOSITORY} target="_blank" rel="noopener noreferrer" className="flex h-11 items-center gap-1 rounded-md px-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.05] dark:hover:text-gray-300"><LibraryIcon type="external" className="h-3 w-3" />查看仓库</a>
          </div>
          {visibleCases.length ? (
            <div className="grid grid-cols-2 gap-2">
              {visibleCases.map((item) => (
                <PromptCaseCard
                  key={item.id}
                  item={item}
                  canImportImage={canImportImage}
                  importing={importingId === item.id}
                  onImportImage={() => onImportImage(item)}
                  onUsePrompt={() => onUsePrompt(item)}
                  onOpenDetails={() => setSelectedCase(item)}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-8 text-center text-xs text-gray-500 dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-gray-600">没有匹配的案例，试试其他关键词。</div>
          )}
          {visibleCount < filteredCases.length && (
            <button type="button" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)} className="flex h-11 w-full items-center justify-center rounded-xl border border-gray-200 bg-gray-50 text-xs font-medium text-gray-600 transition hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-400/60 dark:border-white/[0.08] dark:bg-white/[0.025] dark:text-gray-400 dark:hover:border-violet-400/30 dark:hover:bg-violet-500/[0.05] dark:hover:text-violet-200">加载更多案例</button>
          )}
        </>
      )}

      {selectedCase && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="prompt-case-detail-title" onClick={() => setSelectedCase(null)}>
          <div className="flex max-h-[min(88dvh,760px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-white/[0.1] dark:bg-gray-900" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-white/[0.08]">
              <div className="min-w-0">
                <h2 id="prompt-case-detail-title" className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{selectedCase.title}</h2>
                <p className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400">#{selectedCase.id} · {selectedCase.category}</p>
              </div>
              <button type="button" onClick={() => setSelectedCase(null)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-violet-400/60 dark:hover:bg-white/[0.06] dark:hover:text-white" aria-label="关闭详情"><LibraryIcon type="close" /></button>
            </div>
            <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
              <img src={getAwesomePromptImageUrl(selectedCase)} alt={selectedCase.imageAlt} className="mx-auto max-h-[42dvh] w-full rounded-xl bg-gray-100 object-contain dark:bg-white/[0.04]" />
              <div className="mt-4 flex flex-wrap gap-1.5">
                <span className="rounded-md bg-violet-500/10 px-2 py-1 text-[10px] text-violet-700 dark:text-violet-200">{selectedCase.category}</span>
                {selectedCase.styles.map((style) => <span key={style} className="rounded-md bg-gray-100 px-2 py-1 text-[10px] text-gray-600 dark:bg-white/[0.06] dark:text-gray-300">{style}</span>)}
              </div>
              <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
                <p className="mb-2 text-[10px] font-semibold text-gray-500 dark:text-gray-400">完整 Prompt</p>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-gray-700 dark:text-gray-300">{selectedCase.prompt}</pre>
              </div>
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <button type="button" onClick={() => { onUsePrompt(selectedCase); setSelectedCase(null) }} className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-3 text-xs font-semibold text-white transition hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-400/60"><LibraryIcon type="sparkles" className="h-4 w-4" />填入 Prompt</button>
                <button type="button" onClick={() => onImportImage(selectedCase)} disabled={!canImportImage || importingId === selectedCase.id} className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-cyan-200 bg-cyan-50 px-3 text-xs font-medium text-cyan-700 transition hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-cyan-400/15 dark:bg-cyan-500/[0.06] dark:text-cyan-200"><LibraryIcon type="download" className="h-4 w-4" />{importingId === selectedCase.id ? '导入中…' : '导入参考图'}</button>
              </div>
              <a href={selectedCase.sourceUrl || selectedCase.githubUrl} target="_blank" rel="noopener noreferrer" className="mt-3 flex h-11 items-center justify-center gap-1 text-[11px] text-gray-500 underline underline-offset-2 hover:text-gray-800 dark:hover:text-gray-200"><LibraryIcon type="external" className="h-3.5 w-3.5" />查看来源</a>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
