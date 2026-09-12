import { DEFAULT_AGENT_MAX_TOOL_ROUNDS, DEFAULT_STREAM_PARTIAL_IMAGES, type ApiProfile, type AppSettings, type ResponsesApiResponse, type ResponsesOutputItem, type TaskParams } from '../types'
import { buildApiUrl, isServerManagedApiConfigEnabled, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { appendStreamingFormatHint, getApiErrorMessage, getResponsesImageResultBase64, maybeAppendStreamingHint, MIME_MAP, normalizeBase64Image, pickActualParams, PROMPT_REWRITE_GUARD_PREFIX } from './imageApiShared'
import { normalizeResponsesOutputItems } from './responsesOutputState'
import { isEventStreamResponse, readJsonServerSentEvents, throwIfAborted } from './serverSentEvents'
import { normalizeAgentImageSize } from './size'

export interface AgentApiResultImage {
  toolCallId?: string
  batchCallId?: string
  batchItemId?: string
  referenceId?: string
  referenceIds?: string[]
  action?: string
  dataUrl: string
  prompt?: string
  actualParams?: Partial<TaskParams>
  revisedPrompt?: string
  startedAt?: number
  finishedAt?: number
}

export interface AgentApiImageToolFailure {
  toolCallId: string
  error: string
}

export interface AgentApiResult {
  responseId?: string
  text: string
  images: AgentApiResultImage[]
  outputItems: ResponsesApiResponse['output']
  rawResponsePayload?: string
  captionState?: 'idle' | 'pending' | 'running' | 'done'
}

const AGENT_IMAGE_INSTRUCTIONS = [
  '你是一个多轮图库应用中的图像生成助手。',
  '',
  '## 渐进式批量生成',
  '当用户请求多张图片时，采用渐进式批量策略保证一致性：',
  '  1. **先生成基准图：** 如果图片需要保持一致风格、角色或版式（例如 PPT 页面、故事板），先生成一张主图建立视觉基准，然后调用 continue_generation 进入下一轮。',
  '  2. **批量生成剩余图片：** 基准图可用后，再列出所有剩余图片。应用会为你并发生成。在描述中明确要求引用基准图以保持一致性。',
  '  3. **独立图片：** 如果请求的图片彼此完全独立（例如“3 只不同的猫”），应在一次回复中一起生成。不要把独立图片拆到多轮逐张生成。',
  '随着本轮推进，在每次工具调用前输出一句简短进度说明。',
  '单图请求直接生成，不需要列清单。',
  '',
  '## 生成图片',
  '- 每张不同图片调用一次 image_generation，不要把多张图片拼成拼图。',
  '- 有依赖关系的图片（后续图片需要引用前一张图）→ 先生成前置图片，再调用 continue_generation。下一轮会通过 `<ref id="..." />` 提供结果。',
  '- 只有用户明确要求生成图片时才生成；否则用文字回复。',
  '- 忠实保留用户原始意图。不要因为版权或商标原因擅自替换用户要求的主题。',
  '',
  '## 引用标签与上下文中的生成图',
  '绝不要在可见的助手文本中输出 `<ref>`、`<available_refs>`、`<removed_ref>` 或任何 XML 引用标签。系统会自动注入这些标签，你的原始输出会直接展示给用户。',
  '- 之前生成的图片用 `<ref id="round-N-image-M" prompt="..." />` 标签表示；当后续图像生成提示词引用该标签时，应用会把标签解析为实际图片。',
  '- 已删除的图片会显示为 `<removed_ref id="..." />`，且没有对应图片，不要引用它们。',
  '- 在用户消息中，`<ref id="..." />` 也可能指向用户附加或引用的图片。',
  '- 在 generate_image_batch 的工具参数中，如果某个图像提示词引用了已有图片，请在其中加入匹配的 `<ref id="..." />` 标签。不要只使用裸引用 ID。',
  '把用户提到的“第一张图”等表述解析为匹配的 ID。只能使用图像生成提示词和 generate_image_batch 提示词中已存在的 ID。',
].join('\n')

const AGENT_MATH_FORMATTING_INSTRUCTIONS = [
  '## 数学公式格式',
  '- 当回复包含数学公式时，使用本应用支持的 Markdown 数学分隔符输出。',
  '- 行内公式使用 `$...$`。',
  '- 展示公式使用 `$$` 独占一行作为开始和结束。',
  '- 不要在可见助手文本中使用 LaTeX 分隔符，例如 `\\(...\\)` 或 `\\[...\\]`。',
].join('\n')

export function createAgentInstructions(settings: AppSettings, codexCliSize?: string) {
  const maxToolRounds = Number.isFinite(settings.agentMaxToolRounds)
    ? Math.max(1, Math.trunc(settings.agentMaxToolRounds))
    : DEFAULT_AGENT_MAX_TOOL_ROUNDS
  const imageToolInstruction = settings.agentApiConfigMode === 'hybrid'
    ? '单图请求使用 generate_image，多图并发请求使用 generate_image_batch。本次会话不提供内置 image_generation 工具。'
      + '每张图可以用 size 单独指定像素尺寸（例如长卷用 3840x1600）；填 auto 表示沿用应用里的生图尺寸设置。'
    : '单图请求使用 image_generation，多图并发请求使用 generate_image_batch。'
  const imageInstructions = settings.agentApiConfigMode === 'hybrid'
    ? AGENT_IMAGE_INSTRUCTIONS.replace(/image_generation/g, 'generate_image')
    : AGENT_IMAGE_INSTRUCTIONS
  const instructions = [
    imageInstructions,
    '',
    '## 工具策略',
    `- 本次 Agent 轮次最多可使用工具轮数：${maxToolRounds}。`,
    `- ${imageToolInstruction}`,
    '- 只有在你已经生成前置图片、并且还需要生成依赖图片时才调用 continue_generation。任务完成后不要调用它。',
    '- 当 web_search 可用时，只在最新外部信息有助于回答，或用户要求研究/新闻/事实时使用。',
    '- 当用户请求的任务完成后，停止调用工具并提供最终回复。',
  ]

  if (codexCliSize && codexCliSize !== 'auto') {
    instructions.push('', `- 每个图像提示词必须以 "Generate at ${codexCliSize} resolution." 开头，后面跟一个空格。`)
  }

  if (settings.agentMathFormattingPrompt) instructions.push('', AGENT_MATH_FORMATTING_INSTRUCTIONS)

  return instructions.join('\n')
}

const AGENT_TITLE_INSTRUCTIONS = [
  'Generate a concise conversation title from the first user message.',
  'Output exactly one XML element in this form: <title>short title</title>',
  'Do not output markdown, code fences, explanations, attributes, or additional XML elements.',
  'Use the main language of the user message. Chinese titles should be no more than 12 characters. English titles should be no more than 5 words.',
  'Escape XML special characters when necessary.',
].join('\n')

const AGENT_TITLE_MAX_LENGTH = 28

const AGENT_IMAGE_SIZE_PROPERTY = {
  type: 'string',
  description: '输出尺寸。填 "auto" 表示沿用应用里的生图尺寸设置；也可直接给“宽x高”像素值（16 的倍数，长边不超过 3840，宽高比不超过 3:1）。'
    + '常用值：1024x1024、1024x1536、1536x1024（1K）；2048x2048、2560x1440、1440x2560（2K）；'
    + '2880x2880、3456x2304、3840x2160、2160x3840、3840x1600（4K，超宽长卷用 3840x1600）。'
    + '用户要求 4K、高清或长卷时按需填具体尺寸，不要只在提示词里写分辨率。',
}

function createHeaders(profile: ApiProfile): Record<string, string> {
  return {
    ...(profile.apiKey.trim() ? { Authorization: `Bearer ${profile.apiKey}` } : {}),
    'Content-Type': 'application/json',
  }
}

function createImageTool(params: TaskParams, profile: ApiProfile, maskDataUrl?: string): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: 'auto',
    output_format: params.output_format,
    moderation: params.moderation,
  }

  if (!profile.codexCli) {
    tool.size = params.size
  }

  tool.quality = params.quality

  if (params.output_format !== 'png' && params.output_compression != null) {
    tool.output_compression = params.output_compression
  }

  if (profile.streamImages) {
    tool.partial_images = profile.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES
  }

  if (maskDataUrl) {
    tool.input_image_mask = {
      image_url: maskDataUrl,
    }
  }

  return tool
}

