/**
 * dsh-matrix-agent 的浏览器端（Client 半）源码 —— 由 esbuild 打包为
 * `window.__ModuleLoader__.load({ id, factory })` 自包含 bundle（见
 * scripts/build-client.mjs）。运行期依赖（react）外部化，由 dsh 模块系统
 * 以 factory(require) 注入，避免与 shell 的 React 实例冲突。
 *
 * 单入口：设置侧栏只注册一个「数字分身」入口（settings.section 'dsh-matrix'），
 * 内部用一级标签页分区（二级 = 区内分块）：
 * - 连接：Matrix 账号（连接信息）+ 模型路由（worker 默认）
 * - 角色：数字人 worker / 秘书 / 前台接待（reception 分类表）
 * - 社交：自我介绍 / 成员记忆 / 打招呼 / 测试房间前缀
 * - 兜底话术：正则兜底 ack 文案（AI 接待关闭/失败时用）
 *
 * 运行时工作台（第二入口「分身工作台」sidebar.footer.action）：
 * - 任务：各房间当前忙/待交付/请示中状态（taskBoard 镜像）
 * - 收件箱：主人待批请示/汇报（ownerInbox 镜像 + ownerDecisionOps 决策）
 * - 时间线：自我记忆查看/筛选/删除/清空（timelineSnapshot + timelineOps）
 *
 * 岗位人设与秘书工作流由岗位 preset（agent.cordis.yml 的 persona 行）承载，
 * 不再在此注入（灵魂子系统已彻底移除）。
 *
 * 能选择的不填写：provider/model/agentPreset 用 dsh 运行时 API 下拉；
 * owner 提供「由分身账号 ai- 前缀推导」的默认值提示（仅配置页，运行期不推导）。
 *
 * 依赖服务经 inject 声明：slots / settingsScope / connection / locale。
 * 纯 React.createElement，无 JSX；样式用 --dsw-alias-* 主题 token。
 */

import React from 'react'

/**
 * 插件版本号：由 scripts/build-client.mjs 在构建时注入（esbuild define），
 * 浏览器端无法读 package.json，故在构建期固化为常量。未注入时回退 'dev'。
 * 用于设置页等 UI 展示当前安装/运行的插件版本。
 */
const PLUGIN_VERSION = typeof __PLUGIN_VERSION__ !== 'undefined' ? __PLUGIN_VERSION__ : 'dev'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'settingsScope', 'connection', 'locale']

/** settings namespace（与 Host settings.ts 的 MATRIX_NS 一致）。 */
const MATRIX_NS = 'dsh-matrix'

/** 从 settingsScope 绑定某 namespace，返回 scope（未就绪返回 undefined）。 */
function bindScope(ctx, namespace) {
  const settingsScope = ctx.get('settingsScope')
  if (settingsScope === undefined) return undefined
  try {
    return settingsScope.bind({ namespace })
  } catch {
    return undefined
  }
}

/** 从 scope 快照取 section（value 优先，否则 base）。 */
function sectionOf(scope) {
  if (scope === undefined) return undefined
  const snap = scope.getSnapshot()
  return snap.value ?? snap.base ?? undefined
}

/**
 * 从分身账号推导默认 Owner（仅配置页提示用，运行期不推导）。
 * '@ai-niukunliang:domain' → '@niukunliang:domain'。
 */
function deriveDefaultOwner(userId) {
  if (typeof userId !== 'string' || !userId.startsWith('@')) return undefined
  const at = userId.indexOf(':')
  if (at === -1) return undefined
  const local = userId.slice(1, at)
  const domain = userId.slice(at)
  if (!local.startsWith('ai-')) return undefined
  const ownerLocal = local.slice(3)
  if (ownerLocal === '') return undefined
  return '@' + ownerLocal + domain
}

const FIELD_STYLE = {
  display: 'flex', flexDirection: 'column', gap: '8px',
  marginBottom: '12px', maxWidth: '560px',
}
const LABEL_STYLE = { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const INPUT_STYLE = {
  padding: '6px 8px', borderRadius: '6px',
  border: '1px solid var(--dsw-alias-border-l1)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: '13px',
}
const TEXTAREA_STYLE = Object.assign({}, INPUT_STYLE, { minHeight: '72px', resize: 'vertical' })
const ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '8px' }
const HINT_STYLE = { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', margin: '2px 0 0' }

function TextField(props) {
  const { label, value, onChange, textarea, placeholder, hint, type } = props
  const el = textarea
    ? React.createElement('textarea', {
        style: TEXTAREA_STYLE, value: value ?? '', placeholder,
        onChange: (e) => onChange(e.target.value),
      })
    : React.createElement('input', {
        style: INPUT_STYLE, value: value ?? '', placeholder, type: type ?? 'text',
        onChange: (e) => onChange(e.target.value),
      })
  return React.createElement('div', { style: FIELD_STYLE },
    React.createElement('label', { style: LABEL_STYLE }, label),
    el,
    hint ? React.createElement('div', { style: HINT_STYLE }, hint) : null)
}

function NumberField(props) {
  const { label, value, onChange, min, max, step } = props
  return React.createElement('div', { style: FIELD_STYLE },
    React.createElement('label', { style: LABEL_STYLE }, label),
    React.createElement('input', {
      style: INPUT_STYLE, type: 'number', value: value ?? '', min, max, step,
      onChange: (e) => {
        const n = e.target.value === '' ? 0 : Number.parseInt(e.target.value, 10)
        onChange(Number.isNaN(n) ? 0 : n)
      },
    }))
}

function SelectField(props) {
  const { label, value, onChange, options, hint } = props
  return React.createElement('div', { style: FIELD_STYLE },
    React.createElement('label', { style: LABEL_STYLE }, label),
    React.createElement('select', {
      style: INPUT_STYLE, value: value ?? '',
      onChange: (e) => onChange(e.target.value),
    }, options.map((opt) =>
      React.createElement('option', { key: opt.value, value: opt.value }, opt.label))),
    hint ? React.createElement('div', { style: HINT_STYLE }, hint) : null)
}

function SwitchField(props) {
  const { label, value, onChange, hint } = props
  return React.createElement('div', { style: FIELD_STYLE },
    React.createElement('div', { style: ROW_STYLE },
      React.createElement('input', {
        type: 'checkbox', checked: value === true,
        onChange: (e) => onChange(e.target.checked),
      }),
      React.createElement('label', { style: LABEL_STYLE }, label)),
    hint ? React.createElement('div', { style: HINT_STYLE }, hint) : null)
}

function SaveBar(props) {
  const { onSave, saved, hint, onReset } = props
  return React.createElement('div', { style: Object.assign({}, ROW_STYLE, { justifyContent: 'space-between', flexWrap: 'wrap' }) },
    React.createElement('div', { style: ROW_STYLE },
      React.createElement('button', {
        style: {
          padding: '6px 16px', borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-brand-primary)',
          color: 'var(--dsw-alias-bg-base)', cursor: 'pointer', fontSize: '13px',
        },
        onClick: onSave,
      }, '保存'),
      saved ? React.createElement('span', { style: { color: 'var(--dsw-alias-state-success-primary)', fontSize: '12px' } }, '✓ 已保存') : null,
      hint ? React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' } }, hint) : null),
    onReset !== undefined
      ? React.createElement('button', {
          style: {
            padding: '6px 12px', borderRadius: '6px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: '12px',
          },
          onClick: onReset,
        }, '重置为默认')
      : null)
}

async function applyScope(scope, patch) {
  if (scope === undefined) return
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue
    await scope.set(field, value)
  }
}

