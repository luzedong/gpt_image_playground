# Progress Log

## Session: 2026-09-05 — Phase 21 完成

- 定位到服务端异步 Agent 使用 `stream: false`，客户端只在 `/result` 完成后提交助手消息，导致文本和“生图生成中”一起延迟到整轮结束。
- 服务端改为读取 Responses SSE，并将文本增量、工具调用、待生成图片和已完成图片写入持久化进度快照；新增 `/api-agent-tasks/:id/progress` 结果接口。
- 前端状态轮询间隔调整为 800ms；文本进度会立即更新助手消息，检测到图像工具调用后创建 running 任务卡，图片完成后增量写入画廊；页面重开继续读取同一个 `serverTaskId`。
- 本地进程级 smoke 复现通过：文本先出现、图像任务 `pending=1`、图片完成后才进入下一轮；全量测试 37 个文件、551 项通过，生产构建和 Node 语法检查通过。
- 提交 `ce05369` 已推送；`jdy` 已拉取、构建并运行镜像 `sha256:00107c67709f9b45f9687856b7d32ac3126efdb03209e5d8a427b4666b8a24f4`。
- 线上验证通过：首页、Agent `?meta=1`、`/progress`、`/result` 均返回 200，配置挂载、任务数据挂载和 Node 任务进程正常。

## Session: 2026-09-05 — Phase 20 完成

- 发现 `jdy` 的 Git 工作区已是 `cd98a10`，但运行容器仍是旧镜像；容器内没有新的 Agent `meta=1`/`result` 路由。
- 在 `/root/gpt_image_playground` 重新构建 `gpt-image-playground:latest`，镜像摘要为 `sha256:e3159876d755379b37de67b3af1145707d16c1e90d603f1471e8eee5e7226486`。
- 重建容器时保留 `unless-stopped`、`5173:80`、只读 API 配置挂载和 `/var/lib/gpt-image-playground` 持久化挂载，没有删除历史任务数据。
- 线上验证通过：首页 HTTP 200，Node `async-task-server.mjs` 正常运行；`mtnnapen1a5cm?meta=1` 返回 200 且仅 130 bytes，`/result` 返回 200 且结果约 2.49 MB。
- Nginx Agent 路由已生效并关闭 `proxy_buffering`；远端容器运行新镜像摘要，任务数据仍保留。
- 本地验证通过：37 个测试文件、550 项测试；`npm run build`、Node 语法检查、部署脚本 shell 检查和 `git diff --check` 均通过。
- Phase 20 完成。用户侧需对页面执行强制刷新，再重新发起 Agent 生图；切到后台或重新打开对话时应继续使用原服务端任务 ID。

## Session: 2026-09-05 — Phase 19