function createGenerateImageFunctionTool() {
  return {
    type: 'function',
    name: 'generate_image',
    description: [
      '通过应用图像 API 生成一张图片。用于单图请求，或供后续图片引用的前置/基准图。',
      '提示词必须自包含，并包含完整的视觉风格描述。',
      '如果提示词引用已有图片，请在提示词中加入对应 XML 标签，例如 <ref id="round-1-image-1" />，应用会自动附加参考图。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '用于标识图片的简短稳定 ID，例如 "cover"、"base_character"、"scene_1"。',
        },
        prompt: {
          type: 'string',
          description: '包含完整视觉细节的图像生成提示词。引用已有图片时请加入匹配的 XML 标签。',
        },
        size: AGENT_IMAGE_SIZE_PROPERTY,
      },
      required: ['id', 'prompt', 'size'],
      additionalProperties: false,
    },
    strict: true,
  }
}

function createAgentTools(params: TaskParams, profile: ApiProfile, settings: AppSettings, maskDataUrl?: string): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = settings.agentApiConfigMode === 'hybrid'
    ? [createGenerateImageFunctionTool()]
    : [createImageTool(params, profile, maskDataUrl)]
  const singleImageToolInstruction = settings.agentApiConfigMode === 'hybrid'
    ? '单图或前置/基准图请使用 generate_image 工具。'
    : '单图或前置/基准图请使用内置 image_generation 工具。'

  // generate_image_batch: custom function tool for concurrent multi-image generation
  tools.push({
    type: 'function',
    name: 'generate_image_batch',
    description: [
      '并发生成多张图片。仅在满足以下条件时使用：',
      '1. 还有至少 2 张图片，且它们依赖的前置/基准图都已生成。',
      '2. 这些图片彼此独立，没有图片引用同一批次中的另一张图片。',
      singleImageToolInstruction,
      '每个图像提示词必须自包含，并包含完整的视觉风格描述。',
      '如果图片需要匹配之前生成的图片，请在该图像提示词中加入对应 XML 标签，例如 <ref id="round-1-image-1" />，应用会自动附加参考图。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        images: {
          type: 'array',
          description: '需要并发生成的图片数组。',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: '用于标识图片的简短稳定 ID，例如 "slide_2_problem"、"scene_3"。',
              },
              prompt: {
                type: 'string',
                description: '包含完整视觉细节的图像生成提示词。如果引用之前的图片，请加入匹配的 XML 标签，例如 <ref id="round-1-image-1" />。',
              },
              size: AGENT_IMAGE_SIZE_PROPERTY,
            },
            required: ['id', 'prompt', 'size'],
            additionalProperties: false,
          },
        },
      },
      required: ['images'],
      additionalProperties: false,
    },
    strict: true,
  })

  // continue_generation: model calls this to request another round (e.g. after generating a prerequisite image)
  tools.push({
    type: 'function',
    name: 'continue_generation',
    description: [
      '请求进入下一轮继续生成图片。',
      '只有在你刚生成前置/基准图，并且还需要生成引用它的依赖图片时才调用。',
      '任务已经完成时不要调用。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '简短说明为什么需要下一轮，以及下一轮将生成什么。',
        },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    strict: true,
  })

  tools.push({ type: 'web_search' })
  return tools
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getStringValue(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value ? value : undefined
}

