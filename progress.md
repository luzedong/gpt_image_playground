# 工作进度

## 2026-09-05

- 已创建本次排查计划。

## 2026-09-06

- 完成线上日志与本地任务链对齐，确认重复扣费来自页面恢复时误把 Agent 生图占位任务重新提交为普通图像任务。
- 已在 `src/store.ts` 的 `resumePendingTasks()` 跳过服务端托管 Agent 占位任务，并在 `src/store.test.ts` 增加回归测试。
- 针对性测试通过；生产构建通过；完整测试通过（37 个测试文件、555 项）。
- 待完成：提交、推送、部署及线上验证。

## 回滚处理

- 线上临时覆盖前端后发现本地构建未包含 Docker 服务端配置注入标记，已保留问题镜像为 `gpt-image-playground:broken-53c62e5`，并恢复部署前 `7234329d...` 镜像。
- 回滚后容器正常运行于 `5173:80`，网页资源恢复，服务端 API 配置文件仍挂载，任务目录文件数仍为 63。

## 镜像构建排查

- 复现当前提交的远程 Docker 构建，确认失败发生在读取构建文件阶段，而不是 `npm ci` 或 `npm run build`。
- 已确认前次排查中误判了 `.dockerignore`；已恢复该文件。实际需要修正构建命令，显式指定 `deploy/Dockerfile`。

## 部署完成

- 服务器端正确执行 `docker build -f deploy/Dockerfile`，最终生成镜像 `7f0cb82a...`。
- 构建未使用镜像源，默认 npm registry 最终完成；若后续再次卡在 `npm ci`，再切换镜像源。
- 已重建线上容器，资源引用为新构建产物 `assets/index-Dq32tEdt.js`。
- 校验 `SERVER_MANAGED_API_CONFIG=true`，API 配置文件和任务目录挂载不变，服务正常运行于 `5173:80`。

## Agent 生图等待排查

- 对照线上日志与任务文件确认：图片已在 Agent progress 中产生，最终 Agent 任务仍需等待后续模型文字回复才结束。
- 当前未改代码；已确定优化方向为图片任务与 Agent 轮次解耦、先展示图片，再异步收尾最终文字回复。
- 已将图片就绪状态从 Agent 轮次运行状态中独立出来，前端会在图片到达后显示“图片已生成，正在整理回复”。

## 2026-09-06 即时图片资源优化

- 完成服务端 Agent 图片独立资源接口，进度 JSON 不再携带图片 Base64。
- 前端收到图片资源地址后立即下载并交给现有图片展示/持久化流程。
- 记录图片工具真实开始与完成时间，图片任务耗时不再包含最终文字回复。
- `npm run build`、`npm test -- --run` 已通过（37 个测试文件、555 项）；`node --check deploy/async-task-server.mjs` 已通过。
- 已推送提交 `4f71043` 并在服务器使用 `deploy/Dockerfile` 构建部署；`/api-agent-tasks/:id/progress` 已验证返回 `imageUrl`，图片资源接口返回 200。

## 2026-09-06 图片即时预览修复

- 发现旧流程必须等待图片下载、哈希、缩略图和 IndexedDB 写入完成，任务卡才有 `outputImages`，导致服务端图片已完成但界面仍显示加载中。
- 新增 `previewImageUrl`，任务卡收到图片资源地址后直接显示，持久化在后台继续执行。
- `npm run build`、`npm test -- --run` 已通过。

## 2026-09-06 完整性能复查

- 开始重新测量聊天流式进度、图片资源首字节/下载速度和浏览器端处理链路，暂不修改业务代码。
- 已完成服务器本机、公网图片和公网静态资源测速，确认公网单连接吞吐约 0.36–0.37 MB/s。

## 2026-09-06 流式与图片传输优化