/** 数据源 hook：并行拉取 provider/model/agentPreset 目录。 */
function useRuntimeCatalogs(conn) {
  const [providers, setProviders] = React.useState([])
  const [modelGroups, setModelGroups] = React.useState([])
  const [presets, setPresets] = React.useState([])

  React.useEffect(() => {
    if (conn === undefined || conn.api === undefined) return undefined
    let alive = true
    // providers：响应为 { result: { ok, value: { providers } } }。
    conn.api.llm.providers({}).then((res) => {
      if (!alive || res.result?.ok !== true) return
      const list = Array.isArray(res.result?.value?.providers) ? res.result.value.providers : []
      setProviders(list.map((p) => ({ value: p.provider, label: p.displayName ?? p.provider })))
    }).catch(() => {})
    // models：响应为 { result: { ok, value: { groups } } }。
    conn.api.llm.models({}).then((res) => {
      if (!alive || res.result?.ok !== true) return
      const groups = Array.isArray(res.result?.value?.groups) ? res.result.value.groups : []
      setModelGroups(groups)
    }).catch(() => {})
    // agentPresets：响应为 { result: { ok, value: { presets } } }。
    conn.api.agentPresets.list({}).then((res) => {
      if (!alive || res.result?.ok !== true) return
      const items = Array.isArray(res.result?.value?.presets) ? res.result.value.presets : []
      setPresets(items.map((p) => ({
        value: p.id,
        label: (p.name ?? p.id) + (p.isDefault ? '（默认）' : ''),
      })))
    }).catch(() => {})
    return () => { alive = false }
  }, [conn])

  return { providers, modelGroups, presets }
}

/** 该 provider 下的模型下拉 options（含当前值 fallback）。 */
function modelOptionsFor(groups, provider, currentModel) {
  const group = groups.find((g) => g.id === provider)
  const list = (group && Array.isArray(group.models) ? group.models : []).map((m) => ({ value: m.id, label: m.id }))
  if (currentModel !== undefined && currentModel !== '' && !list.some((o) => o.value === currentModel)) {
    list.unshift({ value: currentModel, label: currentModel + '（当前）' })
  }
  if (list.length === 0 && provider !== undefined && provider !== '') {
    return [{ value: '', label: '（该 provider 暂无模型目录）' }]
  }
  return list
}

/** Matrix 账号标签页。 */
function AccountTab(props) {
  const { form, set, save, saved, reset, providers, modelGroups, presets, conn } = props
  const providerOptions = providers.length > 0
    ? providers
    : (form.provider !== undefined && form.provider !== '' ? [{ value: form.provider, label: form.provider + '（当前）' }] : [])
  const modelOptions = modelOptionsFor(modelGroups, form.provider, form.model)
  const presetOptions = presets.length > 0
    ? presets
    : (form.agentPreset !== undefined && form.agentPreset !== '' ? [{ value: form.agentPreset, label: form.agentPreset + '（当前）' }] : [])
  const defaultOwner = deriveDefaultOwner(form.userId)

  return React.createElement('div', null,
    React.createElement('div', { style: SECTION_TITLE_STYLE }, 'Matrix 账号'),
    React.createElement('p', { style: HINT_STYLE },
      'Matrix 连接与桥接配置。连接类字段（服务器地址 / Access Token / 账号 ID）保存后需重启 dsh 才生效；其余字段即时生效。'),
    React.createElement(TextField, { label: 'Homeserver URL（需重启）', value: form.homeserverUrl, onChange: set('homeserverUrl'), placeholder: 'https://im-ipm.ict.cmcc' }),
    React.createElement(TextField, { label: '分身账号 ID（需重启）', value: form.userId, onChange: set('userId'), placeholder: '@ai-xxx:server' }),
    React.createElement(TextField, { label: 'Access Token（需重启，已保存不回显）', value: '', onChange: set('accessToken'), type: 'password', placeholder: '留空保持不变' }),
    React.createElement(TextField, {
      label: '实例命名空间 instanceKey（需重启，留空自动用 DSH_HOME）',
      value: form.instanceKey, onChange: set('instanceKey'),
      placeholder: '留空 = 自动按 DSH_HOME 隔离（推荐）',
      hint: '不同 dsh 实例（端口/profile/DSH_HOME）登录同一分身、处理同一房间时，会话 id 会冲突互相 resume。留空时自动用 DSH_HOME 做会话隔离；也可显式填 "3090" 之类标识。',
    }),
    React.createElement(TextField, {
      label: 'Owner（审批应答人）',
      value: form.owner, onChange: set('owner'),
      placeholder: defaultOwner !== undefined ? defaultOwner : '@user:server',
      hint: defaultOwner !== undefined
        ? '分身账号以 ai- 开头，未填时默认：' + defaultOwner + '（可手动填入）'
        : undefined,
    }),
    React.createElement(SwitchField, { label: '响应房间所有消息（respondToAll）', value: form.respondToAll, onChange: set('respondToAll') }),
    React.createElement(SwitchField, { label: '允许任意用户（allowAllUsers，仅开发）', value: form.allowAllUsers, onChange: set('allowAllUsers') }),
    React.createElement(TextField, {
      label: '白名单（逗号分隔 userId）',
      value: (form.allowedUserIds ?? []).join(', '),
      onChange: (v) => set('allowedUserIds')(v.split(',').map((s) => s.trim()).filter((s) => s !== '')),
      hint: '格式：@user:server，逗号分隔。成员加入后分身会自动记住（/memory 查看）。',
    }),
    React.createElement('div', { style: { ...SECTION_TITLE_STYLE, marginTop: '16px' } }, '模型路由（数字人 worker 默认）'),
    React.createElement('p', { style: HINT_STYLE }, '数字人（worker）执行任务用的模型；秘书/接待可在「角色」tab 单独覆盖。'),
    React.createElement(SelectField, {
      label: 'LLM Provider', value: form.provider, onChange: set('provider'),
      options: providerOptions.length > 0 ? providerOptions : [{ value: '', label: '（加载中或未配置）' }],
    }),
    React.createElement(SelectField, {
      label: '模型', value: form.model, onChange: set('model'),
      options: modelOptions.length > 0 ? modelOptions : [{ value: '', label: '（选择 provider 后加载）' }],
    }),
    React.createElement(SelectField, {
      label: 'Agent Preset', value: form.agentPreset, onChange: set('agentPreset'),
      options: presetOptions.length > 0 ? presetOptions : [{ value: '', label: '（加载中或未配置）' }],
    }),
    React.createElement(SelectField, {
      label: REASONING_LABELS.worker, value: form.workerReasoningEffort, onChange: set('workerReasoningEffort'),
      options: REASONING_OPTIONS, hint: REASONING_HINT,
    }),
    React.createElement(NumberField, { label: '单条消息字符上限', value: form.chunkMaxChars, onChange: set('chunkMaxChars'), min: 100, max: 20000, step: 100 }),
    React.createElement(SwitchField, { label: '主动消息需审批（proactiveSendRequiresApproval）', value: form.proactiveSendRequiresApproval, onChange: set('proactiveSendRequiresApproval') }),
    React.createElement(SwitchField, { label: '保留富文本/回复/编辑语义（preserveRichText）', value: form.preserveRichText, onChange: set('preserveRichText') }),
    React.createElement(SaveBar, { onSave: save, saved, hint: '连接类字段重启后生效', onReset: () => reset('connection') }))
}

