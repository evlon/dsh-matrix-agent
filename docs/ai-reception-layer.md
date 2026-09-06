# AI 接待层设计（Reception as an Agent）

> 状态：✅ 已实施并通过端到端验证（2026-09-06）
> 日期：2026-09-06
> 范围：dsh-bridge / dsh-matrix-agent 数字员工沟通架构的「前台接待层」AI 化
> 关联问题：同事确认收货后 worker 仍在补发「[前台接待] 手头正忙」占位（占位累积）；根因是接待层用**写死正则**猜消息类型（isNewTask / isClosingAck / isQuestion），语义判断会猜错。

---

## 1. 背景与问题

### 1.1 现状（三层架构）

```
Matrix 群消息
   │
   ▼
┌─────────────────────────────┐
│ 接待层（bridge 规则代码）      │  ← 即时礼貌 ack、忙状态、话术模板
│  · isQuestion / isNewTask     │     （写死正则，本设计的改造对象）
│  · isClosingAck（本轮回新增）   │
│  · roomBusy 置位/清除          │
│  · 话术 receptionAckNewTask…  │
└────────────┬────────────────┘
             ▼ 转交
┌─────────────────────────────┐
│ worker（数字分身 agent 会话）   │  ← 真执行：读文件/整理/交付
│  preset=pm/qa/dev…           │
└─────────────────────────────┘
   ▲                     ▲
   │ 请示/汇报            │ 批准/回传
┌──┴─────────────────────┴──┐
│ 秘书（协调 agent 会话）        │  ← 决策/调度/上呈主人
│  preset=secretary, v3      │
└────────────────────────────┘
```

### 1.2 占位累积根因

1. **channel 层过滤自己消息回流**（`dsh-channel-matrix/src/matrix.ts` L285/L515）：
   `sender === userId` 的消息不会进 handleMessage → bridge 的
   `if (message.sender === this.userId) roomBusy.delete(...)`（L1985）**是死代码**，
   roomBusy 一旦置位永不自动清除。
2. **正则猜消息类型会错**：同事说「收到，清单没问题，模块和级别都对得上，辛苦了」——
   这是**验收收尾**，但正则把它判成 `isNewTask=true`（@worker + 非问句 + 长度>8 + 不忙）
   → 触发 new-task ack + 重新置忙 + 走 clarify-gate → 后续消息全部触发「手头正忙」占位。
3. 本轮已加的 `isClosingAck` 正则能缓解，但**仍是写死规则**：换个说法（「行，没问题了」
   「收到，8 条都对得上，先这样」）就可能漏判/误判，且无法覆盖开放语义。

### 1.3 用户的架构判断（决策依据）

> 「这个判断是礼貌性的还是分类？我觉得在接待层更为合适。」
> 「接待层也作为 DSH 的一个会话，配自己单独的模型，一定不要启用思考模式，
>   这样能更快速地进行接待工作。以后接待者也可以配置不同的 preset 和 skill。」

即：接待层的本质职责是**对入站消息做语义分类**（新任务 / 忙时追问 / 收尾确认 / 闲聊），
并据此决定即时礼貌回应策略。这个**分类**应该由 **AI** 完成（而非写死正则），
且接待层本身应是一个 **可配置的 agent 会话**（像秘书一样有 preset/skill/独立模型/关思考）。

---

## 2. 目标

1. 接待层从「写死正则」升级为「AI 语义分类」：入站消息 → 接待 agent 快速推理（effort=off）
   → 输出**结构化判定** → bridge 按判定执行。
2. 接待层成为可配置角色：确定性会话 id + reception preset + 独立模型 + reasoningEffort 恒 off，
   以后可像秘书一样换 preset/skill 定制话术与策略。
3. 消除占位累积：worker 实质交付后 busy 正确清除；收尾/确认消息不再被当新任务置忙。
4. 降级安全：接待 agent 不可用/超时/解析失败时回退现有正则逻辑，不破坏现有 reception 场景。
5. 所有话术仍用户可改（settings 模板保留；AI 判定输出的话术也走模板变量，不硬编码在代码）。

---

## 3. 角色与职责（改造后）

