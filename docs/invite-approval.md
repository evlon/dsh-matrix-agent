# 入群邀请审批（Invite Approval）

> 状态：**已实现并实机验证**（2026-09-21，3090 测试分身 + 真实 `im-ipm.ict.cmcc`）
> 相关代码：`dsh-channel-matrix/src/matrix.ts`、`dsh-bridge/src/invite-store.ts`、`dsh-bridge/src/bridge.ts`、`dsh-matrix-agent/src/client-main.js`

## 一、需求

用户原话：

> 收到邀请就自动同意——首次邀请的时候，要请示一下主人，主人同意后才能够进群。
> 如果以前这个人要求邀请过我们，主人同意过，那就直接进群。

拆成三条可验收行为：

| # | 场景 | 期望行为 |
|---|---|---|
| 1 | **陌生邀请人**首次邀请 | **不自动进群**；落盘待决 + 请示主人（收件箱 + 私聊） |
| 2 | 主人**批准** | 进群；**记住该邀请人**（批准名单） |
| 3 | 该邀请人**再次邀请** | **直接进群**，不再打扰主人 |
| 4 | 主人**拒绝** | 退群/清挂起邀请；**记住该邀请人**（拒绝名单） |
| 5 | 该邀请人再次邀请 | **直接静默拒绝**，不再反复打扰主人 |

## 二、⚠️ 决定性约束：邀请只投递一次

这是整个设计的地基，**实测确认**（3090 + 真实 homeserver）：

| sync | 结果 |
|---|---|
| 首次（无 `since`） | `rooms.invite` 含该房 ✅ |
| 增量 #2（带 `since`） | **invite rooms = 0** |
| 增量 #3（再确认） | **invite rooms = 0** |

**含义**：sync 游标一推进，未处理的邀请**永久消失**。

而「等主人同意」可能耗时数分钟、甚至跨进程重启。所以：

> **收到邀请的瞬间必须把 `{roomId, inviter, roomName, dmRoomId}` 落盘**，
> 绝不能靠「下次 sync 再看一遍」——那是空话。

这条约束决定了 `invite-store.ts` 的存在，也决定了它的写盘策略（见第五节）。

## 三、架构：三层各司其职

```
Matrix homeserver
   │  rooms.invite[roomId].invite_state.events
   ▼
① 通道层 dsh-channel-matrix
   · 解析邀请人（member.sender → create.creator 兜底）、群名、是否 1:1
   · 投影 self-invite 事件（含 inviter/roomName）
   · 【绝不自动入群】——入群决策权归桥接层
   · 提供 joinRoom / leaveRoom
   ▼
② 桥接层 dsh-bridge（邀请审批状态机）
   · 查批准名单 → 直接进群
   · 查拒绝名单 → 直接静默拒绝
   · 否则 → 落盘待决 + pushInbox(kind='invite') + 私聊请示主人
   · 主人决策 → join/leave + 记名单（原子落盘）
   ▼
③ 消费层 dsh-matrix-agent
   · 收件箱 UI 渲染 kind='invite'（「📨 入群邀请」+「✅ 同意进群」）
```

### 3.1 通道层：为什么必须改

**旧实现（有安全缺口）**：`processRooms` 里 `Object.keys(rooms.invite)` 后**无条件 `joinRoom`**——
任何知道分身 Matrix ID 的人拉它进任意房间，它都会进去，还会自我介绍。且 `invite_state` 完全没解析，
**邀请人信息被丢弃**，桥接层从头到尾没见过「谁邀请的」。

**新实现**：只投影事件，不动作。关键回归断言（`tests/invite-approval.test.mjs`）：

```js
const joinCalls = calls.filter((c) => c.path.includes('/join'))
assert.equal(joinCalls.length, 0, '❌ 通道层不得自动调用 /join')
```

### 3.2 ⚠️ `self-invite` vs `invite`（语义陷阱）

两者**完全不同**，混用会导致邀请审批走错入口：

| kind | 来源 | 含义 |
|---|---|---|
| `invite` | `rooms.join[roomId].state.events` | **已加入房间里「别人」被邀请**（旁观事件） |
| `self-invite` | `rooms.invite[roomId]` | **有人把「本账号」拉进新房间**（入群决策入口） |