- Agent 任务新增 SSE 事件流，浏览器不再持续轮询整包任务 JSON；连接中断时保留状态轮询恢复。
- Agent 任务拆分保存主状态、进度和输入上下文，流式进度不再重复落盘图片 Base64。
- Agent 完成结果只返回图片资源地址，前端按需从同源资源读取并复用浏览器缓存，避免结果 JSON 再传一遍原图。
- 图片资源补充 `Content-Length`、ETag 和长期缓存；Markdown 流式动画改为零时长；IndexedDB 改为 800ms 防抖且只写入变化的会话。
- `npm run build`、`npm test -- --run`、`node --check deploy/async-task-server.mjs` 均通过（37 个测试文件、555 项）。
- 发现并修复服务端配置模式下 Agent 图像配置选择被 `normalizeSettings()` 强制重置为 AIPixel 的问题，新增 AILink 选择回归测试，待运行验证。
- 按新需求将网络搜索改为强制开启，设置界面显示“已开启”，并覆盖前端、服务端与旧配置恢复路径。
- 发现截图中的 Agent AIPixel 标签来自真实任务配置：顶部图像配置与 Agent 图像配置此前是两个独立选择；已让服务端固定模式下顶部 AIPixel/AILink 切换同步 Agent 图像配置，并修复预置空 Key 配置不显示的问题。
- 提交 `cfeed38` 已推送并在服务器构建部署；线上容器运行 `gpt-image-playground:cfeed38`，新的前端资源包含 `agent-input` 历史用户参考图候选及 AILink 配置切换逻辑，配置文件和异步任务卷保持不变。
- 复查线上任务文件发现最近 Agent 任务真实使用 `default-openai`；修复服务端模式初始化时可能不创建 AILink 的设计漏洞，增加始终恢复两套图像配置的回归测试。
- 提交 `d26d484` 已推送并部署；线上容器运行 `gpt-image-playground:d26d484`，新版资源包含两套图像 profile，Nginx 已生成 AILink 1K/4K 路由，API 配置和任务数据卷保持不变。

## 2026-09-08 Agent 异步失败排查

- 线上日志与任务文件确认两次失败均不是任务创建或 SSE 本身故障，而是图片生成后继续请求上游时失败。
- 已完成服务端上游有限重试、图像供应商串行锁、Agent 图像 profile 透传、已有图片的部分结果兜底和 SSE 错误信息透传。
- 图片请求仅对明确的限流、并发和网关预算错误重试，网络中断或未知 5xx 不自动重发生图，避免重复扣费。
- `npm run build`、完整测试（37 个文件、560 项）和 `node --check deploy/async-task-server.mjs` 均通过。
- 修复提交 `3b97eb0`、历史失败任务恢复提交 `d8efecd` 均已推送。
- 服务器 Docker 构建命中 `npm ci` 缓存，线上容器已更新为 `gpt-image-playground:d8efecd`，原配置和任务数据卷挂载保持不变。
- 旧失败任务 `mts36vx84bes6`、`mts3uisw1ohqf` 已恢复为 `done`，结果各包含 1 张图片；对应图片资源返回 200，大小约 3.26 MB 和 3.01 MB。
- 启动后首次探测曾短暂返回 502，确认是 Nginx 已启动而 Node 尚在扫描迁移历史任务的约 2 秒窗口，随后接口正常，进程未崩溃。

## 2026-09-09 生图模型可配置

- AIPixel、AILink 图像配置的模型 ID 改为可编辑并分别持久化，默认均为 `gpt-image-2`；聊天模型、API URL 和 Key 继续锁定。
- 普通异步生图和 Agent 生图请求均携带所选模型，服务端校验后随任务持久化并用于上游请求。
- 部署配置增加 AIPixel/AILink 1K/4K 四个模型环境变量，老任务或旧前端未传模型时使用环境变量默认值。
- 完整测试通过（37 个文件、561 项），生产构建、Node 语法、Shell 语法和 diff 检查均通过。
- 提交 `c5f0c3f` 已推送并在服务器构建部署；容器运行正常，配置和任务数据挂载保持不变。
- 线上确认四个模型环境变量默认均为 `gpt-image-2`，历史 Agent 接口返回 200；非法模型 ID 在创建任务前返回 400，未触发真实生图。

