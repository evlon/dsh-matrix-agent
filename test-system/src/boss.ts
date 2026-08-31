/**
 * 老板代理（BossAgent）：测试系统模拟真实老板。
 * - 用老板账号登录 Matrix，监听与数字人的私聊房（数字人 sendDm 建）
 * - 看到「【任务请示】」→ 自动回复批准（如"批准"）
 * - 看到「【交付确认】」→ 自动回复"交付"
 * - 记录所有收到的 DM（供断言：数字人是否真的私聊了老板）
 */
import { MatrixClient, type RoomMessage } from './matrix-client.js'

export interface BossDmEvent {
  roomId: string
  ts: number
  /** 数字人发来的请示/确认文本。 */
  text: string
  /** 老板的自动回复。 */
  reply: string
  /** 请示 or 确认。 */
  kind: 'clarify' | 'confirm'
}

export interface BossAgentOptions {
  homeserver: string
  bossUserId: string
  bossAccessToken: string
  /** 轮询间隔 ms。默认 2000。 */
  pollMs?: number
  /** 测试接缝。 */
  fetchFn?: typeof fetch
}

export class BossAgent {
  private readonly client: MatrixClient
  private readonly bossUserId: string
  private readonly pollMs: number
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly seenEvents = new Set<string>()
  /** 所有收到的数字人 DM（供断言）。 */
  readonly dmEvents: BossDmEvent[] = []
  private readonly dmByRoom = new Map<string, { lastText: string; replied: boolean }>()
  /** 老板代理启动时间：只处理此时间之后的新请示，避免重放历史 DM 房里的旧请示。 */
  private readonly startedAt = Date.now()

  constructor(options: BossAgentOptions) {
    this.bossUserId = options.bossUserId
    this.pollMs = options.pollMs ?? 2000
    this.client = new MatrixClient({
      homeserver: options.homeserver,
      account: { userId: options.bossUserId, displayName: localpart(options.bossUserId), accessToken: options.bossAccessToken },
      fetchFn: options.fetchFn,
    })
  }

  /** 启动轮询：监听所有已加入房间，找数字人发来的请示/确认并自动回复。 */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => void this.poll(), this.pollMs)
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** 数字人是否私聊过老板（任一请示/确认 DM）。 */
  get hasTwinDm(): boolean {
    return this.dmEvents.length > 0
  }

  /** 老板是否回复过批准。 */
  get hasApproved(): boolean {
    return this.dmEvents.some((e) => e.kind === 'clarify' && e.reply !== '')
  }

  private async poll(): Promise<void> {
    try {
      // 先接受所有待处理邀请（数字人 sendDm 会 create-room + invite 老板，
      // 不接受则 joinedRooms 永远看不到请示房，导致请示无人批准）。
      try {
        const invited = await this.client.invitedRooms()
        for (const roomId of invited) {
          await this.client.joinRoom(roomId)
          console.log(`[boss] 已加入邀请房 ${roomId}`)
        }
      } catch { /* 邀请查询/接受失败忽略，下一轮重试 */ }

      const rooms = await this.client.joinedRooms()
      for (const roomId of rooms) {
        try {
          const msgs = await this.client.getRoomMessages(roomId, 20)
          await this.handleRoom(roomId, msgs)
        } catch { /* 单房失败忽略 */ }
      }
    } catch { /* 轮询失败忽略 */ }
    if (this.timer !== undefined) {
      this.timer = setTimeout(() => void this.poll(), this.pollMs)
    }
  }

  private async handleRoom(roomId: string, msgs: RoomMessage[]): Promise<void> {
    // 只看数字人发来的消息（排除自己/其他同事）。
    for (const msg of msgs) {
      // 忽略老板代理启动之前的历史消息：否则会重放历史 DM 房里的旧请示，
      // 对已经不存在的任务重复批准。
      if (msg.timestamp < this.startedAt) continue
      // 找数字人的消息：数字人 id 未知时按内容特征（【任务请示】【交付确认】）。
      const text = msg.body
      if (!text.includes('【任务请示】') && !text.includes('【交付确认】')) continue
      const dedupKey = `${roomId}:${msg.eventId}`
      if (this.seenEvents.has(dedupKey)) continue
      this.seenEvents.add(dedupKey)

      const isClarify = text.includes('【任务请示】')
      const kind = isClarify ? 'clarify' as const : 'confirm' as const
      const reply = isClarify ? '批准' : '交付'
      // 自动回复（老板行为）。
      try {
        await this.client.sendText(roomId, reply)
        this.dmEvents.push({ roomId, ts: Date.now(), text, reply, kind })
        console.log(`[boss] 收到数字人${kind === 'clarify' ? '请示' : '确认'}，已回复「${reply}」`)
      } catch (error) {
        console.error(`[boss] 回复失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

function localpart(userId: string): string {
  const at = userId.indexOf(':')
  return userId.startsWith('@') && at > 0 ? userId.slice(1, at) : userId
}
