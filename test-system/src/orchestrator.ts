/**
 * 测试编排器：按场景推进多个房间的对话。
 * 每个房间独立循环：选一个同事 → AI 生成发言 → 发到房间 → 等数字人回复 → 记录事件 → 下一轮。
 * 所有事件推入 EventBus（Web UI 实时展示）。
 */
import { AiColleague, type ColleaguePersona } from './ai-colleague.js'
import { MatrixClient, type RoomMessage } from './matrix-client.js'
import type { TestConfig } from './config.js'
import { EventBus, type RoomState, type TestEvent } from './events.js'

/** 场景定义：一个测试房间。 */
export interface TestRoomDef {
  name: string
  /** 参与本房间的同事（按序轮流发言）。 */
  colleagues: ColleaguePersona[]
  /** 测试目标（注入所有同事）。 */
  goal: string
}

/** 数字人账号。 */
export interface TwinIdentity {
  userId: string
  displayName: string
}

export interface OrchestratorOptions {
  config: TestConfig
  bus: EventBus
  /** 测试接缝。 */
  fetchFn?: typeof fetch
}

/** 运行中的房间句柄（供 UI/停止用）。 */
export interface RunningRoom {
  roomId: string
  state: RoomState
  stop(): void
}

export class Orchestrator {
  private readonly config: TestConfig
  private readonly bus: EventBus
  private readonly fetchFn: typeof fetch
  private readonly clients: MatrixClient[] = []
  private readonly colleague: AiColleague
  private readonly twin: TwinIdentity
  private readonly rooms = new Map<string, RunningRoom>()
  private readonly stopFlags = new Set<string>()

  constructor(options: OrchestratorOptions) {
    this.config = options.config
    this.bus = options.bus
    this.fetchFn = options.fetchFn ?? fetch
    this.twin = { userId: this.config.twinUserId, displayName: localpart(this.config.twinUserId) }
    this.colleague = new AiColleague({
      baseUrl: this.config.llm.baseUrl,
      apiKey: this.config.llm.apiKey,
      model: this.config.llm.model,
      twinUserId: this.twin.userId,
      fetchFn: this.fetchFn,
    })
  }

  /** 初始化：每个同事一个 Matrix 客户端。 */
  init(): void {
    for (const account of this.config.colleagues) {
      this.clients.push(new MatrixClient({ homeserver: this.config.homeserver, account, fetchFn: this.fetchFn }))
    }
    if (this.clients.length === 0) throw new Error('没有同事账号（检查 COLLEAGUE_TOKENS）')
  }

  get roomsSnapshot(): RoomState[] {
    return [...this.rooms.values()].map((r) => r.state)
  }

  /** 启动一个测试房间（创建房间 + invite 数字人 + 开始对话循环，异步）。 */
  startRoom(def: TestRoomDef): Promise<RunningRoom> {
    return this.runRoom(def)
  }

  /** 停止所有房间。 */
  stopAll(): void {
    for (const [roomId, room] of this.rooms) {
      this.stopFlags.add(roomId)
      room.stop()
    }
  }

