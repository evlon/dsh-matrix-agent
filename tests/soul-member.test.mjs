import assert from 'node:assert/strict'
import test from 'node:test'
import { soulText, mergeSoulConfig, isMatrixSession, SoulStatsCollector, deriveDefaultOwner } from '../lib/soul.js'
import { mergeMatrixConfig, DEFAULT_SOUL, emptyTasksSnapshot } from '../lib/settings.js'
import { MemberStore } from '../lib/member-store.js'
import { BridgeState } from '../lib/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('soulText renders the dynamic (百变员工) default persona block', () => {
  const text = soulText(DEFAULT_SOUL)
  assert.match(text, /【你的性格】你是「百变员工」/)
  // 动态模式（style 为空）：输出自主适配提示，不锁死单一风格。
  assert.match(text, /说话风格：不固定/)
  assert.match(text, /回复习惯：适中（一段）/)
  assert.match(text, /工作习惯：先理解当前对话的语境/)
  // 动态模式没有固定口头禅。
  assert.doesNotMatch(text, /口头禅/)
})

test('soulText renders a fixed-style soul with catchphrase/habits', () => {
  const fixed = { ...DEFAULT_SOUL, persona: '你叫小灵，是团队里靠谱又有人情味的数字同事。', style: 'friendly', catchphrase: '交给我吧', replyLength: 'short' }
  const text = soulText(fixed)
  assert.match(text, /【你的性格】你叫小灵/)
  assert.match(text, /说话风格：亲切友好/)
  assert.match(text, /回复习惯：简短（一两句）/)
  assert.match(text, /口头禅：交给我吧/)
})

test('soulText handles unknown style/length labels gracefully', () => {
  const text = soulText({ ...DEFAULT_SOUL, style: 'mysterious', replyLength: 'epic' })
  assert.match(text, /说话风格：mysterious/)
  assert.match(text, /回复习惯：epic/)
})

test('soulText omits empty catchphrase/habits', () => {
  const text = soulText({ ...DEFAULT_SOUL, catchphrase: '', habits: '' })
  assert.doesNotMatch(text, /口头禅/)
  assert.doesNotMatch(text, /工作习惯/)
})

test('mergeSoulConfig: user layer overrides, missing fields keep base', () => {
  const merged = mergeSoulConfig(DEFAULT_SOUL, { persona: '新人格' })
  assert.equal(merged.persona, '新人格')
  assert.equal(merged.style, '')
  assert.equal(merged.catchphrase, '')
  assert.equal(merged.enabled, true)
})

test('mergeSoulConfig: undefined user returns base copy', () => {
  const merged = mergeSoulConfig(DEFAULT_SOUL, undefined)
  assert.deepEqual(merged, DEFAULT_SOUL)
  // 不共享引用。
  merged.persona = 'x'
  assert.equal(DEFAULT_SOUL.persona, '你是「百变员工」：会根据所在房间的名称、讨论氛围与收到的消息，自动选择最合适的人设与语气（比如在技术群里像靠谱的研发、在需求讨论里像产品经理、面对新同事像乐于帮助的前辈）。你不需要固定一种性格。')
})

test('isMatrixSession detects matrix room agent sessions', () => {
  assert.equal(isMatrixSession('matrix-ai-niukunliang-abc123'), true)
  assert.equal(isMatrixSession('session-fc0708ce'), false)
  assert.equal(isMatrixSession('matrix-'), true)
})

test('SoulStatsCollector aggregates replies/tools/active only for matrix sessions', () => {
  const collector = new SoulStatsCollector()
  const session = { id: { toString: () => 'matrix-room1-hash' } }
  collector.handle(session, { type: 'turn/start', data: {} })
  collector.handle(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '你好世界' }] } },
  })
  collector.handle(session, { type: 'tool/call', data: { name: 'bash' } })
  collector.handle(session, { type: 'tool/call', data: { name: 'bash' } })
  // 非 matrix 会话不统计。
  collector.handle({ id: { toString: () => 'session-abc' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } })

  const snap = collector.snapshot()
  assert.equal(snap.rooms.length, 1)
  const room = snap.rooms[0]
  assert.equal(room.replies, 1)
  assert.equal(room.chars, 4)
  assert.deepEqual(room.tools, { bash: 2 })
  assert.ok(room.activeAt > 0)
  assert.equal(snap.totals.replies, 1)
  assert.equal(snap.totals.toolCalls, 2)
  assert.deepEqual(snap.totals.topTools, [{ name: 'bash', count: 2 }])
})

test('SoulStatsCollector caps at configured limit (drops oldest)', () => {
  const collector = new SoulStatsCollector(2)
  for (let i = 0; i < 5; i++) {
    const id = `matrix-r${i}`
    collector.handle({ id: { toString: () => id } }, { type: 'turn/start', data: {} })
  }
  assert.equal(collector.snapshot().rooms.length, 2)
})