/** 社交标签页：自我介绍/成员记忆/打招呼/测试房间。 */
function SocialTab(props) {
  const { form, set, save, saved, reset } = props
  return React.createElement('div', null,
    React.createElement('p', { style: HINT_STYLE },
      '分身与同事/其他数字人的社交行为：入群自我介绍、成员记忆、打招呼。'),
    React.createElement(SwitchField, { label: '入群主动自我介绍（autoIntroduce）', value: form.autoIntroduce, onChange: set('autoIntroduce') }),
    React.createElement(NumberField, { label: '自我介绍 @ 人数上限', value: form.maxSelfIntroMentions, onChange: set('maxSelfIntroMentions'), min: 0, max: 200, step: 1 }),
    React.createElement(TextField, { label: '自我介绍模板', value: form.selfIntroTemplate, onChange: set('selfIntroTemplate'), textarea: true, hint: '占位符：{{userId}} / {{role}} / {{owner}}' }),
    React.createElement(SwitchField, { label: '记住成员（memberMemory）', value: form.memberMemory, onChange: set('memberMemory'), hint: '记住每个房间里见过的成员（含其他数字人），/memory 查看' }),
    React.createElement(SwitchField, { label: '新成员入群主动打招呼（autoGreet）', value: form.autoGreet, onChange: set('autoGreet'), hint: '新成员（含其他数字人）入群时提示分身主动了解对方' }),
    React.createElement(TextField, { label: '测试房间前缀（testRoomPrefix）', value: form.testRoomPrefix, onChange: set('testRoomPrefix'), hint: '房间名含此前缀视为测试环境：分身每次回复都会被提示「请勿真实执行任务/修改文件/发真实消息」。留空关闭' }),
    React.createElement(SaveBar, { onSave: save, saved, onReset: () => reset('social') }))
}

/** 兜底话术标签页：正则兜底 ack 文案（仅 AI 接待关闭/判定失败时生效）。 */
function ScriptsTab(props) {
  const { form, set, save, saved, reset } = props
  const reception = [
    { field: 'receptionAckNewTask', label: '① 新任务收到（房间不忙时 @ 派活）', ph: '收到，我这就去整理{{taskHint}}，稍后把结果发你～' },
    { field: 'receptionAckBusyQuestion', label: '② 忙时被问问题', ph: '[前台接待] @{{lp}} 这条我记下了，手头正忙（处理任务中）{{taskDesc}}{{eta}}，处理完马上回你；有急需可以再把关键点说一遍～' },
    { field: 'receptionAckBusy', label: '③ 忙时普通消息', ph: '[前台接待] @{{lp}} 收到，我手头正忙（处理任务中）{{taskDesc}}{{eta}}，稍后回你这条～' },
    { field: 'receptionRejected', label: '④ 主人拒绝开工', ph: '[前台接待] 主人暂时不同意开工，任务「{{summary}}」先搁置。' },
    { field: 'receptionGiveUp', label: '⑤ 跟进超时占位（提醒 2 次仍无果后代发）', ph: '[前台接待] 我正在整理「{{summary}}」，结果稍后同步，请稍等～' },
  ]
  return React.createElement('div', null,
    React.createElement('p', { style: HINT_STYLE },
      '以下是「正则兜底」话术：仅在 AI 接待层关闭（receptionEnabled=false）或 AI 判定失败时生效。若已启用 AI 接待，请到「角色 → 前台接待 → 分类表」改每类的 ackText。'),
    React.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '12px', lineHeight: '20px' } },
      '占位符：{{lp}} 发送者短名 · {{taskHint}} 任务摘要（含「」） · {{taskDesc}} 「正在做…」段 · {{eta}} 已耗时/ETA 段 · {{summary}} 任务摘要（含「」）。清空某条 = 该场景不自动回复。'),
    reception.map((r) => React.createElement(TextField, {
      key: r.field, label: r.label, value: form[r.field], onChange: set(r.field),
      textarea: true, placeholder: r.ph,
    })),
    React.createElement(SaveBar, { onSave: save, saved, hint: '保存即生效，无需重启', onReset: () => reset('scripts') }))
}