function getNumberValue(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function escapeMarkdownLinkLabel(text: string) {
  return text.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
}

type ResponseTextAnnotation = NonNullable<NonNullable<ResponsesOutputItem['content']>[number]['annotations']>[number]

function applyUrlCitations(text: string, annotations: ResponseTextAnnotation[] | undefined) {
  const citations = (annotations ?? [])
    .filter((annotation) =>
      annotation.type === 'url_citation' &&
      typeof annotation.url === 'string' &&
      annotation.url.trim() &&
      typeof annotation.start_index === 'number' &&
      typeof annotation.end_index === 'number' &&
      annotation.start_index >= 0 &&
      annotation.end_index > annotation.start_index &&
      annotation.end_index <= text.length,
    )
    .sort((a, b) => (a.start_index ?? 0) - (b.start_index ?? 0))

  if (citations.length === 0) return text

  let cursor = 0
  let output = ''
  for (const citation of citations) {
    const start = citation.start_index ?? 0
    const end = citation.end_index ?? start
    if (start < cursor) continue

    output += text.slice(cursor, start)
    const label = text.slice(start, end) || citation.title || citation.url || 'source'
    output += `[${escapeMarkdownLinkLabel(label)}](${citation.url})`
    cursor = end
  }
  output += text.slice(cursor)
  return output
}

function getStreamEventErrorMessage(event: Record<string, unknown>): string | null {
  const error = event.error
  if (isRecordValue(error)) {
    const message = getStringValue(error, 'message')
    if (message) return message
  }
  if (typeof error === 'string' && error.trim()) return error

  const type = getStringValue(event, 'type')
  if (type?.endsWith('.failed')) return getStringValue(event, 'message') ?? 'Agent 流式请求失败'
  return null
}

function getErrorMessageFromValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (!isRecordValue(value)) return null

  return getStringValue(value, 'message')
    ?? getStringValue(value, 'code')
    ?? null
}

