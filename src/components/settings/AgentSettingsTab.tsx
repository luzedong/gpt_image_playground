import {
  DEFAULT_AGENT_MAX_TOOL_ROUNDS,
  type AgentApiConfigMode,
  type ApiProfile,
  type AppSettings,
} from '../../types'
import { normalizeAgentMaxToolRounds } from '../../lib/apiProfiles'
import Select from '../Select'

interface SelectOption {
  label: string
  value: string
}

interface AgentSettingsTabProps {
  draft: AppSettings
  agentMaxToolRoundsInput: string
  agentTextProfileOptions: SelectOption[]
  agentImageProfileOptions: SelectOption[]
  effectiveAgentTextProfile: ApiProfile | null
  selectedAgentTextProfile: ApiProfile | null
  selectedAgentImageProfile: ApiProfile | null
  agentTextProfileUsesActive: boolean
  agentTextProfileLocked: boolean
  agentTextProfileError: string | null
  setAgentMaxToolRoundsInput: (value: string) => void
  updateAgentApiConfigMode: (mode: AgentApiConfigMode) => void
  updateAgentTextProfileModel: (value: string) => void
  commitAgentTextProfileModel: (value: string) => void
  openApiSettings: () => void
  createAgentTextProfile: (() => void) | null
  commitSettings: (nextDraft: AppSettings) => void
  commitAgentMaxToolRounds: () => void
}