旧的 `kind='invite'` 分支（`onStateEvent` 里 `membership==='invite'`）只覆盖前者，**不能当审批入口**。

### 3.3 桥接层：为什么不能用现有请示机制

现有 `waitOwnerDecision` / `handleOwnerDecisionOps` 是**「发起方 turn 挂起等 resolve」**模型
（`initiatorSessionId` + `ownerPending` 队列）。但邀请审批**没有 agent turn 可挂起**——
它是通道事件驱动。硬套会导致请示无处 resolve。

**正确形态**：独立的非阻塞状态机（`handleSelfInvite`），决策到达**不唤醒任何会话**。

## 四、状态机

```
收到 self-invite
  │
  ├─ inviteApprovalEnabled=false ────────────────→ 直接进群（旧行为，仅可信测试环境）
  │
  ├─ 邀请人 = 自己 或 主人 ──────────────────────→ 直接进群
  │
  ├─ 邀请人在【批准名单】 ───────────────────────→ 直接进群（不再打扰主人）
  │
  ├─ 邀请人在【拒绝名单】 ───────────────────────→ 直接静默拒绝
  │
  ├─ 无邀请人信息 ──────────────────────────────→ 落盘待决 + 请示主人（绝不放行）
  │
  └─ 首次遇到该邀请人 ──────────────────────────→ ① 落盘待决（防丢）
                                                   ② pushInbox(kind='invite')
                                                   ③ 私聊请示主人
                                                      ↓
                                            主人决策（收件箱 or 私聊回复）
                                                      ↓
                                          approve → joinRoom + 记批准名单
                                          reject  → leaveRoom + 记拒绝名单
```

### 决策入口（两条，等价）

| 入口 | 路径 |
|---|---|
| **收件箱** | 工作台「待批」tab → 「✅ 同意进群」/「🚫 拒绝」→ `ownerDecisionOps` |
| **私聊回复** | 主人在与分身的私聊里回「批准」/「拒绝」 |

两个入口都先查 `inviteStore.getPending(roomId)`，**优先于**普通请示/汇报分支——
否则会被「无 secretary pending; ignored」吞掉。

### 主人命令（仅 Owner）

| 命令 | 作用 |
|---|---|
| `/invites` | 查看待批邀请 + 已批准/已拒绝名单 |
| `/invite-allow <userId>` | 直接批准某邀请人（以后 TA 邀请直接进群） |
| `/invite-deny <userId>` | 拒绝某邀请人（以后 TA 的邀请直接静默拒绝） |
| `/invite-forget <userId>` | 清除某邀请人的记忆（下次邀请重新请示） |

## 五、持久化：`invite-approval.json`

`stateDir/invite-approval.json`，原子写（tmp + rename），与 `member-store` 同模式。
**只存元数据**（房间 id / 邀请人 / 群名 / 时间 / 请示私聊房 id），**不存聊天内容**（守仓库安全红线）。

```json
{
  "version": 1,
  "pending": [
    { "roomId": "!x:hs", "inviter": "@zhang:hs", "roomName": "项目群",
      "isDirect": false, "at": 1789977721465, "dmRoomId": "!dm:hs" }
  ],
  "approved": [ { "userId": "@zhang:hs", "at": 1789977784647, "roomId": "!x:hs", "roomName": "群「项目群」" } ],
  "denied": []
}
```

### ⚠️ 三个必须记住的写盘决策（都是实测踩出来的）

**1. 待决邀请立即落盘，不走防抖**

与黑白名单不同，待决邀请是「sync 不会再投递」的一次性数据。若进程在防抖窗口内退出，邀请就**永久丢失**了
（主人还没答，群里已经再也收不到）。可靠性要求高于省几次写盘。

**2. `save()` 用串行链，绝不用「dirty 重试」写法**

最初的写法是「在飞则置 `dirty` 并重试」。**两个并发 `save()` 会互相把对方的 `dirty` 置位 → 活锁**
（实测：`save()` 永不返回、进程不退出、测试挂死）。现改为串行链：

