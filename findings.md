# Findings & Decisions

## 服务端异步生图任务（2026-09-04）

- 当前 `submitTask()` 先写入浏览器 IndexedDB，再由 `executeTask()` 直接调用 `callImageApi()`；Pixel Images API 没有可查询的上游 task ID，切换页面只能依赖重提，无法保证原请求继续运行。
- 异步边界：Docker 的 `SERVER_MANAGED_API_CONFIG=true` 模式启用同源 `/api-tasks`；Vercel/GitHub Pages 等纯静态部署继续使用原同步链路。
- 服务端任务服务保存任务 JSON、输入 data URL 和最终结果到持久化目录；前端只提交提示词、参数和图片数据，不提交 API URL、模型或 Key。
- 服务端按尺寸像素预算选择 `IMAGE_1K_*` 或 `IMAGE_4K_*` 配置，默认调用 Images API；任务 ID 写回 `TaskRecord`，刷新后直接查询原任务，避免重复提交。
- Agent 的 Responses 文本会话仍是浏览器流式链路；本次异步化覆盖画廊/Studio 的固定图像生成和编辑任务，后续如需 Agent 整轮离线执行需单独设计会话队列。

## 服务端锁定配置下的流式开关（2026-09-04）

- 根因一：`SettingsModal` 对 `activeProfileLocked` 直接设置流式开关和中间图像数控件为 disabled。
- 根因二：即使绕过 UI，`updateActiveProfile`/`commitActiveProfilePatch` 以及 `enforcePresetConfigPolicy` 仍会拒绝或覆盖锁定 Profile 的流式字段。
- 根因三：服务端模式的 `normalizeSettings()` 每次保存都会重建默认 Profile，导致开关刚改完就恢复默认值。
- 修复边界：服务端继续锁定 URL、模型、API 类型、代理和其他部署参数；仅 OpenAI Profile 的 `streamImages`、`streamPartialImages` 作为本地体验偏好允许修改。
- 默认值暂不改为开启：当前图像请求对 Pixel Images API 不发送流式字段，避免升级后把不支持 SSE 的图像网关误切到流式；Agent Responses Profile 本来已默认开启流式。
- 线上资源已更新为修复后的构建；已有打开页面可能仍持有旧 JavaScript，需要强制刷新后再操作。

## 服务端固定模型与按分辨率路由（2026-09-04）

- 待确认：当前项目是 React/Vite 静态前端，需检查 Docker/Nginx 是否已有同源动态配置或代理入口；仅用 Vite 环境变量会把 API Key 编译进客户端，不是真正的服务端密钥托管。
- 需求路由：聊天 `https://ai-pixel.online/v1` + `gpt-5.6-luna`；1K 生图 `https://ai-pixel.online/v1` + `gpt-image-2`；4K 生图 `https://direct.linkai.pics/v1` + `gpt-image-2`。
- Docker 默认启用 `SERVER_MANAGED_API_CONFIG=true`；配置文件由 `/etc/gpt-image-playground/api-config.env` 只读挂载，启动脚本将其值提供给 Nginx 模板，不注入前端资源。
- 客户端仅保留 `/api-proxy/chat/`、`/api-proxy/image-1k/`、`/api-proxy/image-4k/` 路径；图片像素预算不超过 1,572,864 走 1K，其余显式尺寸（包括 2K/4K）走 4K。
- 服务端模式下 `normalizeSettings()` 丢弃浏览器持久化的 API Profile/自定义服务商，并固定 Agent 为 hybrid；API Key 弹窗关闭，设置页的 Key 输入只读。
- 非阻塞错误：一次产物扫描命令因 shell 引号不完整失败，未影响代码验证。
- 最终验证确认普通构建产物不包含 `direct.linkai.pics` 或服务端 Key；Docker 运行时才由 Nginx 模板读取并使用三路配置。

## 灵感库本地化（2026-08-25）

