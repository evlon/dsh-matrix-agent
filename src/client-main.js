/**
 * dsh-matrix-agent 的浏览器端（Client 半）源码 —— 由 esbuild 打包为
 * `window.__ModuleLoader__.load({ id, factory })` 自包含 bundle（见
 * scripts/build-client.mjs）。运行期依赖（react）外部化，由 dsh 模块系统
 * 以 factory(require) 注入，避免与 shell 的 React 实例冲突。
 *
 * 单入口：设置侧栏只注册一个「数字分身」入口（settings.section 'dsh-matrix'），
 * 内部用标签页分三个面板：
 * - 灵魂：预设/性格/风格/口头禅/习惯 + 行为模式
 * - Matrix 账号：连接信息 / 模型路由 / 白名单等
 * - 社交：自我介绍 / 成员记忆 / 主动打招呼
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
 * 与 src/soul.ts 的 deriveDefaultOwner 保持一致。
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

/** 内置灵魂预设。 */
const SOUL_PRESETS = [
  {
    id: 'dynamic', label: '百变员工（默认·自动适配）',
    persona: '你是「百变员工」：会根据所在房间的名称、讨论氛围与收到的消息，自动选择最合适的人设与语气（比如在技术群里像靠谱的研发、在需求讨论里像产品经理、面对新同事像乐于帮助的前辈）。你不需要固定一种性格。',
    style: '', catchphrase: '',
    habits: '先理解当前对话的语境与对象，再选择合适的人设与语气；如果切换了人设，主动用一句话告知对方你现在以什么角色出现，并提示可以在「数字分身」设置页修改灵魂。', replyLength: 'normal',
  },
  {
    id: 'default', label: '默认（综合助手）',
    persona: '你叫小灵，是团队里靠谱又有人情味的数字同事。',
    style: 'friendly', catchphrase: '交给我吧',
    habits: '先确认需求再动手，做完主动同步结论。', replyLength: 'short',
  },
  {
    id: 'pm', label: '产品经理',
    persona: '你是团队的产品经理分身。你关注用户价值与目标拆解，习惯先澄清需求背景再推进。',
    style: 'formal', catchphrase: '我们先对齐一下目标',
    habits: '先对齐需求目标与验收标准，再安排执行；产出结论时给出下一步行动项。', replyLength: 'normal',
  },
  {
    id: 'dev', label: '研发工程师',
    persona: '你是团队的后端/全栈研发分身。你技术扎实、注重代码质量与可维护性，沟通直接。',
    style: 'concise', catchphrase: '这个我来搞定',
    habits: '先看代码与文档再动手；遇到问题先说根因再给方案；完成后附关键变更说明。', replyLength: 'short',
  },
  {
    id: 'qa', label: '测试工程师',
    persona: '你是团队的测试工程师分身。你细心严谨、关注边界与回归风险，善于把问题描述清楚。',
    style: 'friendly', catchphrase: '这个我帮你验证一下',
    habits: '先复现再报问题，问题描述带复现步骤/预期/实际；关注回归影响面。', replyLength: 'normal',
  },
  {
    id: 'leader', label: '领导（负责人）',
    persona: '你是团队的负责人分身。你看全局、抓重点，沟通有分寸，善于协调资源与推动决策。',
    style: 'formal', catchphrase: '这件事我来协调',
    habits: '先听结论再问细节；给出方向与优先级；重要事项主动同步进度。', replyLength: 'normal',
  },
  {
    id: 'newbie', label: '新入职员工',
    persona: '你是刚入职的团队成员。你谦虚好学、乐于请教，正在持续学习团队的业务与流程。',
    style: 'friendly', catchphrase: '这个我还在学习中，麻烦多指教',
    habits: '不懂就问、先查资料再提问；做事主动同步进度；每次任务后总结学到的东西并完善自己的认知。', replyLength: 'normal',
  },
]

/** 根据当前 form 的灵魂字段，反推匹配的预设 id（完全一致才匹配；否则自定义）。 */
function presetIdForForm(form) {
  const soulKeys = ['persona', 'style', 'catchphrase', 'habits', 'replyLength']
  for (const preset of SOUL_PRESETS) {
    let match = true
    for (const k of soulKeys) {
      if ((form[k] ?? '') !== (preset[k] ?? '')) { match = false; break }
    }
    if (match) return preset.id
  }
  return 'custom'
}