```ts
const prev = this.saving ?? Promise.resolve()
const next = prev.catch(() => {}).then(async () => { /* 写 tmp + rename */ })
this.saving = next.catch(() => {})
await next
```

串行链天然无此问题，且顺序即调用顺序。

**3. 裁决必须原子（`resolve`），不能分两步写**

「记名单」与「清待决」若分两次落盘，会留下**中间态**——重启后表现为
**「已批准过的人又被请示一次」**（实测：拒绝流程的测试正是抓到了这个中间态）。
故用 `inviteStore.resolve(roomId, decision, inviter, label)` 一次落盘，并 `await` 落盘完成再继续。

## 六、边界与容错

| 情况 | 处理 | 理由 |
|---|---|---|
| 邀请人**已撤回**邀请（`join` 403/404） | **清掉待决**，不写名单 | 否则永远卡在收件箱，主人再批也进不去（实测踩过） |
| 网络/5xx 失败 | **保留待决** | 主人可重试，或重启时重放 |
| **进程重启** | `replayPendingInvites()` 重放待决到收件箱 | sync 不会再投递，只能靠落盘恢复 |
| 重启后主人**私聊回复**「批准」 | 按持久化的 `dmRoomId` 反查 | 内存 `ownerDmToWorkRoom` 已丢，不查这条会把「批准」**当普通消息漏给 agent**（实测踩过） |
| 同一邀请**重复投递** | 通道层 `reportedInvites` 去重 + store 侧刷新 | 避免重复请示主人 |
| 邀请人**无法识别** | 一律请示主人 | 无法判断可信度，绝不放行 |

### 超时策略（可配）

| 配置 | 默认 | 说明 |
|---|---|---|
| `inviteApprovalEnabled` | `true` | `false` = 回退旧行为（收到即进），仅可信测试环境 |
| `inviteApprovalTimeoutSecs` | `0` | **0 = 一直保持待决**（等主人有空再答；邀请已持久化，不会丢） |
| `inviteApprovalTimeoutAction` | `'reject'` | 超时后处置：`reject` 自动拒绝（安全优先）/ `pending` 保持 |

## 七、验收证据（实机）

环境：3090 测试分身 `@ai-niukunliang-test:im-ipm.ict.cmcc`，真实 `im-ipm.ict.cmcc`。

### 7.1 单元/集成测试（86/86 通过）

```
node --test
ℹ tests 86   ℹ pass 86   ℹ fail 0
```

新增两个测试文件：

| 文件 | 覆盖 |
|---|---|
| `tests/invite-approval.test.mjs` | 通道层解析（邀请人/群名/兜底）、**绝不自动 join**、`joinRoom`/`leaveRoom`、store 语义（名单互斥/去重/原子裁决/并发 save 不死锁） |
| `tests/invite-bridge.test.mjs` | 端到端状态机：首次请示→批准进群→再来直接进；拒绝→退群→再来直接拒；主人邀请直接进；**重启后主人回复仍能路由** |

### 7.2 实机闭环（真实 homeserver）

```
[1] 群A = !xIfNAFtSVti9cB74:im-ipm.ict.cmcc
    分身进群A？ false   ✅ 未自动进（已请示主人）
[2] 找到含邀请请示的私聊房 = !Q1Nth7QFEHQ9VYnO:im-ipm.ict.cmcc
    主人回复「批准」status = 200
    分身进群A？ true    ✅ 批准后进群
[3] 群B = !DxlZTtUMM24NuGkH:im-ipm.ict.cmcc
    分身直接进群B？ true ✅ 已批准邀请人再邀请→直接进群
[4] 清理：分身 leave+forget 群A/群B 均 200
```

对应诊断日志（`diagnostics.log`）：

```
handleSelfInvite room=!xIfN... inviter=@aitester-zhang:... name=【审批闭环A】... approval=true
handleSelfInvite room=!xIfN... pending persisted inviter=@aitester-zhang:... reason=首次邀请
acceptInvite     room=!xIfN... inviter=@aitester-zhang:... reason=owner-approved ok
handleOwnerReply invite room=!xIfN... decision=approve hit=true
handleSelfInvite room=!DxlZ... inviter=@aitester-zhang:... already-approved; auto-join
acceptInvite     room=!DxlZ... inviter=@aitester-zhang:... reason=approved-inviter ok
```

