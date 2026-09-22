# 岗位 preset 隔离：其他岗位信息会不会被注入

> 结论文档 · 2026-09-21 · 实测环境：3090（`DSH_HOME=C:\Users\niukl\.dsh-matrix-dev`）

## 一、结论先行

| 问题 | 答案 |
|---|---|
| **岗位技能会不会跨岗位注入？** | **曾经会（真实缺陷，已修）**。修复前 dev-roster 会话的 catalog 含 **7 个其他岗位**技能 |
| **其他岗位的 persona 会不会注入？** | **不会**。persona 是 preset 静态字面量，只注入本 preset 那一份 |
| **现在还会吗？** | **不会**。实测新会话 catalog 从 15 条降到 7 条，**零跨岗位** |
| **还有残留吗？** | 有 1 处（见第五节）：**他岗位工具仍暴露**（`matrix_reply_worker`），但有机制层兜底 |

---

## 二、机制：什么会被注入，什么不会

`dsh-skill-filesystem` 的 `roots()` 决定 catalog 扫描哪些目录（按 rank）：

| rank | 来源 | 路径 | 是否跨岗位 |
|---|---|---|---|
| 100/110 | project-dsh / project-agents | `<项目>/.dsh/skills`、`<项目>/.agents/skills` | 共享（设计如此，员工可覆盖岗位技能） |
| **300** | **custom** | **preset 自己声明的 `customSkillDirs`** | **✅ 岗位私有** |
| 400 | user-dsh | `$DSH_HOME/skills` | ❌ **全局，所有岗位可见** |
| 500 | user-agents | `~/.agents/skills` | ❌ **全局，且不受 DSH_HOME 隔离** |
| 900 | bundled | `DSH_BUNDLED_SKILL_DIR` | 全局 |

**关键**：`includeDefaultRoots` **默认 true**，岗位 preset 的 `agent.cordis.yml` **没有一个**声明 `includeDefaultRoots: false`。所以全局根永远参与扫描。

**persona 不同**：它是 `agent.cordis.yml` 里的 YAML 字面量，mount 时注入本 preset 那一份 —— **结构上不可能跨岗位**。

---

## 三、缺陷本身（已修）

### 根因

旧安装器把岗位技能 `SKILL.md` 落到 **`$DSH_HOME/skills/<name>/`** —— 那是 **user-dsh 全局根（rank 400）**。

```
装 dev-roster
   ↓
$DSH_HOME/skills/dev-roster/SKILL.md      ← 落到全局根！
   ↓
所有 12 个 preset 都扫这个根
   ↓
每个数字员工都能看到并加载其他所有岗位的专项技能
```

### 实测证据（修复前）

`matrix-ai-niukunliang-test-1c3640c9`（preset=dev-roster）：

```
catalog(15): agent-reach, communication, dev, dev-roster, dsh-roster,
             find-skills, general, leader, newbie, officecli, pm, qa,
             reception, report-maintenance, secretary
跨岗位泄漏: ❌ general, leader, newbie, pm, qa, reception, secretary
```

**7 个其他岗位技能**暴露给一个研发岗位的数字员工。

### 影响

1. **岗位隔离形同虚设** —— 岗位包的商业价值（差异化能力）被稀释
2. **挤占目录 token** —— 技能名随岗位增多持续膨胀，每个会话都要付
3. **误触发风险** —— 研发岗可能加载「测试工程师」的方法论去做验收

### 修复

岗位技能改落 **preset 私有层**（与生产安装器 `dsh-himarket/src/skill.ts` 的分层重组一致）：

```
<preset>/skills/<id>/SKILL.md        岗位技能入口（discoverRoot 只认 <dir>/SKILL.md）
<preset>/skills/<id>/references/*.md 岗位资源（resourceBase = <preset>/skills/<id>/）
<preset>/skills/<shared>.md          共享技能（平铺，如 communication）
```

依据：岗位 preset 的 `agent.cordis.yml` 用 `customSkillDirs` 指向自身 `skills/`，注册进**该 preset 自己的层** → 岗位间隔离；员工仍可在 project 层同名覆盖。

**修复位置**：
- `dsh-dev-job-install/src/install.ts`（开发期安装器）
- `dsh-himarket/src/skill.ts`（生产安装器，commit `32ffcde`，已提交）

---

## 四、修复验证（决定性证据）

### 新会话实测

触发方式：新建 Matrix 房间 → 主人发一条消息 → 3090 创建全新 worker 会话。

```
会话: matrix-ai-niukunliang-test-9470efe2   preset=dev-roster
catalog(7): agent-reach, communication, dev-roster, dsh-roster,
            find-skills, officecli, report-maintenance
跨岗位泄漏: ✅ 无
```

**15 条 → 7 条，7 个其他岗位技能全部消失。**

### 逐条溯源

| catalog 条目 | 来源根 | 判定 |
|---|---|---|
| dev-roster, communication, dsh-roster | preset 私有层 | ✅ 正确 |
| agent-reach, find-skills, officecli, report-maintenance | `~/.agents/skills` | ⚠️ 全局根（见第五节） |

### persona 注入检查

逐一比对 12 个岗位 persona 的特征句：

```
✅ 本岗位 persona: dev-roster
→ ✅ 无他岗位 persona 注入
```

