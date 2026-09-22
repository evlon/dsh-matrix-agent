/**
 * 入群邀请审批测试：通道层解析 + 审批库语义 + 端到端状态机。
 *
 * 覆盖本轮需求：「首次邀请请示主人，同意后进群；以前同意过该邀请人的邀请直接进群」。
 *
 * 关键回归点（都是实测踩过的坑）：
 *   1. 通道层**绝不**自动 joinRoom——收到邀请只投影 self-invite 事件；
 *   2. invite_state 里能解析出邀请人（member.sender）与群名（m.room.name）；
 *   3. 无邀请人信息 → 一律请示主人，绝不放行；
 *   4. 批准过的邀请人 → 直接进群；拒绝过的 → 直接静默拒绝；
 *   5. 待决邀请必须落盘（sync 游标推进后不会再投递，重启必须能恢复）。
 *
 * 跑法：npm run build 后 `node --test tests/invite-approval.test.mjs`
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MatrixChannel } from '@evlon/dsh-channel-matrix'
import { BridgeState, InviteStore } from '@evlon/dsh-bridge'

const HS = 'https://hs.example'
const TOKEN = 'token'
const BOT = '@twin:hs.example'
const INVITER = '@zhang:hs.example'
const ROOM = '!invited:hs.example'

/** 构造可断言的 mock fetch：记录所有调用。 */
function mockFetch(handler) {
  const calls = []
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url)
    const path = u.pathname
    calls.push({ path, url: String(url), init })
    const result = handler({ path, u, init })
    if (result === undefined) return { ok: true, status: 200, async json() { return {} } }
    if (typeof result === 'object' && ('json' in result || 'arrayBuffer' in result)) return result
    return { ok: true, status: 200, async json() { return result } }
  }
  return { fetchFn, calls }
}

function makeState() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-invite-test-'))
  const state = new BridgeState(join(dir, 'state.json'))
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
  return state
}

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-invite-store-'))
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 一个真实的 rooms.invite 载荷（形状来自 im-ipm.ict.cmcc 实测）。 */
function invitePayload(roomId = ROOM, inviter = INVITER, name = '测试群') {
  return {
    [roomId]: {
      invite_state: {
        events: [
          { type: 'm.room.create', sender: inviter, content: { creator: inviter } },
          { type: 'm.room.member', state_key: BOT, sender: inviter, content: { membership: 'invite' } },
          { type: 'm.room.name', sender: inviter, content: { name } },
        ],
      },
    },
  }
}

// ─────────────────────────── 通道层 ───────────────────────────

test('收到邀请：投影 self-invite（含邀请人/群名），且【绝不】自动 join', async () => {
  const events = []
  const { fetchFn, calls } = mockFetch(({ path }) => {
    if (path.endsWith('/sync')) return { next_batch: 's1', rooms: { invite: invitePayload() } }
    return undefined
  })
  const ch = new MatrixChannel({
    homeserverUrl: HS, accessToken: TOKEN, userId: BOT, state: makeState(), fetchFn,
    onRoomEvent: (e) => events.push(e),
  })
  await ch.start()
  await ch.stop()

  const invites = events.filter((e) => e.kind === 'self-invite')
  assert.equal(invites.length, 1, '应投影一条 self-invite 事件')
  assert.equal(invites[0].roomId, ROOM)
  assert.equal(invites[0].userId, INVITER, 'userId 应为邀请人')
  assert.equal(invites[0].detail.inviter, INVITER, 'detail.inviter 应为邀请人')
  assert.equal(invites[0].detail.roomName, '测试群', '应解析出群名')

  // 核心回归断言：绝不能自动加入。
  const joinCalls = calls.filter((c) => c.path.includes('/join'))
  assert.equal(joinCalls.length, 0, '❌ 通道层不得自动调用 /join（入群决策权归桥接层）')
  const selfJoin = events.filter((e) => e.kind === 'self-join')
  assert.equal(selfJoin.length, 0, '不应发出 self-join')
})