function getImageToolFailureFromOutputItem(event: Record<string, unknown>, item?: ResponsesOutputItem): AgentApiImageToolFailure | null {
  if (item?.type !== 'image_generation_call' || item.status !== 'failed') return null

  const toolCallId = (typeof item?.id === 'string' && item.id)
    || getStringValue(event, 'item_id')
  if (!toolCallId) return null

  const itemRecord = item as Record<string, unknown> | undefined
  const error = getErrorMessageFromValue(itemRecord?.error)
    ?? getErrorMessageFromValue(event.error)
    ?? getStringValue(event, 'message')
    ?? '内置 image_generation 工具调用失败'

  return {
    toolCallId,
    error,
  }
}

function extractText(payload: ResponsesApiResponse) {
  const chunks: string[] = []

  for (const item of payload.output ?? []) {
    if (item.type !== 'message') continue
    for (const part of item.content ?? []) {
      if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
        chunks.push(applyUrlCitations(part.text, part.annotations))
      } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
        chunks.push(part.refusal)
      }
    }
  }

  return chunks.join('\n').trim()
}

function decodeXmlText(text: string) {
  return text.replace(/&(?:#(\d+)|#x([\da-fA-F]+)|amp|lt|gt|quot|apos);/g, (entity, decimal: string | undefined, hex: string | undefined) => {
    if (decimal) return String.fromCodePoint(Number(decimal))
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16))
    switch (entity) {
      case '&amp;': return '&'
      case '&lt;': return '<'
      case '&gt;': return '>'
      case '&quot;': return '"'
      case '&apos;': return "'"
      default: return entity
    }
  })
}

function parseAgentConversationTitleXml(text: string) {
  const match = text.match(/<title>([\s\S]*?)<\/title>/i)
  const title = match ? decodeXmlText(match[1]).trim() : ''
  const chars = Array.from(title)
  if (chars.length <= AGENT_TITLE_MAX_LENGTH) return title
  return `${chars.slice(0, AGENT_TITLE_MAX_LENGTH - 3).join('')}...`
}

function extractImages(payload: ResponsesApiResponse, fallbackMime: string): AgentApiResultImage[] {
  const images: AgentApiResultImage[] = []

  for (const item of payload.output ?? []) {
    if (item.type !== 'image_generation_call') continue

    const b64 = getResponsesImageResultBase64(item.result)
    if (!b64) continue
    images.push({
      toolCallId: typeof item.id === 'string' ? item.id : undefined,
      action: typeof item.action === 'string' ? item.action : undefined,
      dataUrl: normalizeBase64Image(b64, fallbackMime),
      actualParams: pickActualParams(item),
      revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
    })
  }

  return images
}

function extractImageFromOutputItem(item: ResponsesOutputItem, fallbackMime: string): AgentApiResultImage | null {
  if (item.type !== 'image_generation_call') return null

  const b64 = getResponsesImageResultBase64(item.result)
  if (!b64) return null
  return {
    toolCallId: typeof item.id === 'string' ? item.id : undefined,
    action: typeof item.action === 'string' ? item.action : undefined,
    dataUrl: normalizeBase64Image(b64, fallbackMime),
    actualParams: pickActualParams(item),
    revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
  }
}

