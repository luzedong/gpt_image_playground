# Task Plan: Pixel Image Studio 工作区

## Goal

在现有 gpt_image_playground 功能骨架上，接入 Pixel API 的生图/编辑流程，提供受 InvokeAI 启发的画布式工作区，并使用 tui-image-editor 完成遮罩编辑，同时保留原有画廊、历史和 API 配置能力。

## Current Phase

Phase 17: Agent 对话异步生图恢复（进行中）

## Phases

### Phase 1: Requirements & Discovery

- [x] 检查仓库结构、技术栈、现有 API 和遮罩流程
- [x] 确认现有功能可复用范围
- [x] 记录设计与许可证约束
- **Status:** complete

### Phase 2: Planning & Structure

- [x] 定义 Studio 工作区信息架构
- [x] 确定 tui-image-editor 的集成边界
- [x] 拆分新增组件与工具模块
- **Status:** complete

### Phase 3: Implementation

- [x] 新增 Studio 工作区入口与三栏布局
- [x] 接入 tui-image-editor 遮罩编辑器
- [x] 将工作区提交动作连接到现有 submitTask/API 层
- [x] 完善结果预览、重用和错误状态
- **Status:** complete

### Phase 4: Testing & Verification

- [x] 运行类型检查和生产构建
- [x] 运行现有测试
- [x] 启动开发服务器检查页面和遮罩编辑流程
- [x] 检查移动端布局、键盘焦点和 reduced-motion
- **Status:** complete

### Phase 5: Delivery

- [x] 审查变更范围和依赖许可证
- [x] 更新进度与使用说明
- [x] 向用户交付可运行结果和验证信息
- **Status:** complete

### Phase 6: 外部 Prompt 素材库可行性评估

- [x] 核查 `freestylefly/awesome-gpt-image-2` 基本信息、默认分支与更新状态
- [x] 分析 Prompt、图片、分类及可复用索引的数据结构
- [x] 核查许可证、免责声明与图片再分发风险
- [x] 评估仓库体积、同步方式和与当前 Studio 的集成成本
- [x] 给出推荐接入架构与实施边界
- **Status:** complete

### Phase 7: awesome-gpt-image-2 素材库接入

- [x] 新增远程 manifest/图片 URL 解析与校验模块
- [x] 在 Studio 左侧增加 Prompt 灵感库、搜索和分类筛选
- [x] 实现 Prompt 一键填充与单图按需导入
- [x] 增加网络失败、加载中、来源标识和授权提示
- [x] 编写单元测试并完成构建、全量测试和浏览器 smoke 验证
- **Status:** complete

### Phase 8: Agent 语言模型配置体验修复

- [x] 定位 Agent 语言模型无法直接设置的原因
- [x] 让 Agent 配置页始终显示当前生效的语言模型
- [x] 支持在 Agent 配置页直接修改所选文本 Profile 的模型 ID
- [x] 为缺少 Responses API 配置的状态提供明确创建/配置入口
- [x] 完成构建、全量测试和桌面/移动端交互验证
- **Status:** complete

### Phase 9: 微信小程序开发计划

- [x] 明确小程序首发产品范围和暂缓功能
- [x] 设计小程序端、业务后端和模型服务架构
- [x] 梳理当前 Web 功能的迁移与重写边界
- [x] 制定阶段、接口、审核、风险和验收计划
- [x] 输出独立 Markdown 开发计划
- **Status:** complete

### Phase 10: 部署默认配置固化

- [x] 核对当前 Pixel Profile 与默认生成参数
- [x] 固化 Pixel API URL 与其余非敏感部署默认设置
- [x] 支持静态构建、Docker 和 GitHub Pages 仅注入 API Key
- [x] 更新部署示例与安全说明
- [x] 完成构建、全量测试和 diff 校验
- **Status:** complete

### Phase 11: 启动 Key 引导与任务恢复

- [x] 空 Key 时每次打开/刷新显示同风格输入弹窗
- [x] 支持弹窗内校验、保存、键盘操作和移动端布局
- [x] 审计同步、流式和异步任务在刷新/关闭时的生命周期
- [x] 保留并复用现有服务端异步任务启动恢复与继续轮询
- [x] 对 Pixel 同步请求实现刷新后自动重新提交，并记录重复请求边界
- [x] 补充测试、部署说明与浏览器验证
- **Status:** complete

### Phase 12: Pixel Agent 默认配置统一

- [x] 默认 Agent 使用 `gpt-5.6-luna` 与 Responses API
- [x] Agent 与生图配置共用 Pixel API URL 和 API Key
- [x] 移除 Agent 新建流程中的 OpenAI 官方 URL 回退
- [x] 迁移旧浏览器中自动生成的 OpenAI Agent 配置
- [x] 完成测试；推送并重新部署 `jdy:5173`
- **Status:** complete

### Phase 13: 灵感库本地化与手动同步

- [x] 新增手动同步脚本，将上游清单和案例图拉取到 `public/prompt-library`
- [x] 执行脚本并将当前素材快照纳入 Git
- [x] 前端改为仅请求本站同源清单和图片
- [x] 更新测试、README 与部署静态资源缓存配置
- [x] 完成构建、全量测试、提交并推送 `main`
- **Status:** complete

### Phase 14: 服务端固定模型与按分辨率路由

- [x] 梳理现有 API Profile、聊天请求、生图尺寸和部署配置链路
- [x] 设计并实现服务端配置读取与客户端不可编辑的固定 Profile
- [x] 实现聊天、1K 生图、4K 生图的固定 URL/模型路由
- [x] 更新部署示例、接口契约和必要测试
- [x] 完成构建、全量测试和 diff 检查
- **Status:** complete