/** 灵魂标签页。 */
function SoulTab(props) {
  const { scope, form, set, save, saved, reset } = props
  const currentPreset = presetIdForForm(form)

  const applyPreset = (id) => {
    // "custom" 表示不套用任何预设（保持当前值）。
    if (id === 'custom') return
    const preset = SOUL_PRESETS.find((p) => p.id === id)
    if (preset === undefined) return
    setFormFromPreset(set, preset)
  }

  return React.createElement('div', null,
    React.createElement(SelectField, {
      label: '选择预设（一键填充，可再微调）',
      value: currentPreset,
      onChange: (v) => applyPreset(v),
      options: [
        { value: 'custom', label: '— 自定义 —' },
      ].concat(SOUL_PRESETS.map((p) => ({ value: p.id, label: p.label }))),
    }),
    React.createElement(SwitchField, { label: '启用灵魂', value: form.enabled, onChange: set('enabled') }),
    React.createElement(TextField, { label: '性格 / 人设', value: form.persona, onChange: set('persona'), textarea: true }),
    React.createElement(SelectField, {
      label: '说话风格', value: form.style, onChange: set('style'),
      options: [
        { value: 'concise', label: '简洁干练' },
        { value: 'friendly', label: '亲切友好' },
        { value: 'formal', label: '正式专业' },
        { value: 'humorous', label: '幽默风趣' },
        { value: 'sassy', label: '毒舌犀利' },
      ],
    }),
    React.createElement(SelectField, {
      label: '回复长度', value: form.replyLength, onChange: set('replyLength'),
      options: [
        { value: 'short', label: '简短（一两句）' },
        { value: 'normal', label: '适中（一段）' },
        { value: 'detailed', label: '详细（多段）' },
      ],
    }),
    React.createElement(TextField, { label: '口头禅', value: form.catchphrase, onChange: set('catchphrase') }),
    React.createElement(TextField, { label: '工作习惯', value: form.habits, onChange: set('habits'), textarea: true }),
    React.createElement(SaveBar, { onSave: save, saved, onReset: () => reset('soul') }))
}

function setFormFromPreset(set, preset) {
  set('persona')(preset.persona)
  set('style')(preset.style)
  set('catchphrase')(preset.catchphrase)
  set('habits')(preset.habits)
  set('replyLength')(preset.replyLength)
}