- 用户确认不需要服务启动后的定时同步，改为仓库内提供手动拉取脚本。
- 当前前端直接读取 GitHub Raw 的 `data/cases.json` 和 `data/images/case*`，用户网络和 GitHub 可用性会直接影响灵感库。
- 本地化目标目录采用 Vite 原样复制的 `public/prompt-library`；开发、静态构建和 Nginx 部署均可通过 `/prompt-library/...` 同源访问。
- 上游快照约 529 条清单、532 张图片、总计约 154 MB；会显著增大 Git 仓库，但已知单文件不超过 GitHub 100 MB 上限。
- 同步脚本只复制清单、532 张 `case*` 案例图片和来源/许可说明，不保留上游 `.git`，并清理已从上游删除的旧图片；上游图片目录中的 27 个赞助商、站点预览和分类封面不纳入快照。

## Requirements

- 使用已拉下来的 `gpt_image_playground` 作为功能骨架。
- 目标 API 是 Pixel API 的 OpenAI-compatible Images API：`/v1/images/generations` 与 `/v1/images/edits`。
- 生图和编辑图需要在同一个创作工作流中完成。
- 画布交互参考 InvokeAI。
- 遮罩编辑使用开源 `tui-image-editor`。

## Research Findings

- 仓库技术栈：React 19、Vite、TypeScript、Zustand、Tailwind CSS。
- 现有 `src/lib/openaiCompatibleImageApi.ts` 已支持：
  - JSON 生图请求
  - multipart 编辑请求
  - `image[]` 参考图上传
  - `mask` PNG 上传
  - `data[].url` 和 `data[].b64_json` 响应
- 现有 `src/store.ts` 已有 `prompt`、`inputImages`、`maskDraft`、`maskEditorImageId` 和 `submitTask()`。
- 现有 `src/components/MaskEditorModal.tsx` 是自研 Canvas 编辑器，具备缩放、平移、画笔、橡皮、撤销/重做和遮罩尺寸校验。
- 现有主界面是 Gallery + 固定底部 InputBar；可通过 `appMode` 扩展入口，但不能破坏 Agent 模式。
- `tui-image-editor@3.15.3` 为 MIT，提供 `loadImageFromURL`、`startDrawingMode`、`setBrush`、`undo`、`redo`、`toDataURL` 和事件监听。
- `InvokeAI` 为 Apache-2.0，适合作为画布和 Board/Gallery 交互参考，不直接复制其完整实现。
- `ComfyUI` 为 GPL-3.0、AUTOMATIC1111 为 AGPL-3.0，不作为代码移植来源。

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| 新增 `StudioWorkspace` 组件 | 把三栏布局与原有 Gallery 解耦，方便渐进式集成 |
| 新增 `TuiMaskEditorModal` 组件 | 先以独立入口验证 tui-image-editor，再决定是否替换旧编辑器 |
| Studio 的提交动作调用 `submitTask()` | 保持任务持久化、错误处理、历史和 API profile 逻辑一致 |
| 当前输入状态继续由 Zustand 管理 | 避免 Studio 和 InputBar 产生两份 prompt/图片/遮罩状态 |
| 结果区读取现有 `TaskGrid` | 复用历史筛选、收藏、删除和详情能力 |

## 部署默认配置固化（2026-08-24）

- 用户最终要求新部署只填写 API Key，Pixel API URL 也固定在应用默认配置中。
- 当前 Pixel 适配同时识别 `ai-pixel.online` 与 `api.ai-pixel.online`；项目编辑接口测试已经使用完整 API 地址 `https://api.ai-pixel.online/v1`，固定默认值采用该 API 子域名与 `/v1` 前缀。
- 旧版持久化设置必须继续优先于部署默认值，避免升级后覆盖已有用户 Profile；全新部署或全新浏览器状态才直接使用固化默认配置。
- 前端环境变量中的 Key 会进入构建产物或容器运行时替换后的 JavaScript，不能视为服务端秘密。
- 现有 `VITE_DEFAULT_API_URL` / `DEFAULT_API_URL` 继续保留为高级兼容覆盖项，但普通部署不再需要填写；新增 Key 变量后，优先级为 URL 查询参数 `apiKey` > 部署 Key 环境变量 > 空值。
- `normalizeSettings()` 的 legacy Profile 在缺少 `apiKey` 时当前显式回退空字符串，需要改为部署默认 Key；显式保存的空字符串仍应保留，表示用户主动清空。
- `isDefaultOpenAIProfile()` 当前把空 Key 和“默认”名称写死，用于判断配置是否仍是未修改默认项；固化 Pixel 默认值时必须同步基于新的默认 Profile 比较，否则导入/预置合并行为会退化。
- Docker 已有构建占位符→容器启动时替换的机制，新增 Key 可沿用同一链路；URL 变量继续存在仅用于旧部署和高级覆盖。

