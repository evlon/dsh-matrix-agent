/**
 * 测试编排器：按场景推进多个房间的对话。
 * 每个房间独立循环：选一个同事 → AI 生成发言 → 发到房间 → 等数字人回复 → 记录事件 → 下一轮。
 * 所有事件推入 EventBus（Web UI 实时展示）。
 *
 * 支持 Web UI 干预（control()）：
 * - pause / resume：房间循环在下一轮开始前挂起/继续
 * - stop：提前结束房间
 * - skip-wait：跳过当前"等数字人回复"
 * - inject：以指定身份发消息（同事账号，或数字人账号【需 TWIN_ACCESS_TOKEN】）
 * - switch：换同事发言（从下一轮起用指定同事）
 * 全局指令（roomId 为 'all'）：pause-all / resume-all / stop-all
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
  /** 房间断言（done 后评估）。 */
  asserts?: RoomAssert[]
}

/** 断言上下文（供 evaluate 使用）。 */
export interface AssertContext {
  roomId: string
  events: Array<{ kind: string; from: string; text?: string; ts: number }>
  /** 数字人消息数。 */
  twinMessages: number
  /** 同事消息数。 */
  colleagueMessages: number
  /** 实际轮次。 */
  rounds: number
}

/** 房间断言。 */
export interface RoomAssert {
  id: string
  label: string
  kind: 'twin-replied' | 'twin-responded-in-time' | 'twin-mentioned-colleague' | 'message-count' | 'custom'
  /** message-count 目标。 */
  target?: number
  /** custom 评估器。 */
  evaluate?: (ctx: AssertContext) => boolean | Promise<boolean>
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

/** 干预指令（来自 Web UI）。 */
export interface ControlCmd {
  /** 目标房间；'all' 或无表示全局。 */
  roomId?: string
  action: 'pause' | 'resume' | 'stop' | 'skip-wait' | 'inject' | 'switch' | 'pause-all' | 'resume-all' | 'stop-all'
  /** 同事 userId（inject 的发送身份 / switch 的目标同事）。 */
  colleagueId?: string
  /** inject 消息文本。 */
  text?: string
  /** inject 是否用数字人身份（需配置 TWIN_ACCESS_TOKEN）。 */
  asTwin?: boolean
}

/** 运行中的房间句柄（供 UI/停止用）。 */
export interface RunningRoom {
  roomId: string
  state: RoomState
  stop(): void
}

/** 房间内部控制状态。 */
interface RoomControl {
  queue: ControlCmd[]
  paused: boolean
  pausedResolve: (() => void) | undefined
  skipWait: boolean
  nextColleagueId: string | undefined
  /** 占位 id（rooms/controls map 的 key）。 */
  placeholderId: string
  /** 真实 Matrix 房间 id（创建后更新；control 按它匹配）。 */
  realRoomId: string | undefined
  /** 房间是否已结束（done/error）；结束后不再接受干预。 */
  finished: boolean
}

export class Orchestrator {
  private readonly config: TestConfig
  private readonly bus: EventBus
  private readonly fetchFn: typeof fetch
  private readonly clients: MatrixClient[] = []
  private readonly colleague: AiColleague
  private readonly twin: TwinIdentity
  /** 数字人账号客户端（数字人身份注入用；未配 token 时 undefined）。 */
  private twinClient: MatrixClient | undefined
  private readonly rooms = new Map<string, RunningRoom>()
  private readonly controls = new Map<string, RoomControl>()
  private readonly stopFlags = new Set<string>()
  /** 房间占位 id → 场景 def（单房间重跑用）。 */
  private readonly roomDefs = new Map<string, TestRoomDef>()
  /** 当前场景信息。 */
  private currentScenario: { id: string; name: string; run: number } | undefined
  /** 场景启动时的同事 userId（重跑用）。 */
  private scenarioUserIds: string[] = []

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

