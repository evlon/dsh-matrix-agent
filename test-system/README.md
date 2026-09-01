# 数字人行为测试系统（test-system）

独立测试系统：连**真实 Matrix homeserver**，模拟多个群 + 多个 **AI 同事**（LLM 扮演），
对运行中的 dsh-matrix-agent 数字人发起真实对话，实时网页查看测试过程。

## 特性

- **多群**：同时启动多个测试房间（群），每个房间独立对话循环
- **AI 同事**：OpenAI 兼容 LLM 扮演同事（角色 persona + 房间上下文 + 测试目标），动态生成发言、追问细节
- **实时网页**：SSE 推送，房间列表 + 对话流（同事↔数字人气泡）+ 状态徽标（进行中/完成/失败）
- **解耦**：独立 LLM key，不依赖 dsh 进程（通过真实 Matrix 与数字人交互）

## 架构

```
test-system（本目录，独立 Node 项目）
  ├─ orchestrator.ts   场景推进：创建房间 → 同事 AI 发言 → 等数字人 → 记录事件
  ├─ matrix-client.ts  多账号 Matrix 客户端（create-room/invite/send/receive）
  ├─ ai-colleague.ts   LLM 同事（OpenAI 兼容）
  ├─ scenarios/        场景定义（MVP：基本对话）
  └─ web/              http + SSE + 静态页（实时展示）
        │
        │ Matrix 协议（真实 homeserver）
        ▼
  数字人（dsh web 运行 dsh-matrix-agent，加入测试房间按插件逻辑响应）
```

## 准备

1. **同事测试账号**：在 homeserver（Synapse）预建若干测试账号（如 `@zhang:server`、`@li:server`），各拿一个 access token。
2. **数字人账号**：dsh-matrix-agent 的分身账号（如 `@ai-niukunliang:server`）已配置运行。
3. 复制 `.env.example` 为 `.env` 并填写。

## 配置（.env）

```bash
HOMESERVER=https://im-ipm.ict.cmcc
TWIN_USER_ID=@ai-niukunliang:im-ipm.ict.cmcc
# 同事账号：userId:accessToken，逗号分隔
COLLEAGUE_TOKENS=@zhang:im-ipm.ict.cmcc:syt_xxx,@li:im-ipm.ict.cmcc:syt_yyy
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-xxx
LLM_MODEL=gpt-4o-mini
WEB_PORT=3088
ROUNDS_PER_ROOM=6
REPLY_TIMEOUT_SECS=90
```

## 运行

```bash
cd test-system
npm install
npm run build
npm start
```

启动后：
- `AUTO_START=true`（默认）自动创建「研发讨论群」「产品讨论群」两个房间，邀请数字人 + 同事
- 每个房间独立循环：同事 AI 发言 → 等数字人回复 → 下一轮（最多 `ROUNDS_PER_ROOM` 轮）
- 浏览器打开 `http://127.0.0.1:3088`（或部署后的 `http://ai-test.ict.cmcc`）实时看对话流
- Ctrl+C 优雅停止

## 测试生命周期（Web UI 顶部）

| 控制 | 行为 |
|---|---|
| 场景下拉 | 选择测试场景（当前：基本对话） |
| ▶ 开始测试 | 启动所选场景（停止并清空现有房间 → 建新房间） |
| 🔄 重新开始 | 重跑当前场景（run 计数 +1） |
| ⏹ 停止 | 停止全部房间并清空列表 |
| 房间控制条「🔄 重跑本房间」 | 单房间重跑（房间 done/error 后仍可用） |

- 顶部显示当前场景 + 轮次（如「场景「基本对话」· 第 2 轮」）
- `AUTO_START=false` 时启动后不自动跑，等你在 Web 点「开始测试」

## 干预控制（Web UI）

测试进行中可在网页底部控制条主动干预（每个房间独立）：

| 按钮 | 行为 |
|---|---|
| ⏸ 暂停 / ▶ 继续 | 暂停/恢复房间循环（在下一轮开始前生效） |
| ⏭ 跳过等待 | 不等数字人回复，立即进入下一轮（数字人卡住时用） |
| ⏹ 停止 | 提前结束该房间 |
| 换同事 | 从下一轮起改用指定同事发言（覆盖轮流顺序） |
| 注入 | 以指定身份手动发消息：选同事账号，或「（数字人）」以数字人身份（需配 `TWIN_ACCESS_TOKEN`） |
| 顶部全局 | 全部暂停 / 全部继续 / 全部停止 |

干预经 `POST /control`（body: `{ roomId, action, colleagueId?, text?, asTwin? }`）→ orchestrator 指令队列 → 房间循环消费。

## 断言与测试报告（闭环）

每个场景房间可定义**断言**（`TestRoomDef.asserts`），房间跑完（done）后自动评估：

| 断言 kind | 含义 |
|---|---|
| `twin-replied` | 数字人回复过同事 |
| `twin-responded-in-time` | 数字人在超时内回复 |
| `twin-mentioned-colleague` | 数字人回复包含 @提及 |
| `message-count` | 房间消息总数 ≥ target |
| `custom` | 自定义 `evaluate(ctx)` |

- 房间卡显示 `✔ 断言全过` / `✘ 断言 N/M` 徽标，点击展开断言明细
- 对话流显示每条断言结果（🧪）
- 场景报告：所有房间聚合（通过/失败），顶部场景信息显示当前轮次

**改进循环**：跑完看断言 → 失败的断言即改进清单 → 改 dsh-matrix-agent 插件 → 点「🔄 重新开始」重测 → 对照报告确认改进。

## 岗位验证（agent preset 切换）

test-system 是独立进程，经真实 Matrix 与数字人交互，**不感知岗位**——数字人的岗位由
dsh-matrix-agent 侧的 `agentPreset` 决定（岗位 preset 在 `@evlon/dsh-job-presets`）。

验证某岗位：把数字人的 `agentPreset` 翻到目标岗位（改 profile 的 `cordis.patch.yml` 或
settings.yaml 用户层 `dsh-matrix.agentPreset`），重启 dsh，然后跑 `task-flow` 场景：

- `pm`：交付物带「用户价值/目标拆解/验收」措辞
- `dev`：交付物带「根因/负责组/排期/验证闭环」措辞
- 各岗位共用同一套秘书编排链路（请示→读数据→私发→等交付→发群），task-flow 断言岗位无关

## 扩展：新场景

在 `src/scenarios/` 新建场景文件，返回 `TestRoomDef[]`（房间 + 同事 persona + 目标 + 断言），
在 `src/scenarios/index.ts` 注册到 `SCENARIOS` 即可（Web 场景下拉自动出现）。

已注册场景：
- `basic-chat`：基本对话（研发群 + 产品群，含回复/消息数断言）
- `task-flow`：任务流转（完整请示/交付流程，断言岗位无关，适用于验证任意岗位 preset）