test('解析邀请人：member 事件缺失时回退到 m.room.create 的 creator', async () => {
  const events = []
  const { fetchFn } = mockFetch(({ path }) => {
    if (path.endsWith('/sync')) {
      return {
        next_batch: 's1',
        rooms: {
          invite: {
            [ROOM]: {
              invite_state: {
                events: [{ type: 'm.room.create', sender: INVITER, content: { creator: INVITER } }],
              },
            },
          },
        },
      }
    }
    return undefined
  })
  const ch = new MatrixChannel({
    homeserverUrl: HS, accessToken: TOKEN, userId: BOT, state: makeState(), fetchFn,
    onRoomEvent: (e) => events.push(e),
  })
  await ch.start()
  await ch.stop()
  assert.equal(events[0].detail.inviter, INVITER, '无 member 事件时应回退到 creator')
})

test('解析邀请人：完全无法识别时 detail.inviter 缺失（由桥接层一律请示主人）', async () => {
  const events = []
  const { fetchFn } = mockFetch(({ path }) => {
    if (path.endsWith('/sync')) {
      return { next_batch: 's1', rooms: { invite: { [ROOM]: { invite_state: { events: [] } } } } }
    }
    return undefined
  })
  const ch = new MatrixChannel({
    homeserverUrl: HS, accessToken: TOKEN, userId: BOT, state: makeState(), fetchFn,
    onRoomEvent: (e) => events.push(e),
  })
  await ch.start()
  await ch.stop()
  assert.equal(events[0].detail.inviter, undefined, '无法识别邀请人时不应编造')
  assert.equal(events[0].detail.isDirect, false)
})

test('joinRoom/leaveRoom：调用正确的 Matrix 端点', async () => {
  const { fetchFn, calls } = mockFetch(() => undefined)
  const ch = new MatrixChannel({
    homeserverUrl: HS, accessToken: TOKEN, userId: BOT, state: makeState(), fetchFn,
  })
  await ch.joinRoom(ROOM)
  assert.ok(calls.some((c) => c.path.includes('/rooms/') && c.path.endsWith('/join')), '应 POST /join')
  await ch.leaveRoom(ROOM)
  assert.ok(calls.some((c) => c.path.includes('/rooms/') && c.path.endsWith('/leave')), '应 POST /leave')
})

test('joinRoom 失败时抛错（桥接层据此保留待决记录）', async () => {
  const { fetchFn } = mockFetch(({ path }) => {
    if (path.endsWith('/join')) return { ok: false, status: 500, async json() { return {} } }
    return undefined
  })
  const ch = new MatrixChannel({
    homeserverUrl: HS, accessToken: TOKEN, userId: BOT, state: makeState(), fetchFn,
  })
  await assert.rejects(() => ch.joinRoom(ROOM), /join HTTP 500/)
})

// ─────────────────────── 审批库（持久化 + 名单） ───────────────────────