/** 行为模式摘要（灵魂 tab 底部）。 */
function BehaviorSummary(props) {
  const { conn } = props
  const [stats, setStats] = React.useState(undefined)

  React.useEffect(() => {
    if (conn === undefined || conn.api === undefined) return undefined
    let alive = true
    // session.list 响应：{ result: { ok, value: { items } } }。
    conn.api.sessions.list({}).then((res) => {
      if (!alive || res.result?.ok !== true) return
      const sessions = Array.isArray(res.result?.value?.items)
        ? res.result.value.items.filter((s) => typeof s.id === 'string' && s.id.startsWith('matrix-'))
        : []
      setStats({
        rooms: sessions.map((s) => ({ sessionId: s.id, title: s.title ?? '' })),
        count: sessions.length,
      })
    }).catch(() => {})
    return () => { alive = false }
  }, [conn])

  return React.createElement('div', null,
    React.createElement('hr', { style: { margin: '16px 0', borderColor: 'var(--dsw-alias-border-l1)' } }),
    React.createElement('h4', { style: { margin: '0 0 8px', color: 'var(--dsw-alias-label-primary)' } }, '行为模式'),
    stats === undefined
      ? React.createElement('p', { style: HINT_STYLE }, '加载中…')
      : React.createElement('div', null,
          React.createElement('p', { style: { fontSize: '13px', margin: '4px 0', color: 'var(--dsw-alias-label-primary)' } },
            '活跃的 Matrix 会话：' + stats.count + ' 个'),
          stats.rooms.length === 0
            ? React.createElement('p', { style: HINT_STYLE },
                '暂无 Matrix 房间会话（分身还没被拉进任何群，或尚未对话）。')
            : React.createElement('ul', { style: { fontSize: '13px', paddingLeft: '18px', margin: '4px 0', color: 'var(--dsw-alias-label-primary)' } },
                stats.rooms.map((room) =>
                  React.createElement('li', { key: room.sessionId },
                    (room.title !== '' ? room.title : room.sessionId) + '（' + room.sessionId + '）'))),
          React.createElement('p', { style: HINT_STYLE },
            '更详细的回复数 / Top 工具统计可在对话中让分身调用 twin_soul_status 工具查看。')))
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
  // 灵魂（默认百变员工）。
  soul: {
    enabled: true,
    persona: '你是「百变员工」：会根据所在房间的名称、讨论氛围与收到的消息，自动选择最合适的人设与语气（比如在技术群里像靠谱的研发、在需求讨论里像产品经理、面对新同事像乐于帮助的前辈）。你不需要固定一种性格。',
    style: '',
    catchphrase: '',
    habits: '先理解当前对话的语境与对象，再选择合适的人设与语气；如果切换了人设，主动用一句话告知对方你现在以什么角色出现，并提示可以在「数字分身」设置页修改灵魂。',
    replyLength: 'normal',
  },
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

/** 把 settings 的 soul 子对象展开到顶层 form（form.persona/style/... 直接可读写），
 *  其余顶层字段直取；settings 未就绪时用显示默认值。 */
function mergeFormSection(section) {
  const base = Object.assign({}, FORM_DEFAULTS, FORM_DEFAULTS.soul)
  if (section === undefined) return base
  for (const [k, v] of Object.entries(section)) {
    if (v === undefined || v === null) continue
    if (k === 'soul' && typeof v === 'object') {
      // soul 子字段展开到顶层。
      for (const [sk, sv] of Object.entries(v)) {
        if (sv !== undefined && sv !== null) base[sk] = sv
      }
    } else {
      base[k] = v
    }
  }
  return base
}

/** 保存时把顶层 soul 字段收拢回 form.soul，再整体写 settings。 */
function collectFormForSave(form) {
  const soul = {
    enabled: form.enabled,
    persona: form.persona,
    style: form.style,
    catchphrase: form.catchphrase,
    habits: form.habits,
    replyLength: form.replyLength,
  }
  const rest = {}
  for (const [k, v] of Object.entries(form)) {
    if (k === 'soul') continue
    if (['enabled', 'persona', 'style', 'catchphrase', 'habits', 'replyLength'].includes(k)) continue
    rest[k] = v
  }
  return Object.assign({ soul }, rest)
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
    soul: ['soul'], // 灵魂为嵌套对象，重置时 unset 整个 soul。
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
      if (tabId === 'soul') {
        next.enabled = def.enabled
        next.persona = def.persona
        next.style = def.style
        next.catchphrase = def.catchphrase
        next.habits = def.habits
        next.replyLength = def.replyLength
      } else {
        fields.forEach((f) => { next[f] = def[f] })
      }
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

/** 任务状态中文标签与颜色。 */
const TASK_STATUS_META = {
  pending: { label: '⏳ 待审', color: 'var(--dsw-alias-state-warn-primary)' },
  approved: { label: '✅ 已批准', color: 'var(--dsw-alias-brand-primary)' },
  rejected: { label: '🚫 已拒绝', color: 'var(--dsw-alias-state-error-primary)' },
  done: { label: '🏁 已完成', color: 'var(--dsw-alias-state-success-primary)' },
  clarifying: { label: '🤔 请示中', color: 'var(--dsw-alias-state-warn-primary)' },
  confirming: { label: '🔐 待确认', color: 'var(--dsw-alias-state-warn-primary)' },
}
function taskStatusMeta(status) {
  return TASK_STATUS_META[status] ?? { label: status ?? '?', color: 'var(--dsw-alias-label-secondary)' }
}

/** 从 dsh-matrix settings 读任务快照（运行时镜像）。 */
function useTasksSnapshot(ctx) {
  const [scope] = React.useState(() => bindScope(ctx, MATRIX_NS))
  const [snapshot, setSnapshot] = React.useState(undefined)
  React.useEffect(() => {
    const update = () => {
      const section = sectionOf(scope)
      // section 就绪但无快照字段：视为空快照（避免永久"加载中"）。
      if (section !== undefined) {
        setSnapshot(section.tasksSnapshot !== undefined
          ? section.tasksSnapshot
          : { rooms: {}, sessionRooms: {}, updatedAt: 0 })
      }
    }
    update()
    if (scope !== undefined) return scope.subscribe(update)
    return undefined
  }, [scope])
  return snapshot
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

/** 任务列表渲染（供会话 tab 与所有任务面板共用）。 */
const SMALL_BTN = {
  padding: '2px 10px', borderRadius: '6px', border: 'none',
  cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap', marginTop: '1px',
}

function TaskRow(props) {
  const { task, onApprove, onReject, roomLabel } = props
  const meta = taskStatusMeta(task.status)
  const when = task.createdAt ? new Date(task.createdAt).toLocaleString('zh-CN', { hour12: false }) : ''
  return React.createElement('div', {
    style: {
      display: 'flex', alignItems: 'flex-start', gap: '8px',
      padding: '8px', borderBottom: '1px solid var(--dsw-alias-border-l1)',
    },
  },
    React.createElement('span', { style: { color: meta.color, fontSize: '12px', whiteSpace: 'nowrap', marginTop: '1px' } }, meta.label),
    React.createElement('div', { style: { flex: 1, minWidth: 0 } },
      React.createElement('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-word' } },
        task.text.length > 80 ? task.text.slice(0, 80) + '…' : task.text),
      React.createElement('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginTop: '2px' } },
        (roomLabel !== undefined ? roomLabel + ' · ' : '') + task.sender + (when !== '' ? ' · ' + when : '') +
        (task.note !== undefined && task.note !== '' ? ' · ' + task.note : '')),
    ),
    task.status === 'pending' && onApprove !== undefined
      ? React.createElement('button', {
          style: { ...SMALL_BTN, background: 'var(--dsw-alias-state-success-primary)', color: 'var(--dsw-alias-bg-base)' },
          onClick: () => onApprove(task),
        }, '批准')
      : null,
    task.status === 'pending' && onReject !== undefined
      ? React.createElement('button', {
          style: { ...SMALL_BTN, background: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-bg-base)' },
          onClick: () => onReject(task),
        }, '拒绝')
      : null)
}

/** 向会话发 /approve /reject 命令（复用现有命令语义）。 */
function runTaskCommand(ctx, sessionId, line) {
  const session = ctx.get('sessions')?.binding?.(sessionId)?.session
  if (session !== undefined && typeof session.command === 'function') {
    session.command(line).catch(() => {})
    return
  }
  // 兜底：无法直接命令，提示用户在房间操作。
  window.alert('请在 Matrix 房间发送：' + line)
}

/** 会话「任务」tab：显示该会话（房间）的任务列表。 */
function SessionTasksTab(props) {
  const { sessionId } = props
  const ctx = props.ctx
  const snapshot = useTasksSnapshot(ctx)
  // 经 sessionRooms 反查本会话对应的房间。
  const roomId = snapshot !== undefined ? (snapshot.sessionRooms ?? {})[sessionId] : undefined
  const tasks = roomId !== undefined && snapshot !== undefined
    ? (snapshot.rooms ?? {})[roomId] ?? []
    : []
  const [filter, setFilter] = React.useState('all')

  const filtered = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter)
  const counts = {}
  tasks.forEach((t) => { counts[t.status] = (counts[t.status] ?? 0) + 1 })

  return React.createElement('div', null,
    React.createElement('p', { style: HINT_STYLE },
      '本会话（房间）的任务。任务来自 Matrix 房间里同事发来的工作请求，经审批后由分身执行。'),
    React.createElement('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' } },
      ['all', 'pending', 'approved', 'done', 'rejected', 'clarifying', 'confirming'].map((s) =>
        React.createElement('button', {
          key: s,
          onClick: () => setFilter(s),
          style: {
            padding: '3px 10px', borderRadius: '999px', cursor: 'pointer', fontSize: '12px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: filter === s ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-1)',
            color: filter === s ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-primary)',
          },
        }, (s === 'all' ? '全部' : taskStatusMeta(s).label) +
           (s !== 'all' && counts[s] !== undefined ? ' (' + counts[s] + ')' : '')))),
    roomId === undefined
      ? React.createElement('p', { style: HINT_STYLE },
          '本会话不是 Matrix 房间会话，或暂无任务快照。')
      : filtered.length === 0
        ? React.createElement('p', { style: HINT_STYLE }, '本会话暂无任务。')
        : React.createElement('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px' } },
            filtered.map((task) =>
              React.createElement(TaskRow, {
                key: task.id, task,
                onApprove: () => runTaskCommand(ctx, sessionId, '/approve ' + (tasks.indexOf(task) + 1)),
                onReject: () => runTaskCommand(ctx, sessionId, '/reject ' + (tasks.indexOf(task) + 1)),
              }))))
}