| 角色 | 机制 | 职责 | 关键约束 |
|---|---|---|---|
| **接待层（AI）** | 独立 agent 会话 `matrix-<localpart>-reception-v1`，preset=reception | 对入站消息做**语义分类**，输出判定（类型 + 是否 ack + 话术要点 + 是否转交 + 是否置忙） | effort 恒 off；只读上下文 + 输出 JSON，**无发消息/执行工具**（防它乱发） |
| **worker** | 现有 per-room agent | 真执行任务、交付 | 不变 |
| **秘书** | 现有 secretary-v3 | 决策/调度/上呈 | 不变 |
| **bridge** | 编排 | 收消息 → 问接待 agent → 按判定执行（发 ack / 置忙 / 转发 worker / 清 busy） | 接待判定只影响「即时礼貌层」，**绝不吞消息**；worker 仍收到全部消息 |

---

## 4. 接待 agent 会话

### 4.1 确定性 id 与会话生命周期

```
matrix-<localpart>-reception-v1
```

- 完全复用秘书会话样板（`getSecretaryAgent` 模式）：
  `receptionInflight` 防并发 → `acquireAgent(sessionId, { cwd, agentPreset: RECEPTION_PRESET })`
  → `attachSessionToWorkspace` → `ensureEffortHook(..., effort=恒 off)` → 标题「前台接待 · @localpart」。
- 懒加载：第一条入站消息需要判定时才创建；创建后常驻（同秘书）。
- 会话历史只积累「判定请求」，不注入业务对话（判定是**无状态**的：每次只发「当前消息 +
  最近 N 条房间消息 + 当前忙状态」问一次，不依赖接待会话自己的历史）。这样：
  - 判定快（无长上下文）；
  - 接待会话不会"学歪"（不积累业务内容）；
  - 也可选做成完全无状态（不落盘判定历史，只用一个临时请求）——见 §7 备选。

### 4.1b 技术可行性（已探明，2026-09-06）

| 需求 | 机制 | 结论 |
|---|---|---|
| 独立会话 | `getReceptionAgent()` 复制秘书样板：确定性 id + `acquireAgent` + `agentSetup(RECEPTION_PRESET)` | ✅ 现成 |
| 会话级独立 provider/model | `AgentOptions` 是 `Create/Resume` 的可选参数（含 `provider`/`model`/`maxTokens`）；reception 会话 `acquireAgent` 时传 `{ provider: receptionProvider || 默认, model: receptionModel || 默认 }` 覆盖 worker 档 | ✅ 现成 |
| 单轮判定 + 等结果 | `agent.followup(createUserMessage(...))` 唤醒（同 `wakePendingWaiter`）；bridge 已有 session event 订阅（`turn/end` 等，handleSessionEvent L2535）；注册一次性监听拿该会话 assistant 文本 | ✅ 现成 |
| reasoningEffort 恒 off | `ensureEffortHook` 加 reception 档（第三档 isReception），读 `receptionReasoningEffort`（默认 off） | ✅ 现成（扩一个档） |
| 工具收口 | reception preset 挂 `tool-restrict.mjs`，ALLOW 留空或只读（判定只输出文本 JSON，可零工具） | ✅ 秘书样板 |
| GUI 可见（开放性） | 会话落盘 + attach workspace + 标题「前台接待」→ GUI 会话列表可见，实时看接待层判定记录；未来可再和 Matrix 打通（用户已表达此诉求） | ✅ 秘书同款 |

### 4.2 reception preset（新，落盘 .agent-presets/reception/）

```
.agent-presets/reception/
├── agent.cordis.yml      # persona + 工具收口
├── preset.yml            # name/description/order
└── tool-restrict.mjs     # 只暴露只读工具（可选，或零工具）
```

- persona 要点：
  「你是前台接待。你的唯一职责是对群里@数字员工的每条消息做**语义分类**并输出 JSON 判定。
  你**不执行任务、不写文件、不回业务内容**——你只判断消息该归哪类、要不要立刻礼貌回应。」
- persona 会注入**当前可用的分类标签表**（来自 settings，见 §4.2b）：AI 判定时只从表里选 kind id。

### 4.2b 分类标签表（settings 结构化配置，核心开放点）——【用户决策：统一进 settings】

接待策略不做成代码里写死的 5 个 kind，而是一张 **settings 结构化表 `receptionKinds`**，
每个标签独立可配：语义描述（给 AI 判定参考）+ ack 话术模板 + 置忙策略 + 转发策略。
内置 5 类默认值；用户可在设置界面**增删改标签**、调每类的行为。