- 用户反馈重新部署后 Agent 生图仍失败。
- 远端容器已确认运行最新镜像；最近日志暂未出现新的失败请求，继续审计所有 Agent 生图恢复分支并获取可复现时序。
- 已确认远端仍运行 `21f44c8` 的旧前端，Agent 请求仍走 `/api-proxy/chat/responses`；远端历史两个参考图失败任务的根因是旧服务端把直连图像 API 的文件字段发送为 `image`，而 `direct.linkai.pics` 需要 `image[]`。
- 修正服务端 Agent 批量结果按模型顺序归并，避免并发完成顺序改变生成图引用；同时为固定 Agent 任务 ID 增加创建锁，并让任务异常保存不会卡住后续队列。
- 进程级假上游验证通过：Agent 批量任务最终状态 `done` 且图片顺序保持 `slow, fast`；带参考图的 Agent 任务走直连 `/images/edits`，multipart 使用 1 个 `image[]` 文件；整轮共完成 4 次 Responses 请求（两轮 Agent）。
- 本轮最终审查确认：前端 Agent 已切换到 `/api-agent-tasks` 固定任务 ID，Nginx 已代理创建/查询路由；本地工作区仍待测试、提交和部署，远端当前仍是旧提交。
- 一次辅助 `rg` 命令因 zsh 未匹配到 `docker-compose.yml*` 退出，未影响代码或部署；后续改用明确文件路径检查。
- 本地最终验证通过：`npm test -- --run` 为 37 个测试文件、549 项测试；`npm run build`、`node --check deploy/async-task-server.mjs`、部署脚本 `sh -n` 和 `git diff --check` 均通过。
- `jdy` 现状核对：容器仍运行旧提交 `21f44c8`，端口为 `5173:80`，并保留配置只读挂载与持久化任务目录挂载；远端没有 `rg`，已改用基础命令检查。
- 提交前敏感信息扫描第一次因匹配规则过宽，把文件名 `async-task-server` 误识别为 `sk-...`；改用至少 20 位 ASCII Key 模式复核后再继续，未发现真实 Key。
- 提交 `782ad5f` 已推送到 `origin/main`；`jdy` 已 fast-forward 到该提交并成功构建新 Docker 镜像。
- 已重建 `gpt-image-playground` 容器，保留 `unless-stopped`、`5173:80`、配置只读挂载和持久化任务目录；Node 异步任务进程正常运行。
- 线上 smoke 通过：首页 HTTP 200；`/api-agent-tasks` 创建校验 HTTP 400、未知任务查询 HTTP 404；新前端资源包含 `api-agent-tasks`；服务端三路配置 Key 均确认已加载（仅检查非空，未打印值）。
- Phase 19 已完成。未发起真实生图请求，避免部署验收产生额外计费；建议用户手机端强制刷新后重新测试 Agent 生图。

## Session: 2026-09-05 — Phase 20

- 用户反馈仍显示“服务端 Agent 异步任务超时”。
- 远端核对确认后台并未超时：最近任务约 146 秒完成；真正异常是手机后台挂起前端轮询，恢复后被浏览器端 30 分钟硬截止误判。
- 同时发现超时错误未被中文恢复判断识别，会清除 `serverTaskId`；完成状态响应还会一次性返回 1–2 MB 的图片结果。
- 目标改为服务端任务唯一真相：取消客户端绝对截止、轻量状态接口 + 独立结果接口、轮询退避重试，并保留任务 ID 直到明确成功/服务端失败。
- 已完成服务端 Agent `?meta=1` 状态接口和 `/result` 结果接口；默认旧路径仍返回完整结果以兼容已打开的旧版前端。
- 已移除 Agent 客户端 30 分钟 deadline；轮询与结果下载遇到网关/网络失败会指数退避重试，页面重新可见时会立即恢复 running round。
- 本地验证：37 个测试文件、550 项测试通过；生产构建、Node 语法、部署脚本语法和 diff 检查通过。

## Session: 2026-09-04 — Phase 17

- 定位确认：画廊任务的服务端队列已正常工作，Agent hybrid 的图片任务却与浏览器 Responses AbortController 绑定；断开后主轮次 catch 会覆盖为失败。
- 已补充服务端 task ID 的断线恢复调度；断线后任务保持运行并在页面恢复或稍后重试时复用原任务，不会重复创建上游图片任务。
- 已补充 Agent 轮次启动恢复；图片完成后会继续 Responses 续答，并清理恢复前遗留的“请求失败”占位文本。
- 验证通过：36 个测试文件、546 项测试；本地生产构建和 `git diff --check` 通过；远端 `jdy` 已重建容器，5173 首页 HTTP 200、异步任务路由和 Node 任务进程正常。

## Session: 2026-09-04 — Phase 18

- 根据用户截图和远端日志确认：失败点是图片任务完成后的 Agent Responses 续答请求 499，不是图片生成任务本身。
- 已让已完成服务端图片任务关联的 Agent 续答断线后保留 running 状态，并在页面恢复后重建续答请求；不会重新创建图片任务。
- 新增续答断线回归测试；本地验证：36 个测试文件、547 项测试通过，生产构建和 `git diff --check` 通过。
- 已提交 `6c55fdc` 并推送 `main`；远端 `jdy` 已拉取、重建并运行新容器。
- 远端验证通过：容器 `Up`、端口 `5173:80`、配置只读挂载和任务数据挂载均保留，首页返回 HTTP 200。

