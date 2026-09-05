# 排查发现

- 用户看到同一时间段两笔 `pro / gpt-image-2 / v1/images/generations`，耗时约 30.38 秒和 32.92 秒。
- 需要区分批量工具调用（一次 Agent 任务内并行两次上游请求）与整轮任务重复执行。
- 已确认不是一次 Agent 任务内的两个生图工具调用：线上同一提示词分别经过 `POST /api-agent-tasks` 和 `POST /api-tasks`。
- `syncServerManagedAgentProgress()` 创建的 Agent 生图占位任务带有 `sourceMode: 'agent'`、`agentConversationId`、`agentRoundId`、`agentToolCallId`，但没有普通图像任务的 `serverTaskId`。
- `resumePendingTasks()` 原先会把所有 `status === 'running'` 任务重新交给 `executeTask()`，导致服务端 Agent 占位任务被重复提交；Agent 轮次本应由 `resumePendingAgentRounds()` 根据 `round.serverTaskId` 恢复。
- 修复边界：仅在服务端托管配置开启、任务是 Agent 任务且没有 `serverTaskId` 时跳过普通任务恢复；普通 Agent 恢复和带真实 `serverTaskId` 的任务不跳过。
- 部署回归原因：直接使用本地 `npm run build` 的 `dist` 覆盖 Docker 运行时资源时，没有 Dockerfile 构建阶段的 `VITE_SERVER_MANAGED_API_CONFIG=true` 占位符注入；前端因此退回客户端配置模式并弹出 API Key 输入。
- 已用原部署前镜像 `7234329d1c37...` 回滚线上容器，API 配置挂载和服务端任务数据未改动。
- 00:42 左右线上 Agent 任务 `mtom0v2335x7l` 的服务端记录显示：图片已进入 `progress.images`，但整个 Agent 任务直到约 00:43:07 才标记 `done`；最终结果约 1MB，包含图片 Base64 和最终文本。
- 当前流程将“图片工具完成”和“Agent 整轮完成”绑定：图片生成后还要把图片作为输入继续请求聊天模型，等待最终文字回复，期间对话轮次继续显示运行中。
- 轮询状态本身约每 800ms/1s 一次，不是主要瓶颈；主要可优化点是让图片结果独立完成并立即展示，同时将 Agent 最终回复作为后续状态，不阻塞画廊图片。
- 已实现安全的前端解耦提示：AgentRound 增加 `imageReady`，收到服务端进度图片后立即记录；对话等待文案改为“图片已生成，正在整理回复”，但后台轮次仍保持 running，避免中途允许下一轮或错误恢复。
- 镜像构建失败根因已确认：构建命令使用了 `docker build ... <context>`，但仓库根目录没有 `Dockerfile`；实际 Dockerfile 位于 `deploy/Dockerfile`，应使用 `docker build -f deploy/Dockerfile ... <context>`。远程日志为 `failed to read dockerfile: open Dockerfile: no such file or directory`，业务代码本身不是构建失败原因。
- 新增优化确认：Agent 进度接口不再返回图片 Base64，而是返回同源图片资源地址；服务端将图片写入任务目录下的 `agent-images`，前端收到资源后再转换为 data URL，用于立即更新画廊。
- 图片结果新增 `startedAt`/`finishedAt`，图片任务计时不再包含 Agent 最终文字回复时间。
- 最新任务 `mtonjekl3ix7e` 对齐结果：图片工具完成于 `17:26:06`，进度接口在 `17:26:07` 被前端发现，图片资源请求在 `17:26:14` 完成；服务端并非等到最终回复才提供图片，但旧前端仍要等本地 IndexedDB/缩略图流程完成才渲染。
- 已改为任务卡收到 `previewImageUrl` 后直接展示服务端图片，后台再完成本地持久化。