### 12 个 preset 隔离完整性

```
✅ dev ✅ dev-roster ✅ general ✅ leader ✅ leader-roster ✅ newbie
✅ pm  ✅ pm-roster  ✅ qa      ✅ qa-roster ✅ secretary
❌ reception（设计如此：零工具、明确「不加载任何岗位技能」）
全局 DSH_HOME/skills: ✅ 空
```

---

## 五、⚠️ 两个残留（如实报告）

### 残留 1：他岗位工具仍暴露

dev-roster 会话的工具列表含 **23 个** `matrix_*`/`roster_*` 工具，其中：

| 工具 | 本属 | 是否真暴露 |
|---|---|---|
| `matrix_reply_worker` | **秘书专属**（决策回传） | ✅ 完整 schema 暴露 |
| `matrix_request_owner_decision` | worker（请示主人） | ✅ 合理 |
| `matrix_report_owner` | worker | ✅ 合理 |
| `matrix_send_dm` / `matrix_send_room_message` | worker | ✅ 合理 |

**风险等级：低** —— `bridge.ts:1352-1359` 有**机制层授权红线**：

```ts
// 授权红线：matrix_reply_worker 是秘书→worker 的决策回传工具，只有秘书会话能调。
// worker（执行岗）调用即视为「自我批准绕过主人授权」，一律拒绝并记录。
if (callerSessionId === undefined || callerSessionId !== this.secretarySessionId()) {
  this.ctx.logger.warn('... replyWorker DENIED ...')
  return { roomId, ok: false }
}
```

即：**工具可见 ≠ 可用**。worker 调用会被拒绝并记日志。秘书侧另有 `tool-restrict.mjs` 白名单硬收口（只暴露 9 个工具）。

**但仍有改进空间**：工具描述会占用提示词 token，且「可见即可试」会诱发无效调用。建议 worker 侧也加 restrict（或按角色过滤注册）。

### 残留 2：`~/.agents/skills` 是跨 DSH_HOME 的全局根

`agent-reach` / `find-skills` / `officecli` / `report-maintenance` 来自 `~/.agents/skills`（`DSH_AGENTS_HOME` 未设时的默认值）。

**性质**：这些是**开发者的个人通用技能**（网络调研、Office 文档、汇报维护），不是岗位技能，**跨岗位共享是合理的**。

**但要注意**：它**不受 `DSH_HOME` 隔离** —— 即使给数字分身配了独立 home，仍会扫到开发者的个人技能。企业分发场景下，若这些技能不该出现在数字员工身上，需显式设 `DSH_AGENTS_HOME` 或 `includeDefaultRoots: false`。

### 残留 3：`reception` 的技能是孤儿

`reception/skills/reception/SKILL.md` 存在，但 `agent.cordis.yml` 注释明写「**不加载任何岗位技能**」（零工具设计），且未声明 `customSkillDirs` → **该 SKILL.md 永不生效**。

不是缺陷（设计如此），但**该技能文件是死文件**，要么删、要么在 reception 源包 `agent.cordis.yml` 里注明「本 SKILL.md 仅供仓库参考，不参与运行时」。

---

## 六、防复发

已把回归测试固化进 `dsh-dev-job-install/tests/skill-isolation.test.mjs`（此前只存在于一次性脚本，清理即丢失）：

```
✔ 【dev-roster】岗位技能落 preset 私有层，不污染全局 skills/
✔ 【dev-roster】SKILL.md 内 references 链接全部可解析（资源重组正确）
✔ 【dev】岗位技能落 preset 私有层，不污染全局 skills/
✔ 【dev】SKILL.md 内 references 链接全部可解析（资源重组正确）
✔ 安装器不再向全局 skillRoot 写入（传了也不写）

5/5 通过
```

核心断言：**安装后全局 `skills/` 必须为空** —— 这条一旦回归，测试立即失败。

运行：`cd dsh-dev-job-install && npm test`

---

## 七、遗留待办

| # | 事项 | 优先级 |
|---|---|---|
| 1 | worker 侧也加 `tool-restrict`（隐藏 `matrix_reply_worker`） | P2（有机制兜底，非紧急） |
| 2 | 决定 `~/.agents/skills` 是否应对数字员工可见（企业分发口径） | P2（需产品决策） |
| 3 | 处理 `reception` 的孤儿 SKILL.md | P3（无功能影响） |
| 4 | 生产安装器 `dsh-himarket` 的发版（含 skill.ts 分层重组） | 待确认 |

---

## 附：本次实测方法（可复现）

```bash
# 1. 触发全新 worker 会话（新建房 + 主人发消息）
node _tmp-probe-session.mjs     # 分身建房
node _tmp-boss-send.mjs <roomId> # 主人发消息

# 2. 读会话 catalog（注意 v3 格式文件名 session.v3.jsonl.zstd）
node _tmp-read-session.mjs <会话目录名>

# 3. 判定跨岗位泄漏 + persona 注入
node _tmp-check-leak.mjs <会话目录名>

# 4. 逐条溯源到根
node _tmp-trace-catalog.mjs <会话目录名>
```

**踩坑**：新会话是 **v3 格式**（`session.v3.jsonl.zstd`），只找 `session.jsonl.zstd` 会漏检（我第一轮就漏了，误判"无新会话"）。
