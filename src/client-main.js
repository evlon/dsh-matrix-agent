/**
 * dsh-matrix-agent 的浏览器端（Client 半）源码 —— 由 esbuild 打包为
 * `window.__ModuleLoader__.load({ id, factory })` 自包含 bundle（见
 * scripts/build-client.mjs）。运行期依赖（react）外部化，由 dsh 模块系统
 * 以 factory(require) 注入，避免与 shell 的 React 实例冲突。
 *
 * 单入口：设置侧栏只注册一个「数字分身」入口（settings.section 'dsh-matrix'），
 * 内部用标签页分三个面板：
 * - Matrix 账号：连接信息 / 模型路由 / 白名单等
 * - 社交：自我介绍 / 成员记忆 / 主动打招呼
 * - 时间线：自我记忆查看/筛选/删除/清空
 *
 * 岗位人设与秘书工作流由岗位 preset（agent.cordis.yml 的 persona 行）承载，
 * 不再在此注入（灵魂子系统已彻底移除）。
 *
 * 会话视图：在「对话/轨迹/树状视图」后新增「任务」tab；会话头部新增
 * 「所有任务」入口 + 全局面板。
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
    React.createElement('p', { style: HINT_STYLE },
      'Matrix 账号与桥接配置。连接类字段（服务器地址 / Access Token / 账号 ID）保存后需重启 dsh 才生效；其余字段即时生效。'),
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
    React.createElement(NumberField, { label: '单条消息字符上限', value: form.chunkMaxChars, onChange: set('chunkMaxChars'), min: 100, max: 20000, step: 100 }),
    React.createElement(SwitchField, { label: '主动消息需审批（proactiveSendRequiresApproval）', value: form.proactiveSendRequiresApproval, onChange: set('proactiveSendRequiresApproval') }),
    React.createElement(SwitchField, { label: '保留富文本/回复/编辑语义（preserveRichText）', value: form.preserveRichText, onChange: set('preserveRichText') }),
    React.createElement(SaveBar, { onSave: save, saved, hint: '连接类字段重启后生效', onReset: () => reset('account') }))
}

/** 社交标签页。 */
function SocialTab(props) {
  const { form, set, save, saved, reset } = props
  return React.createElement('div', null,
    React.createElement('p', { style: HINT_STYLE },
      '分身与同事/其他数字人的社交行为：入群自我介绍、成员记忆、主动打招呼。'),
    React.createElement(SwitchField, { label: '入群主动自我介绍（autoIntroduce）', value: form.autoIntroduce, onChange: set('autoIntroduce') }),
    React.createElement(NumberField, { label: '自我介绍 @ 人数上限', value: form.maxSelfIntroMentions, onChange: set('maxSelfIntroMentions'), min: 0, max: 200, step: 1 }),
    React.createElement(TextField, { label: '自我介绍模板', value: form.selfIntroTemplate, onChange: set('selfIntroTemplate'), textarea: true, hint: '占位符：{{userId}} / {{role}} / {{owner}}' }),
    React.createElement(SwitchField, { label: '记住成员（memberMemory）', value: form.memberMemory, onChange: set('memberMemory'), hint: '记住每个房间里见过的成员（含其他数字人），/memory 查看' }),
    React.createElement(SwitchField, { label: '新成员入群主动打招呼（autoGreet）', value: form.autoGreet, onChange: set('autoGreet'), hint: '新成员（含其他数字人）入群时提示分身主动了解对方' }),
    React.createElement(TextField, { label: '测试房间前缀（testRoomPrefix）', value: form.testRoomPrefix, onChange: set('testRoomPrefix'), hint: '房间名含此前缀视为测试环境：分身每次回复都会被提示「请勿真实执行任务/修改文件/发真实消息」。留空关闭' }),
    React.createElement(SwitchField, { label: '群聊默认启用秘书编排（secretaryGroupDefault）', value: form.secretaryGroupDefault, onChange: set('secretaryGroupDefault'), hint: 'Matrix 群聊消息默认进任务队列待 owner 审核/请示/确认；@ 提及自己的即时交流仍直接回复。关闭后仅 digitalTwinMode 或前缀匹配的房间启用' }),
    React.createElement(SwitchField, { label: '私聊也启用秘书编排（secretaryDmDefault）', value: form.secretaryDmDefault, onChange: set('secretaryDmDefault'), hint: '默认关闭（私聊直接对话）；开启后数字分身的私聊消息也进任务队列待 owner 审核' }),
    React.createElement(SaveBar, { onSave: save, saved, onReset: () => reset('social') }))
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
    account: ['homeserverUrl', 'userId', 'accessToken', 'instanceKey', 'owner', 'respondToAll', 'allowAllUsers', 'allowedUserIds', 'provider', 'model', 'agentPreset', 'chunkMaxChars', 'proactiveSendRequiresApproval', 'preserveRichText'],
    social: ['autoIntroduce', 'maxSelfIntroMentions', 'memberMemory', 'autoGreet', 'selfIntroTemplate', 'testRoomPrefix', 'secretaryGroupDefault', 'secretaryDmDefault'],
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
    { id: 'account', label: 'Matrix 账号' },
    { id: 'social', label: '社交' },
    { id: 'timeline', label: '时间线' },
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
      active === 'account' ? React.createElement(AccountTab, tabProps)
        : active === 'social' ? React.createElement(SocialTab, tabProps)
        : React.createElement(TimelineTab, { ctx })))
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