```yaml
# settings.yaml → dsh-matrix.receptionKinds
receptionKinds:
  new-task:                      # kind id（唯一，AI 判定输出它）
    label: 新任务                 # 显示名（设置界面/GUI）
    describe: >-                # 语义描述（注入 persona，供 AI 判定参考）
      同事明确要求数字员工动手执行的任务：整理/汇总/编写/分析/排期等，通常有可交付成果。
      特征是命令式或请求式，指向未来的产出。
    ack: true                   # 命中是否立刻发礼貌 ack
    ackText: 收到，我这就去整理{{taskHint}}，稍后把结果发你～   # 话术模板（空=用默认模板）
    busy: true                  # 是否把该房间 worker 置忙
    forward: true               # 是否照常转交 worker
  busy-question:
    label: 忙时追问
    describe: >-
      worker 正在处理任务（房间忙）时，同事发来的追问/澄清/问题，期望 worker 处理完当前任务后回答。
    ack: true
    ackText: '[前台接待] @{{lp}} 这条我记下了，手头正忙{{taskDesc}}{{eta}}，处理完马上回你；有急需可以再把关键点说一遍～'
    busy: false                  # 追问不改变忙状态（worker 已在忙）
    forward: true
  busy-plain:
    label: 忙时普通消息
    describe: >-
      worker 忙时同事发来的非问题类消息（补充信息/同步/简单说明），需礼貌回应但不打断当前工作。
    ack: true
    ackText: '[前台接待] @{{lp}} 收到，我手头正忙{{taskDesc}}{{eta}}，稍后回你这条～'
    busy: false
    forward: true
  closing-ack:
    label: 收尾确认
    describe: >-
      同事对已交付结果的验收/确认/致谢/收尾（如「收到，清单没问题，辛苦了」「行，先这样」）。
      表示话题已闭合，不是新任务、不需要 worker 再动手。
    ack: false                   # 不抢发 ack（避免「对方收尾我还在说手头正忙」）
    ackText: ''
    busy: false                  # 不置忙（关键：消除占位累积）
    forward: false               # worker idle 时不转交（不打扰）；worker 忙时也不转（避免补发占位）
  chat:
    label: 闲聊问答
    describe: >-
      普通对话/闲聊/答疑，无需动手执行，worker 直接回复即可。接待层不抢答。
    ack: false
    ackText: ''
    busy: false
    forward: true
```

- **kind id 是 AI 判定输出与 bridge 执行之间的契约**：AI 只输出 `kind: <id>`，bridge 查表执行
  （ack/busy/forward/ackText）。表里没有的 id → 按 `chat` 兜底 + 记日志。
- **现有 5 个散装话术键**（receptionAckNewTask/receptionAckBusyQuestion/receptionAckBusy/
  receptionRejected/receptionGiveUp）**并入此表**（receptionRejected/receptionGiveUp 是
  "拒绝开工/跟进放弃"的独立场景话术，保留为表外两个散键即可——见 §10 迁移说明）。
- 设置界面展示这张表（每行一个 kind：label/describe/ack 开关/话术/置忙/转发），
  用户可改内置 5 类、也可**新增自定义 kind**（新 describe + 话术 + 策略）——AI 判定时
  persona 自动带上新增标签的语义描述，即可识别并路由到新分类。

### 4.3 独立模型配置（settings 新增）

```yaml
dsh-matrix:
  receptionProvider: ""        # 空=沿用 worker 的 provider
  receptionModel: ""           # 空=沿用 worker 的 model（建议填轻量快模型）
  receptionReasoningEffort: off  # 恒 off：接待判定必须快，不需要思考
  receptionPreset: reception     # preset id（默认 reception，可换）
  receptionEnabled: true         # false=退回纯正则接待（降级总开关）
  receptionKinds: { ... }        # 分类标签表（见 §4.2b；内置 5 类默认，可增删改）
  # 表外散键（非分类场景的独立话术，保留现状）：
  receptionRejected: "主人暂时不同意开工，任务「{{summary}}」先搁置。"
  receptionGiveUp: "我正在整理「{{summary}}」，结果稍后同步，请稍等～"
```

- 值域/语义对齐现有 `workerReasoningEffort` / `secretaryReasoningEffort`。
- agentOptions 按账号构造时若 reception 独配了 provider/model 则覆盖。
- 旧散键 `receptionAckNewTask/receptionAckBusyQuestion/receptionAckBusy` **迁移进 receptionKinds
  对应标签的 ackText**（settings 层做一次兼容：读取时若表缺失该标签的 ackText，回退旧散键值）。

### 4.4 如何"问"接待 agent（bridge 侧）——【已确认：方案 A】

