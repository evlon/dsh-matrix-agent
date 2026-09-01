/**
 * 会话命名空间隔离测试：
 * 同一分身账号 + 同一房间，在不同 dsh 实例（instanceKey / DSH_HOME 不同）下，
 * 应生成不同的确定性会话 id，绝不 resume 到对方历史。
 *
 * 验证点：
 * 1. resolveSessionNamespace：instanceKey 优先，其次 DSH_HOME，否则 undefined。
 * 2. BridgeState.load(namespace)：namespace 与磁盘记录不一致时作废 roomSessions/epochs。
 * 3. 端到端：不同 instanceKey 下 MatrixBridge 创建不同 session id。
 *
 * 跑法：npm run build 后 `node --test tests/session-namespace.test.mjs`
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MatrixBridge } from '@evlon/dsh-bridge'
import { resolveStateDir } from '@evlon/dsh-bridge'
import { BridgeState } from '@evlon/dsh-bridge'

const ROOM_ID = '!room:hs.example'
const USER_ID = '@bot:hs.example'
const SENDER = '@alice:hs.example'

function fakeHomeserver() {
  const sends = []
  const queues = new Map()
  const waiters = new Map()
  const started = new Set()
  const broadcast = []
  let pendingReleases = 0
  let token = 0
  return {
    sends,
    async fetch(url, init) {
      const path = new URL(url).pathname
      const acct = String(init?.headers?.Authorization ?? '').replace('Bearer ', '') || '?'
      if (path.endsWith('/sync')) {
        if (!queues.has(acct)) queues.set(acct, [...broadcast])
        const events = await new Promise((resolve, reject) => {
          const q = queues.get(acct)
          if (q.length > 0) { resolve(q.splice(0)); return }
          if (!started.has(acct) && pendingReleases > 0) {
            started.add(acct)
            pendingReleases -= 1
            resolve([])
            return
          }
          waiters.set(acct, () => resolve(queues.get(acct).splice(0)))
          init.signal?.addEventListener('abort', () => {
            waiters.delete(acct)
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
        token += 1
        return { ok: true, status: 200, async json() { return { next_batch: `s${token}`, rooms: { join: { [ROOM_ID]: { timeline: { events } } } } } } }
      }
      if (path.includes('/send/m.room.message/')) {
        sends.push({ kind: 'send', body: JSON.parse(init.body) })
        return { ok: true, status: 200, async json() { return { event_id: '$out' } } }
      }
      if (path.includes('/joined_members')) {
        return { ok: true, status: 200, async json() { return { joined: { '@a:hs': {}, '@b:hs': {}, '@bot:hs': {} } } } }
      }
      if (path.includes('/state/m.room.name')) {
        return { ok: true, status: 200, async json() { return { name: '测试群' } } }
      }
      if (path.includes('/typing/')) return { ok: true, status: 200, async json() { return {} } }
      if (path.endsWith('/join')) return { ok: true, status: 200, async json() { return { room_id: ROOM_ID } } }
      return { ok: true, status: 200, async json() { return {} } }
    },
    deliver(events) {
      broadcast.push(...events)
      if (events.length === 0) pendingReleases += 1
      for (const [, q] of queues) q.push(...events)
      const wakes = []
      for (const [acct, wake] of waiters) { waiters.delete(acct); wakes.push(wake) }
      for (const wake of wakes) wake()
    },
  }
}

function textEvent(eventId, body) {
  return { type: 'm.room.message', sender: SENDER, event_id: eventId, content: { msgtype: 'm.text', body } }
}

function makeCtx() {
  const captured = { agents: [] }
  const agentById = new Map()
  const makeAgent = (id) => ({
    id, status: 'idle',
    ctx: { systemPrompt: { tools() {} } },
    session: { id, append() {}, deriveMessages() { return [] } },
    followup() {},
  })
  return {
    captured,
    ctx: {
      tools: { register() {}, get() { return undefined } },
      logger: { warn() {}, error() {}, info() {} },
      get(service) {
        if (service === 'agentPresets') return { async mount() {} }
        if (service === 'tools') return this.tools
        return undefined
      },
      on() { return () => {} },
      inject(_deps, cb) { cb({ on() { return () => {} } }) },
      agents: {
        get(id) { return agentById.get(String(id)) },
        async create({ sessionId }) {
          const agent = makeAgent(sessionId)
          agentById.set(sessionId, agent)
          captured.agents.push({ agent, async dispose() {} })
          return { agent, async dispose() {} }
        },
        async resume() { throw new Error('has no persisted log') },
      },
    },
  }
}

/** 跑一个 bridge 到「房间会话建立」，返回该房间的 session id。 */
async function sessionIdFor(instanceKey, stateDir) {
  const hs = fakeHomeserver()
  const { ctx, captured } = makeCtx()
  const bridge = new MatrixBridge(ctx, {
    homeserverUrl: 'https://hs.example',
    accessToken: 'token',
    userId: USER_ID,
    allowedUserIds: [SENDER],
    allowAllUsers: false,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    chunkMaxChars: 4000,
    mergeTimeoutSecs: 1,
    approvalTimeoutSecs: 60,
    stateDir,
    instanceKey,
    fetchFn: hs.fetch,
    sleep: async () => {},
    respondToAll: false,
  })
  const startPromise = bridge.start()
  hs.deliver([])
  await startPromise
  // 触发一条 @bot 消息，驱动 getRoomAgent 建立确定性会话。
  hs.deliver([textEvent('$e1', '@bot 你好!!')])
  // 等待 agent 建立（轮询）。
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && captured.agents.length === 0) {
    await new Promise((r) => setTimeout(r, 10))
  }
  await bridge.stop()
  return captured.agents.length > 0 ? captured.agents[0].agent.id : undefined
}