  /** 初始化：每个同事一个 Matrix 客户端；数字人账号（若配了 token）。 */
  init(): void {
    for (const account of this.config.colleagues) {
      this.clients.push(new MatrixClient({ homeserver: this.config.homeserver, account, fetchFn: this.fetchFn }))
    }
    if (this.clients.length === 0) throw new Error('没有同事账号（检查 COLLEAGUE_TOKENS）')
    if (this.config.twinAccessToken !== undefined && this.config.twinAccessToken !== '') {
      this.twinClient = new MatrixClient({
        homeserver: this.config.homeserver,
        account: { userId: this.twin.userId, displayName: this.twin.displayName, accessToken: this.config.twinAccessToken },
        fetchFn: this.fetchFn,
      })
    }
  }

  get roomsSnapshot(): RoomState[] {
    return [...this.rooms.values()].map((r) => r.state)
  }

  /** 是否已配置数字人账号（数字人身份注入可用）。 */
  get twinInjectionAvailable(): boolean {
    return this.twinClient !== undefined
  }

  /** 停止所有房间。 */
  stopAll(): void {
    for (const [roomId, room] of this.rooms) {
      this.stopFlags.add(roomId)
      room.stop()
    }
  }

  /** 干预入口（Web UI 调用）。全局指令（'all'/无 roomId）分发到所有房间。 */
  control(cmd: ControlCmd): { ok: boolean; message?: string } {
    if (cmd.action === 'pause-all' || cmd.action === 'resume-all' || cmd.action === 'stop-all' || cmd.roomId === undefined || cmd.roomId === 'all') {
      const action = cmd.action === 'pause-all' ? 'pause' : cmd.action === 'resume-all' ? 'resume' : cmd.action === 'stop-all' ? 'stop' : cmd.action
      for (const roomId of this.rooms.keys()) {
        this.controls.get(roomId)?.queue.push({ ...cmd, roomId, action })
      }
      return { ok: true }
    }
    // 按真实房间 id 或占位 id 查找 control。
    let found: { id: string; control: RoomControl } | undefined
    for (const [id, control] of this.controls) {
      if (id === cmd.roomId || control.realRoomId === cmd.roomId) {
        found = { id, control }
        break
      }
    }
    if (found === undefined) {
      // 房间可能已结束（controls 保留但标记 finished）或从未存在。
      const known = [...this.rooms.values()].find((r) => r.state.roomId === cmd.roomId || r.roomId === cmd.roomId)
      if (known !== undefined && (known.state.status === 'done' || known.state.status === 'error')) {
        return { ok: false, message: `房间已结束（${known.state.status}），无法干预；可重新启动测试` }
      }
      return { ok: false, message: `房间不存在: ${cmd.roomId}` }
    }
    if (found.control.finished) {
      return { ok: false, message: '房间已结束，无法干预' }
    }
    if (cmd.action === 'inject' && cmd.asTwin === true && this.twinClient === undefined) {
      return { ok: false, message: '未配置数字人账号 token（TWIN_ACCESS_TOKEN），无法以数字人身份注入' }
    }
    found.control.queue.push(cmd)
    return { ok: true }
  }

  /** 当前场景信息（供 Web 显示）。 */
  get activeScenario(): { id: string; name: string; run: number } | undefined {
    return this.currentScenario
  }

  /**
   * 启动一个场景：停止并清空所有当前房间 → 构建场景房间 → 逐个启动。
   * @param scenarioId 场景 id（scenarios 注册表）
   * @param colleagueUserIds 同事 userId（场景 build 用）
   */
  startScenario(scenarioId: string, scenarioName: string, defs: TestRoomDef[]): { ok: boolean; message?: string } {
    // 停止并清空现有房间。
    this.clearAllRooms()
    // 记录场景信息（run 计数递增）。
    const run = (this.currentScenario?.id === scenarioId ? this.currentScenario.run : 0) + 1
    this.currentScenario = { id: scenarioId, name: scenarioName, run }
    // 启动场景房间。
    for (const def of defs) {
      const room = this.startRoom(def)
      this.roomDefs.set(room.roomId, def)
    }
    return { ok: true, message: `已启动场景「${scenarioName}」（第 ${run} 轮，${defs.length} 个房间）` }
  }