**选型结论**：独立 reception agent 会话（方案 A）。用户决策依据：
> 「方案 A 更有开放性——未来可以把这个会话和 Matrix 打通，实时看到接待层的工作，
>   方便以后调整。」

即接待层不是一段被调用的黑盒函数，而是一个**可见、可查、可调**的 agent 会话：
- 判定记录落盘在会话历史（GUI 可见，像看秘书会话一样看接待层在判什么、依据什么）；
- preset/skill/模型/话术全部可换可配；
- 未来打通 Matrix 后可直接对接待 agent 会话发消息调优（无需改代码）。

**调用方式**：bridge 构造一条**单轮 user 消息**（含分类指令 + 当前消息 + 最近上下文 + 忙状态），
`followup` 给 reception agent，等它返回 assistant 文本（JSON）；注册一次性 session event 监听
（turn/end 或该会话的 assistant/message）拿结果，3s 超时降级正则。

```ts
// 伪码：bridge 侧判定调用
const agent = await this.getReceptionAgent()
const done = this.onceReceptionReply(agent.id)          // 一次性监听该会话下一轮输出
agent.followup(createUserMessage({ content: [{ type: 'text', text: buildClassifyPrompt(...) }], source: { kind: 'user', sender: `@bridge:${this.userId}` } }))
const reply = await Promise.race([done, timeout(3000)])  // 3s 超时
if (reply === undefined) return fallbackRegex(...)        // 降级正则
const { kind } = parseClassifyJson(reply)                // 只取 kind（+reason）
const entry = this.config.receptionKinds[kind]           // 查表：ack/busy/forward/ackText
if (entry === undefined) return { kind: 'chat' }          // 未知 kind 兜底
return entry
```

**为何不直调 LLM（方案 C）**：bridge 没有暴露的 API base/key（模型走 dsh 内部路由），
硬编码 endpoint 不可取；且独立会话让判定过程可见可调，符合开放性诉求。

### 4.5 判定超时与降级

| 情形 | 行为 |
|---|---|
| 接待 agent 创建失败 / preset 缺失 | 记日志，**回退现有正则接待**（isQuestion/isNewTask/isClosingAck） |
| 判定调用超时（如 > 3s） | 回退正则；不阻塞消息转 worker |
| 判定 JSON 解析失败 / kind 非法 | 按 `chat` 处理（不 ack、转 worker），记日志 |
| 接待判定成功 | 按判定执行，日志记录 kind/reason 便于核对 |

---

## 5. busy 状态修复（独立于 AI 化的机制修复）

AI 分类解决"猜错类型"，但 busy 清除的**机制 bug**必须单独修（否则 AI 判对类型也白搭）：

1. **channel 过滤自己消息** → bridge 收不到自己消息回流。修复：
   - `noteOutboundSent` 判定**实质交付**（非占位）时同步 `roomBusy.delete(roomId)`（本轮回新增，保留）。
2. **deliver 只对 taskLike 置忙**（本轮回新增，保留）：
   确认/收尾消息 taskLike=false → 不再重新置忙。
3. **isClosingAck 正则降级保留**：仅作为接待 agent 不可用时的兜底；AI 可用时以 AI 判定为准。
4. （可选，未来）若 channel 层可配置"回传自己消息"，改为由 bridge 主动感知出站完成更干净。

---

## 6. bridge 执行流程（改造后 handleMessage 的关键段）

```
入站消息（@worker / 群消息）
   │
   ├─ 1. 前置：审批词/owner 回复/命令 等特殊通道（不变，最先）
   │
   ├─ 2. 若 receptionEnabled && 有接待 agent：
   │     判定 = await askReceptionAgent(消息, 房间最近消息, 忙状态)   // effort=off，超时 3s
   │     否则判定 = 正则兜底(new-task/busy-question/busy-plain/closing-ack/chat)
   │
   ├─ 3. 按判定执行（只影响礼貌层，绝不吞消息）：
   │     · kind=closing-ack：
   │         - 若 worker 忙（roomBusy 有）→ 不发 ack（静默；worker 交付后 busy 已清，
   │           见 §5.1）；forward=false（worker idle 时不打扰）
   │         - 若 worker 不忙 → 照常转 worker（它可能礼貌回一句，由它决定）
   │     · kind=new-task：若 busy 判定 true → roomBusy.set；发 new-task ack（模板）；forward=true
   │     · kind=busy-question/busy-plain：若 roomBusy 有 → 发忙时 ack（模板）；forward=true
   │     · kind=chat：不 ack；forward=true（worker 直接回）
   │
   └─ 4. forward=true → 照旧 flushMerge → deliver → worker
```