test('InviteStore：待决邀请落盘后能读回（防 sync 游标推进丢失）', async () => {
  const dir = makeTmpDir()
  const store = new InviteStore(dir)
  store.addPending({ roomId: ROOM, inviter: INVITER, roomName: '测试群', isDirect: false, at: 123 })
  await store.save()

  assert.ok(existsSync(join(dir, 'invite-approval.json')), '应落盘 invite-approval.json')
  const raw = JSON.parse(readFileSync(join(dir, 'invite-approval.json'), 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.pending.length, 1, '待决邀请必须持久化')
  assert.equal(raw.pending[0].inviter, INVITER, '邀请人必须持久化（请示主人要用）')

  // 模拟进程重启：新实例 load 后仍能看到。
  const reopened = new InviteStore(dir)
  await reopened.load()
  assert.equal(reopened.getPending(ROOM)?.inviter, INVITER, '重启后待决邀请必须可恢复')
})

test('InviteStore：批准/拒绝名单语义（含改判时互斥）', async () => {
  const dir = makeTmpDir()
  const store = new InviteStore(dir)

  assert.equal(store.isApproved(INVITER), false, '初始未批准')
  store.approve(INVITER, ROOM, '测试群')
  assert.equal(store.isApproved(INVITER), true, '批准后命中批准名单')
  assert.equal(store.isDenied(INVITER), false)

  // 改判：批准 → 拒绝，两个名单必须互斥（否则行为不确定）。
  store.deny(INVITER, ROOM, '测试群')
  assert.equal(store.isDenied(INVITER), true, '改判后命中拒绝名单')
  assert.equal(store.isApproved(INVITER), false, '改判后不应仍在批准名单')

  // 撤销记忆。
  assert.equal(store.forget(INVITER), true)
  assert.equal(store.isDenied(INVITER), false, '撤销后两个名单都不应命中')
})

test('InviteStore：重复投递同一房间不产生重复待决，但刷新邀请人/群名', () => {
  const store = new InviteStore(makeTmpDir())
  store.addPending({ roomId: ROOM, roomName: '旧名', isDirect: false, at: 100 })
  store.addPending({ roomId: ROOM, inviter: INVITER, roomName: '新名', isDirect: true, at: 200 })
  assert.equal(store.listPending().length, 1, '同一房间只保留一条待决')
  const p = store.getPending(ROOM)
  assert.equal(p.inviter, INVITER, '后续投递补齐了邀请人')
  assert.equal(p.roomName, '新名', '群名应刷新')
  assert.equal(p.at, 100, '保留最早收到时间（主人能看到等了多久）')
})

test('InviteStore：removePending 返回是否命中', () => {
  const store = new InviteStore(makeTmpDir())
  store.addPending({ roomId: ROOM, isDirect: false, at: 1 })
  assert.equal(store.removePending(ROOM), true)
  assert.equal(store.removePending(ROOM), false, '重复移除应返回 false')
  assert.equal(store.listPending().length, 0)
})

test('InviteStore：resolve 原子裁决（名单与待决一次落盘，不留中间态）', async () => {
  const dir = makeTmpDir()
  const store = new InviteStore(dir)
  store.addPending({ roomId: ROOM, inviter: INVITER, isDirect: false, at: 1 })
  await store.save()

  await store.resolve(ROOM, 'approve', INVITER, '测试群')

  // 关键：落盘后不应出现「名单已记但待决还在」的中间态（重启会导致重复请示）。
  const raw = JSON.parse(readFileSync(join(dir, 'invite-approval.json'), 'utf8'))
  assert.equal(raw.pending.length, 0, '裁决后待决必须清空')
  assert.equal(raw.approved.length, 1, '裁决后名单必须已记')
  assert.equal(raw.approved[0].userId, INVITER)

  // 重启后仍一致。
  const reopened = new InviteStore(dir)
  await reopened.load()
  assert.equal(reopened.listPending().length, 0, '重启后不应复活待决')
  assert.equal(reopened.isApproved(INVITER), true, '重启后名单应保留')
})

test('InviteStore：resolve 无邀请人时只清待决、不写名单（不编造身份）', async () => {
  const dir = makeTmpDir()
  const store = new InviteStore(dir)
  store.addPending({ roomId: ROOM, isDirect: false, at: 1 })
  await store.resolve(ROOM, 'approve', undefined, '测试群')
  assert.equal(store.listPending().length, 0, '待决应清空')
  assert.equal(store.listApproved().length, 0, '无邀请人时不得写入名单')
  assert.equal(store.listDenied().length, 0)
})

test('InviteStore：并发 save 不死锁（回归：dirty 重试写法会活锁）', async () => {
  const dir = makeTmpDir()
  const store = new InviteStore(dir)
  store.addPending({ roomId: ROOM, inviter: INVITER, isDirect: false, at: 1 })
  // 同时发起多个 save：必须全部完成（历史 bug：两个并发 save 互相置 dirty → 永不返回）。
  await Promise.all([store.save(), store.save(), store.save()])
  const raw = JSON.parse(readFileSync(join(dir, 'invite-approval.json'), 'utf8'))
  assert.equal(raw.pending.length, 1)
})
