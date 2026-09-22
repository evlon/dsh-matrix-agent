/**
 * 入群邀请审批端到端：用假 homeserver 验证完整状态机。
 *
 * 覆盖用户需求原话：
 *   「首次邀请的时候，要请示一下主人，主人同意后才能够进群。
 *     如果以前这个人要求邀请过我们，主人同意过，那就直接进群。」
 *
 * 验证链路（全部走真实桥接层代码，只把 fetch 换成假 homeserver）：
 *   陌生邀请人 → ① 不 join ② 落盘待决 ③ 收件箱 kind='invite' ④ 私聊请示主人
 *   主人批准   → ① POST /join ② 邀请人进批准名单 ③ 收件箱清空
 *   该人再邀请 → 直接 join，不再打扰主人（收件箱不变）
 *   主人拒绝   → ① POST /leave ② 邀请人进拒绝名单
 *   该人再邀请 → 直接 leave，不再打扰主人
 *
 * 跑法：npm run build 后 `node --test tests/invite-bridge.test.mjs`
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MatrixBridge } from '@evlon/dsh-bridge'

const OWNER = '@owner:hs.example'
const BOT = '@twin:hs.example'
const ZHANG = '@zhang:hs.example'
const LI = '@li:hs.example'

const ROOM_NEW = '!room-new:hs.example'      // 陌生邀请人 zhang
const ROOM_AGAIN = '!room-again:hs.example'  // zhang 再次邀请（已批准 → 直接进）
const ROOM_BAD = '!room-bad:hs.example'      // 陌生邀请人 li
const ROOM_BAD2 = '!room-bad2:hs.example'    // li 再次邀请（已拒绝 → 直接拒）

/** 假 homeserver：支持按需投递 rooms（invite/join），并记录 join/leave 调用。 */
function fakeHomeserver(options = {}) {
  const calls = []
  const sends = []
  const joins = []
  const leaves = []
  let queue = []
  let waiter
  let token = 0
  return {
    calls, sends, joins, leaves,
    /** 投递一批 rooms（invite 或 join）。 */
    push(rooms) {
      queue.push(rooms)
      const w = waiter
      waiter = undefined
      if (w !== undefined) w()
    },
    async fetch(url, init = {}) {
      const path = new URL(url).pathname
      calls.push({ path, init })
      if (path.endsWith('/sync')) {
        if (queue.length === 0) {
          // 必须响应 abort：否则 bridge.stop() 会永远等在这个 pending sync 上。
          await new Promise((resolve, reject) => {
            waiter = resolve
            init.signal?.addEventListener('abort', () => {
              waiter = undefined
              reject(new DOMException('aborted', 'AbortError'))
            }, { once: true })
          })
        }
        const rooms = queue.shift() ?? {}
        token += 1
        return { ok: true, status: 200, async json() { return { next_batch: `s${token}`, rooms } } }
      }
      if (path.includes('/send/m.room.message/')) {
        sends.push({ body: JSON.parse(init.body) })
        return { ok: true, status: 200, async json() { return { event_id: '$out' } } }
      }
      if (path.endsWith('/join')) {
        joins.push(decodeURIComponent(path.split('/rooms/')[1].replace('/join', '')))
        return { ok: true, status: 200, async json() { return { room_id: 'x' } } }
      }
      if (path.endsWith('/leave')) {
        leaves.push(decodeURIComponent(path.split('/rooms/')[1].replace('/leave', '')))
        return { ok: true, status: 200, async json() { return {} } }
      }
      if (path.endsWith('/joined_rooms')) {
        return { ok: true, status: 200, async json() { return { joined_rooms: options.joinedRooms ?? [] } } }
      }
      if (path.endsWith('/createRoom')) {
        return { ok: true, status: 200, async json() { return { room_id: options.dmRoomId ?? '!dm:hs.example' } } }
      }
      if (path.includes('/joined_members')) return { ok: true, status: 200, async json() { return { joined: { [BOT]: {}, [OWNER]: {} } } } }
      if (path.includes('/state/m.room.name')) return { ok: true, status: 200, async json() { return { name: '测试群' } } }
      if (path.includes('/profile/')) return { ok: true, status: 200, async json() { return { displayname: '某人' } } }
      return { ok: true, status: 200, async json() { return {} } }
    },
  }
}