### 7.3 容错验证

```
# 失效邀请清理（邀请人已 kick 撤回，主人再批准）
acceptInvite room=!SaMI... reason=owner-approved invite no longer valid (join HTTP 403); pending dropped
→ pending 数 = 0   ✅ 不再卡死

# 重启重放
replayPendingInvites count=1
→ pending[0].dmRoomId 已回填 !Q1Nth7QFEHQ9VYnO:im-ipm.ict.cmcc
```

## 八、文件清单

| 文件 | 变更 |
|---|---|
| `dsh-channel-core/src/types.ts` | 新增 `RoomEventKind` 的 `'self-invite'`（含语义区分注释） |
| `dsh-channel-core/src/channel.ts` | 新增可选契约 `joinRoom?` / `leaveRoom?` |
| `dsh-channel-matrix/src/matrix.ts` | `invite` 类型改为可解析；新增 `parseInvite`；**移除无条件自动 join**；`joinRoom` 转 public；新增 `leaveRoom`；`reportedInvites` 去重 |
| `dsh-bridge/src/invite-store.ts` | **新建**：待决邀请 + 批准/拒绝名单 + 原子裁决 + 串行落盘 |
| `dsh-bridge/src/bridge.ts` | `handleSelfInvite` 状态机、`replayPendingInvites`、`acceptInvite`/`rejectInvite`、`handleInviteDecision`、`checkInviteTimeouts`、决策入口接线、`/invites` 等 4 个命令 |
| `dsh-bridge/src/config.ts` | 新增 `inviteApprovalEnabled` / `inviteApprovalTimeoutSecs` / `inviteApprovalTimeoutAction` |
| `dsh-bridge/src/settings.ts` | 设置页 schema + `LIVE_APPLY_KEYS`；`OwnerInboxItem.kind` 加 `'invite'` |
| `dsh-bridge/src/index.ts` | 导出 `invite-store` |
| `dsh-matrix-agent/src/client-main.js` | 收件箱渲染 `kind='invite'`（「📨 入群邀请」+「✅ 同意进群」） |
| `dsh-matrix-agent/tests/invite-approval.test.mjs` | **新建**：通道层 + store 单测 |
| `dsh-matrix-agent/tests/invite-bridge.test.mjs` | **新建**：端到端状态机 + 重启回归 |

## 九、部署（3090）

按 `E:\ai-works\caddy\DEPLOY-3090.md`：

```bash
# 1. 按依赖序构建（@evlon 包在 profile 里是实体副本，需重新快照）
dsh-channel-core → dsh-channel-matrix → dsh-tools-channel → dsh-bridge → dsh-matrix-agent

# 2. 快照到 profile（本机实操：把各仓 lib/ 拷进 profile 的 @evlon/<pkg>/lib）
#    注意：严禁手动 cp 到 node_modules/.pnpm（历史混乱根源）

# 3. 重启
pm2 restart dsh-matrix-dev-3090
```

## 十、已知限制 / 后续

1. **白名单粒度 = 按邀请人**（当前实现）。批准过 A 一次，A 就能把分身拉进**任意**群。
   若需更严，可扩展为「邀请人 + 群」二元组（需产品决策，见下方「待定」）。
2. **未做频率限制**：同一邀请人被拒绝后不再打扰，但**不同**陌生人的邀请会各自产生一条待批。
3. **非人类邀请人**（其他数字人/机器人）目前与真人同等对待——一律请示主人。
4. **未支持「批准但只此一次」**：批准即记忆。如需一次性放行，需新增语义。

### 待定（需产品决策）

- 白名单粒度：按邀请人 vs 按「邀请人+群」
- 拒绝是否记忆：当前**记忆**（否则同一人可反复邀请反复打扰）
- 陌生邀请的批量请示：多人在短时间内邀请时，是否合并成一条
