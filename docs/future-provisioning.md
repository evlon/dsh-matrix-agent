# 未来需求：数字分身开通与登录流程（暂缓实施）

> 状态：**暂缓**（已回滚，未来再做）
> 背景：2026-08 讨论的方案，聚焦现有功能可用性，本需求延后。

## 目标

让真人用户通过 dsh web 开通/登录自己的数字分身账号，管理员在服务端审核：

1. **新注册**：真人申请创建分身账号（`ai-<真人>`），管理员审核通过后开通。
2. **登录已有**：真人扫码或输入 token 后，从自己名下已开通的分身账号中**选一个**登录（绑定为插件数字分身）。

## 架构

```
┌─ 服务端程序（独立部署，持 Synapse Admin 权限）─────────────┐
│ REST API：                                              │
│   GET  /v1/twins   列出真人名下已开通分身（登录选择）         │
│   POST /v1/apply   申请新分身（校验 ai-<真人>，管理员审核）   │
│   GET  /v1/status  查询审核状态（pending/approved/rejected）│
│   GET  /v1/twin    审核通过后领取分身 token                │
│   POST /v1/review  管理员审核（网页内部调用）                │
│ 网页：管理员审核列表（仅同意 ai-<真人> 前缀的分身）           │
└──────────────┬──────────────────────────────────────────┘
               │ HTTPS（真人 token 认证）
┌─ dsh web（dsh-matrix-agent 插件）─────────────────────────┐
│ Host 侧：TwinProvisioner（调服务端 API，真人 token 仅内存）  │
│ Client 侧：「分身申请/登录」UI                             │
│   · 输入真人 token（或扫码）→ 列出名下分身 / 申请新分身       │
│   · 选择已有分身 → 领 token → 写 digitalTwins              │
│   · 申请新分身 → 待审核轮询 → 通过后领 token → 写配置        │
└──────────────────────────────────────────────────────────┘
```

## 职责边界

- **服务端**：持 Synapse Admin 权限，唯一能创建分身账号的地方；硬校验分身 id `ai-<真人localpart>`；管理员审核；创建后生成 token 存库待领。
- **插件**：仅客户端。真人 token 只在 Host 进程内存，不写 settings/日志/落盘。审核通过后把分身写入 `digitalTwins` 配置（settings 用户层），**重启生效**。

## 核心流程

```
真人（dsh web 输入 token / 扫码）
  → GET /v1/twins 列出名下分身
    ├─ 有已开通分身 → 用户选一个 → GET /v1/twin 领 token → 写 digitalTwins → 重启生效
    └─ 无 / 想新建 → POST /v1/apply（分身名 ai-<真人>）→ 轮询 /v1/status
         → 管理员网页审核（服务端 /v1/review）→ 通过 → GET /v1/twin → 写 digitalTwins → 重启生效
```

## 关键设计点（未来实施时参考）

1. **真人 token 获取**：手动输入（Host 内存持有，用完即弃）；扫码登录（Matrix `/login` SSO）留占位/后续。
2. **服务端归属**：独立小项目（Node + Express）或用户已有系统；插件只做客户端 + 本契约。
3. **分身生效**：当前架构新增分身需重启（digitalTwins 构造时快照）；热加载账号是后续增强。
4. **安全**：真人 token 不落盘；分身 token 用 `role('secret')` 存 settings 或环境变量；服务端是唯一持 Admin 权限处。

## API 契约（草案，供服务端实现）

```
GET /v1/twins                      → { ok, realUserId, twins: [{ twinUserId, displayName, role, status }] }
POST /v1/apply                     → { ok, requestId, status: pending|approved }
  body: { requestedTwinUserId, displayName, role }   // 校验 ai-<真人>
GET /v1/status?requestId=req_xxx   → { ok, requestId, status: pending|approved|rejected, reason? }
GET /v1/twin?requestId=req_xxx     → { ok, twinUserId, accessToken, owner, role }
POST /v1/review                    → { ok }   // body: { requestId, approve, role? }（管理员网页）
  Authorization: Bearer <adminToken>
```

错误码：`unauthorized`（真人 token 无效）/ `forbidden`（分身名不满足 ai-<真人>）/ `already-exists`（已存在，apply 视为登录）/ `pending` / `rejected` / `server-error`。

## 插件侧待办（未来）

- [ ] `src/provision.ts`：TwinProvisioner（服务端 API 客户端）
- [ ] `src/config.ts`：`provisionServerUrl` 配置
- [ ] `src/settings.ts`：`provisionOps` 命令字段（Client→Host）
- [ ] `src/bridge.ts`：handleProvisionOps + 写 digitalTwins
- [ ] `src/client-main.js`：「分身申请/登录」UI
- [ ] 测试：provisioner 单测（apply/status/twins/twin 流程）