## Session: 2026-09-04 — Phase 16

- 将 Docker 固定模式的画廊、Studio 和 Agent 图像子任务改为服务端持久化异步队列；浏览器只创建任务并轮询，切换页面、刷新或容器重启后可继续处理。
- 服务端按图像像素尺寸选择 1K Pixel 或 2K/4K 直连上游，保留质量、格式、审核、压缩、数量、透明背景和编辑图片参数；结果保存到数据卷并自动清理 7 天前的完成/失败任务。
- Docker 镜像复用构建阶段 Node 运行时，避免生产阶段 Alpine 软件源安装卡住；启动时保留 Nginx 官方 entrypoint，确保模板代理路由正常生成。
- 本地验证：36 个测试文件、544 项测试通过，生产构建、Node 语法检查、进程级异步 smoke 和 diff 检查通过。
- 已提交并推送 `611c996`；远端 `jdy` 已拉取、重建并运行 `gpt-image-playground`，5173 首页 HTTP 200，`/api-tasks` JSON 路由、Node 任务进程和两个数据/配置挂载均已确认。

## Session: 2026-09-04 — Phase 15

- 定位到服务端固定 Profile 同时锁定流式设置的原因。
- 已修改设置页和预置策略：OpenAI 预置配置的流式传输与中间图像数可编辑并持久化，URL/模型/Key 等仍保持服务端锁定。
- 已补充预置策略回归测试和配置说明。
- 验证通过：35 个测试文件、542 项测试，生产构建通过，`git diff --check` 通过；提交 `ac3e9b9` 已推送。
- 远端 `jdy` 已更新并重建 `gpt-image-playground` 容器，5173 返回 HTTP 200，`/etc/gpt-image-playground/api-config.env` 保持只读挂载。
- 追加修复 `normalizeSettings()` 重建 Profile 时丢失流式偏好的问题；全量测试和构建再次通过，提交 `4a51ae5` 已部署，远端容器健康检查通过。

## Session: 2026-09-04

### Phase 14: 服务端固定模型与按分辨率路由

- 用户要求：聊天固定使用 `https://ai-pixel.online` 的 `gpt-5.6-luna`；1K 生图固定使用 `https://ai-pixel.online` 的 `gpt-image-2`；4K 生图固定使用 `https://direct.linkai.pics` 的 `gpt-image-2`；配置放服务端，客户端不再要求用户输入。
- 当前阶段先梳理 API Profile、请求构建、尺寸参数和 Docker/静态部署链路，再决定兼容实现边界。
- 已完成服务端固定模式、三路同源 Nginx 代理、按像素路由、客户端固定 Profile 和服务端配置文件示例；正在做最终产物与部署脚本审计。
- 非阻塞错误：一次产物扫描命令因 zsh 引号不完整失败，改用不含反引号的匹配命令重试。
- 最终完成：Docker 默认启用固定模式；配置文件只读挂载到 `/etc/gpt-image-playground/api-config.env`；聊天/标题走 chat 路由，1K 图像走 image-1k，2K/4K 图像走 image-4k。
- 设置页固定 API URL、API 类型、模型 ID 和 Key；关闭启动 Key 弹窗；客户端不带 Authorization，Nginx 按路由注入服务端 Key。
- 验证通过：35 个测试文件、540 项测试；`npm run build`；两个部署脚本 `sh -n`；`git diff --check`；带示例值的 Nginx `envsubst` 路由审计。

## Session: 2026-08-25

### Phase 13: 灵感库本地化与手动同步