## 2026-09-09 移动端遮罩保存按钮

- 确认保存逻辑仍然存在，问题是窄屏头部同时展示标题、说明、移除遮罩和保存操作，右侧保存按钮会被挤出视口。
- 移动端将“移除遮罩”收敛为图标，保存按钮设为不可收缩，并在极窄屏隐藏说明图标；头部补充顶部安全区。
- `npm run build`、完整测试（37 个文件、561 项）和 `git diff --check` 均通过。
- 修复提交 `ee8ecf8` 已推送；服务器 Docker 镜像与线上容器均更新为 `gpt-image-playground:ee8ecf8`，原 API 配置和任务数据卷保持不变。
- 线上首页公网和服务器本机均返回 HTTP 200，异步任务服务正常监听。
- 根据移动端实机截图进一步确认整个头部内容在 iOS PWA 中不可见；改为独立移动端头部，并将关闭、标题、移除和保存操作绝对定位在安全区容器底边，同时移除全屏编辑器的缩放动画。
- 第二版修复提交 `820dc98` 已推送并部署，线上容器运行 `gpt-image-playground:820dc98`；公网入口已引用新资源 `index-BEH2vcGH.js`。

## 2026-09-09 绘语品牌替换

- 使用用户提供的 1254×1254 透明 PNG 生成页面/浏览器、iOS、PWA 192 和 PWA 512 四套图标资源。
- 浏览器标题、应用名称、iOS 主屏幕名称、PWA manifest 和页面顶栏品牌统一为“绘语”；旧 OpenAI PWA SVG 已移除。
- 升级 Service Worker 缓存名称和应用壳资源列表，避免继续回退到旧图标。
- 生产构建和完整测试（37 个文件、561 项）通过；提交 `32a04a7` 已推送并部署，线上容器运行 `gpt-image-playground:32a04a7`。
- 公网确认 HTML 标题为“绘语”，品牌图标和 PWA 512 图标均返回 HTTP 200。

## 2026-09-09 字体加载优化

- 确认浏览器长期待处理的是三套 HarmonyOS 外部字体，总下载量约 13 MB，不是业务 API 请求。
- 已移除第三方字体 CSS，界面改用 macOS/iOS 的苹方及各平台系统中文字体；等宽文本也改用系统字体栈。
- 新构建产物已确认不含字体外链；生产构建、完整测试（37 个文件、561 项）和 diff 检查均通过。
- 修复提交 `28e2861` 已推送并部署；线上容器运行 `gpt-image-playground:28e2861`，CSS 返回 200 且确认不含 HarmonyOS/ZeoSeven 引用，原 API 配置和任务数据挂载保持不变。

## 2026-09-09 低带宽请求审计

- 开始只读审计聊天流、Agent SSE/恢复轮询、图片任务、素材库和静态资源，不修改现有功能。
- 初步确认聊天和 Agent 已采用流式传输；构建产物约 179 MB，其中素材库约 154 MB，需继续确认浏览器真实按需请求范围。
- 按用户要求将范围收窄为用户对话和生图主链路；完成线上任务文件体积、Base64 与二进制大小、SSE 快照策略、标题并发请求和普通生图轮询检查。
- 本轮未修改业务代码。高收益顺序确定为：图片一次上传并以服务端 ID 复用、标题请求不带图且延后、Agent SSE 改增量、普通生图结果改独立二进制资源；轮询间隔优化优先级最低。

## 2026-09-09 对话与生图带宽优化

- 开始实现 Agent 图片按内容哈希上传并复用、对话标题延后生成，以及 SSE 文本增量传输。
- 服务端已加入图片资产目录、校验上传接口、上游调用前引用还原和生成图资产登记；SSE 首次连接保留完整快照，纯文本追加改发增量。