## 页面关闭后的任务生命周期（2026-08-24）

- Pixel 当前公开文档只列出同步 `POST /v1/images/generations` 和 `POST /v1/images/edits`，文档 API 导航中未发现可保存 `task_id` 后查询的异步图片任务接口。
- 当前应用已能恢复 fal.ai 队列和带 `taskIdPath + poll` 的自定义异步供应商：任务 ID 写入 IndexedDB，`initStore()` 重开后自动继续轮询。
- Pixel 请求当前由页面直接持有同步 fetch；`markInterruptedOpenAIRunningTasks()` 会在重开时把这类 `running` 任务标记为“请求中断”。刷新或关闭页面会终止浏览器请求，单纯保留前端状态无法恢复结果。
- Service Worker、`keepalive` 或 Background Sync 都不能可靠保证大文件、最长 600 秒的同步生图请求在浏览器完全关闭后继续；真正保证需要同源部署端后台接收任务、立即返回任务 ID，并由服务端持有 Pixel 请求和结果。
- 推荐实现边界：Docker 部署内增加轻量后台任务服务与持久化任务结果，前端保存后台任务 ID/恢复令牌并重开轮询；纯静态 GitHub Pages/Vercel/Cloudflare Assets 没有常驻后台时继续回退同步请求，并明确提示该部署不支持关闭页面继续运行。
- Agent 的文本 Responses 链路仍是浏览器流式会话，不能仅靠图像后台服务跨关闭恢复；本次后台化优先覆盖 Gallery/Studio 的 Pixel 生图和编辑任务，以及可独立提交的 Pixel 图像调用。

### 当前可落地优化

- 在没有 Pixel 异步 task_id 的前提下，应用重开时保留同步图像任务的 `running` 状态，并使用原任务 ID、Prompt、参数和 IndexedDB 输入图片自动重新提交；避免刷新后直接显示“请求中断”。
- 同一页面内通过执行中任务集合防止初始化和其他入口重复接管同一个任务。
- 如果 Key 尚未填写，任务先保持运行态；用户在启动 Key 弹窗保存后立即触发恢复提交。
- 设置页或预置配置只要把相关 Profile 的 Key 从空值补齐，也会自动扫描并恢复等待中的任务，不依赖必须从启动弹窗保存。
- 页面触发 `beforeunload/pagehide` 后，浏览器主动终止请求不会再把任务写成失败；同页 `pageshow` 或重开初始化会重新接管。恢复请求会获得新的完整超时时间，避免旧任务因创建时间较早而立即被 watchdog 判定超时。
- 这属于“刷新后自动重试恢复”，不是“原请求在浏览器关闭后仍持续运行”。上游可能已完成原请求但结果无法取回，因此极端情况下可能产生重复计费；真正的关闭后后台执行仍需 Pixel 提供异步查询接口或增加自有服务端队列。

## Implementation Notes

- Pixel API 的文档地址可以填写根域名或带 `/v1` 的地址；请求构建复用仓库现有 `buildApiUrl`，避免重复拼接版本路径。
- Pixel Generations 只发送文档中的 `model`、`prompt`、`size`、`n`、`response_format` 字段；Pixel Edits 使用 `model`、`image`、`prompt`、`mask`、`size`、`n`。
- Studio 素材库允许多张图片，但 Pixel Edits 提交时只发送当前选中的底图，因为文档将 `image` 定义为单个必填文件；其他输入图不会被静默拼接到请求。
- TUI 画笔输出是“可编辑区域”预览层，保存时逐像素反转为 API 语义：白色不透明=保护，透明=可编辑，并经过现有遮罩尺寸/覆盖率校验。
- `tui-image-editor` 通过动态 import 加载，避免把约 700KB 编辑器代码放入普通画廊首屏包。

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| 首次安装后 npm bin 链接状态异常 | 重新执行 npm install，构建恢复 |

## Resources