- **Status:** complete
- 用户取消服务启动同步和定时任务，要求新增手动脚本，先拉取完整素材，再提交并推送到 GitHub。
- 已确认当前工作树干净，`main` 与 `origin/main` 同步；现有灵感库清单和图片均直接请求 GitHub Raw。
- 目标：素材存放到 `public/prompt-library`，前端只请求同源路径，部署继续保持纯静态 Nginx 架构。
- 首次查询 GitHub Contents API 时，zsh 将未加引号的 `?ref=main` 当作通配符；已改为引用完整 URL。
- 首次真实同步成功：校验 529 个案例、532 张案例图，原始目录约 156 MB。
- 发现上游 `data/images` 还包含 27 个非案例站点素材（约 7.2 MB）；同步脚本已收紧为只复制 `case*.jpg|jpeg|png|webp`。
- 生产构建后的同源 smoke 通过：清单 529 条、图片 532 张均从 `/prompt-library/...` 返回 200；不再引用 GitHub Raw。
- 全量验证通过：34 个测试文件、536 项测试；生产构建、shell 语法和 `git diff --check` 均通过。

## Session: 2026-08-24

### Phase 12: Pixel Agent 默认配置统一

- **Status:** complete
- 用户确认 Pixel 同一个 URL 和 Key 同时支持 Agent 与生图，Agent 默认模型应为 `gpt-5.6-luna`。
- 定位到旧行为来源：默认仅创建 Images Profile；Agent 新建流程将 Pixel 排除，并硬编码回退到 `https://api.openai.com/v1`，默认 Responses 模型还是 `gpt-5.6-sol`。
- 目标配置：Pixel Images `gpt-image-2` + Pixel Responses `gpt-5.6-luna`，默认混合模式且共享凭据；旧版本自动生成的空白 OpenAI Agent 配置需要一次性迁移。
- 已新增两个内置 Profile：`default-openai`（Images / `gpt-image-2`）与 `default-pixel-agent`（Responses / `gpt-5.6-luna`），默认使用混合模式。
- 内置两套 Profile 的 API URL 和 Key 始终同步；启动 Key 弹窗保存到图像 Profile 后会同步到 Agent Profile。
- 新建 Agent 文本 Profile 改为复用当前 Pixel URL 和 Key，不再回退 `https://api.openai.com/v1`。
- Zustand 持久化版本升级到 3：旧 Pixel 单 Profile 自动补 Agent；旧自动生成的 `Agent 文本模型`/`openai-agent-*` 配置改为 Pixel URL、共享 Key 和 Luna 模型；用户自定义 Responses Profile 不覆盖。
- 最终本地验证：34 个测试文件、536 项测试全部通过；生产构建和 `git diff --check` 通过。

### Phase 10: 部署默认配置固化

- **Status:** complete
- 已恢复现有规划文件与工作树上下文，确认保留前序未提交修改。
- 目标：把当前 Pixel API URL、图像 Profile 和生成参数设为开箱默认值，新部署仅填写 API Key。
- 安全边界：示例和仓库不写入真实 Key；纯前端构建中注入的 Key 会随静态资源暴露。

### Phase 11: 启动 Key 引导与任务恢复