  /** 停止当前场景的所有房间（graceful），并清空房间列表。 */
  stopScenario(): { ok: boolean; message?: string } {
    const count = this.rooms.size
    this.stopAll()
    // 房间循环会陆续退出；先清掉引用，避免旧房间残留。
    this.rooms.clear()
    this.controls.clear()
    this.roomDefs.clear()
    this.currentScenario = undefined
    this.emitScenarioEvent(`已停止全部房间（${count} 个），可重新开始`)
    return { ok: true }
  }

  /** 重跑单个房间（该房间的 def 重建）。 */
  restartRoom(roomId: string): { ok: boolean; message?: string } {
    const def = this.findRoomDef(roomId)
    if (def === undefined) return { ok: false, message: `找不到该房间的场景定义: ${roomId}` }
    // 停止旧房间并清理。
    const old = this.findRoomByAnyId(roomId)
    if (old !== undefined) {
      this.stopFlags.add(old.roomId)
      this.rooms.delete(old.roomId)
      this.controls.delete(old.roomId)
      this.roomDefs.delete(old.roomId)
    }
    // 启动新房间。
    const room = this.startRoom(def)
    this.roomDefs.set(room.roomId, def)
    return { ok: true, message: '已重跑该房间' }
  }

  /** 场景事件（全局，无房间归属）。 */
  private emitScenarioEvent(text: string): void {
    this.bus.emit({
      roomId: 'scenario',
      roomName: '系统',
      ts: Date.now(),
      kind: 'system',
      from: '系统',
      text,
    })
  }

  /** 按占位 id 或真实 id 找房间 def。 */
  private findRoomDef(roomId: string): TestRoomDef | undefined {
    const room = this.findRoomByAnyId(roomId)
    if (room === undefined) return undefined
    return this.roomDefs.get(room.roomId)
  }

  /** 按占位 id 或真实 id 找房间。 */
  private findRoomByAnyId(roomId: string): RunningRoom | undefined {
    for (const [id, room] of this.rooms) {
      if (id === roomId || room.state.roomId === roomId) return room
    }
    return undefined
  }

  /** 停止并清空所有房间（场景切换/重跑用）。 */
  private clearAllRooms(): void {
    for (const roomId of this.rooms.keys()) {
      this.stopFlags.add(roomId)
    }
    this.rooms.clear()
    this.controls.clear()
    this.roomDefs.clear()
  }

