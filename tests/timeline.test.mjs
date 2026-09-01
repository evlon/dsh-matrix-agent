import assert from 'node:assert/strict'
import test from 'node:test'
import { TwinTimeline, TIMELINE_KIND_LABELS } from '../lib/timeline.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function freshTimeline(dir, cap = 500) {
  const t = new TwinTimeline(dir, cap)
  t.load()
  return t
}

test('TwinTimeline: record + query 按时间倒序、按房间/类型过滤', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-timeline-'))
  try {
    const t = freshTimeline(dir)
    t.record({ ts: 100, roomId: '!a:hs', kind: 'reply', charCount: 10 })
    t.record({ ts: 200, roomId: '!b:hs', kind: 'tool-call', tool: 'bash' })
    t.record({ ts: 300, roomId: '!a:hs', kind: 'proactive', target: '@x:hs' })

    // 倒序。
    const all = t.query({ limit: 10 })
    assert.equal(all.length, 3)
    assert.equal(all[0].kind, 'proactive')
    assert.equal(all[2].kind, 'reply')

    // 按房间过滤。
    const a = t.query({ roomId: '!a:hs', limit: 10 })
    assert.equal(a.length, 2)
    assert.ok(a.every((e) => e.roomId === '!a:hs'))

    // 按类型过滤。
    const tools = t.query({ kind: 'tool-call', limit: 10 })
    assert.equal(tools.length, 1)
    assert.equal(tools[0].tool, 'bash')

    // since 过滤。
    const after = t.query({ since: 200, limit: 10 })
    assert.equal(after.length, 2)
    assert.ok(after.every((e) => e.ts >= 200))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TwinTimeline: 元数据不含聊天原文（无 text 字段）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-timeline-'))
  try {
    const t = freshTimeline(dir)
    t.record({ roomId: '!a:hs', kind: 'reply', charCount: 42 })
    const e = t.query({ limit: 1 })[0]
    assert.equal('text' in e, false, '时间线条目不落盘聊天原文')
    assert.equal(e.charCount, 42)
    assert.equal(typeof e.id, 'string')
    assert.equal(typeof e.ts, 'number')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TwinTimeline: cap 裁剪（超上限丢最旧）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-timeline-'))
  try {
    const t = freshTimeline(dir, 3)
    for (let i = 1; i <= 5; i++) t.record({ ts: i, roomId: '!a:hs', kind: 'reply' })
    const all = t.query({ limit: 10 })
    assert.equal(all.length, 3)
    // 保留最新的 3 条（ts 3,4,5）。
    assert.deepEqual(all.map((e) => e.ts), [5, 4, 3])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TwinTimeline: remove/clear + 持久化（重写 jsonl，重启 load 后仍在）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-timeline-'))
  try {
    const t = freshTimeline(dir)
    t.record({ roomId: '!a:hs', kind: 'reply' })
    t.record({ roomId: '!b:hs', kind: 'tool-call', tool: 'write' })
    const id0 = t.query({ limit: 10 })[0].id

    // 删除一条。
    assert.equal(t.remove(id0), true)
    assert.equal(t.query({ limit: 10 }).length, 1)

    // 重启后（新实例 load）只剩 1 条。
    const t2 = freshTimeline(dir)
    assert.equal(t2.query({ limit: 10 }).length, 1)

    // 清空。
    assert.equal(t2.clear(), true)
    const t3 = freshTimeline(dir)
    assert.equal(t3.query({ limit: 10 }).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TwinTimeline: snapshot 形状与 activeRoomCount', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-timeline-'))
  try {
    const t = freshTimeline(dir)
    t.record({ roomId: '!a:hs', kind: 'reply' })
    t.record({ roomId: '!b:hs', kind: 'tool-call', tool: 'bash' })
    t.record({ roomId: '!a:hs', kind: 'reply' })
    const snap = t.snapshot()
    assert.equal(snap.entries.length, 3)
    assert.ok(snap.updatedAt > 0)
    assert.equal(t.activeRoomCount(), 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TwinTimeline: actor 维度（秘书/干活）记录与过滤', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-timeline-'))
  try {
    const t = freshTimeline(dir)
    t.record({ roomId: '!a:hs', kind: 'approval', actor: 'secretary' })   // 秘书请示/确认
    t.record({ roomId: '!a:hs', kind: 'reply' })                          // 干活回复（缺省 worker）
    t.record({ roomId: '!b:hs', kind: 'tool-call', tool: 'bash', actor: 'worker' })

    const secretary = t.query({ actor: 'secretary', limit: 10 })
    assert.equal(secretary.length, 1)
    assert.equal(secretary[0].actor, 'secretary')

    const worker = t.query({ actor: 'worker', limit: 10 })
    assert.equal(worker.length, 2) // 显式 worker + 缺省视为 worker
    assert.ok(worker.every((e) => (e.actor ?? 'worker') === 'worker'))

    const all = t.query({ limit: 10 })
    assert.equal(all.length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TIMELINE_KIND_LABELS 覆盖全部类型', () => {
  for (const kind of ['reply', 'tool-call', 'proactive', 'self-intro', 'approval', 'task']) {
    assert.ok(TIMELINE_KIND_LABELS[kind] !== undefined, `kind ${kind} 有中文标签`)
  }
})
