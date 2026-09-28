/**
 * 入群邀请审批库：持久化「待主人裁决的邀请」+「邀请人黑白名单」。
 *
 * 为什么必须独立落盘（不能靠 sync 重放）：
 *   Matrix 的未处理邀请**只投递一次**——首次 sync 含 rooms.invite，之后带 since 的
 *   增量 sync 不再返回该房（实测连测两次 invite rooms 均为 0）。而「等主人同意」
 *   可能耗时数分钟、甚至跨进程重启。因此收到邀请的瞬间就必须把
 *   {roomId, inviter, roomName, at} 落盘，否则主人还没答，邀请就永久消失了。
 *
 * 为什么不能复用 MemberStore：
 *   member-memory.json 的语义是「见过的人」，受 memberMemory 开关与 upsert 逻辑影响，
 *   与本库的「批准过的邀请人」是两件事，混用会让白名单被无关事件污染。
 *
 * 持久化：stateDir/invite-approval.json，原子写（tmp + rename），与 member-store 同模式。
 * 只存元数据（房间 id/邀请人/群名/时间），**不存聊天内容**，符合仓库安全红线。
 *
 * @module dsh-matrix-agent/invite-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 一条待主人裁决的入群邀请。 */
export interface PendingInvite {
  /** 被邀请进入的房间 id。 */
  roomId: string
  /** 邀请人 userId（解析不出时为 undefined——此时一律请示主人，绝不自动进群）。 */
  inviter?: string
  /** 群名（invite_state 里 m.room.name，可能缺）。 */
  roomName?: string
  /** 邀请是否声明为 1:1 私聊。 */
  isDirect: boolean
  /** 收到邀请的时间戳（ms）。 */
  at: number
  /**
   * 向主人发请示的私聊房 id。
   * 必须持久化：主人可能在进程重启后才回复，而内存里的 DM→房间映射会丢失，
   * 导致「批准」被当成普通消息漏给 agent（实测踩过）。
   */
  dmRoomId?: string
}

/** 一条已决策的邀请记录（批准名单 / 拒绝名单共用）。 */
export interface InviteDecisionRecord {
  /** 决策针对的邀请人 userId。 */
  userId: string
  /** 最近一次决策时间戳（ms）。 */
  at: number
  /** 决策时所在房间 id（审计用）。 */
  roomId: string
  /** 决策时看到的群名（审计用）。 */
  roomName?: string
}

export interface InviteStoreData {
  version: 1
  /** 待主人裁决（未决）的邀请。 */
  pending: PendingInvite[]
  /** 已批准邀请人：命中则其后续邀请直接进群，不再打扰主人。 */
  approved: InviteDecisionRecord[]
  /** 已拒绝邀请人：命中则其后续邀请直接静默拒绝，不再反复打扰主人。 */
  denied: InviteDecisionRecord[]
}

/** 空数据。 */
export function emptyInviteStore(): InviteStoreData {
  return { version: 1, pending: [], approved: [], denied: [] }
}

/** 入群邀请审批库：JSON 落盘（原子写 tmp+rename），进程内同步读写 + 防抖保存。 */
export class InviteStore {
  private readonly filePath: string
  private data: InviteStoreData = emptyInviteStore()
  private saveTimer: NodeJS.Timeout | undefined
  /** 写入串行链：每个 save() 排在前一次之后（见 save() 注释，勿改为 dirty 重试）。 */
  private saving: Promise<void> | undefined