## 2026-09-10 对话与生图带宽优化验证

- 已实现 Agent 参考图按内容哈希上传：首次 `PUT /api-agent-assets/:id` 保存，后续任务仅传 `image_asset_id`，服务端调用上游前还原为 Data URL；上传失败会中止创建，避免出现缺少参考图的错误对话。
- 已把服务端托管 Agent 的首轮标题请求延后到首轮结果提交后，且标题 API 只传文本；主请求先发、标题后发，减少首轮上传流量和上游并发争抢。
- 已把 Agent SSE 的纯文本追加改为 `progress_delta` 增量；首次连接、图片、工具、状态或错误变化仍发送完整快照，保证重连和状态恢复。
- 新增回归测试覆盖资产缺失上传、已知资产复用、任务创建不含 Base64、旧服务端 404 回退，以及 SSE 增量重组；新增标题延后测试覆盖成功轮次和失败轮次。
- 本地验证通过：`npm run build`、`npm test -- --run`（37 个测试文件、566 项）、`node --check deploy/async-task-server.mjs`、`git diff --check`。
- 提交 `dd96335` 已推送；服务器拉取后使用 `deploy/Dockerfile` 构建镜像 `gpt-image-playground:dd96335`，依赖层命中缓存。
- 已按原挂载和启动参数重建线上容器；首页返回 200 且标题为“绘语”，`/api-agent-assets/check` 空列表返回 `{"missing":[]}`，异步任务服务正常监听。

## 2026-09-10 Agent 图片延迟复查

- 新样本 `mtvhkmj385iiv` 显示上游计费耗时 35.58 秒，但前端任务从 20:11:05 计到 05:19。
- 访问日志显示浏览器 20:15:50 才首次请求图片资源，服务端图片文件 20:15:43 才生成；主要延迟发生在服务端暴露图片之前。
- 图片资源约 2.9 MB，公网下载约 34 秒，与已测约 0.36 MB/s 带宽一致，不是主要未知延迟。
- 已确认 252.4 秒全部在服务端图片工具内部，且同时间无其他图像任务占用供应商锁；服务端请求缺少 `response_format: 'b64_json'`，会走 URL 结果并二次下载。
- 已修改 `deploy/async-task-server.mjs`：生成请求固定返回 Base64，AILink 编辑请求返回 Base64，AIPixel 编辑保持兼容；增加安全耗时日志，区分响应头、响应体和图片 URL 下载。
- 验证通过：`node --check deploy/async-task-server.mjs`、`npm run build`、`npm test -- --run`（37 个测试文件、567 项）、`git diff --check`。
- 修改尚未提交、推送或部署，等待用户确认。
- 修复提交 `66dbef7` 已推送到 `main`。
- 服务器已拉取代码并使用 `deploy/Dockerfile` 构建镜像 `gpt-image-playground:66dbef7`；依赖层命中缓存，仅重建源码和产物层。
- 已按原端口、启动命令、API 配置只读挂载和任务数据挂载重建线上容器。
- 部署后容器运行正常；公网首页返回 200 且标题为“绘语”，`/api-agent-assets/check` 空列表返回 `{"missing":[]}`，容器内服务端文件确认包含 `response_format: b64_json` 逻辑。

## 2026-09-10 AIPixel 传输瓶颈复查

- 复查新样本 `mtviyyqe76jth`，确认前端 8m26s 中约 7 分钟发生在 AIPixel 图片响应传输：响应头等待 168.5 秒，3.77 MB Base64 响应体读取 252.0 秒。
- 对照任务文件确认参考图 Data URL 3.85 MB、生成图 Base64 3.77 MB；上游返回 `b64_json`，无 URL 二次下载。
- 使用非计费静态资源测速：服务器到 AIPixel 约 9–10 KB/s，到 AILink 约 251–285 KB/s，到 Cloudflare 约 744 KB/s，证明瓶颈是服务器到 AIPixel 的特定链路。
- 本轮仅完成诊断，未修改业务代码；建议后续优先切换 AILink 承载大图编辑，或确认 AIPixel URL/WebP 支持后再优化传输格式。