/** 角色标签页：worker / 秘书 / 前台接待 三块（为将来各角色独立配置留扩展位）。 */
function RolesTab(props) {
  const { form, set, save, saved, reset, providers, modelGroups, conn } = props
  const providerOptions = providers.length > 0
    ? providers
    : (form.receptionProvider !== undefined && form.receptionProvider !== '' ? [{ value: form.receptionProvider, label: form.receptionProvider + '（当前）' }] : [])
  const modelOptions = modelOptionsFor(modelGroups, form.receptionProvider, form.receptionModel)
  // receptionKinds 编辑：读当前 form（可能 undefined → 用默认）。
  const kinds = (form.receptionKinds && typeof form.receptionKinds === 'object') ? form.receptionKinds : defaultReceptionKinds()
  const setKind = (kindKey, field, value) => {
    const next = Object.assign({}, kinds, {
      [kindKey]: Object.assign({}, kinds[kindKey], { [field]: value }),
    })
    set('receptionKinds')(next)
  }

  return React.createElement('div', null,
    // ── 数字人 worker 块 ──
    React.createElement('div', { style: { ...SECTION_TITLE_STYLE } }, '数字人（worker）'),
    React.createElement('p', { style: HINT_STYLE },
      '数字人是执行岗：收到群任务后请示 → 读真实数据 → 整理 → 汇报 → 交付。模型/思考强度在「连接 → 模型路由」配置。'),
    React.createElement(SwitchField, { label: '群聊默认启用秘书编排（secretaryGroupDefault）', value: form.secretaryGroupDefault, onChange: set('secretaryGroupDefault'), hint: '群聊任务默认走「请示→汇报→交付」闭环（@ 提及自己的即时交流仍直接回复）；关闭后仅前缀匹配房间启用' }),
    React.createElement(SwitchField, { label: '私聊也启用秘书编排（secretaryDmDefault）', value: form.secretaryDmDefault, onChange: set('secretaryDmDefault'), hint: '默认关闭（私聊直接对话）；开启后数字分身的私聊消息也走请示闭环' }),
    React.createElement(NumberField, { label: '开工请示超时（taskClarifyTimeoutSecs，秒）', value: form.taskClarifyTimeoutSecs, onChange: set('taskClarifyTimeoutSecs'), min: 10, max: 3600, step: 10, hint: 'worker 请示主人开工后阻塞等待的秒数；超时转「挂起待答」，主人晚答复会唤醒继续' }),
    React.createElement(NumberField, { label: '交付汇报超时（taskConfirmTimeoutSecs，秒）', value: form.taskConfirmTimeoutSecs, onChange: set('taskConfirmTimeoutSecs'), min: 10, max: 3600, step: 10, hint: 'worker 汇报交付后阻塞等待主人确认的秒数；超时转「挂起待答」' }),
    React.createElement(NumberField, { label: '等秘书回传超时（secretaryDecisionTimeoutSecs，秒）', value: form.secretaryDecisionTimeoutSecs, onChange: set('secretaryDecisionTimeoutSecs'), min: 10, max: 3600, step: 10, hint: 'worker 请示/汇报后等待秘书回传决策的秒数；测试房间自动缩短为 20s' }),

    // ── 秘书块 ──
    React.createElement('div', { style: { ...SECTION_TITLE_STYLE, marginTop: '20px' } }, '秘书（secretary）'),
    React.createElement('p', { style: HINT_STYLE },
      '秘书是协调岗：能定的直接回 worker，需拍板的上呈主人。秘书完整对话在会话列表的「秘书」会话中。'),
    React.createElement(SelectField, {
      label: '秘书思考强度（secretaryReasoningEffort）', value: form.secretaryReasoningEffort, onChange: set('secretaryReasoningEffort'),
      options: REASONING_OPTIONS, hint: REASONING_HINT,
    }),

    // ── 前台接待块 ──
    React.createElement('div', { style: { ...SECTION_TITLE_STYLE, marginTop: '20px' } }, '前台接待（reception）'),
    React.createElement('p', { style: HINT_STYLE },
      '前台接待是即时礼貌层：对每条入站消息做语义分类（独立 agent，零工具），按下面分类表执行「是否秒级 ack / 是否置忙 / 是否转交 worker」。'),
    React.createElement(SwitchField, { label: '启用 AI 接待层（receptionEnabled）', value: form.receptionEnabled, onChange: set('receptionEnabled'), hint: '启用后由独立「前台接待」agent 判定消息分类；关闭则回退内置正则规则（见「兜底话术」tab）' }),
    React.createElement('div', { style: { ...SUB_BLOCK_STYLE } },
      React.createElement('div', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: '8px' } }, '接待 Agent'),
      React.createElement('p', { style: HINT_STYLE }, '岗位 preset 固定为「前台接待」（reception，零工具，只分类不执行），Provider/Model 覆盖主路由；思考强度建议恒 off。'),
      React.createElement(SelectField, {
        label: '接待 Provider', value: form.receptionProvider, onChange: set('receptionProvider'),
        options: providerOptions.length > 0 ? providerOptions : [{ value: '', label: '（默认跟随主路由）' }],
      }),
      React.createElement(SelectField, {
        label: '接待模型', value: form.receptionModel, onChange: set('receptionModel'),
        options: modelOptions.length > 0 ? modelOptions : [{ value: '', label: '（默认跟随主路由）' }],
      }),
      React.createElement(SelectField, {
        label: '接待思考强度', value: form.receptionReasoningEffort, onChange: set('receptionReasoningEffort'),
        options: [{ value: 'off', label: 'off — 关闭思考（推荐）' }, { value: 'low', label: 'low' }, { value: 'high', label: 'high' }, { value: 'max', label: 'max' }],
      }),
      React.createElement('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } },
        React.createElement('div', { style: { flex: 1, minWidth: '150px' } },
          React.createElement(NumberField, { label: '判定超时（秒）', value: form.receptionTimeoutSecs, onChange: set('receptionTimeoutSecs'), min: 1, max: 60, step: 1 })),
        React.createElement('div', { style: { flex: 1, minWidth: '150px' } },
          React.createElement(NumberField, { label: '最短判定长度', value: form.receptionMinLength, onChange: set('receptionMinLength'), min: 0, max: 200, step: 1 })),
        React.createElement('div', { style: { flex: 1, minWidth: '150px' } },
          React.createElement(NumberField, { label: '房间节流（秒）', value: form.receptionThrottleSecs, onChange: set('receptionThrottleSecs'), min: 0, max: 300, step: 1 }))),
    ),
    React.createElement('div', { style: { ...SUB_BLOCK_STYLE, marginTop: '12px' } },
      React.createElement('div', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: '4px' } }, '分类表（receptionKinds）'),
      React.createElement('p', { style: HINT_STYLE },
        '接待 agent 按这些分类判定消息。每类可改显示名、描述（判定依据）、是否发 ack、是否置忙、是否转交 worker，及自定义 ack 话术。' + RECEPTION_PLACEHOLDER_HINT),
      RECEPTION_KIND_KEYS.map((key) => {
        const def = kinds[key] || { label: key, describe: '', ack: true, ackText: '', busy: false, forward: true }
        return React.createElement('div', {
          key, style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', padding: '10px', marginBottom: '8px', background: 'var(--dsw-alias-bg-layer-1)' },
        },
          React.createElement(TextField, { label: key + ' · 显示名', value: def.label, onChange: (v) => setKind(key, 'label', v) }),
          React.createElement(TextField, { label: '描述（判定依据）', value: def.describe, onChange: (v) => setKind(key, 'describe', v), textarea: true }),
          React.createElement('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } },
            React.createElement(SwitchField, { label: '发礼貌 ack', value: def.ack === true, onChange: (v) => setKind(key, 'ack', v) }),
            React.createElement(SwitchField, { label: '视为忙（不打扰）', value: def.busy === true, onChange: (v) => setKind(key, 'busy', v) }),
            React.createElement(SwitchField, { label: '转交 worker', value: def.forward === true, onChange: (v) => setKind(key, 'forward', v) })),
          React.createElement(TextField, { label: '自定义 ack 话术（留空用默认）', value: def.ackText, onChange: (v) => setKind(key, 'ackText', v), textarea: true, placeholder: '收到，我这就去整理{{taskHint}}，稍后把结果发你～' }))
      })),
    React.createElement(SaveBar, { onSave: save, saved, hint: '保存即生效（LIVE 热更新）', onReset: () => reset('roles') }))
}

/** 区块标题样式。 */
const SECTION_TITLE_STYLE = {
  fontSize: '15px', fontWeight: 700, color: 'var(--dsw-alias-label-primary)',
  borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: '4px', marginBottom: '8px',
}
/** 子区块容器样式（卡片）。 */
const SUB_BLOCK_STYLE = {
  border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px',
  padding: '12px', marginBottom: '8px', background: 'var(--dsw-alias-bg-layer-0)',
}