function normalizeResponsePayload(value: unknown): ResponsesApiResponse | null {
  if (!isRecordValue(value)) return null
  return {
    ...value,
    ...(typeof value.id === 'string' ? { id: value.id } : { id: undefined }),
    output: normalizeResponsesOutputItems(value.output),
  }
}

function getStreamResponsePayload(event: Record<string, unknown>): ResponsesApiResponse | null {
  const response = event.response
  const payload = normalizeResponsePayload(response)
  if (payload) return payload

  const item = event.item
  const output = normalizeResponsesOutputItems([item])
  if (output.length) return { output }

  return null
}

async function parseAgentStreamResponse(
  response: Response,
  mime: string,
  signal?: AbortSignal,
  callerSignal?: AbortSignal,
  onTextDelta?: (delta: string) => void,
  onOutputItems?: (outputItems: ResponsesOutputItem[]) => void,
  onImageToolStarted?: (event: { toolCallId: string; outputIndex?: number }) => void | Promise<void>,
  onImagePartialImage?: (event: { toolCallId: string; image: string; partialImageIndex?: number; outputIndex?: number }) => void | Promise<void>,
  onImageToolCompleted?: (image: AgentApiResultImage) => void | Promise<void>,
  onImageToolFailed?: (event: AgentApiImageToolFailure) => void | Promise<void>,
): Promise<AgentApiResult> {
  let completedPayload: ResponsesApiResponse | null = null
  const outputItems: ResponsesOutputItem[] = []
  let streamedText = ''

  const publishOutputItems = (items: ResponsesOutputItem[], outputIndices?: Array<number | undefined>) => {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      const outputIndex = outputIndices?.[i]
      let index = item.id ? outputItems.findIndex((existing) => existing.id === item.id) : -1
      // `response.completed` snapshots can omit item ids; match by output slot before appending.
      if (index < 0 && !item.id && typeof outputIndex === "number" && outputIndex >= 0 && outputIndex < outputItems.length) {
        const candidate = outputItems[outputIndex]
        if (candidate?.type === item.type) index = outputIndex
      }
      if (index < 0 && !item.id && item.type) {
        // Fallback for snapshots that do not expose output indices.
        const sameTypeIndices = outputItems
          .map((existing, idx) => existing.type === item.type ? idx : -1)
          .filter((idx) => idx >= 0)
        if (sameTypeIndices.length === 1) index = sameTypeIndices[0]
      }
      if (index >= 0) outputItems[index] = item
      else outputItems.push(item)
    }
    onOutputItems?.([...outputItems])
  }

  const publishWebSearchStatus = (event: Record<string, unknown>, status: string, actionType?: string) => {
    const id = getStringValue(event, 'item_id')
    if (!id) return

    const index = outputItems.findIndex((item) => item.id === id)
    const current = index >= 0 ? outputItems[index] : { id, type: 'web_search_call' }
    const next: ResponsesOutputItem = {
      ...current,
      id,
      type: 'web_search_call',
      status,
      ...(actionType ? { action: { type: actionType } } : {}),
    }
    if (index >= 0) outputItems[index] = next
    else outputItems.push(next)
    onOutputItems?.([...outputItems])
  }

  await readJsonServerSentEvents(response, async (event) => {
    const type = getStringValue(event, 'type')

    if (type === 'response.image_generation_call.partial_image') {
      const toolCallId = getStringValue(event, 'item_id')
      const b64 = getStringValue(event, 'partial_image_b64')
      if (toolCallId && b64) {
        await onImagePartialImage?.({
          toolCallId,
          image: normalizeBase64Image(b64, mime),
          partialImageIndex: getNumberValue(event, 'partial_image_index'),
          outputIndex: getNumberValue(event, 'output_index'),
        })
      }
      return
    }

    if (type === 'response.web_search_call.searching') {
      publishWebSearchStatus(event, 'in_progress', 'search')
      return
    }
    if (type === 'response.web_search_call.completed') {
      publishWebSearchStatus(event, 'completed')
      return
    }
    if (type === 'response.web_search_call.failed') {
      publishWebSearchStatus(event, 'failed')
      return
    }
    if (type === 'response.web_search_call.in_progress') {
      publishWebSearchStatus(event, 'in_progress')
      return
    }

    if (type === 'response.output_text.delta') {
      const delta = getStringValue(event, 'delta')
      if (delta) {
        streamedText += delta
        onTextDelta?.(delta)
      }
      return
    }

    const payload = getStreamResponsePayload(event)
    if (!payload) return

    if (Array.isArray(payload.output)) {
      // `response.completed` uses the output array position as the implicit output index.
      const indices = type === "response.completed" ? payload.output.map((_, idx) => idx) : undefined
      publishOutputItems(payload.output, indices)
    }

    if (type === 'response.output_item.added') {
      const item = payload.output?.[0]
      if (item?.type === 'image_generation_call' && typeof item.id === 'string' && item.id) {
        await onImageToolStarted?.({
          toolCallId: item.id,
          outputIndex: getNumberValue(event, 'output_index'),
        })
      }
      return
    }

    if (type === 'response.output_item.done') {
      const item = payload.output?.[0]
      const imageFailure = getImageToolFailureFromOutputItem(event, item)
      if (imageFailure) {
        await onImageToolFailed?.(imageFailure)
        return
      }

      const image = item ? extractImageFromOutputItem(item, mime) : null
      if (image) await onImageToolCompleted?.(image)
      return
    }

    if (type === 'response.completed' || isRecordValue(event.response)) {
      completedPayload = payload
    }
  }, {
    signals: [signal, callerSignal],
    formatErrorMessage: appendStreamingFormatHint,
    getEventErrorMessage: getStreamEventErrorMessage,
  })

  throwIfAborted(signal, callerSignal)
  const payload: ResponsesApiResponse | null = completedPayload ?? (outputItems.length ? { output: outputItems } : null)
  if (!payload) throw new Error('Agent 流式接口未返回最终响应数据')

  const text = extractText(payload) || streamedText.trim()
  return {
    responseId: payload.id,
    text,
    images: extractImages(payload, mime),
    outputItems: payload.output ?? [],
    rawResponsePayload: JSON.stringify(payload, null, 2),
  }
}