## 2026-09-11 新样本耗时结构复查

- 复查 `mtwczd0q82q2b`：前端 2m01s，实际从创建到完成约 120.2 秒；图片工具前聊天约 13.3 秒，AIPixel 图片上游 68.8 秒，图片可见后最终聊天约 30.9 秒。
- 该任务无参考图，`responseBodyMs` 仅 3.1 秒，说明 AIPixel 传输已恢复；图片请求完成时间 10:51:50，任务结果完成时间 10:52:21。
- 剩余优化空间集中在两处：最终聊天仍会附加 3.99 MB 生成图 Base64，可改为文本元数据；若接受牺牲自然收尾文案，可把最终整理从任务完成条件中解耦，让图片任务在图片就绪后即结束。
- 上游图片生成等待 65.7 秒属于 AIPixel 模型生成耗时，最近另一个同类生成样本为 119.4 秒；进一步缩短需要测试其他供应商或模型，不能仅靠本地代码优化。

## 2026-09-11 最终聊天去图与文案异步化

- 将 Agent 最终聊天输入从“生成图 Base64 + `<ref>`”改为仅 `<ref>` 文本；服务端 `references` 映射仍保留实际 Data URL，后续依赖生图可以继续引用原图。
- 单次 `generate_image` 场景下，图片落盘并广播后立即结束任务，返回当前进度文案和图片；服务端启动 `captionState=pending` 的后台整理任务，最终文案再异步写入 progress/result。
- 为减少后台文案流式更新带来的大文件写放大，新增 `saveAgentProgress`，文案增量只写 progress 文件，最终状态才写完整任务快照。
- 前端在初始结果完成后监听 `captionState`，最终文案到达后更新 Agent 消息和响应输出，不重复存储图片。
- 验证通过：`node --check deploy/async-task-server.mjs`、`npm run build`、`npm test -- --run`（37 个测试文件、567 项）、`git diff --check`。
- 提交 `0556826` 已推送；服务器使用 `deploy/Dockerfile` 构建镜像 `gpt-image-playground:0556826`，并按原端口、重启策略、API 配置只读挂载和任务数据挂载重建容器。
- 部署后容器运行正常，本机和公网首页均返回 200，`/api-agent-assets/check` 返回 `{"missing":[]}`，容器内服务端文件确认包含文案异步整理逻辑。

## 2026-09-11 应用标题改为 IMAGE

- 将浏览器标题、iOS/PWA 应用名、PWA manifest 名称和页面顶栏品牌从“绘语”统一改为 `IMAGE`。
- 生产构建和完整测试（37 个测试文件、567 项）均通过。

## 2026-09-11 服务端代理与 AIPixel 默认模型

- 服务端新增 `UPSTREAM_PROXY_URL`，通过 `undici` 的 `EnvHttpProxyAgent` 让 Node 内置 `fetch` 出站请求走代理；Docker 运行时补入 `undici`。
- jdy 配置文件增加 `UPSTREAM_PROXY_URL=http://172.17.0.1:7890`，容器启动日志确认 `upstream_proxy enabled host=172.17.0.1:7890`。
- AIPixel 默认模型改为 `gpt-image-2.5-flare`，AILink 保持 `gpt-image-2`；服务端模式每次归一化设置时强制覆盖已保存的 AIPixel 模型，保留 AILink 模型。
- 提交 `55e0977`、`f14dcec` 已推送；服务器构建镜像 `gpt-image-playground:f14dcec`，线上容器已更新。
- 验证：临时容器通过 `172.17.0.1:7890` 请求外网返回代理出口 IP；正式容器代理日志、模型环境变量、公网首页均正常。