/** 设置页显示默认值：settings 未就绪/加载失败时也展示合理默认（与 config.ts 默认一致）。 */
const FORM_DEFAULTS = {
  // Matrix 账号。
  homeserverUrl: '',
  userId: '',
  owner: '',
  instanceKey: '',
  respondToAll: true,
  allowAllUsers: false,
  allowedUserIds: [],
  provider: '',
  model: '',
  agentPreset: 'standard',
  workerReasoningEffort: '',
  secretaryReasoningEffort: '',
  chunkMaxChars: 4000,
  proactiveSendRequiresApproval: true,
  preserveRichText: true,
  // 社交。
  autoIntroduce: true,
  maxSelfIntroMentions: 20,
  memberMemory: true,
  autoGreet: true,
  selfIntroTemplate: '大家好，我是 {{userId}}，很高兴加入这个群。以后有什么需要帮忙的尽管找我，我会尽力配合大家的工作！',
  // 测试环境。
  testRoomPrefix: '【测试】',
  // 群聊默认秘书编排。
  secretaryGroupDefault: true,
  // 私聊默认秘书编排（默认关闭）。
  secretaryDmDefault: false,
  // 秘书编排超时（秒）。
  taskClarifyTimeoutSecs: 120,
  taskConfirmTimeoutSecs: 600,
  secretaryDecisionTimeoutSecs: 180,
  // 前台接待层话术模板（默认=bridge 内置文案，占位符见话术 tab 提示）。
  receptionAckNewTask: '收到，我这就去整理{{taskHint}}，稍后把结果发你～',
  receptionAckBusyQuestion: '[前台接待] @{{lp}} 这条我记下了，手头正忙（处理任务中）{{taskDesc}}{{eta}}，处理完马上回你；有急需可以再把关键点说一遍～',
  receptionAckBusy: '[前台接待] @{{lp}} 收到，我手头正忙（处理任务中）{{taskDesc}}{{eta}}，稍后回你这条～',
  receptionRejected: '[前台接待] 主人暂时不同意开工，任务「{{summary}}」先搁置。',
  receptionGiveUp: '[前台接待] 我正在整理「{{summary}}」，结果稍后同步，请稍等～',
  // AI 接待层（reception）。
  receptionEnabled: false,
  receptionPreset: 'reception',
  receptionProvider: '',
  receptionModel: '',
  receptionReasoningEffort: 'off',
  receptionTimeoutSecs: 3,
  receptionMinLength: 0,
  receptionThrottleSecs: 0,
  receptionKinds: defaultReceptionKinds(),
}

/** 把 settings 用户层字段合并进顶层 form；settings 未就绪时用显示默认值。 */
function mergeFormSection(section) {
  const base = Object.assign({}, FORM_DEFAULTS)
  if (section === undefined) return base
  for (const [k, v] of Object.entries(section)) {
    if (v === undefined || v === null) continue
    base[k] = v
  }
  return base
}

/** 保存时把 form 收拢后整体写 settings。 */
function collectFormForSave(form) {
  const rest = {}
  for (const [k, v] of Object.entries(form)) {
    rest[k] = v
  }
  return rest
}

