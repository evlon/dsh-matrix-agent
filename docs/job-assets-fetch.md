# 岗位资产运行时拉取（preset/skill from job source）

> 状态：设计稿（待评审）
> 日期：2026-09-06
> 范围：dsh-bridge（配置 + 启动拉取） / dsh-himarket（provide service） / dsh-matrix-agent（UI 展示）
> 关联问题：① 前台接待/秘书的 preset+skill 目前是**手工落盘** .agent-presets/（内容与源码仓 dsh-job-* 双份维护，改一处忘另一处即分叉）；② client-main.js 内嵌 `defaultReceptionKinds` 与 Host config.ts 双份默认表（将来加第 6 类必分叉）；③ preset 缺失时 reception 只能"空表兜底"。

---

## 1. 目标

1. **配置声明**：在 settings 里用 job 关键字声明各角色用什么岗位（worker/secretary/reception），
   不再依赖手工把 preset 复制到 .agent-presets/。
2. **运行时拉取**：preset/skill 缺失（或来源 job 与配置不一致）时，自动从服务器（HiMarket）
   下载该 job 的岗位包并落盘（skill → skills/<id>，preset → .agent-presets/<id>）。
3. **内容一致性**：代码/UI 不再内嵌岗位内容（receptionKinds 默认表等）——岗位内容以
   服务器发布的 job 包为唯一真相；本地拉取后即时生效。
4. **降级明确**：服务器不可达/未登录/未配置 → 用本地已落盘 preset；本地也没有 → 明确报错
   （提示先同步/安装），不做"空表兜底"的静默降级。

---

## 2. 现状梳理

### 2.1 已有机制（可复用，不重复造）

- **HiMarket 岗位包**：zip 根含 `SKILL.md` + `agent.cordis.yml` + `preset.yml` + 伴随文件
  （tool-restrict.mjs 等）。发布侧：`dsh-himarket publishJob(job)`（本机 .agent-presets/<job>
  + skills/<job> 打平成 zip → 建/复用产品 → 上传 → online）。
- **安装侧**：`dsh-himarket installSkill(nameOrId)` → `sync` 拿 publishedSkills →
  `client.downloadSkill(productId)` 下载 zip → `installSkill()` 解压：
  - `SKILL.md` → `skills/<id>/`（skill 发现）
  - `agent.cordis.yml` + `preset.yml` + 伴随 → `.agent-presets/<id>/`（preset discovery 重读即发现，无需重启）
- **preset 消费**：`agentSetup(presetId)` → `ctx.get('agentPresets').mount(agentCtx, presetId)`
  —— dsh-bridge 建秘书/接待/worker 会话时按 presetId 挂载。

### 2.2 断点（本设计要解决的）

| 断点 | 现状 | 后果 |
|---|---|---|
| 手工落盘 | reception/secretary preset 是我手动从 dsh-job-* 拷到 .agent-presets/ | 源码更新≠测试环境更新；同事机器没有 |
| 双份默认表 | receptionKinds 默认在 Host config.ts + Client client-main.js 各一份 | 加分类必分叉 |
| 空表兜底 | preset 缺失时 classify 走 undefined → 正则 | 静默降级难排查 |
| 无版本/来源追踪 | .agent-presets/<id> 里没有"来自哪个 job/何时拉的"标记 | 无法判断本地是否过期 |

---

## 3. 方案

### 3.1 配置（settings.yaml → dsh-matrix）

```yaml
dsh-matrix:
  # 岗位来源：一个能唯一定位"岗位发布源"的标识。
  # 目前支持 HiMarket：jobSource: himarket（或省略，himarket 装了就用）
  # 未来可扩展：本地目录 / git 仓库 / URL。
  jobSource: himarket
  # 各角色的 job 关键字（preset id 即 job 名；不配置则回退现状：
  #   worker=agentPreset、secretary=secretary、reception=reception）
  jobs:
    worker: pm            # worker 岗位（默认=config.agentPreset）
    secretary: secretary
    reception: reception
  # 拉取策略
  jobAutoFetch: true      # 启动/发现缺失时自动拉取
  jobFetchPolicy: missing  # missing=仅缺失时拉（默认）；always=每次启动都重拉（更新）
```