/** 构造一个 rooms.invite 载荷（形状来自 im-ipm.ict.cmcc 实测）。 */
function inviteRooms(roomId, inviter, name = '某群') {
  return {
    invite: {
      [roomId]: {
        invite_state: {
          events: [
            { type: 'm.room.create', sender: inviter, content: { creator: inviter } },
            { type: 'm.room.member', state_key: BOT, sender: inviter, content: { membership: 'invite' } },
            { type: 'm.room.name', sender: inviter, content: { name } },
          ],
        },
      },
    },
  }
}

function makeCtx() {
  const captured = { tools: [] }
  const toolsService = { register(tool) { captured.tools.push(tool) }, get() { return undefined } }
  return {
    captured,
    ctx: {
      tools: toolsService,
      logger: { warn() {}, error() {}, info() {} },
      get(service) {
        if (service === 'tools') return toolsService
        if (service === 'agentPresets') return { async mount() {} }
        return undefined
      },
      on() { return () => {} },
      inject(_deps, cb) { cb({ on() { return () => {} } }) },
      agents: {
        get() { return undefined },
        async create() { throw new Error('invite flow must not create agents') },
        async resume() { throw new Error('invite flow must not resume agents') },
      },
    },
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timed out')
}

/**
 * 轮询读取邀请审批库，直到满足断言条件。
 * 桥接层对邀请的落盘是异步的（收件箱推送是同步的、写盘在其后），
 * 因此断言必须等「持久化后的状态」，而不是等网络调用发生。
 */
async function waitForStore(dir, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(await readFile(join(dir, 'invite-approval.json'), 'utf8'))
      if (predicate(last)) return last
    } catch { /* 文件可能尚未写出 */ }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`waitForStore timed out; last=${JSON.stringify(last)}`)
}

/**
 * 删除临时目录。桥接层的私聊请示是 fire-and-forget，可能在 stop() 后仍在收尾，
 * 与 rm 竞态（Windows 上表现为 ENOTEMPTY）。重试几次即可，不影响断言有效性。
 */
async function cleanupDir(dir) {
  for (let i = 0; i < 10; i += 1) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EBUSY') throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

test('邀请审批：首次请示主人 → 批准进群并记住 → 再来直接进', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-invite-bridge-'))
  let bridge
  try {
    const hs = fakeHomeserver()
    const { ctx } = makeCtx()
    const inboxes = []
    bridge = new MatrixBridge(ctx, {
      homeserverUrl: 'https://hs.example',
      accessToken: 'token',
      userId: BOT,
      owner: OWNER,
      allowedUserIds: [OWNER],
      allowAllUsers: false,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      chunkMaxChars: 4000,
      mergeTimeoutSecs: 5,
      approvalTimeoutSecs: 60,
      stateDir: dir,
      fetchFn: hs.fetch,
      sleep: async () => {},
      updateOwnerInbox: (snap) => inboxes.push(snap),
    })

    // 启动（首次 sync 返回空）。
    hs.push({})
    await bridge.start()

    // ── ① 陌生邀请人 zhang 邀请 → 必须请示主人，绝不自动进群 ──
    hs.push(inviteRooms(ROOM_NEW, ZHANG, '项目群'))
    await waitFor(() => inboxes.some((s) => s.items.some((i) => i.kind === 'invite')))

    assert.equal(hs.joins.length, 0, '❌ 首次邀请绝不能自动进群')
    const inviteItem = inboxes.flatMap((s) => s.items).find((i) => i.kind === 'invite')
    assert.equal(inviteItem.id, ROOM_NEW, '收件箱 id 应为房间 id')
    assert.ok(inviteItem.text.includes('zhang'), '请示正文应说明是谁邀请的')
    assert.ok(inviteItem.text.includes('项目群'), '请示正文应说明是哪个群')
    assert.ok(hs.sends.some((s) => String(s.body.body).includes('入群邀请待批')), '应向主人发私聊请示')

    // 待决邀请必须已落盘（sync 游标推进后不会再投递）。
    const stored = await waitForStore(dir, (s) => s.pending.length === 1)
    assert.equal(stored.pending[0].inviter, ZHANG, '落盘必须含邀请人')

    // ── ② 主人批准 → POST /join + 记入批准名单 + 收件箱清空 ──
    bridge.handleOwnerDecisionOps({ seq: Date.now(), id: ROOM_NEW, decision: 'approve' })
    await waitFor(() => hs.joins.length === 1)
    assert.equal(hs.joins[0], ROOM_NEW, '批准后应加入被邀请的房间')

    const afterApprove = await waitForStore(dir, (s) => s.pending.length === 0 && s.approved.length === 1)
    assert.ok(afterApprove.approved.some((r) => r.userId === ZHANG), '批准后邀请人应进批准名单')

    // ── ③ 同一人再邀请（另一个群）→ 直接进群，不再打扰主人 ──
    const inboxCountBefore = inboxes.flatMap((s) => s.items).length
    hs.push(inviteRooms(ROOM_AGAIN, ZHANG, '另一个群'))
    await waitFor(() => hs.joins.length === 2)
    assert.equal(hs.joins[1], ROOM_AGAIN, '已批准的邀请人再邀请应直接进群')

    const invitesAfter = inboxes.flatMap((s) => s.items).filter((i) => i.kind === 'invite')
    assert.equal(invitesAfter.length, 1, '✅ 已批准邀请人不应再产生新的待批邀请')
    assert.ok(inboxes.flatMap((s) => s.items).length <= inboxCountBefore, '收件箱不应新增条目')

    await bridge.stop()
  } finally {
    await cleanupDir(dir)
  }
})