/** 主设置页：单入口 + 内部标签页。 */
function MatrixSettingsPage(props) {
  const ctx = props.ctx
  const [scope] = React.useState(() => bindScope(ctx, MATRIX_NS))
  const [form, setForm] = React.useState(() => mergeFormSection(undefined))
  const [saved, setSaved] = React.useState(false)
  const [active, setActive] = React.useState('account')

  React.useEffect(() => {
    const update = () => {
      const section = sectionOf(scope)
      setForm(mergeFormSection(section))
    }
    update()
    if (scope !== undefined) return scope.subscribe(update)
    return undefined
  }, [scope])

  const conn = ctx.get('connection')
  const catalogs = useRuntimeCatalogs(conn)

  const set = (field) => (value) => {
    setForm((prev) => Object.assign({}, prev, { [field]: value }))
    setSaved(false)
  }
  const save = () => {
    applyScope(scope, collectFormForSave(form)).then(() => setSaved(true)).catch(() => setSaved(false))
  }

  // 各 tab 的字段清单（用于「重置为默认」）。
  const TAB_FIELDS = {
    connection: ['homeserverUrl', 'userId', 'accessToken', 'instanceKey', 'owner', 'respondToAll', 'allowAllUsers', 'allowedUserIds', 'provider', 'model', 'agentPreset', 'workerReasoningEffort', 'chunkMaxChars', 'proactiveSendRequiresApproval', 'preserveRichText'],
    roles: ['secretaryGroupDefault', 'secretaryDmDefault', 'taskClarifyTimeoutSecs', 'taskConfirmTimeoutSecs', 'secretaryDecisionTimeoutSecs', 'secretaryReasoningEffort', 'receptionEnabled', 'receptionPreset', 'receptionProvider', 'receptionModel', 'receptionReasoningEffort', 'receptionTimeoutSecs', 'receptionMinLength', 'receptionThrottleSecs', 'receptionKinds'],
    social: ['autoIntroduce', 'maxSelfIntroMentions', 'memberMemory', 'autoGreet', 'selfIntroTemplate', 'testRoomPrefix'],
    scripts: ['receptionAckNewTask', 'receptionAckBusyQuestion', 'receptionAckBusy', 'receptionRejected', 'receptionGiveUp'],
  }
  // 重置某 tab：清除 settings 用户层对应字段（回继承默认），并同步前端 form。
  const resetTab = (tabId) => {
    const fields = TAB_FIELDS[tabId] ?? []
    if (scope !== undefined) {
      fields.forEach((field) => {
        try { scope.unset(field) } catch { /* 字段可能未写，忽略 */ }
      })
    }
    // 前端同步恢复显示默认值。
    const def = mergeFormSection(undefined)
    setForm((prev) => {
      const next = Object.assign({}, prev)
      fields.forEach((f) => { next[f] = def[f] })
      return next
    })
    setSaved(false)
  }

  const tabs = [
    { id: 'connection', label: '连接' },
    { id: 'roles', label: '角色' },
    { id: 'social', label: '社交' },
    { id: 'scripts', label: '兜底话术' },
  ]
  const tabProps = { scope, form, set, save, saved, conn, reset: resetTab, ...catalogs }

  return React.createElement('div', null,
    React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '4px' } },
      React.createElement('h3', { style: { margin: '0', color: 'var(--dsw-alias-label-primary)' } }, '数字分身'),
      React.createElement('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, `dsh-matrix-agent v${PLUGIN_VERSION}`)),
    React.createElement('div', { style: { display: 'flex', gap: '4px', marginBottom: '16px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
      tabs.map((tab) =>
        React.createElement('button', {
          key: tab.id,
          role: 'tab',
          'aria-selected': active === tab.id,
          onClick: () => setActive(tab.id),
          style: {
            padding: '8px 14px',
            border: 'none',
            borderBottom: active === tab.id ? '2px solid var(--dsw-alias-brand-primary)' : '2px solid transparent',
            background: 'transparent',
            color: active === tab.id ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: active === tab.id ? 600 : 400,
          },
        }, tab.label))),
    React.createElement('div', { role: 'tabpanel' },
      active === 'connection' ? React.createElement(AccountTab, tabProps)
        : active === 'roles' ? React.createElement(RolesTab, tabProps)
        : active === 'social' ? React.createElement(SocialTab, tabProps)
        : React.createElement(ScriptsTab, tabProps)))
}

/** 从 dsh-matrix settings 读自我时间线快照（运行时镜像，仅元数据）。 */
function useTimelineSnapshot(ctx) {
  const [scope] = React.useState(() => bindScope(ctx, MATRIX_NS))
  const [snapshot, setSnapshot] = React.useState(undefined)
  React.useEffect(() => {
    const update = () => {
      const section = sectionOf(scope)
      // section 就绪但无快照字段：视为空快照（避免永久"加载中"）。
      if (section !== undefined) {
        setSnapshot(section.timelineSnapshot !== undefined
          ? section.timelineSnapshot
          : { entries: [], updatedAt: 0 })
      }
    }
    update()
    if (scope !== undefined) return scope.subscribe(update)
    return undefined
  }, [scope])
  return { scope, snapshot }
}

/** 时间线动作类型中文标签（无原文，仅元数据）。 */
const TIMELINE_KIND_LABELS = {
  reply: '💬 回复',
  'tool-call': '🔧 工具',
  proactive: '📨 主动消息',
  'self-intro': '👋 自我介绍',
  approval: '✅ 审批',
  task: '📋 任务',
}
function timelineKindLabel(kind) {
  return TIMELINE_KIND_LABELS[kind] ?? kind ?? '?'
}

/** 「时间线」tab：查看/筛选/删除/清空自己的跨房间记忆（仅元数据，无原文）。 */
function TimelineTab(props) {
  const ctx = props.ctx
  const { scope, snapshot } = useTimelineSnapshot(ctx)
  const entries = (snapshot !== undefined && Array.isArray(snapshot.entries)) ? snapshot.entries : []
  const [filter, setFilter] = React.useState('all')
  const [roomFilter, setRoomFilter] = React.useState('')
  const [actorFilter, setActorFilter] = React.useState('all')

  const visible = entries.filter((e) =>
    (filter === 'all' || e.kind === filter) &&
    (actorFilter === 'all' || (e.actor ?? 'worker') === actorFilter) &&
    (roomFilter === '' || (e.roomId ?? '').includes(roomFilter)))

  const removeEntry = (id) => {
    if (scope === undefined) return
    scope.set('timelineOps', { removeIds: [id] }).catch(() => {})
  }
  const clearAll = () => {
    if (scope === undefined) return
    scope.set('timelineOps', { clearSeq: Date.now() }).catch(() => {})
  }

  return React.createElement('div', null,
    React.createElement('p', { style: HINT_STYLE },
      '这里是「自己的记忆」：你在各群里说过什么（回复次数）、调用过什么工具、主动发过什么消息、完成过什么任务（仅结构化元数据，不含聊天原文）。用于检查分身做了什么，为迭代更新提供依据。'),
    React.createElement('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap', alignItems: 'center' } },
      React.createElement('select', {
        style: Object.assign({}, INPUT_STYLE, { width: 'auto' }),
        value: filter,
        onChange: (e) => setFilter(e.target.value),
      }, ['all', 'reply', 'tool-call', 'proactive', 'self-intro', 'approval', 'task'].map((k) =>
        React.createElement('option', { key: k, value: k }, k === 'all' ? '全部类型' : timelineKindLabel(k)))),
      React.createElement('select', {
        style: Object.assign({}, INPUT_STYLE, { width: 'auto' }),
        value: actorFilter,
        onChange: (e) => setActorFilter(e.target.value),
      }, [
        { value: 'all', label: '全部主体' },
        { value: 'secretary', label: '秘书动作' },
        { value: 'worker', label: '干活动作' },
      ].map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label))),
      React.createElement('input', {
        style: Object.assign({}, INPUT_STYLE, { width: '160px' }),
        placeholder: '按房间过滤…',
        value: roomFilter,
        onChange: (e) => setRoomFilter(e.target.value),
      }),
      React.createElement('button', {
        style: { ...SMALL_BTN, background: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-bg-base)' },
        onClick: clearAll,
      }, '清空全部')),
    snapshot === undefined
      ? React.createElement('p', { style: HINT_STYLE }, '时间线加载中…')
      : visible.length === 0
        ? React.createElement('p', { style: HINT_STYLE }, '暂无时间线记录。分身回复/调用工具后会出现在这里。')
        : React.createElement('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px' } },
            visible.map((e) => {
              const when = e.ts ? new Date(e.ts).toLocaleString('zh-CN', { hour12: false }) : ''
              const meta = e.tool !== undefined ? '工具: ' + e.tool
                : e.target !== undefined ? '目标: ' + e.target
                : e.charCount !== undefined ? '长度: ' + e.charCount + ' 字'
                : ''
              const actorLabel = e.actor === 'secretary' ? '秘书' : '干活'
              return React.createElement('div', {
                key: e.id,
                style: {
                  display: 'flex', alignItems: 'flex-start', gap: '8px',
                  padding: '8px', borderBottom: '1px solid var(--dsw-alias-border-l1)',
                },
              },
                React.createElement('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', marginTop: '1px' } },
                  timelineKindLabel(e.kind) + '·' + actorLabel),
                React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                  React.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-primary)' } },
                    '房间 ' + (e.roomId !== undefined && e.roomId.length > 20 ? e.roomId.slice(0, 20) + '…' : (e.roomId ?? '')) +
                    (meta !== '' ? ' · ' + meta : '')),
                  React.createElement('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginTop: '2px' } }, when)),
                React.createElement('button', {
                  style: { ...SMALL_BTN, background: 'transparent', border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)' },
                  onClick: () => removeEntry(e.id),
                }, '删除'))
            })))
}

/** 通用小按钮样式。 */
const SMALL_BTN = {
  padding: '2px 10px', borderRadius: '6px', border: 'none',
  cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap', marginTop: '1px',
}

/** 思考强度选项（与 codebuddy adapter 的 reasoningEffort 值域一致；'' = 不干预）。 */
const REASONING_OPTIONS = [
  { value: '', label: '（不干预，跟随默认）' },
  { value: 'off', label: 'off — 关闭思考（最快）' },
  { value: 'low', label: 'low — 轻量思考' },
  { value: 'high', label: 'high — 标准思考' },
  { value: 'max', label: 'max — 深度思考' },
]
/** 思考强度提示（两个字段共用）。 */
const REASONING_HINT = '改动只对之后新创建的会话生效；已存在的旧会话会沿用建立时的强度，如需切换请删除对应会话重建。'
const REASONING_LABELS = {
  worker: '数字人思考强度（workerReasoningEffort）',
  secretary: '秘书思考强度（secretaryReasoningEffort）',
}