## 2026-09-11 遮罩保存后的发送按钮文案

- 确认遮罩保存后 `maskDraft` 应继续保留，输入图片上的 MASK 标记用于表示当前附带遮罩。
- 修复输入栏底部按钮：有已保存遮罩时不再显示“遮罩编辑”，统一显示“生成图像”；遮罩编辑器自身仍保留编辑状态。
- 生产构建和完整测试（37 个测试文件、567 项）通过。

## 2026-09-11 Agent 遮罩叠加输入

- Agent 输入构造现在会在当前轮存在遮罩时，把遮罩主图合成为遮罩叠加图，再作为 `input_image` 发送给对话模型。
- 不额外增加预览图；模型收到的就是用户编辑后看到的遮罩叠加画面，用于识别圈选区域。

## 2026-09-11 画廊任务幂等

- 服务端 `/api-tasks` 新增 `client_task_id`，同 ID 重试直接返回已有任务，并用创建锁处理并发重复请求。
- 客户端服务端生图请求携带本地任务 ID；`submitTask` 增加整体提交锁，`retryTask` 增加按原任务 ID 的重试锁，防止连续点击创建多条任务。
- 本地临时服务验证：相同 `client_task_id` 连续 POST 两次，返回同一个任务 ID。

## 2026-09-11 AIPixel 多图验证

- 受控调用 AIPixel `/images/edits`，使用两张测试 PNG 和字段 `image[]`，模型 `gpt-image-2.5-flare`，返回 HTTP 200 并生成 1 张图片。
- 移除 AIPixel 只取第一张参考图的截断逻辑：单图仍使用 `image`，多图改用 `image[]`。
- 本地验证通过：`node --check`、`npm run build`、`npm test -- --run`（37 个测试文件、567 项）。

## 2026-09-11 输入图片格式标准化

- AIPixel 和 AILink 请求前统一将参考图重新编码为尺寸不变、白底、无透明通道的 8-bit RGB PNG。
- 服务端托管请求与直连客户端请求两条链路均接入标准化；解码失败时保留原图并记录警告。
- 本地验证通过：`npm run build`、`npm test -- --run`（37 个测试文件、567 项）。

## 2026-09-11 Agent 参考图标准化补充

- 复查发现画廊请求已标准化，但服务端 Agent 上传的 `input_image` 仍保留原始编码，因此 AILink 的 `generate_image` 仍可能返回 `Invalid image file or mode`。
- 在 Agent 输入上传前增加递归标准化，所有 `input_image` 先转为白底 8-bit RGB PNG，再上传资产供服务端生图工具引用。
- 本地验证通过：`npm run build`、`npm test -- --run`（37 个测试文件、567 项）。

## 2026-09-11 DeepSeek 工具调用流式进度

- 线上日志确认 DeepSeek 在工具调用前只发送 `response.reasoning_text.delta`，真正的 `function_call` 直到 `response.output_item.added` / arguments done 才出现。
- 服务端此前只转发 `response.output_text.delta`，没有把工具项和参数增量上报到 Agent 进度，导致前端在生图决策阶段长时间只显示等待，最后一次性出现工具调用。
- 服务端现在会在 `response.output_item.added/done` 和 `response.function_call_arguments.delta/done` 时立即广播 output items；空参数工具占位会被过滤，参数完整后立即显示生图工具状态。

## 2026-09-11 PNG 元数据剥离

- 失败资产检查发现参考图是标准 1024×1024 8-bit RGB PNG，但仍包含 `caBX` PNG chunk（C2PA 元数据）。
- 受控测试确认：保留 `caBX` 时 AILink 返回 `Invalid image file or mode`；剥离 `caBX` 后同一张图返回 HTTP 200 并成功生成。
- 服务端在上传 AIPixel/AILink 前统一剥离 PNG 的 `caBX` / `c2pa` chunk，仅移除元数据，不改图片像素、尺寸或格式。