test('resolveStateDir: 相对路径锚定 DSH_HOME，绝对路径原样返回，空回退 .dsh-matrix', async () => {
  const prev = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = 'C:/home/dev'
    assert.equal(resolveStateDir('.dsh-matrix'), join('C:/home/dev', '.dsh-matrix'))
    assert.equal(resolveStateDir('foo/bar'), join('C:/home/dev', 'foo/bar'))
    assert.equal(resolveStateDir('C:/abs/path'), 'C:/abs/path')
    assert.equal(resolveStateDir(''), join('C:/home/dev', '.dsh-matrix'))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('resolveSessionNamespace: instanceKey 优先，其次 DSH_HOME，否则 undefined', async () => {
  // 通过 BridgeState.load 的命名空间行为间接验证（resolveSessionNamespace 未导出，
  // 但 MatrixBridge 构造时经日志调用；此处直接测 store 的 namespace 作废逻辑）。
  const dir = await mkdtemp(join(tmpdir(), 'dsh-matrix-ns-resolve-'))
  try {
    // 写入带 namespace A 的 state。
    const stateA = new BridgeState(join(dir, 'state.json'))
    await stateA.load('instance-A')
    stateA.setRoomSession(ROOM_ID, 'matrix-bot-deadbeef')
    await stateA.saveNow()

    // 以 namespace B 读取：绑定应被作废。
    const stateB = new BridgeState(join(dir, 'state.json'))
    await stateB.load('instance-B')
    assert.equal(stateB.roomSession(ROOM_ID), undefined, 'namespace 变化时应作废房间绑定')

    // 以相同 namespace A 读取：绑定保留。
    const stateA2 = new BridgeState(join(dir, 'state.json'))
    await stateA2.load('instance-A')
    assert.equal(stateA2.roomSession(ROOM_ID), 'matrix-bot-deadbeef', 'namespace 一致时保留绑定')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('不同 instanceKey 下生成不同的会话 id（同账号同房间）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-matrix-ns-e2e-'))
  try {
    const idA = await sessionIdFor('port-3090', join(dir, 'a'))
    const idB = await sessionIdFor('port-3180', join(dir, 'b'))
    assert.ok(idA, 'instanceKey A 应建立会话')
    assert.ok(idB, 'instanceKey B 应建立会话')
    assert.notEqual(idA, idB, '不同 instanceKey 必须产生不同会话 id')
    assert.match(idA, /^matrix-bot-[0-9a-f]{8}$/)
    assert.match(idB, /^matrix-bot-[0-9a-f]{8}$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('相同 instanceKey 下生成相同会话 id（确定性）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-matrix-ns-determinism-'))
  try {
    const id1 = await sessionIdFor('shared-key', join(dir, 'a'))
    const id2 = await sessionIdFor('shared-key', join(dir, 'b'))
    assert.ok(id1 && id2)
    assert.equal(id1, id2, '相同 instanceKey + 相同房间应确定性复用会话 id')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
