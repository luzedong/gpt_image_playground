import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getActiveApiProfile } from '../lib/apiProfiles'
import { isServerManagedApiConfigEnabled } from '../lib/devProxy'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { useStore } from '../store'

interface ApiKeyPromptModalProps {
  appReady: boolean
}

export default function ApiKeyPromptModal({ appReady }: ApiKeyPromptModalProps) {
  const settings = useStore((state) => state.settings)
  const setSettings = useStore((state) => state.setSettings)
  const showToast = useStore((state) => state.showToast)
  const activeProfile = getActiveApiProfile(settings)
  const needsApiKey = appReady && !isServerManagedApiConfigEnabled() && !activeProfile.apiKey.trim()
  const [dismissed, setDismissed] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const visible = needsApiKey && !dismissed

  useEffect(() => {
    if (!visible) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => previousFocusRef.current?.focus()
  }, [visible])

  useEffect(() => {
    if (!visible) return
    setApiKey('')
    setShowApiKey(false)
    setError('')
  }, [visible, activeProfile.id])

  const close = () => setDismissed(true)
  useCloseOnEscape(visible, close)
  usePreventBackgroundScroll(visible)

  if (!visible) return null

  const save = () => {
    const value = apiKey.trim()
    if (!value) {
      setError('请输入 Pixel API Key')
      inputRef.current?.focus()
      return
    }

    setSettings({ apiKey: value })
    setDismissed(true)
    showToast('API Key 已保存，可以开始创作', 'success')
  }

  return createPortal(
    <div
      data-no-drag-select
      className="fixed inset-0 z-[130] flex items-center justify-center p-4"
      onClick={close}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-md animate-overlay-in motion-reduce:animate-none" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="api-key-prompt-title"
        aria-describedby="api-key-prompt-description"
        className="relative z-10 w-full max-w-sm rounded-3xl border border-white/50 bg-white/95 p-6 shadow-[0_8px_40px_rgb(0,0,0,0.16)] ring-1 ring-black/5 animate-confirm-in motion-reduce:animate-none dark:border-white/[0.08] dark:bg-gray-900/95 dark:shadow-[0_8px_40px_rgb(0,0,0,0.5)] dark:ring-white/10"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])') ?? [])
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (!first || !last) return
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-500 dark:bg-blue-400/10 dark:text-blue-400">
          <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="7.5" cy="15.5" r="5.5" />
            <path d="m21 2-9.6 9.6" />
            <path d="m15.5 7.5 3 3L22 7l-3-3" />
          </svg>
        </div>

        <h2 id="api-key-prompt-title" className="text-lg font-bold text-gray-800 dark:text-gray-100">
          输入 Pixel API Key
        </h2>
        <p id="api-key-prompt-description" className="mt-2 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
          API 地址、Images API 模式和 gpt-image-2 已配置完成，只需填写 Key 即可开始生图和编辑图片。
        </p>

        <form
          className="mt-5"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <label htmlFor="startup-api-key" className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
            API Key
          </label>
          <div className="relative">
            <input
              ref={inputRef}
              id="startup-api-key"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value)
                if (error) setError('')
              }}
              type={showApiKey ? 'text' : 'password'}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="sk-..."
              aria-required="true"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'startup-api-key-error' : 'startup-api-key-helper'}
              className={`h-12 w-full rounded-xl border bg-white px-3.5 pr-12 text-base text-gray-800 outline-none transition placeholder:text-gray-300 focus:ring-2 dark:bg-white/[0.04] dark:text-gray-100 dark:placeholder:text-gray-600 ${error ? 'border-red-400 focus:border-red-400 focus:ring-red-400/20 dark:border-red-400/80' : 'border-gray-200 focus:border-blue-400 focus:ring-blue-500/20 dark:border-white/[0.1] dark:focus:border-blue-400'}`}
            />
            <button
              type="button"
              onClick={() => setShowApiKey((value) => !value)}
              className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-xl text-gray-400 transition hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:hover:text-gray-200"
              aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
            >
              {showApiKey ? (
                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M2 2l20 20" />
                  <path d="M6.7 6.7C4.6 8.1 3 10 2 12c2 4 5.3 7 10 7 1.5 0 2.8-.3 4-.8" />
                  <path d="M10.7 5.1A9.7 9.7 0 0 1 12 5c4.7 0 8 3 10 7a15 15 0 0 1-2 3" />
                  <path d="M14.1 14.1A3 3 0 0 1 9.9 9.9" />
                </svg>
              ) : (
                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
          {error ? (
            <p id="startup-api-key-error" role="alert" className="mt-2 text-sm text-red-500 dark:text-red-400">
              {error}
            </p>
          ) : (
            <p id="startup-api-key-helper" className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-gray-500">
              手动填写的 Key 仅保存在当前浏览器配置中。请勿在公共设备上保存私人 Key。
            </p>
          )}

          <div className="mt-6 flex gap-2.5">
            <button
              type="button"
              onClick={close}
              className="min-h-11 flex-1 rounded-xl border border-gray-200 px-4 text-sm text-gray-600 transition hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-white/[0.08] dark:text-gray-400 dark:hover:bg-white/[0.06]"
            >
              稍后填写
            </button>
            <button
              type="submit"
              className="min-h-11 flex-1 rounded-xl bg-blue-500 px-4 text-sm font-medium text-white shadow-sm shadow-blue-500/20 transition hover:bg-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
            >
              保存并开始
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