- **Status:** complete
- 用户追加要求：每次打开或刷新时，若当前生效图像 Profile 的 Key 为空，显示与网站同步的输入弹窗。
- 用户反馈刷新后运行中任务中断；开始审计请求是否由浏览器同步持有、任务是否保存服务端 ID、应用启动是否会恢复轮询。
- UI/UX 约束：弹窗需有可见标签、自动聚焦、键盘提交、字段内错误、44px 操作目标、焦点环和移动端适配。
- 已新增启动 API Key 弹窗：应用配置初始化完成后检测当前 Profile；空 Key 时每次打开/刷新显示，支持显隐、Enter 保存、Esc/稍后关闭和字段内校验。
- 已确认 Pixel 公开文档没有图片异步 task_id 查询接口；无法保证浏览器完全关闭后原同步 fetch 继续运行。
- 已实现可落地优化：刷新后不再把同步图像任务直接标记“请求中断”，而是保留任务并使用 IndexedDB 中的原输入自动重新提交；同页执行集合防止重复接管。若 Key 为空，保存 Key 后立即恢复。
- 风险说明：同步请求的刷新恢复本质是自动重试，上游若已经完成但响应丢失，可能产生重复计费；真正后台持续执行仍需要服务端队列或上游异步接口。
- 首轮全量测试发现 10 项回归：9 项是默认 Profile 改为 Pixel 后，原通用 OpenAI Images 测试误走 Pixel 精简契约；1 项是默认名称断言仍为“默认”。开始隔离通用接口测试并补任务恢复测试。
- 修正默认预置判断：仅在部署显式提供 URL/Key 或启用代理时创建 preset；内置 Pixel URL 本身不再导致每次启动重复导入预置配置。Docker 未显式覆盖 URL 时交由前端内置 Pixel 默认值处理。
- 设置页、URL/部署预置或启动弹窗将 Profile Key 从空值补齐后，都会自动恢复等待中的同步任务；无需限定从某个入口填写。
- 页面卸载网络中断保持任务运行态；同页返回或重开后自动重试。恢复请求使用新的完整超时时间，恢复的 Agent 图像任务完成后继续原 Agent 回合。
- 新增同步恢复测试：重启自动重提、无 Key 等待后自动恢复、卸载中断不写失败，以及页面先返回而旧请求稍后才失败的竞态。
- Chrome 390×844 smoke：弹窗自动聚焦、无横向溢出，两个操作按钮均为 44px；保存后刷新不再显示，清空 Key 后刷新重新显示，Esc 关闭后下次刷新仍再次显示。
- 最终验证：`npm test -- --run` 通过 34 个文件、531 项测试；`npm run build` 成功；`git diff --check` 与两个 Docker shell 脚本语法检查通过。当前环境 Docker daemon 未运行，因此未执行容器镜像构建。

### 微信小程序化调研

- **Status:** research complete
- 对照当前 Web 代码梳理了小程序迁移阻力：需重写 UI、存储、文件/Canvas、网络和流式任务链路。
- 查阅微信开发文档网络要求，确认生产环境需要配置服务器域名并使用 HTTPS。
- 查阅国家网信办《生成式人工智能服务管理暂行办法》，确认公众图片生成服务涉及内容安全、隐私、生成内容标识；具有舆论属性/社会动员能力时还涉及安全评估和算法备案。
- 形成产品命名候选、同类产品审核对照和分阶段上架建议，结论已写入 `findings.md`。
- 输出独立开发计划 `wechat-miniprogram-development-plan.md`，包含产品范围、技术架构、迁移映射、接口草案、七阶段里程碑、合规审核清单、风险和验收标准。

### Phase 8: Agent 语言模型配置体验修复

- **Status:** complete
- Actions taken:
  - 定位请求链路，确认 Agent 文本模型来自 Responses API Profile 的 `model`，不是请求层写死。
  - 确认现有 Agent 配置在独立配置关闭时隐藏语言模型，且 Images API Profile 不会进入文本模型候选列表。
  - 使用 UI/UX Pro Max 复核空状态、错误恢复、表单标签、触控尺寸和焦点要求。
  - Agent 配置页新增常驻“语言模型”卡片，支持直接编辑模型 ID，并显示 Profile 来源、配置状态和锁定状态。
  - 缺少 Responses Profile 时提供“新建 Responses 配置”和“去 API 配置”；新建后自动转到 API 页补全地址、Key、模型和推理强度。
  - 未填写 API Key 的 Responses Profile 仍可见，字段旁显示具体缺失项；不再出现创建后配置又消失的问题。
  - Pixel Images API 被明确标识为图像服务；自动新建文本配置时不会复用 Pixel 地址/Key，README 补充混合模式说明。
  - Agent 入口的错误对话框改为直接跳转 Agent 配置页。