export default function AgentSettingsTab({
  draft,
  agentMaxToolRoundsInput,
  agentTextProfileOptions,
  agentImageProfileOptions,
  effectiveAgentTextProfile,
  selectedAgentTextProfile,
  selectedAgentImageProfile,
  agentTextProfileUsesActive,
  agentTextProfileLocked,
  agentTextProfileError,
  setAgentMaxToolRoundsInput,
  updateAgentApiConfigMode,
  updateAgentTextProfileModel,
  commitAgentTextProfileModel,
  openApiSettings,
  createAgentTextProfile,
  commitSettings,
  commitAgentMaxToolRounds,
}: AgentSettingsTabProps) {
  return (
    <div className="space-y-4">
      <div className="block">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="block text-sm text-gray-600 dark:text-gray-300">使用独立的 API 配置</span>
          <div className="w-20 shrink-0">
            <Select
              value={draft.agentApiConfigMode}
              onChange={(value) => updateAgentApiConfigMode(value as AgentApiConfigMode)}
              options={[
                { label: '关闭', value: 'off' },
                { label: '原生', value: 'native' },
                { label: '混合', value: 'hybrid' },
              ]}
              className="w-full px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm text-gray-700 dark:text-gray-200 outline-none"
            />
          </div>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500 space-y-1">
          <div>原生：使用原生的 Responses API 配置，由模型调用 <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px] dark:bg-white/[0.06]">image_generation</code> 工具生成图片。</div>
          <div>混合：使用非原生的混合 API 配置，由文本模型调用自定义工具，请求图像模型生成图像，解决部分服务商/模型不支持 <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px] dark:bg-white/[0.06]">image_generation</code> 工具的问题。</div>
        </div>
      </div>

      <section className="rounded-2xl border border-blue-200/70 bg-blue-50/60 p-4 dark:border-blue-400/20 dark:bg-blue-500/[0.06]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="block text-sm font-medium text-gray-700 dark:text-gray-200">语言模型</span>
            <p data-selectable-text className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
              Agent 使用它理解对话、决定是否调用生图工具。它必须是支持 Responses API 的文本模型，不是 gpt-image-2 这类图像模型。
            </p>
          </div>
          <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-medium ${effectiveAgentTextProfile && !agentTextProfileError ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300'}`}>
            {effectiveAgentTextProfile ? (agentTextProfileError ? '配置不完整' : '已配置') : '未配置'}
          </span>
        </div>

        {effectiveAgentTextProfile ? (
          <div className="mt-4 space-y-3">
            {draft.agentApiConfigMode !== 'off' && (
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-gray-600 dark:text-gray-300">API 配置</span>
                <Select
                  value={selectedAgentTextProfile?.id ?? ''}
                  onChange={(value) => commitSettings({ ...draft, agentTextProfileId: String(value) })}
                  options={agentTextProfileOptions}
                  showValueTooltips
                  className="w-full rounded-xl border border-blue-200/70 bg-white/70 px-3 py-2 text-sm text-gray-700 shadow-sm outline-none transition-all duration-200 hover:bg-white dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200 dark:hover:bg-white/[0.07]"
                />
              </label>
            )}
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-gray-600 dark:text-gray-300">模型 ID</span>
              <input
                value={effectiveAgentTextProfile.model}
                onChange={(e) => updateAgentTextProfileModel(e.target.value)}
                onBlur={(e) => commitAgentTextProfileModel(e.target.value)}
                type="text"
                disabled={agentTextProfileLocked}
                placeholder="例如 gpt-5.6-sol"
                className="w-full rounded-xl border border-blue-200/70 bg-white/70 px-3 py-2.5 font-mono text-sm text-gray-700 outline-none transition focus:border-blue-400 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200 dark:focus:border-blue-500/60 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
            <p data-selectable-text className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
              {agentTextProfileUsesActive
                ? '当前 Agent 跟随 API 配置页选中的主配置。切换到“原生”或“混合”后，可以单独选择另一套文本模型配置。'
                : `请求将发送到「${effectiveAgentTextProfile.name}」的 Responses API。API 地址、Key 和推理强度仍在 API 配置页管理。`}
              {agentTextProfileLocked && ' 当前配置由部署端锁定，模型 ID 需要由管理员修改。'}
            </p>
            {agentTextProfileError && (
              <p role="alert" className="rounded-xl border border-amber-200/80 bg-amber-50/80 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/[0.08] dark:text-amber-200">
                当前配置还不能用于 Agent：{agentTextProfileError}。请补全后再开始对话。
              </p>
            )}
            <button
              type="button"
              onClick={openApiSettings}
              className="min-h-11 rounded-xl border border-blue-200/80 bg-white/70 px-3 py-2 text-xs font-medium text-blue-700 transition hover:bg-white dark:border-blue-400/25 dark:bg-white/[0.04] dark:text-blue-300 dark:hover:bg-white/[0.08]"
            >
              管理 API 地址、Key 和推理强度
            </button>
          </div>
        ) : (
          <div role="alert" className="mt-4 rounded-xl border border-amber-200/80 bg-amber-50/80 p-3 dark:border-amber-400/20 dark:bg-amber-400/[0.08]">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-200">没有可用的 Responses API 文本模型</p>
            <p data-selectable-text className="mt-1 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              当前的 Pixel 配置是 Images API，只能调用生图/编辑接口。请新建或切换一套 Responses API 配置，再填写语言模型 ID 和 API Key。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {createAgentTextProfile && (
                <button
                  type="button"
                  onClick={createAgentTextProfile}
                  className="min-h-11 rounded-xl bg-blue-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400"
                >
                  新建 Responses 配置
                </button>
              )}
              <button
                type="button"
                onClick={openApiSettings}
                className="min-h-11 rounded-xl border border-amber-300/80 bg-white/70 px-3 py-2 text-xs font-medium text-amber-800 transition hover:bg-white dark:border-amber-400/25 dark:bg-white/[0.04] dark:text-amber-200 dark:hover:bg-white/[0.08]"
              >
                去 API 配置
              </button>
            </div>
          </div>
        )}
      </section>

      {draft.agentApiConfigMode !== 'off' && (
        <>
          {draft.agentApiConfigMode === 'hybrid' && (
            <div className="block">
              <div className="mb-1 flex items-center justify-between gap-3">
                <span className="block text-sm text-gray-600 dark:text-gray-300">图像模型 API 配置</span>
                <div className="w-40 shrink-0">
                  {agentImageProfileOptions.length > 0 ? (
                    <Select
                      value={selectedAgentImageProfile?.id ?? '请选择配置'}
                      onChange={(value) => commitSettings({ ...draft, agentImageProfileId: String(value) })}
                      options={agentImageProfileOptions}
                      showValueTooltips
                      className="w-full px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm text-gray-700 dark:text-gray-200 outline-none"
                    />
                  ) : (
                    <div className="w-full rounded-xl border border-gray-200/60 bg-white/50 px-3 py-1.5 text-center text-xs text-gray-700 shadow-sm transition-all duration-200 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200">
                      没有可用配置
                    </div>
                  )}
                </div>
              </div>
              <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
                用于生成图像，支持所有类型的 API 配置。
              </div>
            </div>
          )}
        </>
      )}
      <label className="block">
        <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">最大工具调用轮数</span>
        <input
          value={agentMaxToolRoundsInput}
          onChange={(e) => setAgentMaxToolRoundsInput(e.target.value)}
          onBlur={commitAgentMaxToolRounds}
          type="number"
          min={1}
          max={50}
          className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
        />
        <div data-selectable-text className="mt-1.5 text-xs leading-relaxed text-gray-500 dark:text-gray-500">
          默认 15。用于限制 Agent 连续调用工具时的最大轮数，防止无限循环。
        </div>
      </label>
      <div className="block">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="block text-sm text-gray-600 dark:text-gray-300">网络搜索</span>
          <button
            type="button"
            onClick={() => {
              const agentMaxToolRounds = agentMaxToolRoundsInput.trim() === ''
                ? DEFAULT_AGENT_MAX_TOOL_ROUNDS
                : normalizeAgentMaxToolRounds(agentMaxToolRoundsInput, draft.agentMaxToolRounds)
              setAgentMaxToolRoundsInput(String(agentMaxToolRounds))
              commitSettings({ ...draft, agentMaxToolRounds, agentWebSearch: !draft.agentWebSearch })
            }}
            className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${draft.agentWebSearch ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            role="switch"
            aria-checked={draft.agentWebSearch}
            aria-label="网络搜索"
          >
            <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${draft.agentWebSearch ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
          </button>
        </div>
        <div data-selectable-text className="text-xs text-gray-500 dark:text-gray-500">
          启用 Responses API 的 <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px] dark:bg-white/[0.06]">web_search</code> 工具。模型每次调用此工具会产生少量固定价格的额外计费。
        </div>
      </div>
    </div>
  )
}