### Phase 15: 服务端锁定配置下恢复流式开关

- [x] 定位锁定配置导致流式开关不可点击且提交后被策略覆盖的原因
- [x] 允许 OpenAI 预置 Profile 保存流式传输和中间图像数偏好
- [x] 完成测试、构建、提交推送和远端部署验证
- **Status:** complete

### Phase 16: 服务端异步生图任务

- [x] 确认当前同步请求由浏览器持有，切换页面会中断；确定仅 Docker 服务端模式接入异步队列
- [x] 新增持久化任务服务、上游调用和任务状态查询接口
- [x] 前端保存服务端任务 ID，切页/刷新后轮询原任务并落库结果
- [x] 更新 Docker/Nginx 启动方式、数据卷和部署说明
- [x] 完成测试、构建、部署和移动端生命周期验证
- **Status:** complete

### Phase 17: Agent 对话异步生图恢复

- [x] 让 Agent 混合模式的服务端图片任务在 Responses 连接断开后保持运行并恢复
- [x] 页面重开时恢复已完成图片任务对应的 Agent 轮次
- [x] 增加断线/重开回归测试
- [x] 完成构建、全量测试和 diff 检查
- **Status:** complete

## Key Questions

1. 如何让 Studio 工作区复用现有 `InputBar`、`TaskGrid`、`submitTask` 和 IndexedDB，而不是复制一套状态？
2. tui-image-editor 如何只负责遮罩绘制，同时保持现有白色可编辑区域、蓝色预览和遮罩尺寸校验语义？
3. 如何在不破坏现有 Gallery/Agent 模式的情况下引入 Studio 入口？

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| 复用现有 OpenAI-compatible API 层 | 仓库已经支持 `images/generations`、`images/edits`、URL/base64 响应和自定义服务商映射 |
| 先做独立 Studio 视图，不重写整个 Gallery | 降低回归风险，同时保留现有历史、批量操作和 Agent 能力 |
| tui-image-editor 只作为遮罩编辑实现 | InvokeAI 的完整画布/节点系统过重；当前 API 只需要主图、遮罩和 prompt |
| 使用 MIT 许可的 `tui-image-editor` | 适合当前 MIT 项目，便于商业改造；保留许可证记录 |
| Studio 默认采用深色三栏工作区 | 与现有产品截图和 InvokeAI 的创作工作流一致，突出画布与结果 |
| Agent 语言模型继续复用 API Profile | 模型还依赖 URL、Key、Responses API 与推理强度，独立保存模型字符串会产生无效组合 |
| Agent 配置页直接暴露语言模型 ID | 当前只显示 Profile 下拉框，用户无法确认或修改实际发送的模型，容易误以为模型被写死 |
| 新部署仅注入 Key | Pixel API URL、Provider、Images API 模式、`gpt-image-2` 与当前生成参数属于产品默认值，不应要求部署者重复配置 |
| 默认 Agent 使用混合模式 | `gpt-5.6-luna` 负责 Responses 对话，`gpt-image-2` 继续通过 Images API 生图；二者共享 Pixel URL 和 Key |
| 灵感库使用 Git 内置快照 + 手动同步脚本 | 用户不需要依赖浏览器直连 GitHub，也不运行后台定时任务；升级素材时由维护者执行脚本并提交快照 |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| 首次 `npm run build` 找不到 `tsc` | 1 | 重新执行 `npm install --ignore-scripts --no-audit --no-fund`，确认 node_modules bin 链接恢复 |
| Pixel 测试 URL 出现 `/v1/v1` | 1 | 复用项目 `buildApiUrl` 自带的 `/v1` 规范化，仅在尾斜杠 Base URL 场景补 path 前缀 |
| 编辑接口测试复用了已消费的 `Response` | 1 | 将 fetch mock 改为每次调用都创建新的 `Response` |
| 新增 TUI 转换测试的 mock 触发 Vitest hoist 错误 | 1 | 使用 `vi.hoisted` 初始化共享 mock |
| TUI 转换测试默认 Node 环境没有 Canvas DOM | 2 | 为该测试声明 `jsdom` 环境 |
| 一次并行抓取输出过大被工具截断 | 1 | 改为将 GitHub API 数据落到临时目录后，用 `jq`/`rg` 提取统计与关键片段 |
| 默认 Pixel Profile 导致既有通用 OpenAI Images 测试误走精简契约 | 1 | 测试显式使用非 Pixel URL，并保留 Pixel 专属契约测试 |
| Chrome smoke 首次使用模糊 label 匹配到多个控件 | 1 | 改用 `textbox` role 精确定位 API Key 输入框 |
| 当前机器 Docker daemon 不可用 | 1 | 执行 Dockerfile/脚本静态审计与 shell 语法检查，未构建镜像 |
| zsh 将 GitHub API URL 的 `?ref=main` 解析为通配符 | 1 | 为包含查询参数的 URL 加单引号后继续检查 |

## Notes

- 现有 `MaskEditorModal` 已有完整 Canvas 遮罩、缩放、撤销/重做和尺寸预处理逻辑。
- `src/lib/openaiCompatibleImageApi.ts` 已实现 multipart 编辑请求：`image[]` + `mask`，无需重复实现 API 请求。
- 新增 UI 必须遵循现有 2 空格、单引号、无分号风格。