  /** 启动一个测试房间：同步建句柄并立即返回，对话循环在后台推进。 */
  startRoom(def: TestRoomDef): RunningRoom {
    const roomId = `room-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const control: RoomControl = { queue: [], paused: false, pausedResolve: undefined, skipWait: false, nextColleagueId: undefined, placeholderId: roomId, realRoomId: undefined, finished: false }
    this.controls.set(roomId, control)
    const state: RoomState = {
      roomId,
      roomName: def.name,
      members: [...def.colleagues.map((c) => c.userId), this.twin.userId],
      status: 'creating',
      paused: false,
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
    void this.runRoom(room, control, def)
    return room
  }

  private async runRoom(room: RunningRoom, control: RoomControl, def: TestRoomDef): Promise<void> {
    const roomId = room.roomId
    const state = room.state

    const emit = (kind: TestEvent['kind'], from: string, text?: string, status?: string, round?: number): void => {
      // 用 state.roomId（创建后即真实 Matrix 房间 id），与 /state 的 rooms key 一致，
      // 浏览器才能把 SSE 事件归到正确房间。
      const event: TestEvent = { roomId: state.roomId, roomName: def.name, ts: Date.now(), kind, from, text, status, round }
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
      control.realRoomId = realRoomId
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

        // 消费干预指令（pause 挂起 / stop 跳出 / inject 发送 / switch 换人）。
        const shouldBreak = await this.drainControls(roomId, realRoomId, def, emit, round)
        if (shouldBreak) break
        if (control.paused) {
          // 暂停：挂起直到 resume。
          state.paused = true
          emit('system', '系统', '⏸ 已暂停（等待继续）', 'paused', round)
          await new Promise<void>((resolve) => { control.pausedResolve = resolve })
          control.pausedResolve = undefined
          state.paused = false
          emit('system', '系统', '▶ 已继续', 'active', round)
          continue
        }

        round += 1
        state.round = round

        // 收集房间历史（去重）。
        const history = await this.collectHistory(realRoomId)

        // 选当前轮次的同事：switch 指定优先，否则轮流。
        let persona: ColleaguePersona
        if (control.nextColleagueId !== undefined) {
          const found = def.colleagues.find((c) => c.userId === control.nextColleagueId)
          persona = found ?? def.colleagues[(round - 1) % def.colleagues.length]
          control.nextColleagueId = undefined
        } else {
          persona = def.colleagues[(round - 1) % def.colleagues.length]
        }
        state.activeColleague = persona.displayName
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

        // 等数字人回复（仅新增的数字人消息；可被 skip-wait/stop 中断）。
        const twinBefore = await this.countTwinMessages(realRoomId)
        control.skipWait = false
        const twinReply = await this.waitForTwinReply(roomId, realRoomId, twinBefore, this.config.replyTimeoutSecs * 1000)
        if (twinReply !== undefined) {
          emit('twin', this.twin.displayName, twinReply.body, undefined, round)
        } else {
          emit('assert', '系统', undefined, control.skipWait
            ? '已跳过等待（用户干预）'
            : `数字人 ${this.twin.displayName} 未在 ${this.config.replyTimeoutSecs}s 内回复（无响应）`, round)
        }
      }
      state.status = 'done'
      emit('system', '系统', `房间「${def.name}」测试完成（${round} 轮）`, 'done')
      // 房间断言评估（done 后）。
      if (def.asserts !== undefined && def.asserts.length > 0) {
        await this.evaluateAsserts(room, def, state, emit, round)
      }
    } catch (error) {
      state.status = 'error'
      emit('system', '系统', `房间失败: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
    // 房间结束：保留 controls 供查询，但标记 finished（control() 返回友好提示）。
    control.finished = true
  }

  /** 评估房间断言（done 后），结果写入 state.asserts/passed 并推事件。 */
  private async evaluateAsserts(
    room: RunningRoom,
    def: TestRoomDef,
    state: RoomState,
    emit: (kind: TestEvent['kind'], from: string, text?: string, status?: string, round?: number) => void,
    round: number,
  ): Promise<void> {
    const asserts = def.asserts ?? []
    const ctx: AssertContext = {
      roomId: room.roomId,
      events: this.bus.recent(2000).filter((e) => e.roomId === room.roomId),
      twinMessages: 0,
      colleagueMessages: 0,
      rounds: round,
    }
    // 统计数字人/同事消息（从事件流）。
    for (const e of ctx.events) {
      if (e.kind === 'twin') ctx.twinMessages += 1
      else if (e.kind === 'colleague') ctx.colleagueMessages += 1
    }
    const results: Array<{ id: string; label: string; passed: boolean; detail?: string }> = []
    let allPassed = true
    for (const assert of asserts) {
      let passed = false
      let detail: string | undefined
      try {
        switch (assert.kind) {
          case 'twin-replied':
            passed = ctx.twinMessages > 0
            detail = passed ? `数字人回复 ${ctx.twinMessages} 次` : '数字人未回复'
            break
          case 'twin-responded-in-time':
            // 有 assert 事件非"无响应"即认为及时（简单近似：存在 twin 消息即通过）。
            passed = ctx.twinMessages > 0
            detail = passed ? `数字人回复 ${ctx.twinMessages} 次` : '数字人未在超时内回复'
            break
          case 'twin-mentioned-colleague':
            passed = ctx.events.some((e) => e.kind === 'twin' && (e.text ?? '').includes('@'))
            detail = passed ? '数字人回复包含 @提及' : '数字人回复未 @同事'
            break
          case 'message-count':
            passed = ctx.colleagueMessages + ctx.twinMessages >= (assert.target ?? 1)
            detail = `消息总数 ${ctx.colleagueMessages + ctx.twinMessages}（目标 ≥${assert.target ?? 1}）`
            break
          case 'custom':
            if (assert.evaluate !== undefined) passed = await assert.evaluate(ctx)
            else passed = false
            detail = passed ? '自定义断言通过' : '自定义断言失败'
            break
          default:
            passed = false
            detail = `未知断言类型: ${assert.kind}`
        }
      } catch (error) {
        passed = false
        detail = `断言执行错误: ${error instanceof Error ? error.message : String(error)}`
      }
      results.push({ id: assert.id, label: assert.label, passed, detail })
      if (!passed) allPassed = false
      emit('assert-result', '系统', undefined, `${assert.label}: ${passed ? '通过' : '失败'}${detail ? '（' + detail + '）' : ''}`, round)
    }
    state.asserts = results
    state.passed = allPassed
    emit('system', '系统', `断言结果: ${allPassed ? '✅ 全部通过' : `❌ ${results.filter((r) => !r.passed).length}/${results.length} 未通过`}`, allPassed ? 'done' : 'assert-fail', round)
  }