- Verification:
  - `npm run build` 成功；仅保留第三方 TUI CSS 拼写警告和既有大 chunk 警告。
  - `npm test -- --run` 通过 35 个测试文件、525 项测试。
  - `git diff --check` 通过。
  - Chrome 桌面 smoke：空状态、新建 Responses 配置、模型 ID 修改、补齐 Key 后状态切换为“已配置”均通过。
  - Chrome 390×844：无横向溢出，主要操作按钮高度 44px。
- Files modified:
  - `src/components/settings/AgentSettingsTab.tsx`
  - `src/components/SettingsModal.tsx`
  - `src/store.ts`
  - `README.md`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### Phase 7: awesome-gpt-image-2 素材库接入

- **Status:** complete
- Actions taken:
  - 阅读 UI/UX Pro Max 规范，确定素材库采用懒加载、明确来源、44px 触控目标和移动端可折叠布局。
  - 复查 Studio、Zustand 输入图状态和 IndexedDB 图片导入路径，准备复用现有动作。
  - 新增 `awesomePromptLibrary.ts`：清单字段校验、超时、缓存、分类/全文筛选和 Raw 图片 URL 映射。
  - 新增 `PromptLibraryPanel.tsx`：懒加载案例卡、搜索、分类、分页、来源链接、失败重试和授权提示。
  - 接入 Studio 左侧 `灵感` 标签；“使用”填入完整 Prompt，“复制”写入剪贴板，“导入为参考图”按需下载单图并复用现有 IndexedDB 流程。
  - 增加 6 项素材库数据层测试；当前已通过构建和 524 项全量测试。
- Browser smoke:
  - Chrome 1440×900：清单加载 18 张首批卡片，三栏 `288px 800px 352px`，无横向溢出；使用 Prompt 后右侧文本框长度正确；单图导入后自动切换编辑模式。
  - Chrome 390×844：素材库仍显示 18 张卡片，`scrollWidth=390`，无横向溢出；素材库按钮目标尺寸调整为至少 44px。
  - 最终 `npm run build` 成功（仅保留既有 TUI CSS 拼写警告和大 chunk 警告）；`npm test -- --run` 通过 35 个测试文件、525 项测试；`git diff --check` 通过。
- Files created/modified:
  - `task_plan.md`
  - `progress.md`
  - `src/lib/awesomePromptLibrary.ts`
  - `src/lib/awesomePromptLibrary.test.ts`
  - `src/components/PromptLibraryPanel.tsx`
  - `src/components/StudioWorkspace.tsx`
  - `README.md`
- Known non-blocking build warnings:
  - `tui-image-editor` 发布 CSS 中已有的 `backbround-color` 拼写警告。
  - 既有大型 chunk 警告；素材库 manifest 与图片没有打入 bundle。

### Phase 6: 外部 Prompt 素材库可行性评估

- **Status:** complete
- Actions taken:
  - 核查 GitHub 仓库元数据、默认分支、HEAD、README 和递归目录树。
  - 初步确认仓库有 532 个案例、分类画廊、结构化风格 JSON 与站点数据生成脚本。
  - 开始核查仓库体积、图片目录统计、许可证和免责声明。
  - 确认 532 张案例图约 153 MB，manifest 529 条且缺少 ID 12、169、170；确认 `data/style-library.json` 有 13 类、19 风格、10 场景、22 模板。
  - 阅读 MIT LICENSE、免责声明、站点数据生成脚本和 Agent Skill，完成内容授权与接入边界评估。
  - 结论：技术上可拉取，推荐“远程 Prompt/预览库 + 按需单图导入”，不推荐无条件全量复制图片。
- Files created/modified:
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### Phase 1: Discovery

- **Status:** complete
- **Started:** 2026-08-24
- Actions taken:
  - 检查仓库结构、README、AGENTS.md 和 package.json。
  - 确认现有 OpenAI-compatible 生图/编辑请求和遮罩状态模型。
  - 查看现有界面截图和 MaskEditorModal 实现。
  - 安装 `tui-image-editor@3.15.3`（MIT）。
  - 运行 `npm run build`，确认基线构建通过。