/** 所有任务面板：聚合所有会话任务，按状态分组。 */
function AllTasksPanel(props) {
  const { ctx, onClose } = props
  const snapshot = useTasksSnapshot(ctx)
  const [filter, setFilter] = React.useState('all')
  const [selectedSession, setSelectedSession] = React.useState(undefined)

  const allTasks = []
  if (snapshot !== undefined) {
    for (const [roomId, tasks] of Object.entries(snapshot.rooms ?? {})) {
      tasks.forEach((t) => allTasks.push({ task: t, roomId }))
    }
  }
  // 按状态过滤。
  const visible = filter === 'all' ? allTasks : allTasks.filter((x) => x.task.status === filter)
  // 按 createdAt 降序（最新在前）。
  visible.sort((a, b) => (b.task.createdAt ?? 0) - (a.task.createdAt ?? 0))
  const pendingCount = allTasks.filter((x) => x.task.status === 'pending').length

  const openSession = (roomId) => {
    // roomId → sessionId（反查）。
    let sid
    if (snapshot !== undefined) {
      for (const [k, v] of Object.entries(snapshot.sessionRooms ?? {})) {
        if (v === roomId) { sid = k; break }
      }
    }
    if (sid !== undefined && ctx.get('sessions')?.open !== undefined) {
      ctx.get('sessions').open(sid)
    } else if (typeof onClose === 'function') {
      onClose()
    }
  }

  return React.createElement('div', {
    style: {
      position: 'fixed', top: '56px', right: '16px', width: '480px', maxWidth: '90vw',
      maxHeight: '80vh', overflowY: 'auto', zIndex: 1000,
      background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '10px', boxShadow: '0 8px 30px rgba(0,0,0,0.3)', padding: '14px',
    },
  },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
      React.createElement('h3', { style: { margin: 0, fontSize: '14px', color: 'var(--dsw-alias-label-primary)' } },
        '所有任务' + (pendingCount > 0 ? '（待审 ' + pendingCount + '）' : '')),
      React.createElement('button', {
        onClick: onClose,
        style: { ...SMALL_BTN, background: 'transparent', border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-primary)' },
      }, '✕')),
    React.createElement('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' } },
      ['all', 'pending', 'approved', 'done', 'rejected', 'clarifying', 'confirming'].map((s) =>
        React.createElement('button', {
          key: s,
          onClick: () => setFilter(s),
          style: {
            padding: '3px 10px', borderRadius: '999px', cursor: 'pointer', fontSize: '12px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: filter === s ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-1)',
            color: filter === s ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-primary)',
          },
        }, s === 'all' ? '全部' : taskStatusMeta(s).label))),
    snapshot === undefined
      ? React.createElement('p', { style: HINT_STYLE }, '任务数据加载中…')
      : visible.length === 0
        ? React.createElement('p', { style: HINT_STYLE }, '暂无任务。')
        : React.createElement('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px' } },
            visible.map(({ task, roomId }) =>
              React.createElement(TaskRow, {
                key: task.id, task,
                roomLabel: '房间 ' + (roomId.length > 12 ? roomId.slice(0, 12) + '…' : roomId),
                onApprove: () => {
                  // 定位会话并执行 /approve（序号 = 该房间 pending 列表中的位置）。
                  let sid
                  if (snapshot !== undefined) {
                    for (const [k, v] of Object.entries(snapshot.sessionRooms ?? {})) {
                      if (v === roomId) { sid = k; break }
                    }
                  }
                  const roomTasks = snapshot !== undefined ? (snapshot.rooms ?? {})[roomId] ?? [] : []
                  const pending = roomTasks.filter((t) => t.status === 'pending')
                  const idx = pending.indexOf(task)
                  if (sid !== undefined && idx >= 0) runTaskCommand(ctx, sid, '/approve ' + (idx + 1))
                },
                onReject: () => {
                  let sid
                  if (snapshot !== undefined) {
                    for (const [k, v] of Object.entries(snapshot.sessionRooms ?? {})) {
                      if (v === roomId) { sid = k; break }
                    }
                  }
                  const roomTasks = snapshot !== undefined ? (snapshot.rooms ?? {})[roomId] ?? [] : []
                  const pending = roomTasks.filter((t) => t.status === 'pending')
                  const idx = pending.indexOf(task)
                  if (sid !== undefined && idx >= 0) runTaskCommand(ctx, sid, '/reject ' + (idx + 1))
                },
              }))))
}