  private async runRoom(def: TestRoomDef): Promise<RunningRoom> {
    const roomId = `room-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const state: RoomState = {
      roomId,
      roomName: def.name,
      members: [...def.colleagues.map((c) => c.userId), this.twin.userId],
      status: 'creating',
      round: 0,
      messageCount: 0,
      lastEventTs: Date.now(),
    }
    const room: RunningRoom = {
      roomId,
      state,
      stop: () => { this.stopFlags.add(roomId) },
    }
    this.rooms.set(roomId, room)

    const emit = (kind: TestEvent['kind'], from: string, text?: string, status?: string, round?: number): void => {
      const event: TestEvent = { roomId, roomName: def.name, ts: Date.now(), kind, from, text, status, round }
      state.messageCount += text !== undefined ? 1 : 0
      state.lastEventTs = event.ts
      this.bus.emit(event)
    }

    try {
      // 1. 用第一个同事建群 + invite 数字人和其他同事。
      const hostClient = this.clients[0]
      emit('system', '系统', `创建房间「${def.name}」并邀请成员…`, 'creating')
      const realRoomId = await hostClient.createRoom(def.name, [
        this.twin.userId,
        ...def.colleagues.slice(1).map((c) => c.userId),
      ])
      state.roomId = realRoomId
      state.status = 'active'
      emit('system', '系统', `房间已创建 ${realRoomId}`, 'active')

      // 2. 等数字人加入（join 需要时间；轮询成员直到数字人在）。
      await this.waitForTwinJoin(realRoomId, def, emit)

      // 3. 对话循环。
      let round = 0
      const maxRounds = this.config.roundsPerRoom
      const allDone = new Set<string>()
      while (round < maxRounds) {
        if (this.stopFlags.has(roomId)) break
        round += 1
        state.round = round

        // 收集房间历史（去重）。
        const history = await this.collectHistory(realRoomId)

        // 选当前轮次的同事（轮流）。
        const persona = def.colleagues[(round - 1) % def.colleagues.length]
        if (allDone.has(persona.userId)) continue

        // AI 生成发言。
        emit('system', '系统', `第 ${round} 轮：等待 ${persona.displayName} 发言…`, 'thinking', round)
        let turn
        try {
          turn = await this.colleague.nextMessage(persona, history, round)
        } catch (error) {
          emit('assert', '系统', undefined, `AI 同事生成失败: ${error instanceof Error ? error.message : String(error)}`, round)
          continue
        }
        if (turn.done) {
          allDone.add(persona.userId)
          emit('system', '系统', `${persona.displayName} 认为目标已达成，本轮结束`, 'done', round)
          continue
        }
        if (turn.text === null) continue

        // 发送发言；若未 @ 数字人则自动加前缀（保证数字人响应）。
        let outText = turn.text.replace(/@+/g, '@')
        if (!outText.includes(this.twin.userId) && !outText.includes(`@${this.twin.displayName}`)) {
          outText = `@${this.twin.userId} ${outText}`
        }
        emit('colleague', persona.displayName, outText, undefined, round)
        await hostClient.sendText(realRoomId, outText)

        // 等数字人回复（仅新增的数字人消息）。
        const twinBefore = await this.countTwinMessages(realRoomId)
        const twinReply = await this.waitForTwinReply(realRoomId, twinBefore, this.config.replyTimeoutSecs * 1000)
        if (twinReply !== undefined) {
          emit('twin', this.twin.displayName, twinReply.body, undefined, round)
        } else {
          emit('assert', '系统', undefined, `数字人 ${this.twin.displayName} 未在 ${this.config.replyTimeoutSecs}s 内回复（无响应）`, round)
        }
      }
      state.status = 'done'
      emit('system', '系统', `房间「${def.name}」测试完成（${round} 轮）`, 'done')
    } catch (error) {
      state.status = 'error'
      emit('system', '系统', `房间失败: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
    return room
  }

  /** 轮询直到数字人加入房间（最多 120s）。 */
  private async waitForTwinJoin(
    roomId: string,
    _def: TestRoomDef,
    emit: (kind: TestEvent['kind'], from: string, text?: string, status?: string, round?: number) => void,
  ): Promise<void> {
    const client = this.clients[0]
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      try {
        const members = await client.getRoomMembers(roomId)
        if (members.includes(this.twin.userId)) {
          emit('system', '系统', `数字人 ${this.twin.displayName} 已加入房间`, 'active')
          return
        }
      } catch { /* 房间可能还没建好 */ }
      await sleep(2000)
    }
    emit('system', '系统', `等待数字人加入超时（继续对话，数字人可能不在）`, 'warn')
  }

  private async collectHistory(roomId: string): Promise<Array<{ sender: string; text: string }>> {
    try {
      const msgs = await this.clients[0].getRoomMessages(roomId, 30)
      return msgs.map((m) => ({ sender: shortName(m.sender), text: m.body }))
    } catch {
      return []
    }
  }

  /** 统计房间中数字人的消息数。 */
  private async countTwinMessages(roomId: string): Promise<number> {
    try {
      const msgs = await this.clients[0].getRoomMessages(roomId, 50)
      return msgs.filter((m) => m.sender === this.twin.userId).length
    } catch {
      return 0
    }
  }

  /** 等数字人回复：轮询房间消息，返回发送后**新增**的数字人消息（排除进群自我介绍等旧消息）。 */
  private async waitForTwinReply(roomId: string, beforeTwinCount: number, timeoutMs: number): Promise<RoomMessage | undefined> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.stopFlags.has(roomId)) return undefined
      try {
        const msgs = await this.clients[0].getRoomMessages(roomId, 30)
        const twinMsgs = msgs.filter((m) => m.sender === this.twin.userId)
        if (twinMsgs.length > beforeTwinCount) {
          return twinMsgs[twinMsgs.length - 1]
        }
      } catch { /* 忽略拉取错误 */ }
      await sleep(2000)
    }
    return undefined
  }
}

function localpart(userId: string): string {
  const at = userId.indexOf(':')
  return userId.startsWith('@') && at > 0 ? userId.slice(1, at) : userId
}

function shortName(userId: string): string {
  return userId.startsWith('@') ? localpart(userId) : userId
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