test('邀请审批：主人拒绝 → 退群并记住 → 该人再来直接静默拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-invite-bridge-'))
  let bridge
  try {
    const hs = fakeHomeserver()
    const { ctx } = makeCtx()
    const inboxes = []
    bridge = new MatrixBridge(ctx, {
      homeserverUrl: 'https://hs.example',
      accessToken: 'token',
      userId: BOT,
      owner: OWNER,
      allowedUserIds: [OWNER],
      allowAllUsers: false,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      chunkMaxChars: 4000,
      mergeTimeoutSecs: 5,
      approvalTimeoutSecs: 60,
      stateDir: dir,
      fetchFn: hs.fetch,
      sleep: async () => {},
      updateOwnerInbox: (snap) => inboxes.push(snap),
    })

    hs.push({})
    await bridge.start()

    // ── ① 陌生邀请人 li 邀请 → 请示主人 ──
    hs.push(inviteRooms(ROOM_BAD, LI, '可疑群'))
    await waitFor(() => inboxes.some((s) => s.items.some((i) => i.kind === 'invite')))
    assert.equal(hs.joins.length, 0, '首次邀请不得自动进群')
    assert.equal(hs.leaves.length, 0, '未裁决前不应退群')

    // ── ② 主人拒绝 → POST /leave + 记入拒绝名单 ──
    bridge.handleOwnerDecisionOps({ seq: Date.now(), id: ROOM_BAD, decision: 'reject' })
    await waitFor(() => hs.leaves.length === 1)
    assert.equal(hs.leaves[0], ROOM_BAD, '拒绝后应退群/清掉挂起邀请')

    const afterReject = await waitForStore(dir, (s) => s.pending.length === 0 && s.denied.length === 1)
    assert.ok(afterReject.denied.some((r) => r.userId === LI), '拒绝后邀请人应进拒绝名单')
    assert.ok(!afterReject.approved.some((r) => r.userId === LI), '拒绝后不应在批准名单')

    // ── ③ 同一人再邀请 → 直接静默拒绝，不再打扰主人 ──
    hs.push(inviteRooms(ROOM_BAD2, LI, '另一个可疑群'))
    await waitFor(() => hs.leaves.length === 2)
    assert.equal(hs.leaves[1], ROOM_BAD2, '已拒绝的邀请人再邀请应直接拒绝')
    assert.equal(hs.joins.length, 0, '❌ 已拒绝的邀请人绝不能被加入')

    const invitesAfter = inboxes.flatMap((s) => s.items).filter((i) => i.kind === 'invite')
    assert.equal(invitesAfter.length, 1, '✅ 已拒绝邀请人不应再产生新的待批邀请')

    await bridge.stop()
  } finally {
    await cleanupDir(dir)
  }
})