- Files created/modified:
  - `task_plan.md`
  - `findings.md`
  - `progress.md`
  - `package.json`（新增 tui-image-editor）
  - `package-lock.json`（依赖锁定）

### Phase 2: Structure

- **Status:** complete
- Actions taken:
  - 规划 Studio 三栏布局：左侧素材/历史，中间画布与结果，右侧 Prompt/参数/提交。
  - 规划 tui-image-editor 独立遮罩编辑器，保存结果回写现有 `maskDraft`。
  - 确定 Studio 使用独立 `studioOpen` UI 状态，不扩展 Agent 的 `AppMode` 状态机。
  - 确定 TUI 编辑器使用透明编辑层，保存时反转为 Images Edits 所需的白色/透明 mask。
- Files created/modified:
  - `task_plan.md`
  - `progress.md`

### Phase 3: Implementation

- **Status:** complete
- **Started:** 2026-08-24
- Actions taken:
  - 开始实现 Studio 工作区、TUI 遮罩编辑器和共享提交流程。
  - 完成 Studio 三栏工作区、Pixel API 请求适配、TUI 遮罩转换与入口接线。

### Phase 4: Testing & Verification

- **Status:** complete
- **Started:** 2026-08-24
- Actions taken:
  - 重新运行生产构建，TypeScript 与 Vite 构建成功。
  - 运行完整 Vitest 测试，34 个测试文件、519 项测试全部通过。
  - 运行 `git diff --check`，未发现空白或补丁格式错误。
  - 使用本机 Chrome 无头模式实测桌面端 Studio：三栏布局、无横向溢出、入口和 API 设置入口正常。
  - 使用 390px 移动视口实测：三栏折叠为单列，无横向溢出，主要操作按钮满足触控尺寸。
  - 上传本地图片后实测编辑模式自动切换，TUI 遮罩弹窗成功加载 2 个 Canvas，画笔拖动并保存后回写 `MASK` 与“已应用遮罩”状态。
  - 通过浏览器路由拦截实测 Studio 生图请求：`POST /v1/images/generations` 使用 JSON，Pixel 默认 `auto` 尺寸被省略。
  - 通过浏览器路由拦截实测 Studio 编辑请求：`POST /v1/images/edits` 使用 multipart，发送单个 `image`；保存遮罩后同时发送单个 `mask`。
  - 使用本机 Chrome 验证时外部字体资源出现 403/网络错误，已在实测中拦截字体请求；应用核心渲染与交互无页面异常。
  - 在 390px 视口下用键盘 Tab 检查 Studio 控件顺序和焦点环，按钮/输入框均可聚焦；`prefers-reduced-motion: reduce` 下动画与过渡降为近乎 0。
  - 修正已有遮罩重新打开时的可视化：可编辑区域显示为半透明紫色，不再用白色遮挡底图；保存转换和 API alpha 语义保持不变。
  - 为 TUI 全屏编辑层补充 `role="dialog"`、`aria-modal` 和标题关联。

## Test Results

| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| Baseline build | `npm run build` | TypeScript 和 Vite 构建成功 | 构建成功 | ✓ |
| Current production build | `npm run build` | 当前 Studio 与 TUI 代码可生产构建 | 构建成功；仅第三方 TUI CSS 与大包警告 | ✓ |
| Full unit tests | `npm test` | 全部测试通过 | 34 files / 519 tests passed | ✓ |
| Diff whitespace | `git diff --check` | 无空白错误 | 无输出，退出码 0 | ✓ |
| Desktop Studio smoke | Chrome 1440×900 | 三栏工作区、入口和画布显示 | 通过；`288px 800px 352px`，无横向溢出 | ✓ |
| Mobile Studio smoke | Chrome 390×844 | 单列布局、无横向溢出、触控尺寸 | 通过；`grid=390px`、scrollWidth=390 | ✓ |
| TUI mask smoke | 上传图片→画笔→保存 | 遮罩回写并可用于编辑请求 | 通过；出现 `MASK`、`已应用遮罩` | ✓ |
| Pixel generation request | Studio 提交生图 | JSON generations 契约 | 通过；字段为 `model`、`prompt`，auto size 省略 | ✓ |
| Pixel edit request | Studio 提交编辑 | multipart edits 契约 | 通过；单个 `image`，带遮罩时单个 `mask` | ✓ |
| Keyboard/reduced motion | Chrome 390×844 + reduce | Tab 可达、动画降级 | 通过；焦点环可见，transition `1e-05s` | ✓ |
| Mask reopen preview | 保存后重新打开 TUI | 可编辑区域保持可见 | 通过；显示半透明紫色区域 | ✓ |

