# dsh-matrix-agent

DeepSeek Harness（dsh）的 Matrix agent 桥接插件：把 Matrix 房间桥接到 harness agent 会话，每个房间一个会话，支持在聊天里远程监控、审批和追加指令；多分身架构 + 媒体/富文本/回复/编辑信息完整处理。

> **独立演进**：本包由 `dsh-matrix` 独立而来，已断开与上游的远端关联，按自身路线演进。

```
src/
├── index.ts       # 插件入口（name/inject/apply/Config），无 default export
├── matrix.ts      # 兼容 shim：转发 @evlon/dsh-channel-matrix / @evlon/dsh-channel-core
├── tools.ts       # 兼容 shim：转发 @evlon/dsh-tools-channel
└── client-main.js # 浏览器端源码（esbuild 打包为 __ModuleLoader__ bundle）：设置页（单入口+标签页，含时间线 tab）、会话任务 tab、秘书工作台面板

test-system/     # 独立测试系统（真实 homeserver + AI 同事 + 断言引擎 + Web 实时界面，见下「测试系统」）
```

> **组合包**：本包是「纯组合包」——桥接层（bridge/config/format/settings/store/auth-store/
> member-store/chatlog/timeline/diag）已拆到独立仓库 [`@evlon/dsh-bridge`](https://github.com/evlon/dsh-bridge)；
> 通道实现 [`@evlon/dsh-channel-matrix`](https://github.com/evlon/dsh-channel-matrix)、通道抽象
> [`@evlon/dsh-channel-core`](https://github.com/evlon/dsh-channel-core)、原子工具
> [`@evlon/dsh-tools-channel`](https://github.com/evlon/dsh-tools-channel) 也各自独立。
> 本包只负责「组装」：把 bridge 挂进 cordis 组合、提供 cordis.patch.yml、以及 client 半的设置 UI。
> 岗位人设与秘书工作流由岗位 preset（`@evlon/dsh-job-presets`）+ 岗位 skill（`@evlon/dsh-job-skills`）承载。

## 架构

### 整体拓扑：每个分身一个 harness 进程

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        Matrix 房间（每个平台/模块一个房间）                        │
│                                                                              │
│   真人同事 @tianjintao   真人（Owner）@niukunliang     其他分身 @ai-liuliye      │
│     （Matrix 客户端）      （Matrix 客户端，仅客户端登录）   （跑在自己的 harness）    │
└──────────┬──────────────────────┬─────────────────────────┬──────────────────┘
           │                      │                         │
           │       房间内对话 / @提及 / 审批「批准/拒绝」        │
           ▼                      ▼                         ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         Matrix Homeserver（im-ipm.ict.cmcc）                    │
└──────┬───────────────────────┬──────────────────────────┬───────────────────┘
       │                       │                          │
       ▼                       ▼                          ▼
┌──────────────┐      ┌──────────────┐           ┌──────────────┐
│ Harness 进程 A │      │ Harness 进程 B │           │ Harness 进程 C │
│              │      │              │           │              │
│ userId:      │      │ userId:      │           │  （每个分身    │
│ @ai-niukun-  │      │ @ai-niukun-  │           │   一个独立     │
│ liang        │      │ liang-dev    │           │   进程）       │
│ owner:       │      │ owner:       │           │              │
│ @niukunliang │      │ @niukunliang │           │              │
└──────┬───────┘      └──────┬───────┘           └──────────────┘
       │                     │
       ▼                     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          dsh-matrix 插件（每个进程各跑一份）                      │
│                                                                              │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────────────┐  │
│  │ 通道层            │  │ 桥接层            │  │ 授权库                          │  │
│  │ @evlon/          │  │ @evlon/          │  │ @evlon/dsh-bridge              │  │
│  │ dsh-channel-matrix│ │ dsh-bridge        │  │ · 记忆授权（L1 静默放行）         │  │
│  │ · /sync 长轮询   │  │ · 消息路由        │  │ · Owner 房间确认（L2）            │  │
│  │ · send/typing  │  │   @提及/私聊/兜底 │  │ · 红线强制确认（L3，每次）        │  │
│  │ · 邀请自动加入    │  │ · 合并窗口 .. !!  │  │ · auth-store.json 落盘          │  │
│  │                │  │ · per-room agent │  │                                │  │
│  └────────────────┘  └────────────────┘  └────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 身份模型

| 角色 | Matrix 账号 | 登录位置 | 职责 |
|---|---|---|---|
| **真人（Owner）** | `@niukunliang:im-ipm.ict.cmcc` | **仅 Matrix 客户端** | 在房间与分身对话、应答「批准/拒绝」审批、吊销授权 |
| **数字分身** | `@ai-niukunliang:im-ipm.ict.cmcc` | **自己的 harness 进程** | 与真人同事、其他分身协作，执行研发/测试等工作 |
| **真人同事** | `@tianjintao:im-ipm.ict.cmcc` 等 | Matrix 客户端 | 在房间与分身协作（能否驱动分身由白名单控制） |

> 每个分身 = 一个独立 Matrix 账号 + 一个独立 harness 进程。分身账号的 `owner` 指向其工作责任负责人（真人），审批/吊销授权仅 Owner 可应答。

### 三级授权

```
分身请求执行工具
      │
      ▼
┌──────────────┐  命中红线（bash/write/edit…）  ┌──────────────────┐
│ 红线检查?      │ ───────────────────────────▶│ L3 强制房间确认     │
└──────┬───────┘                              │ （每次都要，不入库） │
       │ 未命中                              └──────────────────┘
       ▼
┌──────────────┐  有记忆授权                    ┌──────────────────┐
│ 记忆授权库?    │ ───────────────────────────▶│ L1 静默放行        │
└──────┬───────┘                              └──────────────────┘
       │ 无记录
       ▼
┌─────────────────────────────────────────────────────────────┐
│ L2 房间确认：推送审批 → 仅 Owner 回复「批准」有效                  │
│   → 批准后写入记忆授权（auth-store.json），下次同类工具 L1 放行     │
└─────────────────────────────────────────────────────────────┘
```

## 能力

- **Matrix → DSH**：白名单用户文本经合并窗口（`..` 继续 / `!!` 立即提交 / 裸文本进合并窗口）后，通过 `agent.followup` 注入对应房间的 agent 会话；`/bind <session-id>` 可切换到已有会话
- **媒体处理（图片/文件/音视频/位置）**：入站非文本消息自动下载（`mxc://` → `/media/v3/download`），保存到房间工作区 `.dsh-matrix/media`（或 `stateDir/media`）并附上本地路径；**图片额外持久化为多模态 `image` 内容块**，让模型直接看见——即使模型不支持视觉，harness 也会优雅降级为文本占位而非报错（避免旧版 `read_image` 工具不存在导致的 `unknown tool` 失败）；位置消息带坐标
- **信息完整（类人处理）**：`preserveRichText`（默认开）时入站消息信息不丢失——**图文混排**保留文字说明（caption，修复旧版丢 caption bug）、**富文本**（`formatted_body` 的链接/加粗/代码块/列表）注入结构注记、**回复引用**（`m.in_reply_to`）注入被回复原消息上下文、**编辑**（`m.replace`）标记为最新版并在聊天记录里去重替换；设为 `false` 回退纯文本旧行为
- **10 个 Matrix 工具**（经 `ctx.tools.register` 注册，模型可见且可直接执行）：`matrix_get_room_members` / `matrix_get_recent_messages` / `matrix_get_room_info` / `matrix_get_user_info` / `matrix_send_room_message` / `matrix_send_dm` / `matrix_mention_member` / `matrix_list_rooms` / `matrix_get_media` / `twin_timeline`（详情见下方「Matrix 工具」）
- **主动消息**：agent 可主动私聊、向房间发消息、@成员（`matrix_send_dm`/`send_room_message`/`mention_member`）；首用经 Owner 审批记忆授权（`proactiveSendRequiresApproval`），或配置关闭直接允许
- **房间事件**：入群/离群/邀请/改名换头像/房间名/主题变化经 `onRoomEvent` 投影，`notifyRoomEvents` 开启后注入 agent 会话（供主动打招呼等）
- **DSH → Matrix**：监听 `session/event`，把 `assistant/message` 的可见文本分段（前缀 `（i/n）` 参与长度收敛）后以 `org.matrix.custom.html` 发回；`turn/start` 显示 typing
- **数字分身架构**：**每个分身一个 harness 进程**——`userId` 即分身账号（bot 自己登录），`owner` 是真实人账号（仅在 Matrix 客户端登录）。分身与真人同事、其他分身在同一房间协作；@提及路由、私聊判定、多账号协调（可选 `digitalTwins` 同进程跑多分身）均已支持
- **三级授权**：
  - **L1 记忆授权**：非红线工具此前被批准过 → 静默放行（`auth-store.json` 持久化）
  - **L2 即时确认**：房间推送审批，配置了 `owner` 的账号**仅 Owner** 可应答，批准后写入记忆授权库
  - **L3 红线强制**：命中 `redlineTools`（默认 `bash`/`pwsh`/`write`/`edit`）→ **每次都必须确认**，批准永不入库
- **命令**：`/help` `/status` `/new` `/clear` `/bind <session-id>` `/auth list` `/auth revoke <tool>` `/auth revoke-all` `/memory` `/forget <userId>`
- **数字分身灵魂**：`soul.*` 配置（性格/风格/口头禅/习惯）经 `agentSetup` 注入每个 room agent 的 system prompt（section `twin:soul`，仅 Matrix 会话生效，不污染 GUI）；行为统计（回复数/工具调用/活跃时间）按 `matrix-` 前缀 session 聚合，分身可调用 `twin_soul_status` 工具读取自身人设与统计
- **社交记忆**：分身被邀请入群后按 `selfIntroTemplate` 主动 @ 成员自我介绍（上限 `maxSelfIntroMentions`）；`memberMemory` 开启时记住每个房间里见过的成员（含其他数字人），`/memory` 查看、`/forget <userId>` 忘记；`autoGreet` 开启时新成员入群会提示 agent 主动打招呼了解对方
- **DSH Web 设置界面（单入口 + 标签页）**：Client 半注册一个「数字分身」设置页（`settings.section` `dsh-matrix`），内部三个标签页——**Matrix 账号**（连接/模型路由/白名单）、**社交**（自我介绍/成员记忆/打招呼/测试房间前缀）、**时间线**（自我记忆查看/筛选/删除/清空）。配置统一持久化到 `dsh-matrix` settings namespace（连接类字段需重启生效）。可选项尽量用下拉：`provider`/`model` 来自 dsh 运行时目录（`llm.providers`/`llm.models`），`agentPreset` 来自 `agentPresets.list`；**Owner 提供默认值提示**——分身账号为 `@ai-xxxxxx` 时提示默认主人 `@xxxxxx`（仅配置页辅助，运行期不推导，显式配置优先）。**岗位人设与秘书工作流不再在此注入**——由岗位 preset（`agentPreset` 指向 `@evlon/dsh-job-presets` 的 pm/dev/qa/leader/newbie）承载
- **任务视图（会话「任务」tab + 全局「所有任务」）**：点击 Matrix 会话后，在「对话 / 轨迹 / 树状视图」后新增「任务」tab，展示该房间任务列表与状态（待审/已批/执行中/完成/拒绝），支持「批准/拒绝」按钮（复用 `/approve N` `/reject N` 命令语义）；会话头部「所有任务」按钮弹出全局面板，聚合**所有会话**的任务、按状态筛选、点击跳转对应会话。数据源为 Host 把各房间任务队列写入 `dsh-matrix` settings 的 **`tasksSnapshot` 运行时镜像**（非用户配置；任务变更防抖 300ms 更新）
- **自我时间线（跨房间记忆，防脑裂）**：记录分身自己的出站动作——回复、工具调用、主动消息、自我介绍、审批、任务推送——到 `twin-timeline.jsonl`（**仅结构化元数据：kind/roomId/时间/工具名/长度/主体，不落盘任何聊天原文**，守住「聊天内容不落盘」红线）。**按主体分层**：`actor: secretary`（秘书的请示/确认/交付调度）vs `worker`（干活会话的执行回复/工具），`twin_timeline` 工具与时间线 UI 均可按主体筛选。**逐级暴露**：① 常驻 system prompt 段 `twin:memory`（恒定提示词，字节永不变化，不影响 KV 缓存命中率，仅告知"你有自我记忆可查"）；② 分身用 `twin_timeline` 工具查行动摘要；③ 细节用 `matrix_get_recent_messages` 现查对应房间。设置页「数字分身 → 时间线」tab 可查看/筛选（类型/主体/房间）/**删除单条/清空全部**（经 settings `timelineOps` 命令字段，Host 处理后清零）。配置：`timelineEnabled`（记录开关）、`timelineInject`（常驻提示词段开关）、`timelineCrossRoom`（跨房间共享门控，默认隔离）、`timelineCap`（内存上限）
- **秘书编排（彻底分层）**：数字员工（有 owner）收到群任务时，agent 按岗位 skill 用原子工具自行完成「请示→读数据→整理→私发→等交付→发群」闭环：`matrix_request_owner_decision` 私下请示主人开工 → `matrix_set_room_cwd`/`matrix_list_workspace_files`/`matrix_read_workspace_file` 读真实数据整理 → `matrix_report_owner` 私下汇报完整结果等主人「交付」 → `matrix_send_room_message` 发群交付。bridge 只守两条红线：① 出站分流（assistant/message 内心独白吞掉，不自动发群）；② 交付授权门控（主人未回「交付」前 `matrix_send_room_message` 拒绝，防跳过请示直接发群）。**群里只见自然的人话 + 最终交付物，绝无「请示/待审/等老板」泄露**
- **秘书工作台 UI（大尺寸面板，合理利用桌面可视区）**：入口——**会话头部右上角快捷入口**（`conversation.session.header.utilities`）。点击弹出**大尺寸面板**（占可视区 ~68% 宽、全高、右滑 + 遮罩），**两栏布局（中间分隔条可拖拽调宽度，28%–72%）**：左栏任务列表（按流转分组：待审/🤔请示中/执行中/🔐待确认/完成/已拒绝，每行状态/角色/房间/工作目录状态）、右栏选中任务详情（完整文本/角色/房间/发起人/工作目录/老板指示与意见历史/操作按钮）。**任务 tab**：老板直接「批准开工/给指示/确认交付/给意见/批准/拒绝」+ **设工作目录**（未设目录任务输入路径绑定 cwd，等价于拖到工作区）；**时间线 tab**：自我记忆（主体秘书/干活筛选、删除/清空）。操作经 settings `secretaryOps` 命令字段（含 `set-cwd`），Host 处理后清零。私聊回复仍保留为备选（状态机幂等）。会话头部「所有任务」按钮已移除，由工作台统一
- **可靠性**：事件 id 持久去重环、sync token 落盘重启续传、长回复 HTML 失败回退纯文本、sync 循环指数退避、LLM 受限重试熔断（`maxRetriesBeforeAbort`）

### Matrix 工具

`matrixTools: true`（默认）时经 `ctx.tools.register` 注册以下 10 个工具，agent 既能看见 schema 也能直接调用执行体：

| 工具 | 说明 |
|---|---|
| `matrix_get_room_members` | 取房间成员名单（含显示名/头像 URL） |
| `matrix_get_recent_messages` | 取房间最近 N 条消息（正序，按需回溯上下文） |
| `matrix_get_room_info` | 取房间基本信息（房间名、人数、是否私聊等） |
| `matrix_get_user_info` | 取指定用户的显示名与头像 |
| `matrix_send_room_message` | 主动向房间发文本/HTML 消息 |
| `matrix_send_dm` | 主动给指定用户私聊（自动复用既有 1:1 房或 create-room+invite） |
| `matrix_mention_member` | 发消息并 @ 一个或多个成员（HTML `m.mention` 锚点 + `@名字` 文本兜底，校验目标都是房间成员） |
| `matrix_list_rooms` | 列出已加入房间及名称/成员数 |
| `matrix_get_media` | 下载 Matrix 媒体（`mxc://`）为本地文件并返回路径，或返回 base64 |
| `twin_timeline` | 查自己的跨房间时间线（仅结构化元数据：回复/工具/主动消息/自我介绍/审批/任务），回忆自己在别处做过的事，防脑裂 |

主动发送类工具（`matrix_send_dm`/`send_room_message`/`mention_member`）`isConcurrencySafe=false`（防并行重复发送），首用经 `proactiveSendRequiresApproval` 控制。

## 为什么通道层不用现成 SDK

matrix-js-sdk 的 Node ESM 导入在 v42 是坏的（`oauth` 模块的目录导入，官方建议用户自己上 bundler）；matrix-bot-sdk 的 E2EE 原生二进制依赖被 pnpm 默认拦截的 postinstall 下载。而 dsh 插件运行在 dsh 自己的 Node 进程里，两者都不合适。因此通道层参照 telegram 插件自写客户端的做法，用 `fetch` 直连 client-server API（sync / send / typing / join 四个端点），**零运行时协议依赖**，`dsh plugin add` 安装无需任何构建授权。

## 安装

```bash
# 从本仓库 checkout 安装到 profile（dsh.bundle 声明自动加入组合层）
dsh plugin --profile web add .
# 或 git 安装（需要 pnpm 允许该包的 prepare 构建脚本，见 dsh 官方 publish 教程）
dsh plugin --profile web add github:you/dsh-matrix
# 验证
dsh --profile web --dump-config | grep matrix
```

git 安装拉的是源码：本包 `prepare` 脚本用 tsc 从 `src/` 构建出 `lib/`，pnpm ≥10 首次 `add` 会因未授权构建脚本失败，把提示的包键加进该 profile 的 `pnpm-workspace.yaml` 后重试：

```yaml
allowBuilds:
  dsh-matrix: true
```

也支持 npm 发布 / `pnpm pack` tarball，两种都不需要构建授权。

## 配置

在 profile 的 `cordis.patch.yml` 行上覆盖（整个 `config` 值替换，不深合并）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `homeserverUrl` | 必填 | homeserver 的 client-server API base URL |
| `accessToken` | `''` | 分身 access token；为空回退环境变量 `DSH_MATRIX_TOKEN`，两者都缺则插件加载失败 |
| `userId` | 必填 | 本进程登录的数字分身账号，如 `@ai-niukunliang:example.org` |
| `owner` | `''` | 工作责任负责人（真人账号，仅客户端登录）；设置后审批/吊销仅其可应答 |
| `respondToAll` | `true` | 响应房间所有消息；设为 `false` 则仅 @提及/私聊 响应 |
| `allowedUserIds` | `[]` | 白名单；为空且 `allowAllUsers=false` 时拒绝所有人（fail closed） |
| `allowAllUsers` | `false` | 允许任意用户（仅开发用） |
| `provider` | `deepseek-official` | 每个房间 agent 的 LLM provider |
| `model` | `deepseek-v4-flash` | 每个房间 agent 的模型 |
| `agentPreset` | `standard` | room agent 挂载的 agent preset（决定工具集与角色提示）；留空则无工具 |
| `chunkMaxChars` | `4000` | 出站单条消息字符上限（含分段前缀） |
| `mergeTimeoutSecs` | `5` | 裸文本合并窗口（秒） |
| `approvalTimeoutSecs` | `300` | 审批推送后等待聊天答复的秒数 |
| `stateDir` | `.dsh-matrix` | 状态目录（`state.json` 房间映射 + 去重 + sync token） |
| `maxRetriesBeforeAbort` | `5` | 同一房间 turn 内 LLM 受限自动重试达到该次数时主动 cancel 止损 |
| `retryCircuitBreakerEnabled` | `true` | 是否启用重试熔断兜底 |
| `digitalTwinMode` | `false` | 可选：同一进程挂载多个分身（见下方示例） |
| `digitalTwins` | `[]` | 额外分身账号列表（通常每个分身一个进程，无需配置此项） |
| `authStoreFile` | `auth-store.json` | 记忆授权库文件名（相对 `stateDir`） |
| `redlineTools` | `['bash','pwsh','write','edit']` | 红线工具：即使有记忆授权也每次强制房间确认 |
| `cwdCandidates` | `[进程 cwd]` | 新房间工作目录引导的候选目录列表；首项作为缺省 |
| `taskQueueMax` | `20` | 单个房间 matrix 任务队列上限，超出后最早 pending 任务自动拒绝 |
| `matrixTools` | `true` | 是否注册 10 个 Matrix 工具（成员/消息/房间/用户查询、主动发送、媒体下载、自我时间线） |
| `notifyRoomEvents` | `false` | 是否把入群/离群/资料变更等房间事件注入 agent 会话（供主动打招呼等） |
| `proactiveSendRequiresApproval` | `true` | 主动消息工具（`matrix_send_dm`/`send_room_message`/`mention_member`）首用是否需 Owner 批准 |
| `preserveRichText` | `true` | 是否保留富文本（`formatted_body`）/回复上下文/编辑语义，结构化注入 agent（类人信息完整）；`false` 回退纯文本 |
| `soul.enabled` | `true` | 是否启用灵魂注入（性格/风格/口头禅/习惯注入 room agent 的 system prompt） |
| `soul.persona` | `'你叫小灵…'` | 性格/人设描述（自由文本） |
| `soul.style` | `'friendly'` | 说话风格：`concise`/`friendly`/`formal`/`humorous`/`sassy` |
| `soul.catchphrase` | `'交给我吧'` | 口头禅（可选） |
| `soul.habits` | `'先确认需求再动手…'` | 工作习惯（自由文本） |
| `soul.replyLength` | `'short'` | 回复长度偏好：`short`/`normal`/`detailed` |
| `testRoomPrefix` | `'【测试】'` | 房间名前缀匹配即视为测试房间，给数字人注入测试声明（「当前是测试环境，请勿真实执行任务/修改文件/向真实用户发送消息」）；空=关闭 |
| `twinModeRoomPrefix` | `''` | 房间名前缀匹配即启用秘书编排（任务入队/开工请示/交付确认），即使 `digitalTwinMode=false`；用于「只给测试房间开秘书编排」；空=不启用 |
| `secretaryGroupDefault` | `true` | **群聊默认启用秘书编排**：Matrix 群聊消息（非私聊）默认进任务队列待 owner 审核/请示/确认，无需 `digitalTwinMode` 或前缀；@ 提及自己的即时交流仍直接回复。设为 `false` 关闭群聊默认（此时仅 `digitalTwinMode=true` 或前缀匹配才启用） |
| `secretaryDmDefault` | `false` | **私聊默认秘书编排**：默认 `false`（私聊保持直接对话）；设为 `true` 时数字分身的私聊消息也进任务队列待 owner 审核。仅对数字分身账号（非主账号）生效 |
| `roomRoles` | `{}` | 房间 → 灵魂预设 id 的固定角色映射（如 `{ '!room:hs': 'dev' }`）；未配置用百变员工 |
| `taskClarifyBeforeStart` | `true` | 开工前是否私下 DM 老板请示要求/优先级；超时按原任务开工 |
| `taskClarifyTimeoutSecs` | `120` | 开工请示等待秒数 |
| `taskConfirmBeforeDeliver` | `true` | 交付前是否私下 DM 老板结果摘要请求确认 |
| `taskConfirmTimeoutSecs` | `600` | 交付确认等待秒数 |
| `taskConfirmTimeoutAction` | `'hold'` | 确认超时行为：`hold`（挂起待确认）/`deliver`（自动交付）/`cancel`（取消） |
| `taskConfirmExemptMatters` | `[]` | 豁免交付确认的事分类（低风险任务跳过确认） |

**内置灵魂预设**（设置页「选择预设」一键填充，可再微调后保存）：

| 预设 | 适用 |
|---|---|
| `dynamic` 百变员工（默认） | 根据房间氛围/语境自动切换人设与语气 |
| `default` 综合助手 | 通用助手，靠谱有人情味 |
| `pm` 产品经理 | 关注用户价值与目标拆解，习惯先对齐需求 |
| `dev` 研发工程师 | 技术扎实、沟通直接，先说根因再给方案 |
| `qa` 测试工程师 | 细心严谨，问题描述带复现步骤/预期/实际 |
| `leader` 领导（负责人） | 看全局抓重点，协调资源推动决策 |
| `newbie` 新入职员工 | 谦虚好学，持续学习完善，不懂就问 |
| `autoIntroduce` | `true` | 自己入群后是否主动 @ 成员做自我介绍 |
| `maxSelfIntroMentions` | `20` | 自我介绍 @ 人数上限（超出截断并附「等 N 人」） |
| `memberMemory` | `true` | 是否记住成员资料（join/profile/消息 upsert，落盘 `member-memory.json`） |
| `autoGreet` | `true` | 新成员（含其他数字人）入群时是否提示 agent 主动打招呼了解对方 |
| `selfIntroTemplate` | 模板 | 自我介绍模板；`{{userId}}`/`{{role}}`/`{{owner}}` 占位符可替换 |

### 配置示例

**推荐：每个分身一个 harness 进程（单账号模式）**

```yaml
# 分身 @ai-niukunliang 的 profile 配置
userId: '@ai-niukunliang:example.org'        # 本进程登录的分身
accessToken: '...'                            # 分身的 token（或 tokenEnv 环境变量）
owner: '@niukunliang:example.org'             # 真人账号（仅客户端登录）：审批仅其可应答
respondToAll: true                            # 参与房间协作，响应所有消息
allowAllUsers: false                          # 生产建议用白名单 fail closed
allowedUserIds: ['@niukunliang:example.org', '@tianjintao:example.org']
```

**可选：同一进程挂载多个分身（`digitalTwinMode`）**

```yaml
digitalTwinMode: true
digitalTwins:
  - userId: '@ai-niukunliang-pm:example.org'        # 分身账号（需预先注册并取得 access token）
    tokenEnv: 'DSH_MATRIX_AI_NIUKUNLIANG_PM_TOKEN'  # 从环境变量读 token（推荐）；或直接 accessToken
    owner: '@niukunliang:example.org'               # 工作责任负责人：仅其可在房间应答审批
    role: 'pm'                                      # 角色标签（展示用）
    respondToAll: false                             # 默认仅 @提及/私聊 响应；true 则响应所有消息
    provider: ''                                    # 留空回退顶层 provider/model
    model: ''
```

每个分身独立 sync 循环、独立状态文件（`<stateDir>/twins/<localpart>.json`）、独立 per-room agent 会话；审批按「分身×房间」维度记录记忆授权，Owner 变更不影响其他分身。

## 使用

1. 真实人在 Matrix 客户端登录自己的账号（如 `@niukunliang`），把它加进目标房间
2. 每个分身账号各启动一个 harness：`dsh --profile <分身profile>`，插件自动加入房间（邀请自动接受）
3. 房间里 @提及 分身即可让它干活；分身要执行红线工具时会推送审批，**Owner 在客户端回复「批准/拒绝」**（超时按 unavailable 处理）
4. 常用命令：`/status`（看会话）、`/auth list`（看记忆授权）、`/auth revoke <tool>`（吊销，仅 Owner）
5. `dsh plugin --profile web remove dsh-matrix` 卸载；组合层变更需重启 dsh 进程（不参与 HMR）

## 安全红线

- Matrix 通道等于绕过本机批准体系：approval 应答必须来自白名单 sender 且对应本房间真实 pending 的审批
- 聊天内容只能进会话流（`source.kind = 'plugin'`），绝不允许直接执行 shell
- access token 不进日志、不落盘；`state.json` 不包含任何聊天内容

## 开发

```bash
corepack pnpm install
corepack pnpm test        # tsc + node --test（format 单测 + 假 homeserver 端到端）+ esbuild 打包 client
corepack pnpm build       # tsc（lib/ 产物）+ esbuild 打包 src/client-main.js → lib/client.js
```

改完代码必须重新 build 并重启 dsh 进程（ESM 缓存 + web bundle 重新扫描）。

> **Client 半构建约定**：dsh web 的 client-modules 加载器要求 `exports["./client"]`
> 指向 `window.__ModuleLoader__.load({ id, factory })` 注册格式的自包含 bundle。
> 本项目用 **esbuild** 打包：`src/client-main.js`（ES module 源码，`import React`）
> → CJS bundle → banner/footer 包装成 `__ModuleLoader__.load` 格式 → `lib/client.js`
> （见 `scripts/build-client.mjs`）。`react` 外部化（dsh 模块系统的 shell seed，
> 由 factory(require) 注入，避免与 shell 的 React 实例冲突）；其余代码内联自包含。
> 构建后自动 `node --check` 语法自检。改 client 半时改 `src/client-main.js`，不要改
> `lib/client.js`。

## 测试系统（test-system）

独立于插件仓库根项目的 Node 测试项目（`test-system/`）：连**真实 Matrix homeserver**，
模拟多个群 + 多个 **AI 同事**（LLM 扮演），对运行中的数字人发起真实对话，实时网页查看过程、
断言评估、出测试报告——支撑「设计 → 开发 → 测试 → 改进」闭环。

- **多群 + AI 同事**：同时跑多个测试房间（群），每房间独立对话循环；OpenAI 兼容 LLM 扮演同事
  （角色 persona + 房间上下文 + 测试目标），动态发言、追问细节
- **实时网页**：SSE 推送房间列表 + 对话流（同事↔数字人气泡）+ 状态徽标（进行中/完成/失败）
- **干预控制**：每房间暂停/继续/跳过等待/停止/换同事/注入消息，全局全部暂停/继续/停止
- **场景生命周期**：Web 顶部场景下拉 + 开始/重新开始/停止（stop 清空、重跑 run 计数 +1）、单房间重跑
- **断言引擎**：场景房间定义断言（`twin-replied`/`twin-responded-in-time`/`twin-mentioned-colleague`/
  `message-count`/`twin-sent-dm`/`boss-approved`/`task-delivered`/`custom`），房间跑完自动评估，
  房间卡显示 ✔/✘ 徽标、对话流逐条显示、聚合场景报告——失败的断言即改进清单，改完插件点「重新开始」重测
- **秘书流程场景**：`task-flow` 场景 + `BossAgent`（模拟老板：监听数字人私聊，「任务请示」→批准、
  「交付确认」→确认交付）——数字人侧把 `twinModeRoomPrefix` 设为测试房间前缀即可在测试房间开秘书编排
  （见 `test-system/README.md` 完整说明）

## 已知限制与路线图

- **仅非加密房间**：`m.room.encrypted` 事件只提示不支持（E2EE 二期：Rust crypto + 设备验证）
- **媒体已支持，但无 OCR/转写**：图片/文件/音视频会下载落盘并作为多模态附件/路径交给 agent；暂不内置 OCR、音频转写、视频抽帧等解析（可用 agent 自身能力或外部工具处理已保存的文件）
- **不流式推送工具进度**：每条 `assistant/message` 一条（或多条分段）消息
- **仅长轮询**：无 appservice/webhook 模式，主机需可出站访问 homeserver