export async function callAgentResponsesApi(opts: {
  settings: AppSettings
  profile: ApiProfile
  imageProfile?: ApiProfile
  params: TaskParams
  input: unknown
  maskDataUrl?: string
  signal?: AbortSignal
  onTextDelta?: (delta: string) => void
  onOutputItems?: (outputItems: ResponsesOutputItem[]) => void
  onImageToolStarted?: (event: { toolCallId: string; outputIndex?: number }) => void | Promise<void>
  onImagePartialImage?: (event: { toolCallId: string; image: string; partialImageIndex?: number; outputIndex?: number }) => void | Promise<void>
  onImageToolCompleted?: (image: AgentApiResultImage) => void | Promise<void>
  onImageToolFailed?: (event: AgentApiImageToolFailure) => void | Promise<void>
}): Promise<AgentApiResult> {
  const { settings, profile, imageProfile, params, input, maskDataUrl, signal, onTextDelta, onOutputItems, onImageToolStarted, onImagePartialImage, onImageToolCompleted, onImageToolFailed } = opts
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    const body: Record<string, unknown> = {
      model: profile.model || settings.model,
      instructions: createAgentInstructions(settings, (imageProfile ?? profile).codexCli ? params.size : undefined),
      input,
      tools: createAgentTools(params, profile, settings, maskDataUrl),
    }
    if (profile.reasoningEffort) body.reasoning = { effort: profile.reasoningEffort }
    if (profile.streamImages) {
      body.stream = true
    }

    const response = await fetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy, isServerManagedApiConfigEnabled() ? 'chat' : 'default'), {
      method: 'POST',
      headers: createHeaders(profile),
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorMessage = await getApiErrorMessage(response)
      throw new Error(maybeAppendStreamingHint(errorMessage, response.status, profile.streamImages))
    }

    if (profile.streamImages && isEventStreamResponse(response)) {
      return parseAgentStreamResponse(response, mime, controller.signal, signal, onTextDelta, onOutputItems, onImageToolStarted, onImagePartialImage, onImageToolCompleted, onImageToolFailed)
    }

    const rawPayload = await response.json() as unknown
    const payload = normalizeResponsePayload(rawPayload)
    if (!payload) throw new Error('Agent 接口返回格式无效')
    throwIfAborted(controller.signal, signal)
    return {
      responseId: payload.id,
      text: extractText(payload),
      images: extractImages(payload, mime),
      outputItems: payload.output,
      rawResponsePayload: JSON.stringify(payload, null, 2),
    }
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