## 2026-09-12 DeepSeek 推理等级

- 服务端聊天请求新增 `CHAT_REASONING_EFFORT` 支持，非空时发送 `reasoning: { effort }`。
- 线上配置设置为 `CHAT_REASONING_EFFORT=high`。
- DeepSeek 受控请求确认 `deepseek-flash` 接受 `effort: high`，响应报告 `reasoning.effort = high`。

## 2026-09-12 Agent 提示词中文化

- 将 Agent system prompt、工具策略、数学格式说明，以及 `generate_image`、`generate_image_batch`、`continue_generation` 的工具描述等价翻译为中文。
- 保留所有工具名、XML 标签、参数名和 `Generate at ... resolution.` 这个固定英文前缀，避免改变既有接口语义。
- 同步更新相关测试断言，本地验证通过：`node --check`、`npm run build`、`npm test -- --run`（37 个测试文件、567 项）。

## 2026-09-12 参考图统一 JPEG 95

- 参考图预处理由白底 8-bit RGB PNG 改为白底、保持原尺寸的 JPEG 质量 95。
- mask 文件仍保持 PNG，不参与 JPEG 转换。
- 目标是避免历史生成图以 2048×2048、10MB 级 PNG 反复发送到图像 API。
- 本地验证通过：`node --check`、`npm run build`、`npm test -- --run`（37 个测试文件、567 项）。

## 2026-09-12 Agent 历史图片裁剪

- Agent 输入现在只保留当前轮用户参考图和上一轮模型生成图的实际图片内容。
- 更早轮次的生成图只保留 `<ref>` 文本标签，不再每轮重复传输图片像素。
- 如果当前用户消息明确 `@ 第 N 轮图 M`，则把被明确引用的历史生成图补回。
- 新增回归测试覆盖“当前用户图 + 上一轮生成图保留，更早图片不加载”。
- 本地验证通过：`npm test -- --run`（37 个测试文件、568 项）。
- 根据对话预期修正裁剪规则：保留的应是“所有历史轮中最近一次模型生成的全部图片”，即使其后有多轮纯文本对话也继续沿用；更早的生成图仍只保留 `<ref>` 文本，除非当前消息明确引用。
- 回归测试更新为覆盖“生成图后连续多轮纯文本，仍然携带最近生成图”。

## 2026-09-12 部署 5132f13

- 服务器 `/root/gpt_image_playground` 已同步到 `5132f13`，镜像 `gpt-image-playground:5132f13`（`4b8cc27aa58f`）构建完成。
- 线上容器由 `38726e3` 切换为 `5132f13`，容器 ID `08eb24906f3c`，端口 `5173:80`，`--restart unless-stopped`。
- 验证：`docker ps` 显示运行中，公网 `http://223.109.200.25:5173/` 返回 200，启动日志确认 `upstream_proxy enabled host=172.17.0.1:7890`。

## 2026-09-12 历史用户参考图引用修复（保守）

- 现象：`@第N轮参考图M` 会被重写成 `<ref id="round-N-reference-M" />`，但 `resolveAgentPromptImageReferences` 只解析 `@第N轮图M`，导致该引用拿不到图片像素（临时用例确认 `IMAGE LOADED? false`、`loadImage` 零调用）。
- 修复：`resolveAgentPromptImageReferences` 增加对 `AGENT_ROUND_INPUT_REFERENCE_RE` 的解析，按 `round.index` 定位轮次后取 `inputImageIds[imageIndex]` 加入 `allowedImageIds`，与该文件既有的 `replaceInputReference` 语义保持一致。
- 默认裁剪策略不变：历史轮用户参考图仍不会自动携带，只有被当前消息显式 `@` 引用时才加载。
- 新增两个回归测试（显式引用会加载、未引用则不加载）。本地验证：`npm test -- --run`（37 个文件、570 项）与 `npm run build` 均通过。
- 提交 `566940f` 已推送；服务器 `docker build -f deploy/Dockerfile -t gpt-image-playground:566940f .` 构建成功（`edfa535f0611`）。
- 线上容器切换为 `566940f`，容器 ID `a21db2e2a5ac`，公网 200，启动日志确认 `upstream_proxy enabled host=172.17.0.1:7890`。