test('邀请审批：主人本人邀请直接进群（不请示自己）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-invite-bridge-'))
  let bridge
  try {
    const hs = fakeHomeserver()
    const { ctx } = makeCtx()
    const inboxes = []
    bridge = new MatrixBridge(ctx, {
      homeserverUrl: 'https://hs.example',
      accessToken: 'token',
      userId: BOT,
      owner: OWNER,
      allowedUserIds: [OWNER],
      allowAllUsers: false,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      chunkMaxChars: 4000,
      mergeTimeoutSecs: 5,
      approvalTimeoutSecs: 60,
      stateDir: dir,
      fetchFn: hs.fetch,
      sleep: async () => {},
      updateOwnerInbox: (snap) => inboxes.push(snap),
    })
    hs.push({})
    await bridge.start()

    hs.push(inviteRooms('!owner-room:hs.example', OWNER, '主人建的群'))
    await waitFor(() => hs.joins.length === 1)
    assert.equal(hs.joins[0], '!owner-room:hs.example', '主人邀请应直接进群')
    assert.equal(inboxes.flatMap((s) => s.items).filter((i) => i.kind === 'invite').length, 0, '不应请示主人自己')

    await bridge.stop()
  } finally {
    await cleanupDir(dir)
  }
})

test('邀请审批：重启后主人回复「批准」仍能路由（DM 映射持久化，回归）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-invite-bridge-'))
  const DM_ROOM = '!dm-owner:hs.example'
  let bridge
  try {
    // 假 homeserver 返回固定 DM 房 id，便于断言「重启后按持久化 DM 映射路由」。
    const hs = fakeHomeserver({ dmRoomId: DM_ROOM, joinedRooms: [] })

    const { ctx } = makeCtx()
    const inboxes = []
    const cfg = {
      homeserverUrl: 'https://hs.example',
      accessToken: 'token',
      userId: BOT,
      owner: OWNER,
      allowedUserIds: [OWNER],
      allowAllUsers: false,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      chunkMaxChars: 4000,
      mergeTimeoutSecs: 5,
      approvalTimeoutSecs: 60,
      stateDir: dir,
      fetchFn: hs.fetch,
      sleep: async () => {},
      updateOwnerInbox: (snap) => inboxes.push(snap),
    }

    // ── 第一次启动：收到邀请 → 待决 + DM 映射落盘 ──
    bridge = new MatrixBridge(ctx, cfg)
    hs.push({})
    await bridge.start()
    hs.push(inviteRooms(ROOM_NEW, ZHANG, '重启测试群'))
    await waitForStore(dir, (s) => s.pending.length === 1)
    // 等 DM 映射回填（sendDm 是异步的）。
    const withDm = await waitForStore(dir, (s) => s.pending[0]?.dmRoomId === DM_ROOM)
    assert.equal(withDm.pending[0].dmRoomId, DM_ROOM, 'DM 房映射必须持久化（重启路由要用）')
    assert.equal(hs.joins.length, 0, '首次邀请不得自动进群')
    await bridge.stop()

    // ── 模拟进程重启：新 bridge 实例，内存 DM 映射为空 ──
    const { ctx: ctx2 } = makeCtx()
    const bridge2 = new MatrixBridge(ctx2, cfg)
    hs.push({})
    await bridge2.start()

    // 主人直接在那个 DM 房里回复「批准」——内存映射没有，只能靠持久化兜底。
    const dmEvent = { type: 'm.room.message', sender: OWNER, event_id: '$dm1', content: { msgtype: 'm.text', body: '批准' } }
    hs.push({ join: { [DM_ROOM]: { timeline: { events: [dmEvent] } } } })
    await waitFor(() => hs.joins.length === 1, 5000)
    assert.equal(hs.joins[0], ROOM_NEW, '✅ 重启后主人回复批准仍应触发入群（不得被当普通消息漏给 agent）')

    await bridge2.stop()
  } finally {
    await cleanupDir(dir)
  }
})