export async function callAgentConversationTitleApi(opts: {
  settings: AppSettings
  profile: ApiProfile
  prompt: string
  imageDataUrls?: string[]
  signal?: AbortSignal
}): Promise<string> {
  const { settings, profile, prompt, imageDataUrls, signal } = opts
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    const content: Array<Record<string, string>> = [
      { type: 'input_text', text: `The following is the first message the user sent in a conversation. Generate a title for this conversation.\n\n${prompt}` },
    ]
    for (const dataUrl of imageDataUrls ?? []) {
      content.push({ type: 'input_image', image_url: dataUrl })
    }

    const body: Record<string, unknown> = {
      model: profile.model || settings.model,
      instructions: AGENT_TITLE_INSTRUCTIONS,
      input: [{ role: 'user', content }],
    }
    if (profile.reasoningEffort) body.reasoning = { effort: profile.reasoningEffort }

    const response = await fetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy, isServerManagedApiConfigEnabled() ? 'chat' : 'default'), {
      method: 'POST',
      headers: createHeaders(profile),
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response))
    }

    const payload = normalizeResponsePayload(await response.json())
    if (!payload) throw new Error('Agent 标题接口返回格式无效')
    return parseAgentConversationTitleXml(extractText(payload))
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

// ---------------------------------------------------------------------------
// Batch image generation: execute a single image via Responses API.
// Uses the same pattern as gallery Responses API mode.
// ---------------------------------------------------------------------------

export interface BatchImageCallResult {
  /** The batch item id from the model's function call */
  batchItemId: string
  image: AgentApiResultImage | null
  error: string | null
  rawResponsePayload?: string
}

/**
 * Generate a single image using Responses API.
 * This mirrors the gallery mode's callResponsesImageApiSingle pattern.
 */