## 2026-09-12 修复画廊轮询 404（Not Found）

- 现象：画廊生图提示 `Not Found`。nginx 日志为 `POST /api-tasks 202` 之后紧跟 `GET /api-tasks/<id>?meta=1 404`。
- 根因：`deploy/async-task-server.mjs` 的查询路由正则 `/^\/api-tasks\/([a-f0-9-]+)$/i` 只接受十六进制字符，但前端本地任务 ID 由 `Date.now().toString(36)` 生成（含 g–z），经 `client_task_id` 提交后成为服务端任务 ID，正则不匹配即落到兜底 `{"error":{"message":"Not Found"}}`。
- 回归来源：`client_task_id` 由 `851f896` 引入，正则自 `f38335c` 未变，因此画廊模式自该版本起一直“服务端生成成功、前端轮询 404”。Agent 路由正则本就是 `[A-Za-z0-9_-]+`，不受影响。
- 修复：查询路由改为 `[A-Za-z0-9_-]+`，与 agent 路由一致；`taskPath` 拼接仍无 `/`、`.`，无路径穿越风险。
- 本地验证：临时目录启动服务端实例，base36 ID 任务返回 `200 {"status":"done"}`，未知 base36 ID 返回 `任务不存在`，编码后的路径穿越请求返回 404；`npm test -- --run` 570 项通过。
- 提交 `48e67cd` 已推送；服务器构建镜像 `gpt-image-playground:48e67cd`（`8d0f53d56465`），容器切换为 `d923e9d5cd7a`。
- 线上验证：`GET /api-tasks/mtxnsicn7ogj3?meta=1` 由 404 变为 `200 {"status":"done"}`，完整结果接口返回 200（约 3.4 MB）；此前两个失败任务（`mtxnsicn7ogj3`、`mtxnsn758rwz5`）现均为 `done`。
- 附带观察：容器重启后 async task server 需要约 30 秒完成 `restoreTasks()` 扫描才监听 3000，期间 `/api-tasks*` 返回 502。该行为与本次改动无关，属既有启动特性。

## 2026-09-12 生图模型 ID 改为预设下拉框

- `src/lib/apiProfiles.ts` 新增 `PIXEL_IMAGE_MODEL_SUNBURST = 'gpt-image-2.5-sunburst'` 与 `PIXEL_IMAGE_MODEL_PRESETS = ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']`。
- 设置页「模型 ID」在 OpenAI + Images 场景改为下拉框（`SettingsModal.tsx`），不再自由输入；若历史值不在预设内，会作为额外选项保留在列表中，避免静默改写。Responses 文本模型、fal、自定义服务商仍保留输入框。
- 服务端托管模式下 AIPixel 的强制纠正逻辑调整为：命中预设则保留用户选择，否则纠正为 `gpt-image-2.5-flare`；AILink 仍保留浏览器配置。
- 服务端 `getUpstreamConfig` 使用请求携带的 `model`（仅在上游未提供时回退 env 默认值），因此下拉框选择会真正生效。
- 本地验证：`npm test -- --run`（37 个文件、570 项）与 `npm run build` 均通过。
- 提交 `a048911` 已推送并部署：镜像 `gpt-image-playground:a048911`（`103d97c668bf`），容器 `09e76321fd50`，公网 200，`upstream_proxy` 与 task server 监听均正常。
- 线上产物确认：`assets/index-BTXdmL_l.js` 中已包含 `gpt-image-2.5-sunburst`。