/** 「所有任务」入口按钮（会话头部 actions）。 */
function AllTasksButton(props) {
  const ctx = props.ctx
  const snapshot = useTasksSnapshot(ctx)
  const [open, setOpen] = React.useState(false)
  const pendingCount = snapshot !== undefined
    ? Object.values(snapshot.rooms ?? {}).flat().filter((t) => t.status === 'pending').length
    : 0
  return React.createElement(React.Fragment, null,
    React.createElement('button', {
      onClick: () => setOpen((v) => !v),
      style: {
        padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
        position: 'relative',
      },
    },
      '所有任务' + (pendingCount > 0 ? ' · ' + pendingCount : '')),
    open ? React.createElement(AllTasksPanel, { ctx, onClose: () => setOpen(false) }) : null)
}

/** 秘书工作台：侧栏脚部入口（设置旁），带待办角标（请示中+待确认任务数）。 */
/** 秘书工作台入口：侧栏脚部（设置右侧），样式对齐设置（图标 + 文字，窄态仅图标 + 待办角标）。 */
function SecretaryDeskButton(props) {
  const ctx = props.ctx
  const wide = props.wide !== false
  const snapshot = useTasksSnapshot(ctx)
  const [open, setOpen] = React.useState(false)
  const attention = snapshot !== undefined
    ? Object.values(snapshot.rooms ?? {}).flat().filter((t) => t.status === 'clarifying' || t.status === 'confirming').length
    : 0
  return React.createElement(React.Fragment, null,
    React.createElement('button', {
      onClick: () => setOpen((v) => !v),
      title: '秘书工作台：任务流转 + 自我记忆',
      'aria-label': '秘书工作台' + (attention > 0 ? '（' + attention + ' 待处理）' : ''),
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

/** 秘书工作台分屏大面板：左侧延伸列（贴 sidebar），含「任务」「时间线」双 tab。 */
/** 秘书工作台大尺寸面板：占可视区 ~68% 宽、全高、两栏（左任务列表 + 右详情/操作），含「任务」「时间线」双 tab。 */
function SecretaryDeskPanel(props) {
  const { ctx, onClose } = props
  const [scope] = React.useState(() => bindScope(ctx, MATRIX_NS))
  const [snapshot, setSnapshot] = React.useState(undefined)
  React.useEffect(() => {
    const update = () => {
      const section = sectionOf(scope)
      if (section !== undefined && section.tasksSnapshot !== undefined) setSnapshot(section.tasksSnapshot)
    }
    update()
    if (scope !== undefined) return scope.subscribe(update)
    return undefined
  }, [scope])
  const [tab, setTab] = React.useState('tasks')
  const [group, setGroup] = React.useState('all')
  const [selectedId, setSelectedId] = React.useState(undefined)
  // 左栏宽度占比（%），可拖拽分隔条调整（28–72）。
  const [leftPct, setLeftPct] = React.useState(44)
  const dragRef = React.useRef({ dragging: false })

  const startDrag = (e) => {
    e.preventDefault()
    const container = e.currentTarget.parentElement
    if (container === null) return
    dragRef.current.dragging = true
    const move = (ev) => {
      if (!dragRef.current.dragging) return
      const rect = container.getBoundingClientRect()
      const pct = ((ev.clientX - rect.left) / rect.width) * 100
      setLeftPct(Math.max(28, Math.min(72, Math.round(pct))))
    }
    const up = () => {
      dragRef.current.dragging = false
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const allTasks = []
  if (snapshot !== undefined) {
    for (const [roomId, tasks] of Object.entries(snapshot.rooms ?? {})) {
      tasks.forEach((t) => allTasks.push({ task: t, roomId }))
    }
  }
  const visible = group === 'all' ? allTasks : allTasks.filter((x) => x.task.status === group)
  visible.sort((a, b) => (b.task.createdAt ?? 0) - (a.task.createdAt ?? 0))
  const count = (s) => allTasks.filter((x) => x.task.status === s).length
  const attention = count('clarifying') + count('confirming')
  const selected = allTasks.find((x) => x.task.id === selectedId)

  const sendOps = (taskId, action, extra) => {
    if (scope === undefined) return
    scope.set('secretaryOps', { taskId, action, ...(extra !== undefined ? extra : {}) }).catch(() => {})
  }
  const askText = (taskId, action, prompt) => {
    const v = window.prompt(prompt)
    if (v !== null && v.trim() !== '') sendOps(taskId, action, { text: v.trim() })
  }
  const askCwd = (taskId) => {
    const v = window.prompt('输入该任务的工作目录（绝对路径）：')
    if (v !== null && v.trim() !== '') sendOps(taskId, 'set-cwd', { cwd: v.trim() })
  }

  const groups = [
    { id: 'all', label: '全部' },
    { id: 'pending', label: '待审 (' + count('pending') + ')' },
    { id: 'clarifying', label: '🤔 请示中 (' + count('clarifying') + ')' },
    { id: 'approved', label: '执行中 (' + count('approved') + ')' },
    { id: 'confirming', label: '🔐 待确认 (' + count('confirming') + ')' },
    { id: 'done', label: '完成 (' + count('done') + ')' },
    { id: 'rejected', label: '已拒绝 (' + count('rejected') + ')' },
  ]
  const tabs = [
    { id: 'tasks', label: '任务' },
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
        width: 'min(960px, 68vw)', minWidth: '720px', maxWidth: '100vw', zIndex: 1000,
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
          '秘书工作台' + (attention > 0 ? '（待你处理 ' + attention + '）' : '')),
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
        : React.createElement('div', { style: { flex: 1, display: 'flex', minHeight: 0 } },
            React.createElement('div', { style: { width: leftPct + '%', borderRight: '1px solid var(--dsw-alias-border-l1)', display: 'flex', flexDirection: 'column', minHeight: 0 } },
              React.createElement('div', { style: { padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                groups.map((g) =>
                  React.createElement('button', {
                    key: g.id,
                    onClick: () => setGroup(g.id),
                    style: {
                      padding: '3px 10px', borderRadius: '999px', cursor: 'pointer', fontSize: '12px',
                      border: '1px solid var(--dsw-alias-border-l1)',
                      background: group === g.id ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-1)',
                      color: group === g.id ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-primary)',
                    },
                  }, g.label))),
              React.createElement('div', { style: { flex: 1, overflowY: 'auto' } },
                snapshot === undefined
                  ? React.createElement('p', { style: HINT_STYLE, padding: '12px 16px' }, '任务数据加载中…')
                  : visible.length === 0
                    ? React.createElement('p', { style: HINT_STYLE, padding: '12px 16px' }, '暂无任务。')
                    : visible.map(({ task, roomId }) => {
                        const meta = taskStatusMeta(task.status)
                        const roomLabel = roomId.length > 16 ? roomId.slice(0, 16) + '…' : roomId
                        const roleLabel = task.role !== undefined && task.role !== '' ? task.role : 'dynamic'
                        const noCwd = task.cwd === undefined && (task.status === 'pending' || task.status === 'clarifying')
                        const isSel = task.id === selectedId
                        return React.createElement('div', {
                          key: task.id,
                          onClick: () => setSelectedId(task.id),
                          style: {
                            display: 'flex', alignItems: 'flex-start', gap: '8px',
                            padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)',
                            cursor: 'pointer',
                            background: isSel ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                          },
                        },
                          React.createElement('span', { style: { color: meta.color, fontSize: '12px', whiteSpace: 'nowrap', marginTop: '1px' } }, meta.label),
                          React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                            React.createElement('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-word' } },
                              task.text.length > 50 ? task.text.slice(0, 50) + '…' : task.text),
                            React.createElement('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginTop: '2px' } },
                              '角色:' + roleLabel + ' · ' + roomLabel + ' · ' + task.sender +
                              (noCwd ? ' · ⚠️ 未设目录' : '') +
                              (task.note !== undefined && task.note !== '' ? ' · ' + task.note.slice(0, 30) : ''))))
                      })),
            ),
            // 可拖拽分隔条：调整左右栏宽度比例。
            React.createElement('div', {
              onMouseDown: startDrag,
              style: {
                width: '6px', cursor: 'col-resize', flexShrink: 0,
                background: 'transparent', position: 'relative',
              },
            },
              React.createElement('div', {
                style: {
                  position: 'absolute', top: 0, bottom: 0, left: '2px', width: '2px',
                  background: 'var(--dsw-alias-border-l1)', pointerEvents: 'none',
                },
              })),
            React.createElement('div', { style: { flex: 1, overflowY: 'auto', padding: '16px 20px' } },
              selected === undefined
                ? React.createElement('div', null,
                    React.createElement('p', { style: HINT_STYLE }, '选择左侧任务查看详情并处理。'),
                    React.createElement('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '16px' } },
                      groups.filter((g) => g.id !== 'all').map((g) =>
                        React.createElement('div', {
                          key: g.id,
                          style: {
                            padding: '12px 16px', borderRadius: '8px',
                            border: '1px solid var(--dsw-alias-border-l1)',
                            background: 'var(--dsw-alias-bg-layer-1)',
                            fontSize: '13px', color: 'var(--dsw-alias-label-primary)',
                          },
                        }, g.label))))
                : React.createElement('div', null,
                    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
                      React.createElement('span', { style: { color: taskStatusMeta(selected.task.status).color, fontSize: '14px', fontWeight: 600 } },
                        taskStatusMeta(selected.task.status).label),
                      React.createElement('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
                        '角色:' + (selected.task.role !== undefined && selected.task.role !== '' ? selected.task.role : 'dynamic'))),
                    React.createElement('div', { style: { fontSize: '14px', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: '12px' } },
                      selected.task.text),
                    React.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '1.8' } },
                      React.createElement('div', null, '房间：' + selected.roomId),
                      React.createElement('div', null, '发起人：' + selected.task.sender),
                      React.createElement('div', null, '工作目录：' + (selected.task.cwd !== undefined ? selected.task.cwd : '（未设定）')),
                      selected.task.clarifyReply !== undefined
                        ? React.createElement('div', null, '老板指示：' + selected.task.clarifyReply)
                        : null,
                      selected.task.confirmReply !== undefined
                        ? React.createElement('div', null, '老板意见：' + selected.task.confirmReply)
                        : null,
                      selected.task.note !== undefined
                        ? React.createElement('div', null, '备注：' + selected.task.note)
                        : null),
                    React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '16px' } },
                      (selected.task.cwd === undefined && (selected.task.status === 'pending' || selected.task.status === 'clarifying'))
                        ? React.createElement('button', {
                            style: { ...SMALL_BTN, background: 'var(--dsw-alias-state-warn-primary)', color: 'var(--dsw-alias-bg-base)', padding: '6px 14px', fontSize: '13px' },
                            onClick: () => askCwd(selected.task.id),
                          }, '📁 设工作目录')
                        : null,
                      selected.task.status === 'clarifying'
                        ? React.createElement(React.Fragment, null,
                            React.createElement('button', {
                              style: { ...SMALL_BTN, background: 'var(--dsw-alias-state-success-primary)', color: 'var(--dsw-alias-bg-base)', padding: '6px 14px', fontSize: '13px' },
                              onClick: () => sendOps(selected.task.id, 'approve-start'),
                            }, '✅ 批准开工'),
                            React.createElement('button', {
                              style: { ...SMALL_BTN, background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-bg-base)', padding: '6px 14px', fontSize: '13px' },
                              onClick: () => askText(selected.task.id, 'give-instruction', '给开工指示（可多轮，直到批准开工）：'),
                            }, '💬 给指示'))
                        : selected.task.status === 'confirming'
                          ? React.createElement(React.Fragment, null,
                              React.createElement('button', {
                                style: { ...SMALL_BTN, background: 'var(--dsw-alias-state-success-primary)', color: 'var(--dsw-alias-bg-base)', padding: '6px 14px', fontSize: '13px' },
                                onClick: () => sendOps(selected.task.id, 'confirm-deliver'),
                              }, '✅ 确认交付'),
                              React.createElement('button', {
                                style: { ...SMALL_BTN, background: 'var(--dsw-alias-state-warn-primary)', color: 'var(--dsw-alias-bg-base)', padding: '6px 14px', fontSize: '13px' },
                                onClick: () => askText(selected.task.id, 'give-feedback', '给修改意见（修订后再确认）：'),
                              }, '💬 给意见'))
                          : selected.task.status === 'pending'
                            ? React.createElement(React.Fragment, null,
                                React.createElement('button', {
                                  style: { ...SMALL_BTN, background: 'var(--dsw-alias-state-success-primary)', color: 'var(--dsw-alias-bg-base)', padding: '6px 14px', fontSize: '13px' },
                                  onClick: () => sendOps(selected.task.id, 'approve'),
                                }, '✅ 批准'),
                                React.createElement('button', {
                                  style: { ...SMALL_BTN, background: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-bg-base)', padding: '6px 14px', fontSize: '13px' },
                                  onClick: () => sendOps(selected.task.id, 'reject'),
                                }, '🚫 拒绝'))
                            : null,
                    ),
              ),
            ),
          ),
    ),
  )
}

/** 插件入口：注册设置页 + 会话任务 tab + 所有任务入口/面板 + 秘书工作台。 */
export function apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'dsh-matrix', order: 30, label: () => '数字分身' },
    (props) => React.createElement(MatrixSettingsPage, Object.assign({ ctx }, props)),
  ))
  // 会话「任务」tab：加在 对话/轨迹/树状视图 之后。
  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    { name: 'conversation.view', id: 'tasks', order: 30, label: () => '任务' },
    (props) => React.createElement(SessionTasksTab, Object.assign({ ctx }, props)),
  ))
  // 秘书工作台：会话头部快捷入口（右上角工具位），打开大尺寸面板（任务/时间线）。
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    { name: 'conversation.session.header.utilities', id: 'secretary-desk', order: 30, label: () => '秘书工作台' },
    (props) => React.createElement(SecretaryDeskButton, Object.assign({ ctx, wide: true }, props)),
  ))
}