  constructor(stateDir: string, fileName = 'invite-approval.json') {
    this.filePath = join(stateDir, fileName)
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<InviteStoreData>
      if (parsed?.version === 1) {
        this.data = {
          version: 1,
          pending: Array.isArray(parsed.pending) ? parsed.pending : [],
          approved: Array.isArray(parsed.approved) ? parsed.approved : [],
          denied: Array.isArray(parsed.denied) ? parsed.denied : [],
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  /** 防抖保存（高频变更不逐次写盘）。 */
  scheduleSave(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      void this.save().catch(() => {})
    }, 300)
  }

  /**
   * 落盘。写入串行化（每个调用排在前一次之后），保证「调用方 await 返回时，
   * 本次调用发起前的所有变更都已落盘」。
   *
   * 注意不要用「在飞则置 dirty 并重试」的写法：两个并发调用会互相把对方的
   * dirty 置位，形成活锁（实测 save() 永不返回、进程不退出）。
   * 串行链天然无此问题，且顺序即调用顺序。
   */
  async save(): Promise<void> {
    clearTimeout(this.saveTimer)
    const prev = this.saving ?? Promise.resolve()
    const next = prev
      .catch(() => { /* 前一次失败不阻断本次 */ })
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true })
        const tmp = `${this.filePath}.tmp`
        await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
        await rename(tmp, this.filePath)
      })
    this.saving = next.catch(() => {})
    await next
  }

  /** 强制落盘（stop 时调用）。 */
  async dispose(): Promise<void> {
    clearTimeout(this.saveTimer)
    await this.save().catch(() => {})
  }

  // ── 待决邀请 ──

  /**
   * 记录一条待决邀请（收到邀请的瞬间调用，防 sync 游标推进后丢失）。
   * 同一房间重复投递时刷新内容（保留最早收到时间，便于主人看到「等了多久」）。
   *
   * 注意：这里**立即落盘、不走防抖**——与黑白名单变更不同。待决邀请是
   * 「sync 不会再投递」的一次性数据，若进程在防抖窗口内退出，邀请就永久丢失了
   * （主人还没答，群里已经再也收不到）。这个可靠性要求高于省几次写盘。
   */
  addPending(invite: PendingInvite): void {
    const existing = this.data.pending.find((p) => p.roomId === invite.roomId)
    if (existing !== undefined) {
      if (invite.inviter !== undefined) existing.inviter = invite.inviter
      if (invite.roomName !== undefined) existing.roomName = invite.roomName
      existing.isDirect = invite.isDirect
    } else {
      this.data.pending.push(invite)
    }
    clearTimeout(this.saveTimer)
    void this.save().catch(() => {})
  }

  getPending(roomId: string): PendingInvite | undefined {
    return this.data.pending.find((p) => p.roomId === roomId)
  }

  /** 按「主人请示私聊房」反查待决邀请（重启后主人回复仍能路由）。 */
  pendingByDmRoom(dmRoomId: string): PendingInvite | undefined {
    return this.data.pending.find((p) => p.dmRoomId === dmRoomId)
  }

  /** 回填某待决邀请的请示私聊房（发完 DM 后调用）。 */
  setPendingDmRoom(roomId: string, dmRoomId: string): void {
    const p = this.data.pending.find((x) => x.roomId === roomId)
    if (p === undefined) return
    p.dmRoomId = dmRoomId
    this.saveNow()
  }

  listPending(): PendingInvite[] {
    return [...this.data.pending]
  }

  /** 移除一条待决邀请（已裁决 / 已过期）。返回是否移除。 */
  removePending(roomId: string): boolean {
    const before = this.data.pending.length
    this.data.pending = this.data.pending.filter((p) => p.roomId !== roomId)
    const removed = this.data.pending.length < before
    if (removed) this.saveNow()
    return removed
  }

  /** 立即落盘（邀请审批全程低频，可靠性优先于省写盘）。 */
  private saveNow(): void {
    clearTimeout(this.saveTimer)
    void this.save().catch(() => {})
  }

  // ── 邀请人黑白名单 ──

  /** 该邀请人是否已被批准过（命中则后续邀请直接进群）。 */
  isApproved(userId: string): boolean {
    return this.data.approved.some((r) => r.userId === userId)
  }

  /** 该邀请人是否已被拒绝过（命中则后续邀请直接静默拒绝）。 */
  isDenied(userId: string): boolean {
    return this.data.denied.some((r) => r.userId === userId)
  }

  /** 批准某邀请人（记入批准名单，同时从拒绝名单移除——改判）。 */
  approve(userId: string, roomId: string, roomName?: string): void {
    this.applyDecision('approve', userId, roomId, roomName)
    this.saveNow()
  }

  /** 拒绝某邀请人（记入拒绝名单，同时从批准名单移除——改判）。 */
  deny(userId: string, roomId: string, roomName?: string): void {
    this.applyDecision('deny', userId, roomId, roomName)
    this.saveNow()
  }

  /**
   * 一次性裁决一条待决邀请：记名单 + 清待决，**单次落盘**（返回落盘完成）。
   * 必须原子：分两步写会让「名单已记但待决还在」（或反之）的中间态被读到，
   * 重启后表现为「已批准过的人又被请示一次」。
   * 返回 Promise 让调用方（桥接层）能等落盘完成再继续，避免「已裁决但未持久化」窗口。
   */
  async resolve(roomId: string, decision: 'approve' | 'deny', userId: string | undefined, roomName?: string): Promise<void> {
    if (userId !== undefined && userId !== '') this.applyDecision(decision, userId, roomId, roomName)
    this.data.pending = this.data.pending.filter((p) => p.roomId !== roomId)
    await this.save().catch(() => {})
  }

  /** 名单变更的内存部分（不含落盘）。 */
  private applyDecision(decision: 'approve' | 'deny', userId: string, roomId: string, roomName?: string): void {
    this.data.approved = this.data.approved.filter((r) => r.userId !== userId)
    this.data.denied = this.data.denied.filter((r) => r.userId !== userId)
    const target = decision === 'approve' ? this.data.approved : this.data.denied
    target.push({
      userId,
      at: Date.now(),
      roomId,
      ...(roomName !== undefined ? { roomName } : {}),
    })
  }

  /** 撤销某邀请人的记忆（从两个名单都移除）。返回是否命中。 */
  forget(userId: string): boolean {
    const before = this.data.approved.length + this.data.denied.length
    this.data.approved = this.data.approved.filter((r) => r.userId !== userId)
    this.data.denied = this.data.denied.filter((r) => r.userId !== userId)
    const hit = this.data.approved.length + this.data.denied.length < before
    if (hit) this.saveNow()
    return hit
  }

  /** 批准名单（供设置页/命令展示）。 */
  listApproved(): InviteDecisionRecord[] {
    return [...this.data.approved]
  }

  /** 拒绝名单（供设置页/命令展示）。 */
  listDenied(): InviteDecisionRecord[] {
    return [...this.data.denied]
  }
}
