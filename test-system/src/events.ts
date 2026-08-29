/**
 * 测试事件模型：所有房间的动作（同事发言/数字人回复/系统/断言）统一成事件流，
 * 供 Web UI（SSE）实时推送 + 内存日志。
 */

export type EventKind = 'colleague' | 'twin' | 'system' | 'assert' | 'assert-result'

export interface TestEvent {
  roomId: string
  roomName: string
  ts: number
  kind: EventKind
  /** 发送者显示名。 */
  from: string
  /** 消息正文（kind=colleague/twin）。 */
  text?: string
  /** 状态（kind=system/assert）。 */
  status?: string
  /** 轮次。 */
  round?: number
}

/** 房间级状态（供 UI 列表展示）。 */
export interface RoomState {
  roomId: string
  roomName: string
  members: string[]
  status: 'creating' | 'active' | 'done' | 'error'
  paused: boolean
  /** 当前/下一轮发言的同事显示名。 */
  activeColleague?: string
  round: number
  messageCount: number
  lastEventTs: number
  /** 断言结果（房间 done 后填充）。 */
  asserts?: Array<{ id: string; label: string; passed: boolean; detail?: string }>
  /** 是否全部断言通过（done 后）。 */
  passed?: boolean
}

/** 简单事件总线：orchestrator 写，Web server 订阅。 */
export class EventBus {
  private readonly listeners = new Set<(event: TestEvent) => void>()
  private readonly history: TestEvent[] = []
  private readonly maxHistory = 2000

  emit(event: TestEvent): void {
    this.history.push(event)
    if (this.history.length > this.maxHistory) this.history.shift()
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* 忽略订阅者错误 */ }
    }
  }

  subscribe(listener: (event: TestEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  recent(limit = 500): TestEvent[] {
    return this.history.slice(-limit)
  }
}