语义：
- `jobs.reception: reception` = 接待会话的 preset id 用 `reception`，且它的内容来自
  HiMarket 上名为 `reception` 的岗位包（下载后落 .agent-presets/reception/）。
- `jobFetchPolicy: missing`：仅当 `.agent-presets/<id>` 不存在，或存在但**来源标记**
  （见 §3.3）与当前配置不符时拉取。避免每次启动都全量下载。
- `jobFetchPolicy: always`：每次启动都重拉（服务器是最新真相，本地被覆盖）。

### 3.2 dsh-himarket 扩展：provide `himarket` service

在 `dsh-himarket/src/index.ts` 的 apply 末尾（或独立 provide 函数）：

```ts
ctx.provide('himarket', {
  /** 确保某 job（岗位包）已安装到本机 preset/skill 根。
   *  内部：ensureReady（登录）→ listPublishedSkills 找 name===job 的产品
   *  → downloadSkill(productId) → installSkill（skill + preset 落盘）。
   *  已装同名的会被覆盖（幂等重装，installSkill 现有行为）。
   *  @returns 安装摘要；job 在市场不存在 → 抛错（提示先 publishJob）。 */
  async ensureJob(job: string): Promise<string>,
  /** 当前 job 源是否可用（已配置 + 已登录）。 */
  jobSourceReady(): Promise<boolean>,
})
```

- 复用现有 `ensureReady()` / `installByNameOrId()` 内部逻辑（后者就是按 name 找 product
  并 installSkill——可提炼为 service 方法）。
- **不引入新下载通道**：纯 HTTP client 已有。

### 3.3 来源标记（dsh-bridge 侧）

`.agent-presets/<id>/` 落盘时附一个 marker 文件 `.job-source.json`（由拉取方写）：

```json
{ "job": "reception", "source": "himarket", "fetchedAt": 1788660000000 }
```

dsh-bridge 启动时检查：
- `.agent-presets/<id>` 不存在 → 缺 → 拉
- 存在但无 marker 或 marker.job ≠ 配置 job → 来源不符 → 拉（覆盖）
- 存在且 marker.job 匹配：
  - policy=missing → 跳过（用本地）
  - policy=always → 拉（更新）

### 3.4 拉取时机（dsh-bridge）

在 `AccountBridge.start()`（或首个角色会话创建前）做一次"岗位就绪检查"：

```
start()
 ├─ if (jobSource === 'himarket')
 │     try {
 │       const himarket = ctx.get('himarket')          // 可选依赖：未装=undefined
 │       if (himarket && await himarket.jobSourceReady()) {
 │         for (job of 去重的 jobs 值: worker/secretary/reception) {
 │           if (needFetch(job, policy)) {
 │             await himarket.ensureJob(job)            // 下载 + 落盘 + 写 marker
 │             log(`[job-fetch] ${job} fetched from himarket`)
 │           }
 │         }
 │       }
 │     } catch (e) { log(`[job-fetch] skipped: ${e.message}`) }   // 降级：用本地
```

- **不阻塞启动**：拉取失败只记日志，继续用本地已有 preset。
- 拉取在后台做（fire-and-forget + 首会话创建前的 await 竞态由 agentSetup 的 mount
  失败重试兜底——preset 还没落盘时 mount 会抛错，落盘后 discovery 重读即成功）。
  → 更稳的做法：**首会话创建前 await 一次就绪检查**（拉取超时 10s 内），避免 mount 竞态。

### 3.5 消除双份默认表（client-main.js receptionKinds）

现状：Host config.ts `defaultReceptionKinds()`（Schema 默认）+ Client client-main.js
`defaultReceptionKinds()`（表单 fallback）双份。

改法（选一）：
- **A（推荐）**：Client 不再内嵌默认表。表单初始值 = `scope.getSnapshot()` 里
  Host 下发的 `receptionKinds`（settings 用户层已有该键）；读不到（首次/未同步）时
  显示**空表 + 引导文案**（"分类表来自服务器岗位包，同步后可见"），不做本地兜底。
