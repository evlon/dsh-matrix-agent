/**
 * 成员记忆库：记住每个房间里见过的成员（含其他数字人）。
 *
 * 持久化：stateDir/member-memory.json，原子写（tmp + rename），与 auth-store
 * 同一模式。只存成员元数据（userId/显示名/头像/首末次见到时间/互动次数/备注），
 * **不存聊天内容**，符合仓库安全红线。
 *
 * @module dsh-matrix-agent/member-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 一条成员记忆。 */
export interface MemberRecord {
  /** Matrix 用户 id（@user:server）。 */
  userId: string
  /** 房间 id。 */
  roomId: string
  /** 最近一次见到的显示名。 */
  displayName?: string
  /** 最近一次见到的头像 URL。 */
  avatarUrl?: string
  /** 首次见到时间戳（毫秒）。 */
  firstSeenAt: number
  /** 最近一次见到时间戳（毫秒）。 */
  lastSeenAt: number
  /** 与该成员的互动次数（消息/打招呼等，由桥接层累计）。 */
  interactionCount: number
  /** 人工/分身填写的备注（如"测试负责人，负责 X 模块"）。 */
  note?: string
}

export interface MemberStoreData {
  version: 1
  records: MemberRecord[]
}

/** 成员记忆库：JSON 落盘（原子写 tmp+rename），进程内同步读写。 */
export class MemberStore {
  private readonly filePath: string
  private data: MemberStoreData = { version: 1, records: [] }
  private saveTimer: NodeJS.Timeout | undefined
  private saving: Promise<void> | undefined

  constructor(stateDir: string, fileName = 'member-memory.json') {
    this.filePath = join(stateDir, fileName)
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<MemberStoreData>
      if (parsed?.version === 1 && Array.isArray(parsed.records)) {
        this.data = { version: 1, records: parsed.records }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  /** 防抖保存（高频 upsert/bump 不逐次写盘）。 */
  scheduleSave(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      void this.save()
    }, 500)
  }

  async save(): Promise<void> {
    clearTimeout(this.saveTimer)
    if (this.saving !== undefined) {
      await this.saving
      return
    }
    this.saving = (async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      await rename(tmp, this.filePath)
    })().finally(() => {
      this.saving = undefined
    })
    await this.saving
  }

  /** 强制落盘（stop 时调用）。 */
  async dispose(): Promise<void> {
    clearTimeout(this.saveTimer)
    await this.save()
  }

  /** upsert 一条成员记录（按 userId+roomId 定位）。 */
  upsert(roomId: string, member: { userId: string; displayName?: string; avatarUrl?: string }): void {
    let record = this.get(roomId, member.userId)
    if (record === undefined) {
      record = {
        userId: member.userId,
        roomId,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        interactionCount: 0,
      }
      this.data.records.push(record)
    }
    record.lastSeenAt = Date.now()
    if (member.displayName !== undefined && member.displayName !== '') record.displayName = member.displayName
    if (member.avatarUrl !== undefined && member.avatarUrl !== '') record.avatarUrl = member.avatarUrl
  }

  /** 查询某房间的某成员。 */
  get(roomId: string, userId: string): MemberRecord | undefined {
    return this.data.records.find((r) => r.roomId === roomId && r.userId === userId)
  }

  /** 某房间全部成员（按最近见到排序）。 */
  list(roomId: string): MemberRecord[] {
    return this.data.records
      .filter((r) => r.roomId === roomId)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  /** 是否已记住某成员。 */
  remembered(roomId: string, userId: string): boolean {
    return this.get(roomId, userId) !== undefined
  }

  /** 累计互动次数（供"记住每个人"的活跃度展示）。 */
  bumpInteraction(roomId: string, userId: string): void {
    const record = this.get(roomId, userId)
    if (record !== undefined) {
      record.interactionCount += 1
      record.lastSeenAt = Date.now()
    }
  }

  /** 更新备注。返回是否成功。 */
  updateNote(roomId: string, userId: string, note: string): boolean {
    const record = this.get(roomId, userId)
    if (record === undefined) return false
    record.note = note
    return true
  }

  /** 删除某成员记忆。返回是否删除。 */
  forget(roomId: string, userId: string): boolean {
    const before = this.data.records.length
    this.data.records = this.data.records.filter((r) => !(r.roomId === roomId && r.userId === userId))
    return this.data.records.length < before
  }

  /** 全部记录（供 /memory 汇总等）。 */
  allRecords(): readonly MemberRecord[] {
    return this.data.records
  }
}
