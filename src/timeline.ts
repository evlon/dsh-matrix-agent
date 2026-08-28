/**
 * 数字分身「自我时间线」：跨房间记录分身自己的出站动作（仅结构化元数据）。
 *
 * 安全红线：**不落盘任何聊天原文/工具参数**，只存动作元数据：
 * { id, ts, roomId, kind, tool?, target?, charCount?, sessionId? }。
 * 需要详情时由分身用 `matrix_get_recent_messages` 现查 Matrix 房间
 * （Matrix 房间本就是分身的完整记录，含自己的回复）。
 *
 * 持久化：stateDir/twin-timeline.jsonl（append-only，每行一条 JSON）；
 * 删除/清空时重写文件（tmp+rename 原子写）。内存有界（cap）。
 *
 * @module dsh-matrix-agent/timeline
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** 时间线动作类型。 */
export type TimelineKind = 'reply' | 'tool-call' | 'proactive' | 'self-intro' | 'approval' | 'task'

/** 时间线动作主体：秘书（请示/确认/交付调度） vs 干活会话（执行回复/工具）。 */
export type TimelineActor = 'secretary' | 'worker'

/** 一条自我时间线条目（仅元数据，无聊天原文）。 */
export interface TimelineEntry {
  /** 唯一 id（供删除定位）。 */
  readonly id: string
  /** 时间戳（ms）。 */
  readonly ts: number
  /** 发生的房间。 */
  readonly roomId: string
  /** 动作类型。 */
  readonly kind: TimelineKind
  /** 动作主体：秘书 or 干活会话（缺省视为 worker，兼容旧数据）。 */
  readonly actor?: TimelineActor
  /** 工具名（tool-call 时）。 */
  readonly tool?: string
  /** 主动消息目标 userId（proactive 时）。 */
  readonly target?: string
  /** 回复/消息长度（reply/proactive/self-intro 时，活跃度信号，不含内容）。 */
  readonly charCount?: number
  /** 关联的 agent session id（可选）。 */
  readonly sessionId?: string
}

/** 时间线查询过滤。 */
export interface TimelineFilter {
  roomId?: string
  kind?: TimelineKind
  /** 动作主体过滤。 */
  actor?: TimelineActor
  /** 上限（默认 20，最大 200）。 */
  limit?: number
  /** 仅返回 ts >= since 的条目。 */
  since?: number
}

/** 时间线中文类型标签（UI/摘要用，不含原文）。 */
export const TIMELINE_KIND_LABELS: Record<TimelineKind, string> = {
  reply: '回复',
  'tool-call': '工具',
  proactive: '主动消息',
  'self-intro': '自我介绍',
  approval: '审批',
  task: '任务',
}

/**
 * 跨房间自我时间线：内存有界 + append-only jsonl 落盘。
 * record 为旁路：任何写入失败都静默，绝不中断发送主流程。
 */
export class TwinTimeline {
  private readonly filePath: string
  private readonly entries: TimelineEntry[] = []
  private readonly cap: number

  constructor(stateDir: string, cap = 500) {
    this.filePath = join(stateDir, 'twin-timeline.jsonl')
    this.cap = cap
  }

  /** 启动时读取 jsonl 回填内存（只保留最近 cap 条）。 */
  load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      for (const line of raw.split('\n')) {
        const t = line.trim()
        if (t === '') continue
        try {
          const e = JSON.parse(t) as TimelineEntry
          if (typeof e.ts === 'number' && typeof e.roomId === 'string' && typeof e.kind === 'string') {
            this.entries.push(e)
          }
        } catch { /* 跳过坏行 */ }
      }
      this.trim()
    } catch {
      /* 首跑无文件/读失败，正常 */
    }
  }

  /** 记录一条动作（旁路，失败静默）。 */
  record(entry: Omit<TimelineEntry, 'id' | 'ts'> & { ts?: number }): void {
    const full: TimelineEntry = {
      id: randomUUID(),
      ts: entry.ts ?? Date.now(),
      roomId: entry.roomId,
      kind: entry.kind,
      ...(entry.actor !== undefined ? { actor: entry.actor } : {}),
      ...(entry.tool !== undefined ? { tool: entry.tool } : {}),
      ...(entry.target !== undefined ? { target: entry.target } : {}),
      ...(entry.charCount !== undefined ? { charCount: entry.charCount } : {}),
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
    }
    this.entries.push(full)
    this.trim()
    try {
      mkdirSync(join(this.filePath, '..'), { recursive: true })
      appendFileSync(this.filePath, JSON.stringify(full) + '\n', 'utf8')
    } catch { /* 写失败不影响主流程 */ }
  }

  /** 查询（ts 倒序）。 */
  query(filter?: TimelineFilter): TimelineEntry[] {
    const f = filter ?? {}
    const limit = f.limit !== undefined ? Math.max(1, Math.min(200, Math.floor(f.limit))) : 20
    const out = [...this.entries]
      .filter((e) => f.roomId === undefined || e.roomId === f.roomId)
      .filter((e) => f.kind === undefined || e.kind === f.kind)
      .filter((e) => f.actor === undefined || (e.actor ?? 'worker') === f.actor)
      .filter((e) => f.since === undefined || e.ts >= f.since)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
    return out
  }

  /** 删除一条。返回是否删除。 */
  remove(id: string): boolean {
    const before = this.entries.length
    const next = this.entries.filter((e) => e.id !== id)
    if (next.length === before) return false
    this.entries.length = 0
    this.entries.push(...next)
    this.persist()
    return true
  }

  /** 清空全部。返回是否清空。 */
  clear(): boolean {
    if (this.entries.length === 0) return false
    this.entries.length = 0
    this.persist()
    return true
  }

  /** 快照（供 settings 镜像 → 设置页 UI）。 */
  snapshot(): { entries: TimelineEntry[]; updatedAt: number } {
    return { entries: [...this.entries].sort((a, b) => b.ts - a.ts), updatedAt: Date.now() }
  }

  /** 活跃房间数（隔离态下的无害全局计数）。 */
  activeRoomCount(): number {
    return new Set(this.entries.map((e) => e.roomId)).size
  }

  /** 内存裁剪：超 cap 丢最旧。 */
  private trim(): void {
    if (this.entries.length > this.cap) {
      this.entries.splice(0, this.entries.length - this.cap)
    }
  }

  /** 删除/清空后重写 jsonl（tmp+rename 原子写）。 */
  private persist(): void {
    try {
      mkdirSync(join(this.filePath, '..'), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      const lines = this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
      writeFileSync(tmp, lines, 'utf8')
      renameSync(tmp, this.filePath)
    } catch { /* 写失败不影响主流程 */ }
  }
}