- **B（过渡）**：Client 保留一份但加醒目注释 + 由构建脚本从 config.ts 生成（消除手抄）。

reception preset 的 persona 本来就不内嵌分类表（以每轮请求附表为准），所以 preset
拉取后分类表仍由 **settings 的 receptionKinds** 承载——receptionKinds 的**默认值来源**
从"代码双份"改为"配置单份"（config.ts Schema 是唯一默认；settings.yaml 可覆盖；job 包
不携带 receptionKinds——它属于实例配置而非岗位内容）。

> ⚠️ 需要澄清的设计点：receptionKinds 默认表到底算「岗位内容」（应随 reception job 包
> 下发）还是「实例配置」（留在 settings，用户可改）？本设计倾向后者（用户要能在设置界面
> 增删分类 = 实例级配置），job 包只带 persona/判定契约。若将来要"岗位自带推荐分类表"，
> 可在 job 包 preset.yml 加 `defaultReceptionKinds` 字段，安装时写入 settings 缺省。

### 3.6 settings 与 UI

- settings.ts 加 `jobSource / jobs / jobAutoFetch / jobFetchPolicy` 键（LIVE_APPLY 部分
  jobFetchPolicy 可热更，jobSource/jobs 重启生效）。
- client-main.js「角色」tab 加「岗位来源」块：显示 worker/secretary/reception 的 job
  声明 + 「立即同步岗位」按钮（调 himarket 的 install 路由或 bridge 的 /sync-jobs 命令）。

---

## 4. 降级与错误路径

| 情形 | 行为 |
|---|---|
| himarket 插件未装 | `ctx.get('himarket')` undefined → 跳过拉取，用本地 preset（现状）；本地缺 → mount 报错提示 |
| himarket 未配置/未登录 | jobSourceReady() false → 跳过拉取，用本地；记日志 |
| job 在市场不存在 | ensureJob 抛错 → 记日志；本地有旧版则继续用，提示"市场缺 job，先 publishJob" |
| 网络失败 | ensureJob 抛错 → 记日志，用本地 |
| 本地 preset 缺 + 拉取失败 | 角色会话创建时 mount 失败 → **明确报错**（不再静默空表） |
| policy=missing 且本地在 | 不拉取，直接用 |

---

## 5. 实施步骤

1. **dsh-himarket 扩展**：
   - [ ] `ctx.provide('himarket', { ensureJob, jobSourceReady })`（复用 ensureReady/installByNameOrId）
   - [ ] ensureJob 写 `.job-source.json` marker（或在 preset.ts 落盘后补写）
2. **dsh-bridge 配置与拉取**：
   - [ ] config.ts/settings.ts：`jobSource / jobs / jobAutoFetch / jobFetchPolicy` + Schema/z 默认
   - [ ] AccountBridge.start()：岗位就绪检查（needFetch 判定 + ensureJob + marker 写/读）
   - [ ] 首角色会话创建前 await 就绪检查（或 mount 失败重试）
3. **消除双份**：
   - [ ] client-main.js 去掉内嵌 defaultReceptionKinds，改读 settings 下发值 + 空表引导（方案 A）
4. **验证**（3090）：
   - [ ] 删 .agent-presets/reception → 启动 → 自动从 himarket 拉取 → 会话可用
   - [ ] policy=always → 重启覆盖更新
   - [ ] himarket 未登录 → 降级用本地，无崩溃
   - [ ] 本地缺 + 拉取失败 → 明确报错（非空表静默）
   - [ ] UI「角色」tab 显示 job 声明 + 同步按钮生效
5. **收尾**：commit（dsh-himarket / dsh-bridge / dsh-matrix-agent）

---

## 6. 不做的事（范围外）

- 不改 HiMarket 服务器/契约（岗位包结构不变）。
- 不做通用"任意 URL 下载 preset"（jobSource 先只支持 himarket；git/URL 未来扩展）。
- 不把 receptionKinds 默认表搬进 job 包（实例配置，留在 settings；见 §3.5 澄清点）。
- 不做版本号比较（HiMarket 有版本概念但岗位包无强制版本字段；用 marker + policy 控制更新）。
