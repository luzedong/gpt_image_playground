# Progress Log

## Session: 2026-08-24

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