/** 前台接待内置 5 类分类的默认定义（与 config.ts defaultReceptionKinds 对齐）。 */
function defaultReceptionKinds() {
  return {
    'new-task': { label: '新任务', describe: '同事明确要求数字员工动手执行的任务：整理/汇总/编写/分析/排期/读取文件等，通常有可交付成果，特征是命令式或请求式、指向未来的产出。', ack: true, ackText: '', busy: true, forward: true },
    'busy-question': { label: '忙时追问', describe: 'worker 正在处理任务（房间忙）时，同事发来的追问/澄清/问题，期望 worker 处理完当前任务后回答。注意：即便不带问号，只要明显是针对进行中任务的追问就归此类。', ack: true, ackText: '', busy: false, forward: true },
    'busy-plain': { label: '忙时普通消息', describe: 'worker 忙时同事发来的非问题类消息：补充信息/同步/简单说明/转发材料，需要礼貌回应但不打断当前工作。', ack: true, ackText: '', busy: false, forward: true },
    'closing-ack': { label: '收尾确认', describe: '同事对已交付结果的验收/确认/致谢/收尾（如「收到，清单没问题，辛苦了」「行，先这样，不打扰了」）。表示话题已闭合，不是新任务、不需要 worker 再动手。', ack: false, ackText: '', busy: false, forward: false },
    chat: { label: '闲聊问答', describe: '普通对话/闲聊/答疑，无需动手执行，worker 直接回复即可。接待层不抢答。', ack: false, ackText: '', busy: false, forward: true },
  }
}
/** 前台接待分类表的 key 顺序（UI 固定渲染这些内置类）。 */
const RECEPTION_KIND_KEYS = ['new-task', 'busy-question', 'busy-plain', 'closing-ack', 'chat']
/** reception ackText 占位符说明。 */
const RECEPTION_PLACEHOLDER_HINT = '占位符：{{lp}} 发送者短名 · {{taskHint}} 任务摘要 · {{taskDesc}} 「正在做…」段 · {{eta}} 已耗时/ETA 段；留空 = 用默认话术'

/** 任务看板：读 taskBoard 镜像，展示各房间当前忙/待交付/请示中状态（房间级聚合）。 */
function TaskBoardTab(props) {
  const ctx = props.ctx
  const [scope] = React.useState(() => bindScope(ctx, MATRIX_NS))
  const [board, setBoard] = React.useState(undefined)
  React.useEffect(() => {
    const update = () => {
      const section = sectionOf(scope)
      if (section !== undefined) {
        setBoard(section.taskBoard !== undefined
          ? section.taskBoard
          : { rows: [], updatedAt: 0 })
      }
    }
    update()
    if (scope !== undefined) return scope.subscribe(update)
    return undefined
  }, [scope])

  const rows = board !== undefined ? (board.rows ?? []) : []
  const fmtRoom = (r) => (r.roomName !== undefined && r.roomName !== '' && r.roomName !== r.roomId)
    ? r.roomName
    : (r.roomId !== undefined && r.roomId.length > 28 ? r.roomId.slice(0, 28) + '…' : (r.roomId ?? '?'))
  const fmtElapsed = (since) => {
    if (!since) return ''
    const s = Math.floor((Date.now() - since) / 1000)
    if (s < 15) return '刚开工'
    if (s < 3600) return `已 ${Math.max(1, Math.round(s / 60))} 分钟`
    const h = Math.floor(s / 3600)
    const m = Math.round((s % 3600) / 60)
    return `已 ${h} 小时${m > 0 ? ` ${m} 分` : ''}`
  }
  const stateMeta = (state) => {
    if (state === 'busy') return { icon: '🔴', text: '忙', color: 'var(--dsw-alias-state-error-primary)' }
    if (state === 'awaiting-delivery') return { icon: '🟡', text: '待交付', color: 'var(--dsw-alias-state-warning-primary)' }
    return { icon: '⚪', text: '请示中', color: 'var(--dsw-alias-label-secondary)' }
  }

  return React.createElement('div', null,
    React.createElement('p', { style: HINT_STYLE },
      '各房间当前任务状态（房间级聚合，仅活跃态）。数字人正在处理任务、有待交付结果、或请示中等待拍板时会出现在这里。'),
    board === undefined
      ? React.createElement('p', { style: HINT_STYLE }, '任务看板加载中…')
      : rows.length === 0
        ? React.createElement('p', { style: HINT_STYLE }, '暂无进行中任务。同事派活后，对应房间会出现在这里。')
        : React.createElement('div', null,
            rows.map((r) => {
              const meta = stateMeta(r.state)
              return React.createElement('div', {
                key: r.roomId,
                style: {
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '10px 12px', marginBottom: '6px',
                  border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px',
                  background: 'var(--dsw-alias-bg-layer-1)',
                },
              },
                React.createElement('span', { style: { fontSize: '14px' } }, meta.icon),
                React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                  React.createElement('div', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
                    fmtRoom(r)),
                  React.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginTop: '2px' } },
                    (r.state === 'busy' ? `正在做「${r.label}」` : r.state === 'awaiting-delivery' ? `待交付：「${r.label}」` : `请示中：「${r.label}」`) +
                    (r.since ? ` · ${fmtElapsed(r.since)}` : '') +
                    (r.remindCount ? ` · 已提醒 ${r.remindCount}/2 次` : ''))),
                React.createElement('span', {
                  style: { fontSize: '11px', color: meta.color, whiteSpace: 'nowrap', padding: '2px 8px', borderRadius: '999px', border: '1px solid ' + meta.color },
                }, meta.text))
            })))
}