/** 秘书工作台入口：侧栏/头部快捷入口，带待批角标（收件箱待批数）。 */
function SecretaryDeskButton(props) {
  const ctx = props.ctx
  const wide = props.wide !== false
  const [scope] = React.useState(() => bindScope(ctx, MATRIX_NS))
  const [inbox, setInbox] = React.useState(undefined)
  React.useEffect(() => {
    const update = () => {
      const section = sectionOf(scope)
      if (section !== undefined) {
        setInbox(section.ownerInbox !== undefined ? section.ownerInbox : { items: [], updatedAt: 0 })
      }
    }
    update()
    if (scope !== undefined) return scope.subscribe(update)
    return undefined
  }, [scope])
  const [open, setOpen] = React.useState(false)
  const attention = inbox !== undefined ? (inbox.items ?? []).length : 0
  return React.createElement(React.Fragment, null,
    React.createElement('button', {
      onClick: () => setOpen((v) => !v),
      title: '秘书工作台：主人收件箱 + 自我记忆',
      'aria-label': '秘书工作台' + (attention > 0 ? '（' + attention + ' 待批）' : ''),
      style: {
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: wide ? '6px 12px' : '6px',
        borderRadius: '6px', cursor: 'pointer', fontSize: '13px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
        position: 'relative',
      },
    },
      React.createElement('span', { 'aria-hidden': true, style: { fontSize: '15px' } }, '📋'),
      wide ? React.createElement('span', null, '秘书工作台') : null,
      attention > 0
        ? React.createElement('span', {
            style: {
              position: 'absolute', top: '-4px', right: '-4px',
              minWidth: '16px', height: '16px', borderRadius: '999px',
              background: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-bg-base)',
              fontSize: '10px', lineHeight: '16px', textAlign: 'center', padding: '0 4px',
            },
          }, String(attention))
        : null),
    open ? React.createElement(SecretaryDeskPanel, { ctx, onClose: () => setOpen(false) }) : null)
}

/** 秘书工作台大尺寸面板：含「收件箱」「时间线」两个 tab（彻底分层后无任务队列）。 */
function SecretaryDeskPanel(props) {
  const { ctx, onClose } = props
  const [tab, setTab] = React.useState('inbox')
  const tabs = [
    { id: 'inbox', label: '收件箱' },
    { id: 'timeline', label: '时间线' },
  ]

  return React.createElement(React.Fragment, null,
    React.createElement('div', {
      onClick: onClose,
      style: { position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(0,0,0,0.35)' },
    }),
    React.createElement('div', {
      style: {
        position: 'fixed', top: 0, bottom: 0, right: 0,
        width: 'min(720px, 56vw)', minWidth: '560px', maxWidth: '100vw', zIndex: 1000,
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
          '秘书工作台'),
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
      tab === 'timeline'
        ? React.createElement('div', { style: { flex: 1, overflowY: 'auto', padding: '16px 20px' } },
            React.createElement(TimelineTab, { ctx }))
        : React.createElement('div', { style: { flex: 1, overflowY: 'auto', padding: '16px 20px' } },
            React.createElement(OwnerInboxTab, { ctx })))
  )
}

/** 插件入口：注册设置页 + 秘书工作台。 */
export function apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'dsh-matrix', order: 30, label: () => '数字分身' },
    (props) => React.createElement(MatrixSettingsPage, Object.assign({ ctx }, props)),
  ))
  // 秘书工作台：会话头部快捷入口（右上角工具位），打开面板（收件箱/时间线）。
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    { name: 'conversation.session.header.utilities', id: 'secretary-desk', order: 30, label: () => '秘书工作台' },
    (props) => React.createElement(SecretaryDeskButton, Object.assign({ ctx, wide: true }, props)),
  ))
}