  /** 消费房间干预队列；返回 true 表示应停止循环（stop）。 */
  private async drainControls(
    roomId: string,
    realRoomId: string,
    def: TestRoomDef,
    emit: (kind: TestEvent['kind'], from: string, text?: string, status?: string, round?: number) => void,
    round: number,
  ): Promise<boolean> {
    const control = this.controls.get(roomId)
    if (control === undefined) return false
    while (control.queue.length > 0) {
      const cmd = control.queue.shift()
      if (cmd === undefined) continue
      switch (cmd.action) {
        case 'pause':
          control.paused = true
          emit('system', '系统', '收到暂停指令', 'paused', round)
          break
        case 'resume':
          control.paused = false
          control.pausedResolve?.()
          control.pausedResolve = undefined
          break
        case 'stop':
          emit('system', '系统', '收到停止指令', 'done', round)
          return true
        case 'skip-wait':
          control.skipWait = true
          break
        case 'switch': {
          const found = def.colleagues.find((c) => c.userId === cmd.colleagueId)
          if (found !== undefined) {
            control.nextColleagueId = found.userId
            emit('system', '系统', `已切换：下轮由 ${found.displayName} 发言`, 'active', round)
          }
          break
        }
        case 'inject': {
          if (cmd.text === undefined || cmd.text.trim() === '') break
          if (cmd.asTwin === true) {
            if (this.twinClient === undefined) break
            emit('colleague', this.twin.displayName, cmd.text, undefined, round)
            await this.twinClient.sendText(realRoomId, cmd.text)
          } else {
            const persona = def.colleagues.find((c) => c.userId === cmd.colleagueId) ?? def.colleagues[0]
            if (persona === undefined) break
            const client = this.clients[def.colleagues.indexOf(persona) % this.clients.length]
            emit('colleague', persona.displayName, cmd.text, undefined, round)
            await client.sendText(realRoomId, cmd.text)
          }
          break
        }
        default:
          break
      }
    }
    return false
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

  /** 等数字人回复：轮询房间消息，返回发送后**新增**的数字人消息；可被 skip-wait / stop 中断。 */
  private async waitForTwinReply(
    roomId: string,
    realRoomId: string,
    beforeTwinCount: number,
    timeoutMs: number,
  ): Promise<RoomMessage | undefined> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.stopFlags.has(roomId)) return undefined
      if (this.controls.get(roomId)?.skipWait === true) return undefined
      try {
        const msgs = await this.clients[0].getRoomMessages(realRoomId, 30)
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
