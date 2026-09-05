import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import type { ApiProfile, AppSettings, TaskParams } from '../../types'
import { getOutputImageLimitForSettings, DEFAULT_FAL_IMAGE_SIZE } from '../../lib/paramCompatibility'
import { normalizeCodexCliImageSize, normalizeImageSize } from '../../lib/size'
import { useHintTooltip } from '../../hooks/useHintTooltip'
import SizePickerModal from '../SizePickerModal'
import InputParamsPanel from '../input/inputParamsPanel'

interface ImageGenerationSettingsTabProps {
  draft: AppSettings
  activeProfile: ApiProfile
  setParams: (patch: Partial<TaskParams>) => void
}

export default function ImageGenerationSettingsTab({ draft, activeProfile, setParams }: ImageGenerationSettingsTabProps) {
  const params = useStore((s) => s.params)
  const appMode = useStore((s) => s.appMode)
  const inputImages = useStore((s) => s.inputImages)
  const [outputCompressionInput, setOutputCompressionInput] = useState(
    params.output_compression == null ? '' : String(params.output_compression),
  )
  const [nInput, setNInput] = useState(String(params.n))
  const [nInputFocused, setNInputFocused] = useState(false)
  const [showSizePicker, setShowSizePicker] = useState(false)

  const isFalProvider = activeProfile.provider === 'fal'
  const isFalTextToImage = isFalProvider && inputImages.length === 0
  const displaySize = isFalTextToImage && params.size === 'auto'
    ? DEFAULT_FAL_IMAGE_SIZE
    : (activeProfile.codexCli ? normalizeCodexCliImageSize(params.size) : normalizeImageSize(params.size)) || 'auto'
  const qualityOptions = isFalProvider
    ? [
        { label: 'low', value: 'low' },
        { label: 'medium', value: 'medium' },
        { label: 'high', value: 'high' },
      ]
    : [
        { label: 'auto', value: 'auto' },
        { label: 'low', value: 'low' },
        { label: 'medium', value: 'medium' },
        { label: 'high', value: 'high' },
      ]
  const transparentOutputAvailable = appMode === 'gallery'
  const showTransparentOutputControl = transparentOutputAvailable && (params.output_format === 'png' || params.output_format === 'webp')
  const transparentOutputEnabled = showTransparentOutputControl && params.transparent_output
  const compressionDisabled = params.output_format === 'png' || isFalProvider
  const outputImageLimit = getOutputImageLimitForSettings(draft)
  const agentAutoImageCount = appMode === 'agent'
  const nDraftValue = Number(nInput)
  const effectiveNValue = Number.isNaN(nDraftValue) ? params.n : nDraftValue
  const streamConcurrentByN = activeProfile.provider === 'openai' && activeProfile.streamImages === true && effectiveNValue > 1
  const nLimitHintText = isFalProvider
    ? `fal.ai 最大请求数量为 ${outputImageLimit}`
    : `OpenAI 最大请求数量为 ${outputImageLimit}`
  const transparentOutputHint = useHintTooltip()
  const compressionHint = useHintTooltip({ enabled: () => compressionDisabled })
  const moderationHint = useHintTooltip({ enabled: () => isFalProvider })
  const sizeHint = useHintTooltip({ enabled: () => isFalTextToImage || activeProfile.codexCli })
  const qualityHint = useHintTooltip({ enabled: () => activeProfile.codexCli || isFalProvider })
  const nLimitHint = useHintTooltip({ autoHideMs: 2000 })
  const streamConcurrentHint = useHintTooltip({ enabled: () => streamConcurrentByN })

  useEffect(() => {
    setOutputCompressionInput(params.output_compression == null ? '' : String(params.output_compression))
  }, [params.output_compression])

  useEffect(() => {
    setNInput(agentAutoImageCount ? 'auto' : String(params.n))
  }, [agentAutoImageCount, params.n])

  const commitOutputCompression = () => {
    if (outputCompressionInput.trim() === '') {
      setOutputCompressionInput('')
      setParams({ output_compression: null })
      return
    }

    const nextValue = Number(outputCompressionInput)
    if (Number.isNaN(nextValue)) {
      setOutputCompressionInput(params.output_compression == null ? '' : String(params.output_compression))
      return
    }

    setOutputCompressionInput(String(nextValue))
    setParams({ output_compression: nextValue })
  }

  const commitN = () => {
    nLimitHint.hide()
    if (agentAutoImageCount) {
      setNInput('auto')
      return
    }
    const nextValue = Number(nInput)
    const normalizedValue = nInput.trim() === '' || Number.isNaN(nextValue) ? params.n : nextValue
    const clampedValue = Math.min(outputImageLimit, Math.max(1, normalizedValue))
    setNInput(String(clampedValue))
    setParams({ n: clampedValue })
  }

  const handleNInputChange = (value: string) => {
    if (agentAutoImageCount) {
      setNInput('auto')
      return
    }
    setNInput(value)
    const nextValue = Number(value)
    if (!Number.isNaN(nextValue) && nextValue > outputImageLimit) nLimitHint.show()
    else nLimitHint.hide()
  }

  const handleNLimitIncreaseAttempt = (preventDefault: () => void) => {
    if (agentAutoImageCount) {
      preventDefault()
      nLimitHint.show()
      return
    }
    const currentValue = Number(nInput)
    const effectiveValue = Number.isNaN(currentValue) ? params.n : currentValue
    if (!nInputFocused || effectiveValue < outputImageLimit) return
    preventDefault()
    nLimitHint.show()
  }

  return (
    <>
      {showSizePicker && (
        <SizePickerModal
          currentSize={isFalTextToImage && params.size === 'auto' ? DEFAULT_FAL_IMAGE_SIZE : params.size}
          onSelect={(size) => setParams({ size })}
          onClose={() => setShowSizePicker(false)}
          allowAuto={!isFalTextToImage}
          codexCli={activeProfile.codexCli}
        />
      )}
      <div className="space-y-5">
        <div>
          <h4 className="text-base font-semibold text-gray-800 dark:text-gray-100">生图配置</h4>
          <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">设置图片生成时使用的尺寸、质量、格式和数量，配置会立即保存并应用到下一次生成。</p>
        </div>
        <div className="rounded-2xl border border-gray-200/70 bg-gray-50/50 p-3 dark:border-white/[0.08] dark:bg-white/[0.03] sm:p-4">
          <InputParamsPanel
            cols="grid-cols-2 sm:grid-cols-3"
            params={params}
            setParams={setParams}
            activeProfile={activeProfile}
            isFalProvider={isFalProvider}
            isFalTextToImage={isFalTextToImage}
            displaySize={displaySize}
            qualityOptions={qualityOptions}
            selectClass="px-3 py-2.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm text-gray-700 dark:text-gray-200 outline-none"
            transparentOutputAvailable={transparentOutputAvailable}
            showTransparentOutputControl={showTransparentOutputControl}
            transparentOutputEnabled={transparentOutputEnabled}
            transparentOutputHint={transparentOutputHint}
            onTransparentOutputMenuOpenChange={(open) => { if (open) transparentOutputHint.hide() }}
            compressionHint={compressionHint}
            compressionDisabled={compressionDisabled}
            outputCompressionInput={outputCompressionInput}
            setOutputCompressionInput={setOutputCompressionInput}
            commitOutputCompression={commitOutputCompression}
            moderationHint={moderationHint}
            moderationDisabled={isFalProvider}
            agentAutoImageCount={agentAutoImageCount}
            outputImageLimit={outputImageLimit}
            nInput={nInput}
            setNInputFocused={setNInputFocused}
            commitN={commitN}
            handleNInputChange={handleNInputChange}
            handleNLimitIncreaseAttempt={handleNLimitIncreaseAttempt}
            showAgentNHint={() => { if (agentAutoImageCount) nLimitHint.show() }}
            hideNLimitHint={nLimitHint.hide}
            startAgentNHintTouch={() => { if (agentAutoImageCount) nLimitHint.startTouch() }}
            clearAgentNHintTouchTimer={nLimitHint.clearTimer}
            nLimitHint={nLimitHint}
            nLimitHintText={nLimitHintText}
            streamConcurrentByN={streamConcurrentByN}
            streamConcurrentHint={streamConcurrentHint}
            sizeHint={sizeHint}
            qualityHint={qualityHint}
            onOpenSizePicker={() => setShowSizePicker(true)}
          />
        </div>
      </div>
    </>
  )
}