### Phase 6 研究结果

| Check | Result | Status |
|---|---|---|
| GitHub metadata / default branch | `main`, HEAD `de6a8ad...`, active updates through 2026-08-23 | ✓ |
| Recursive tree | 687 entries; 563 images; no `.gitattributes` contents found | ✓ |
| Case images | `data/images/case1..case532` = 532 images, ~153 MB | ✓ |
| Manifest | `data/cases.json` = 529 records; IDs 12/169/170 absent | ✓ |
| Style library | 13 categories, 19 styles, 10 scenes, 22 templates | ✓ |
| License/disclaimer | MIT for software/docs; third-party image/commercial use not guaranteed | ✓ |
| Integration recommendation | Remote manifest + lazy preview + explicit single-image import | ✓ |

## Error Log

| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-08-24 | `sh: tsc: command not found` | 1 | 重新安装依赖并确认 `node_modules/.bin/tsc` 后构建通过 |
| 2026-08-24 | Pixel 契约测试得到 `/v1/v1/images/generations` | 1 | 移除与 `buildApiUrl` 重复的版本前缀逻辑 |
| 2026-08-24 | API 编辑测试提示 `Body has already been read` | 1 | fetch mock 改为每次返回新的 Response 实例 |
| 2026-08-24 | `tuiMask.test.ts` mock 初始化发生 hoist 错误 | 1 | 使用 `vi.hoisted` 创建 `loadImageMock` |
| 2026-08-24 | `HTMLCanvasElement is not defined` | 2 | 为 TUI 转换测试启用 jsdom |
| 2026-08-24 | Playwright 默认 Chromium 未安装且下载缓慢 | 1 | 改用本机 Google Chrome 的 headless channel 完成页面实测 |
| 2026-08-24 | Playwright 直接读取 multipart 二进制为 UTF-8 失败 | 1 | 使用 `post_data_buffer` 并按 latin-1 解析字段名/计数 |
| 2026-08-24 | `rg` 搜索表达式包含不受支持的转义 | 1 | 改用单引号和普通中文文本重新搜索 |
| 2026-08-24 | 默认 Pixel Profile 导致 10 项既有测试回归 | 1 | 将通用 OpenAI Images 测试显式使用非 Pixel URL，并更新默认名称断言 |
| 2026-08-24 | 弹窗焦点循环使用 `Array.at()` 不符合项目 ES2020 target | 1 | 改用 `focusable[focusable.length - 1]` |
| 2026-08-24 | 当前机器 Docker daemon 不可用 | 1 | 完成 Dockerfile/entrypoint 静态审计与 `sh -n`，记录未执行镜像构建 |

## 5-Question Reboot Check

| Question | Answer |
|----------|--------|
| Where am I? | Phase 11：启动 Key 引导与任务恢复已完成 |
| Where am I going? | 完成最终全量测试、diff 校验并交付 |
| What's the goal? | 新部署只填 Key，空 Key 自动引导，并改善刷新/关闭后的任务恢复 |
| What have I learned? | Pixel 只有同步 Images 接口，纯前端只能重开重试；真正后台持续需服务端队列 |
| What have I done? | 完成默认配置、Key 弹窗、同步任务恢复、测试、构建和移动端 Chrome smoke |