export async function callBatchImageSingle(opts: {
  profile: ApiProfile
  params: TaskParams
  batchItemId: string
  prompt: string
  referenceImageDataUrls: string[]
  referenceIds?: string[]
  allowPromptRewrite?: boolean
  signal?: AbortSignal
  onImageToolStarted?: () => void | Promise<void>
  onPartialImage?: (event: { image: string; partialImageIndex?: number }) => void | Promise<void>
  onImageToolCompleted?: (image: AgentApiResultImage) => void | Promise<void>
}): Promise<BatchImageCallResult> {
  const { profile, params, batchItemId, prompt, referenceImageDataUrls, referenceIds, allowPromptRewrite, signal, onImageToolStarted, onPartialImage, onImageToolCompleted } = opts
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    const referenceMapping = referenceImageDataUrls.length > 0
      ? `Attached reference images correspond to these ids, in order: ${(referenceIds ?? []).map((id) => `<ref id="${id}" />`).join(', ') || 'reference images'}.`
      : ''
    const promptText = allowPromptRewrite ? prompt : `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`
    const guardedPrompt = [referenceMapping, promptText].filter(Boolean).join('\n\n')
    let input: unknown
    if (referenceImageDataUrls.length > 0) {
      input = [{
        role: 'user',
        content: [
          { type: 'input_text', text: guardedPrompt },
          ...referenceImageDataUrls.map((dataUrl) => ({
            type: 'input_image',
            image_url: dataUrl,
          })),
        ],
      }]
    } else {
      input = guardedPrompt
    }

    // Build image_generation tool with current params
    const tool: Record<string, unknown> = {
      type: 'image_generation',
      action: referenceImageDataUrls.length > 0 ? 'auto' : 'generate',
      output_format: params.output_format,
      moderation: params.moderation,
      quality: params.quality,
    }
    if (!profile.codexCli) {
      tool.size = params.size
    }
    if (params.output_format !== 'png' && params.output_compression != null) {
      tool.output_compression = params.output_compression
    }
    if (profile.streamImages) {
      tool.partial_images = profile.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES
    }

    const body: Record<string, unknown> = {
      model: profile.model,
      input,
      tools: [tool],
      tool_choice: 'required',
    }
    if (profile.reasoningEffort) body.reasoning = { effort: profile.reasoningEffort }
    if (profile.streamImages) {
      body.stream = true
    }

    const response = await fetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy, isServerManagedApiConfigEnabled() ? 'chat' : 'default'), {
      method: 'POST',
      headers: createHeaders(profile),
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorMsg = await getApiErrorMessage(response)
      return { batchItemId, image: null, error: maybeAppendStreamingHint(errorMsg, response.status, profile.streamImages) }
    }

    // Handle streaming
    if (profile.streamImages && isEventStreamResponse(response)) {
      await onImageToolStarted?.()
      let completedImage: AgentApiResultImage | null = null
      let rawPayload: string | undefined

      await readJsonServerSentEvents(response, async (event) => {
        const type = getStringValue(event, 'type')

        if (type === 'response.image_generation_call.partial_image') {
          const b64 = getStringValue(event, 'partial_image_b64')
          if (b64) {
            await onPartialImage?.({
              image: normalizeBase64Image(b64, mime),
              partialImageIndex: getNumberValue(event, 'partial_image_index'),
            })
          }
          return
        }

        if (type === 'response.output_item.done') {
          const payload = getStreamResponsePayload(event)
          const item = payload?.output?.[0]
          if (item) {
            const img = extractImageFromOutputItem(item, mime)
            if (img) {
              completedImage = img
              await onImageToolCompleted?.(img)
            }
          }
          return
        }

        if (type === 'response.completed' || isRecordValue(event.response)) {
          const payload = getStreamResponsePayload(event)
          if (payload) rawPayload = JSON.stringify(payload, null, 2)
          if (!completedImage && payload) {
            const images = extractImages(payload, mime)
            if (images.length > 0) {
              completedImage = images[0]
              await onImageToolCompleted?.(completedImage)
            }
          }
        }
      }, {
        signals: [controller.signal, signal],
        formatErrorMessage: appendStreamingFormatHint,
        getEventErrorMessage: getStreamEventErrorMessage,
      })

      return {
        batchItemId,
        image: completedImage,
        error: completedImage ? null : '流式响应未返回图片',
        rawResponsePayload: rawPayload,
      }
    }

    // Non-streaming
    const payload = normalizeResponsePayload(await response.json())
    if (!payload) throw new Error('图像接口返回格式无效')
    const images = extractImages(payload, mime)
    const image = images[0] ?? null
    if (image) await onImageToolCompleted?.(image)
    return {
      batchItemId,
      image,
      error: image ? null : '接口未返回图片数据',
      rawResponsePayload: JSON.stringify(payload, null, 2),
    }
  } catch (err) {
    if (controller.signal.aborted || signal?.aborted) {
      return { batchItemId, image: null, error: '请求已取消' }
    }
    return { batchItemId, image: null, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

/** Parse the arguments of a generate_image_batch function call */
export function parseBatchImageCallArguments(args: string): Array<{ id: string; prompt: string; size: string }> | null {
  try {
    const parsed = JSON.parse(args) as { images?: unknown }
    if (!parsed || !Array.isArray(parsed.images)) return null
    const items: Array<{ id: string; prompt: string; size: string }> = []
    const ids = new Set<string>()
    for (const raw of parsed.images) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
      if (!prompt) continue
      const baseId = (typeof item.id === 'string' ? item.id.trim() : '') || `image_${items.length + 1}`
      let id = baseId
      for (let suffix = 2; ids.has(id); suffix++) id = `${baseId}_${suffix}`
      ids.add(id)
      items.push({ id, prompt, size: normalizeAgentImageSize(item.size) })
    }
    return items.length > 0 ? items : null
  } catch {
    return null
  }
}