- [Pixel image generations 文档](https://docs.ai-pixel.online/docs/api/image-generations)
- [Pixel image edits 文档](https://docs.ai-pixel.online/docs/api/image-edits)
- [gpt_image_playground](https://github.com/CookSleep/gpt_image_playground)
- [InvokeAI](https://github.com/invoke-ai/InvokeAI)
- [tui-image-editor](https://github.com/nhn/tui.image-editor)

## Visual/Browser Findings

- 现有桌面截图为深色界面，顶部有 Gallery/Agent 切换，中部为三列任务卡，底部为悬浮 prompt 与参数栏。
- 推荐 Studio 采用 `#0B0D10` 背景、`#151922` 面板、紫色主操作和青色编辑辅助色；按钮保持至少 44px 触控区域。

## Verification Findings

- 当前生产构建已通过，TUI 编辑器被拆分为独立约 731KB 的懒加载 chunk，没有进入普通画廊首屏主 chunk。
- 当前完整测试为 34 个测试文件、519 项测试全部通过，包括 Pixel generations/edits 请求契约与 TUI 遮罩转换测试。
- 构建中的 `backbround-color` 警告来自 `tui-image-editor` 发布包 CSS，不是项目新增样式；不影响构建成功。
- Chrome smoke test 证实 Studio 点击提交会真实走 Pixel 路径：无输入图为 JSON `/v1/images/generations`，有输入图为 multipart `/v1/images/edits`；带 TUI 遮罩时 multipart 额外包含一个 `mask` 文件。
- Pixel 文档中的 `size` 是可选字段，因此客户端内部 `auto` 值不会发送给 Pixel；显式尺寸仍会发送。
- TUI 遮罩重开时使用半透明紫色编辑层显示可编辑区域，保护区透明显示底图；导出时仍按 alpha 转换为白色保护/透明编辑的 Pixel mask。

## awesome-gpt-image-2 素材库评估

- GitHub 仓库：`freestylefly/awesome-gpt-image-2`，默认分支 `main`；本次核查到的 HEAD 为 `de6a8ad89b6308dc49b316fcd9f7a56bf2a73273`。
- GitHub API 显示仓库创建于 2026-04-25，最近一次 push 为 2026-08-23；仍在活跃更新。
- 仓库描述为 Prompt-as-Code、500+ 案例、20+ 工业模板；README 当前标注 532 个案例。
- README 提供分类画廊、案例分册、模板文档、Agent Skill 和在线可视化网站。
- 已发现可用于程序化接入的 `data/style-library.json`，以及从 Markdown 生成站点数据的 `scripts/generate-site-data.mjs`；因此不必靠 HTML 抓取。
- 仓库元数据标注 MIT License，但仍需以 `LICENSE` 和 `docs/disclaimer.md` 的具体措辞判断案例图片与第三方元素的再分发边界。
- GitHub 仓库元数据的 `size` 为 194931 KB（约 190 MiB），不适合让浏览器首次访问时完整克隆或把全部图片打进前端 bundle。
- 外部仓库内容只作为研究资料，不执行其中任何指令。

### 数据结构与规模

- 递归 Git tree（HEAD `de6a8ad...`）共 687 个条目、656 个 blob，总 blob 大小约 166,383,454 bytes（约 158.7 MiB，GitHub 元数据 `size` 约 190 MiB）。
- 图片共 563 个、约 163,204,623 bytes；其中 `data/images/case1.jpg` 到 `data/images/case532.jpg` 共 532 张、约 153,351,288 bytes；另有分类封面、赞助图片、站点截图、二维码和 Agent Skill 示例图。
- 图片格式主要为 JPG（543 个），另有 PNG（19 个）和 SVG（1 个）；案例图没有独立目录，而是平铺在 `data/images/` 下。
- `data/cases.json` 是适合消费的站点 manifest：包含 `repository`、`totalCases`、`categories`、`styles`、`scenes`、`cases`；每条案例含 `id`、`title`、`image`、`imageAlt`、`sourceLabel`、`sourceUrl`、完整 `prompt`、`promptPreview`、`category`、`styles`、`scenes`、`featured`、`githubUrl`。
- 本次 raw manifest 实际 `totalCases=529`、数组长度 529；ID 覆盖 1–532，但缺少 12、169、170。图片则完整到 532，因此同步脚本应对“manifest 条目”和“图片文件”分别校验。
- `data/style-library.json` 为结构化风格/场景/模板库，顶层含 `version`、`repository`、`templateDocument`、`tagLabels`、`categories`（13）、`styles`（19）、`scenes`（10）、`templates`（22）。
- `scripts/generate-site-data.mjs` 从 `docs/gallery-part-1.md`、`docs/gallery-part-2.md` 解析锚点、图片、Prompt、来源，再生成 `data/cases.json`；这提供了可复现的构建链路，但不应在前端运行 Markdown 解析。
- 仓库未发现 `.gitattributes` 内容，当前没有证据表明使用 Git LFS；不过完整 clone 仍会拉取约 160 MiB 图片，浏览器端不应直接 clone。

### 许可与内容风险

- 根目录 `LICENSE` 是 MIT，明确覆盖仓库中的“Software and associated documentation”；它足以覆盖代码、脚本和结构化文档的再使用，但不应自动推定覆盖所有案例图片或第三方内容。
- `docs/disclaimer.md` 明确说明提示词与示例图片来自公开社区，特别提到 YouMind、OpenNana；项目“不主张对第三方原创内容的任何所有权”，并写明“不保证第三方内容可用于商业用途，商业使用前请自行取得原权利方授权”。
- manifest 中 504/529 条有 `sourceUrl`，来源多为 X 等第三方页面；25 条没有来源 URL。产品若展示案例，应保留 `sourceLabel`、`sourceUrl`、仓库链接和许可证/免责声明入口。
- 不建议把全部案例原图复制进商业产品的自有 CDN 或当作用户可自由下载的素材包；更稳妥的是把它们作为带来源的灵感/预览库，用户点击“使用 Prompt”时只复制文本，图片按需从 GitHub Raw 加载，必要时再由用户明确导入个人素材。

### 对当前 Studio 的适配结论

- 当前 Studio 的 `InputImage` 是本地 data URL + IndexedDB；远程案例图不能直接当 `dataUrl`，需要按需 fetch → Blob/File → 写入现有素材流程，且应限制大小/并发并处理 Raw 失败。
- 第一版推荐只同步轻量 manifest（约 1.3 MB，实际生产可裁剪为 `id/title/thumbnail/prompt/category/styles/scenes/sourceUrl`），案例图用 `raw.githubusercontent.com/.../data/images/case{id}.jpg` 按需加载。
- 缩略图可使用 GitHub Raw 原图配合 `loading="lazy"`，或在服务端/构建时生成 WebP 缩略图；不要把 532 张图 import 进 Vite bundle。
- “使用 Prompt”可以直接填充现有 Zustand `prompt`；“导入为参考图”则下载单张图片并交给现有 `inputImages`/IndexedDB。Pixel 编辑提交仍只选一张底图，符合当前 API 约束。
- 正式部署推荐后端定时固定 commit 同步 manifest，记录 `sourceCommit` 和 `fetchedAt`，并提供上游下架/更新后的清理机制；纯前端 MVP 可先用固定 raw URL + 远程 manifest。

### 已实现的第一版边界

- 新增 `src/lib/awesomePromptLibrary.ts`，默认从 `data/cases.json` 获取约 1.3 MB manifest；请求有 15 秒超时、失败后清除缓存，字段会经过类型和 URL 校验。
- 新增 `src/components/PromptLibraryPanel.tsx`，只渲染当前筛选结果的前 18 条，图片使用 `loading="lazy"` 和固定宽高，避免首屏布局跳动与全量图片下载。
- 每张卡片提供“使用”“复制”“导入为参考图”和来源链接；导入复用既有 `addImageFromUrl`，最终进入 IndexedDB 和 `inputImages`。
- 刷新/重试会清理 manifest 缓存后重新请求；图片 URL 仅允许映射到 `caseN.(jpg|jpeg|png|webp)`，异常路径回退到编号图片，避免把外部清单中的任意 URL 当作图片源。
- UI 采用当前 Studio 的 OLED 深色视觉，不新增依赖；移动端保持单列 Studio，素材库卡片两列，按钮/链接目标至少 44px。

## Agent 语言模型配置问题

- 2026-08-24 追加确认：Pixel 服务同时提供 Responses 文本模型，默认应使用 `gpt-5.6-luna`，并与 `gpt-image-2` 共用 `https://api.ai-pixel.online/v1` 和同一个 Key。
- 当前出现 `https://api.openai.com/v1` 的直接原因是 `SettingsModal.createAgentTextProfile` 对 Pixel Profile 主动禁用复用，并将 Agent Base URL 硬编码为 OpenAI 官方地址。
- 为确保已有浏览器升级后生效，需要提升 Zustand 持久化版本，并仅迁移此前由应用自动创建的默认 Agent Profile，避免覆盖用户自己配置的 Responses 服务。

- Agent 请求实际使用 `getAgentTextApiProfile(settings)` 返回 Profile 的 `model` 字段，请求层没有把语言模型写死。
- 当前 Agent 配置页只允许选择“文本模型 API 配置”，没有直接显示或编辑模型 ID；当“使用独立的 API 配置”为“关闭”时，整段文本模型设置还会被隐藏。
- Agent 文本 Profile 仅接受 `provider=openai` 且 `apiMode=responses` 的配置。Pixel 的 `gpt-image-2` 配置属于 Images API，因此不会进入文本模型下拉列表。
- 推荐保持 Profile 作为配置原子，因为模型必须与 API URL、API Key、Responses API 模式和推理强度配套；UI 应把这层关系解释清楚，并提供就地修改模型和跳转 API 配置的恢复路径。
- UI/UX Pro Max 检查建议：空状态必须包含下一步操作，错误/限制提示应靠近字段，主要触控目标至少 44px，并保留明显的键盘焦点状态。
- 已修复：Agent 配置页现在始终展示“语言模型”卡片，直接显示/修改实际模型 ID，并标出所选 Profile 与配置完整性。
- 新建 Responses 配置时不再复制 Pixel 的图像 API 地址和 Key，避免把 Images-only 服务误当语言模型服务；Pixel 配置保留给 Studio/混合模式的图像工具。
- Responses Profile 即使尚未填写 Key 也会保留在下拉列表中，并显示“配置不完整”及具体缺失字段，不再从界面消失。

## 微信小程序化与上架调研（2026-08-24）

### 当前 Web 项目迁移判断

- 当前项目是 React 19 + Vite Web 应用，不能直接上传为微信小程序；需要使用微信原生小程序、Taro 或 uni-app 重写视图层。
- 当前代码依赖 IndexedDB、DOM/CSS、`window`/`document`、`createPortal`、拖拽事件、浏览器文件输入、剪贴板和 `URL.createObjectURL`；这些能力不能原样搬到小程序，需要替换为 `wx` API、Canvas、文件系统和小程序页面/组件。
- 当前 API 配置允许用户在客户端填写任意 OpenAI-compatible URL 和 API Key。小程序要求在后台配置 HTTPS 服务器域名，且不应把平台/服务端密钥放进客户端；建议改为自有后端代理，服务端托管 Pixel/OpenAI Key。
- 图片生成、Agent SSE/流式响应、图片存储和任务历史建议由后端承接；小程序端只传 prompt/图片文件并接收任务状态，避免把大量 base64 放进本地存储。

### 官方规则依据

- 微信开发文档的网络要求：`wx.request`、图片等网络资源需使用已配置的服务器域名；小程序后台「开发 → 开发设置 → 服务器域名」配置，生产请求要求 HTTPS，证书需有效。
- 《生成式人工智能服务管理暂行办法》（国家网信办，2023-08-15施行）适用于向中国境内公众提供生成文本、图片、音频、视频等内容的服务，也明确通过可编程接口提供服务的组织/个人属于提供者。
- 该办法要求履行网络信息内容生产者责任、保护输入信息与使用记录、处理违法内容、按深度合成规定对图片等生成内容标识；具有舆论属性或社会动员能力的服务，还涉及安全评估和算法备案。
- 2025 年起人工智能生成合成内容标识相关要求进一步落地；上线前应让法务/合规确认图片显式/隐式标识、投诉举报、未成年人保护和隐私政策。

### 同类产品形态与审核经验

- 可参考即梦AI、通义万相、美图设计室、稿定设计等产品：核心入口通常是“生成/编辑→结果预览→保存/分享”，不会把上游 API Key 交给用户；会有内容安全拦截、生成结果标识、用户协议/隐私政策和投诉举报入口。
- “纯工具 + 用户自带 Key + 任意第三方 URL”适合 Web/开发者工具，但不适合小程序首发：网络域名不可控、密钥和个人信息流向难解释、生成内容责任边界不清，容易在审核环节被要求整改。
