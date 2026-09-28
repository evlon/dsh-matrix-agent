/**
 * 通道层持久状态的最小契约：增量同步游标 + 事件去重环。
 * 与桥接层状态解耦：通道只关心「同步到哪了」和「哪些事件处理过」，
 * 房间↔会话映射、工作目录、任务队列等桥接状态不在通道职责内。
 *
 * @module @evlon/dsh-channel-core/state
 */

export interface ChannelState {
  /** 增量同步游标（如 Matrix 的 next_batch）；undefined 表示首次全量同步。 */
  syncToken: string | undefined
  hasSeen(eventId: string): boolean
  markSeen(eventId: string): void
}