**关键红线**：接待判定只决定"是否插一句即时礼貌话术 + busy 标记"，**消息永远转发给 worker**
（除非明确是 worker idle 时的纯收尾确认）。这样接待层退化/误判也不会丢消息。

---

## 7. 开放问题

1. **判定并发**：同房间连续多条消息 → 多条判定请求排队。可加 per-room 判定节流
   （如 1s 内同房间只判 1 次，其余直接按上次结果走 busy 分支）。
2. **成本**：每条入站消息一次 LLM 判定。effort=off + 短 prompt（几百 token）+ 轻模型可控。
   可配置开关/白名单房间（只对测试房间/群聊开，私聊不走）。
3. **tool-restrict**：reception preset 是否要 `tool-restrict.mjs`——若零工具则不需要
   （preset 不挂工具插件即可）；若未来加只读工具再补。
4. **设置界面（Web GUI）**：`receptionKinds` 表在 dsh 设置界面以「接待分类标签」区块呈现
   （每行一个 kind：label/describe/ack 开关/话术/置忙/转发 + 新增/删除），属 host 设置 UI
   工作（可在 dsh-bridge 的 settings namespace schema 加结构化字段后由设置页自动渲染，
   或单独做一个 settings 区块插件）——列为后续迭代，初版先走 settings.yaml 手配。

---

## 8. 实施状态（2026-09-06 已完成主体，待补充项见下）

1. **机制修复先行**（✅ 已验证：7 轮全 PASS，占位从连续 3-4 条降到合理水平）：
   - [x] `noteOutboundSent` 实质交付清 roomBusy
   - [x] deliver 仅 taskLike 置忙
   - [x] isClosingAck 正则降级保留
2. **settings 扩展**（✅ 已编译部署）：
   - [x] `receptionKinds` 结构化表（内置 5 类默认）
   - [x] `receptionProvider/receptionModel/receptionReasoningEffort(off)/receptionPreset/receptionEnabled/receptionTimeoutSecs/receptionMinLength/receptionThrottleSecs`
   - [x] 旧散键兼容（legacyAckKeyForKind 回退）
3. **reception preset**（✅ 已落盘 3090 .agent-presets/reception/ + 源仓 E:\ai-works\dsh-job-reception）：
   - [x] agent.cordis.yml（前台接待 persona：只分类不执行、输出 JSON kind、以请求附表为准）+ preset.yml
4. **bridge 接入**（✅ 已编译部署）：
   - [x] `getReceptionAgent()`：确定性 id `matrix-<localpart>-reception-v1` + preset + effort=off hook + workspace attach + 标题「前台接待」
   - [x] `classifyIncoming`：followup 单轮 + receptionPending FIFO + 超时降级（receptionTimeoutSecs 默认 3s→配置 5s）
   - [x] `classifyMessageIfEnabled`：开关门控 + respondToAll 门控 + 长度阈值 + 房间节流（receptionThrottleSecs）
   - [x] handleSessionEvent reception 分支：无房会话的 assistant/message / turn/end 接线 settle
   - [x] handleMessage 改造：AI 判定优先（busy→ack→forward 按表执行）→ 正则兜底（applyLegacyReceptionRules）
5. **验证**（✅ 端到端实测通过，诊断日志实证）：
   - [x] task-flow 全新轮次：AI 分类 new-task/busy-question/busy-plain/closing-ack 全部正确
   - [x] 交付后 roomBusy cleared；同事确认（3 次"收到清单没问题"）全判 closing-ack，**0 补发占位**
   - [x] reception agent effort=off 生效（诊断 `reasoningEffort request agent=ption-v1 role=reception effort=off`）
   - [ ] 降级路径显式测试（停 preset → 正则兜底）——待补一轮
   - [ ] receptionKinds 增删改自定义 kind 验证——待补
   - [x] 测试台占位跨轮重播修复（shownPlaceholders per-room 持久）
6. **收尾**：诊断日志观察 ✅、记忆写入、代码提交（待用户确认后 git commit）。

---

## 9. 不做的事（范围外）

- 不把秘书/worker 的职责并入接待层。
- 不引入新的 IM 通道/LLM 直连依赖（复用 ctx.agents 模型路由）。
- 不改 dsh-channel-matrix 的"过滤自己消息"（改动面大；用 §5 的出站侧清 busy 替代）。
- 接待层不生成业务交付物、不读工作目录、不发业务消息（那是 worker 的事）。