test('MemberStore upsert/list/remembered/forget round-trips with persistence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-matrix-member-'))
  try {
    const store = new MemberStore(dir)
    store.upsert('!room:hs', { userId: '@alice:hs', displayName: 'Alice' })
    store.upsert('!room:hs', { userId: '@bob:hs' })
    store.upsert('!room:other', { userId: '@alice:hs' })
    assert.equal(store.list('!room:hs').length, 2)
    assert.equal(store.remembered('!room:hs', '@alice:hs'), true)
    assert.equal(store.remembered('!room:hs', '@carol:hs'), false)

    // 更新显示名并累计互动。
    store.upsert('!room:hs', { userId: '@alice:hs', displayName: 'Alice Updated' })
    store.bumpInteraction('!room:hs', '@alice:hs')
    const alice = store.get('!room:hs', '@alice:hs')
    assert.equal(alice?.displayName, 'Alice Updated')
    assert.equal(alice?.interactionCount, 1)

    // 备注。
    assert.equal(store.updateNote('!room:hs', '@alice:hs', '测试负责人'), true)
    assert.equal(store.get('!room:hs', '@alice:hs')?.note, '测试负责人')

    // 持久化：重新 load 后数据仍在。
    await store.save()
    const store2 = new MemberStore(dir)
    await store2.load()
    assert.equal(store2.list('!room:hs').length, 2)

    // forget。
    assert.equal(store.forget('!room:hs', '@alice:hs'), true)
    assert.equal(store.forget('!room:hs', '@alice:hs'), false)
    assert.equal(store.list('!room:hs').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- Owner 默认值推导（仅配置页提示用，运行期不推导） ----

test('deriveDefaultOwner: @ai- 前缀分身推导主人', () => {
  assert.equal(
    deriveDefaultOwner('@ai-niukunliang:im-ipm.ict.cmcc'),
    '@niukunliang:im-ipm.ict.cmcc',
  )
  assert.equal(deriveDefaultOwner('@ai-x:hs'), '@x:hs')
})

test('deriveDefaultOwner: 非 ai- 前缀 / 去掉后为空 / 非法输入返回 undefined', () => {
  assert.equal(deriveDefaultOwner('@niukunliang:hs'), undefined)
  assert.equal(deriveDefaultOwner('@ai:hs'), undefined)
  assert.equal(deriveDefaultOwner('ai-niukunliang:hs'), undefined)
  assert.equal(deriveDefaultOwner(''), undefined)
  assert.equal(deriveDefaultOwner('@noprefix:hs'), undefined)
})

// ---- 设置层嵌套 soul 合并 ----

const MIN_CONFIG = {
  homeserverUrl: 'https://hs.example',
  accessToken: 'token',
  userId: '@ai-main:hs',
  owner: '',
  respondToAll: true,
  allowedUserIds: [],
  allowAllUsers: false,
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  agentPreset: 'standard',
  chunkMaxChars: 4000,
  mergeTimeoutSecs: 5,
  approvalTimeoutSecs: 300,
  maxRetriesBeforeAbort: 5,
  retryCircuitBreakerEnabled: true,
  taskQueueMax: 20,
  matrixTools: true,
  notifyRoomEvents: false,
  proactiveSendRequiresApproval: true,
  preserveRichText: true,
  autoIntroduce: true,
  maxSelfIntroMentions: 20,
  memberMemory: true,
  autoGreet: true,
  selfIntroTemplate: '大家好，我是 {{userId}}。',
  soul: { ...DEFAULT_SOUL },
  digitalTwinMode: false,
  digitalTwins: [],
  stateDir: '.dsh-matrix',
  authStoreFile: 'auth-store.json',
  redlineTools: ['bash', 'pwsh', 'write', 'edit'],
  cwdCandidates: ['C:\\work'],
}

test('mergeMatrixConfig: 用户层 soul 子字段覆盖、其余保留', () => {
  const merged = mergeMatrixConfig(MIN_CONFIG, {
    soul: { persona: '新人格', style: 'formal' },
  })
  assert.equal(merged.soul?.persona, '新人格')
  assert.equal(merged.soul?.style, 'formal')
  // 未覆盖的 soul 子字段保留 base（DEFAULT_SOUL 动态模式 catchphrase 为空）。
  assert.equal(merged.soul?.catchphrase, '')
  assert.equal(merged.soul?.enabled, true)
  // 非 soul 字段不受影响。
  assert.equal(merged.provider, 'deepseek-official')
})

test('mergeMatrixConfig: 顶层字段覆盖 + undefined 用户层返回原 config', () => {
  const merged = mergeMatrixConfig(MIN_CONFIG, { provider: 'sharkai', model: 'glm-5.2' })
  assert.equal(merged.provider, 'sharkai')
  assert.equal(merged.model, 'glm-5.2')
  const same = mergeMatrixConfig(MIN_CONFIG, undefined)
  assert.equal(same, MIN_CONFIG)
})

// ---- 任务快照（运行时镜像） ----

test('emptyTasksSnapshot returns empty structures', () => {
  const snap = emptyTasksSnapshot()
  assert.deepEqual(snap.rooms, {})
  assert.deepEqual(snap.sessionRooms, {})
  assert.equal(snap.updatedAt, 0)
})

test('BridgeState.sessionRoomsSnapshot exposes session→room mapping', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-matrix-snap-'))
  try {
    const state = new BridgeState(join(dir, 'state.json'))
    await state.load()
    state.setRoomSession('!room1:hs', 'matrix-ai-main-abc')
    state.setRoomSession('!room2:hs', 'matrix-ai-main-def')
    const snap = state.sessionRoomsSnapshot()
    assert.equal(snap['matrix-ai-main-abc'], '!room1:hs')
    assert.equal(snap['matrix-ai-main-def'], '!room2:hs')
    // sessionRoom 反查一致。
    assert.equal(state.sessionRoom('matrix-ai-main-def'), '!room2:hs')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