/** 主人收件箱：读 ownerInbox 镜像，主人点「批准/交付/拒绝」写 ownerDecisionOps 命令。 */
function OwnerInboxTab(props) {
  const ctx = props.ctx
  const [scope] = React.useState(() => bindScope(ctx, MATRIX_NS))
  const [inbox, setInbox] = React.useState(undefined)
  React.useEffect(() => {
    const update = () => {
      const section = sectionOf(scope)
      if (section !== undefined) {
        setInbox(section.ownerInbox !== undefined
          ? section.ownerInbox
          : { items: [], updatedAt: 0 })
      }
    }
    update()
    if (scope !== undefined) return scope.subscribe(update)
    return undefined
  }, [scope])

  const decide = (id, decision) => {
    if (scope === undefined) return
    scope.set('ownerDecisionOps', { seq: Date.now(), id, decision }).catch(() => {})
  }

  const items = inbox !== undefined ? (inbox.items ?? []) : []
  return React.createElement('div', null,
    items.length === 0
      ? React.createElement('p', { style: HINT_STYLE },
          '收件箱为空。分身向你请示/汇报后，待批事项会出现在这里，点「批准/交付」即可放行。')
      : items.map((it) => {
          const kindLabel = it.kind === 'clarify' ? '🤔 请示' : '📤 汇报'
          const when = it.createdAt ? new Date(it.createdAt).toLocaleString('zh-CN', { hour12: false }) : ''
          return React.createElement('div', {
            key: it.id,
            style: {
              padding: '12px', marginBottom: '10px',
              border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px',
              background: 'var(--dsw-alias-bg-layer-1)',
            },
          },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
              React.createElement('span', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, kindLabel),
              React.createElement('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, when)),
            React.createElement('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: '10px' } },
              (it.text ?? '').length > 300 ? it.text.slice(0, 300) + '…' : (it.text ?? '')),
            React.createElement('div', { style: { display: 'flex', gap: '8px' } },
              React.createElement('button', {
                style: { ...SMALL_BTN, background: 'var(--dsw-alias-state-success-primary)', color: 'var(--dsw-alias-bg-base)', padding: '6px 14px', fontSize: '13px' },
                onClick: () => decide(it.id, 'approve'),
              }, it.kind === 'clarify' ? '✅ 批准开工' : '✅ 交付'),
              React.createElement('button', {
                style: { ...SMALL_BTN, background: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-bg-base)', padding: '6px 14px', fontSize: '13px' },
                onClick: () => decide(it.id, 'reject'),
              }, '🚫 拒绝')))
        }))
}

/** 分身工作台入口按钮：带待批角标（收件箱待批数 + 任务看板活跃数）。 */
function TwinDeskButton(props) {
  const ctx = props.ctx
  const wide = props.wide !== false
  const [scope] = React.useState(() => bindScope(ctx, MATRIX_NS))
  const [inbox, setInbox] = React.useState(undefined)
  const [board, setBoard] = React.useState(undefined)
  React.useEffect(() => {
    const update = () => {
      const section = sectionOf(scope)
      if (section !== undefined) {
        setInbox(section.ownerInbox !== undefined ? section.ownerInbox : { items: [], updatedAt: 0 })
        setBoard(section.taskBoard !== undefined ? section.taskBoard : { rows: [], updatedAt: 0 })
      }
    }
    update()
    if (scope !== undefined) return scope.subscribe(update)
    return undefined
  }, [scope])
  const [open, setOpen] = React.useState(false)
  const attention = inbox !== undefined ? (inbox.items ?? []).length : 0
  const active = board !== undefined ? (board.rows ?? []).length : 0
  const badge = attention > 0 ? attention : active
  return React.createElement(React.Fragment, null,
    React.createElement('button', {
      onClick: () => setOpen((v) => !v),
      title: '分身工作台：任务看板 / 主人收件箱 / 自我时间线',
      'aria-label': '分身工作台' + (attention > 0 ? '（' + attention + ' 待批）' : ''),
      style: {
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: wide ? '6px 12px' : '6px',
        borderRadius: '6px', cursor: 'pointer', fontSize: '13px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
        position: 'relative',
      },
    },
      React.createElement('span', { 'aria-hidden': true, style: { fontSize: '15px' } }, '📊'),
      wide ? React.createElement('span', null, '分身工作台') : null,
      badge > 0
        ? React.createElement('span', {
            style: {
              position: 'absolute', top: '-4px', right: '-4px',
              minWidth: '16px', height: '16px', borderRadius: '999px',
              background: attention > 0 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
              color: 'var(--dsw-alias-bg-base)',
              fontSize: '10px', lineHeight: '16px', textAlign: 'center', padding: '0 4px',
            },
          }, String(badge))
        : null),
    open ? React.createElement(TwinDeskPanel, { ctx, onClose: () => setOpen(false) }) : null)
}

/** 分身工作台大尺寸面板：任务看板 / 收件箱 / 时间线 三 tab。 */
function TwinDeskPanel(props) {
  const { ctx, onClose } = props
  const [tab, setTab] = React.useState('tasks')
  const tabs = [
    { id: 'tasks', label: '📋 任务' },
    { id: 'inbox', label: '✅ 待批' },
    { id: 'timeline', label: '🕘 时间线' },
  ]

  return React.createElement(React.Fragment, null,
    React.createElement('div', {
      onClick: onClose,
      style: { position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(0,0,0,0.35)' },
    }),
    React.createElement('div', {
      style: {
        position: 'fixed', top: 0, bottom: 0, right: 0,
        width: 'min(760px, 58vw)', minWidth: '560px', maxWidth: '100vw', zIndex: 1000,
        background: 'var(--dsw-alias-bg-layer-1)',
        borderLeft: '1px solid var(--dsw-alias-border-l2)',
        boxShadow: '-8px 0 32px rgba(0,0,0,0.25)',
        display: 'flex', flexDirection: 'column',
      },
    },
      React.createElement('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '16px',
          padding: '12px 20px', borderBottom: '1px solid var(--dsw-alias-border-l1)',
        },
      },
        React.createElement('h3', { style: { margin: 0, fontSize: '16px', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap' } },
          '分身工作台'),
        React.createElement('div', { style: { display: 'flex', gap: '2px' } },
          tabs.map((t) =>
            React.createElement('button', {
              key: t.id,
              onClick: () => setTab(t.id),
              style: {
                padding: '6px 14px', border: 'none', cursor: 'pointer', fontSize: '13px',
                borderRadius: '6px',
                background: tab === t.id ? 'var(--dsw-alias-brand-primary)' : 'transparent',
                color: tab === t.id ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
                fontWeight: tab === t.id ? 600 : 400,
              },
            }, t.label))),
        React.createElement('div', { style: { flex: 1 } }),
        React.createElement('button', {
          onClick: onClose,
          style: { ...SMALL_BTN, background: 'transparent', border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-primary)', padding: '4px 12px' },
        }, '✕ 关闭')),
      // 引导条：说明工作台职责 + 完整对话在会话列表。
      React.createElement('div', {
        style: {
          padding: '10px 20px', borderBottom: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-interactive-bg-hover)',
          color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px',
        },
      },
        React.createElement('div', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600, marginBottom: '2px' } },
          '👁 主人监控窗口：分身们正在干什么 / 有什么等你拍板'),
        '任务 = 各房间正在处理的事（忙/待交付/请示中）；待批 = 分身向你请示/汇报的事项，点「批准/交付/拒绝」放行；时间线 = 分身自己的行动记录。完整对话流请到会话列表打开对应房间 / 秘书会话。'),
      tab === 'tasks'
        ? React.createElement('div', { style: { flex: 1, overflowY: 'auto', padding: '16px 20px' } },
            React.createElement(TaskBoardTab, { ctx }))
        : tab === 'inbox'
          ? React.createElement('div', { style: { flex: 1, overflowY: 'auto', padding: '16px 20px' } },
              React.createElement(OwnerInboxTab, { ctx }))
          : React.createElement('div', { style: { flex: 1, overflowY: 'auto', padding: '16px 20px' } },
              React.createElement(TimelineTab, { ctx })))
  )
}

/** 插件入口：注册设置页 + 分身工作台（全局 + 会话头部两入口）。 */
export function apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'dsh-matrix', order: 30, label: () => '数字分身' },
    (props) => React.createElement(MatrixSettingsPage, Object.assign({ ctx }, props)),
  ))
  // 分身工作台：侧栏底部全局入口（设置按钮旁），任何页面都能打开（任务看板/收件箱/时间线）。
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'twin-desk', order: 20, label: () => '分身工作台' },
    (props) => React.createElement(TwinDeskButton, Object.assign({ ctx, wide: true }, props)),
  ))
  // 分身工作台：会话头部快捷入口（右上角工具位），打开同一面板（保留旧入口习惯）。
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    { name: 'conversation.session.header.utilities', id: 'secretary-desk', order: 30, label: () => '分身工作台' },
    (props) => React.createElement(TwinDeskButton, Object.assign({ ctx, wide: true }, props)),
  ))
}
