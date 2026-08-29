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
- 自动创建「研发讨论群」「产品讨论群」两个房间，邀请数字人 + 同事
- 每个房间独立循环：同事 AI 发言 → 等数字人回复 → 下一轮（最多 `ROUNDS_PER_ROOM` 轮）
- 浏览器打开 `http://127.0.0.1:3088` 实时看对话流
- Ctrl+C 优雅停止

## 扩展：新场景

在 `src/scenarios/` 新建场景文件，返回 `TestRoomDef[]`（房间 + 同事 persona + 目标），
在 `src/index.ts` 替换 `buildBasicChatScenario(...)` 调用即可。

后续阶段（规划）：
- 任务流转场景（发任务 → 数字人请示老板 → 批准 → 执行 → 交付）
- 断言引擎（数字人应回复/应请示/应交付）
- 测试报告（通过/失败/耗时）
- 多群并发压力
