/**
 * 多账号 Matrix 客户端：测试系统的"同事"账号。
 * 职责：create-room + invite 数字人、发消息、轮询拉取房间消息（含数字人回复）。
 * 参考 dsh-matrix-agent/src/matrix.ts 已验证的 API 模式。
 */
import type { ColleagueAccount } from './config.js'

/** 一条房间消息（精简投影）。 */
export interface RoomMessage {
  eventId: string
  sender: string
  body: string
  timestamp: number
}

export interface MatrixClientOptions {
  homeserver: string
  account: ColleagueAccount
  /** 测试接缝。 */
  fetchFn?: typeof fetch
}

export class MatrixClient {
  private readonly baseUrl: string
  private readonly account: ColleagueAccount
  private readonly fetchFn: typeof fetch

  constructor(options: MatrixClientOptions) {
    this.baseUrl = options.homeserver
    this.account = options.account
    this.fetchFn = options.fetchFn ?? fetch
  }

  get userId(): string {
    return this.account.userId
  }

  get displayName(): string {
    return this.account.displayName
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.account.accessToken}` }
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchFn(url, init)
    if (!res.ok) {
      let detail = ''
      try {
        const j = await res.json() as { error?: string }
        detail = j.error ?? ''
      } catch { /* 非 JSON */ }
      throw new Error(`Matrix ${res.status} ${url}: ${detail}`)
    }
    return await res.json() as T
  }

  /** 创建房间（public_chat + invite 目标），返回 roomId。 */
  async createRoom(name: string, inviteUserIds: string[]): Promise<string> {
    const data = await this.json<{ room_id?: string }>(`${this.baseUrl}/_matrix/client/v3/createRoom`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        preset: 'public_chat',
        invite: inviteUserIds,
        initial_state: [{ type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'shared' } }],
      }),
    })
    if (data.room_id === undefined) throw new Error('createRoom 未返回 room_id')
    return data.room_id
  }

  /** 发送文本消息。 */
  async sendText(roomId: string, text: string): Promise<string> {
    const txnId = `t${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const data = await this.json<{ event_id?: string }>(
      `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      {
        method: 'PUT',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'm.text', body: text }),
      },
    )
    return data.event_id ?? ''
  }

  /** 拉取房间最近消息（不区分发送者，供 orchestrator 观察数字人回复）。 */
  async getRoomMessages(roomId: string, limit = 30): Promise<RoomMessage[]> {
    const data = await this.json<{ chunk?: Array<Record<string, unknown>> }>(
      `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`,
      { headers: this.headers() },
    )
    const chunk = data.chunk ?? []
    const out: RoomMessage[] = []
    for (const ev of chunk) {
      if (ev.type !== 'm.room.message') continue
      const content = ev.content as { msgtype?: string; body?: unknown } | undefined
      if (content?.msgtype !== 'm.text') continue
      if (typeof content.body !== 'string') continue
      const sender = ev.sender
      if (typeof sender !== 'string') continue
      out.push({
        eventId: String(ev.event_id ?? ''),
        sender,
        body: content.body,
        timestamp: typeof ev.origin_server_ts === 'number' ? ev.origin_server_ts : Date.now(),
      })
    }
    return out.reverse() // dir=b 返回倒序，转正序
  }

  /** 已加入的房间列表。 */
  async joinedRooms(): Promise<string[]> {
    const data = await this.json<{ joined_rooms?: string[] }>(
      `${this.baseUrl}/_matrix/client/v3/joined_rooms`,
      { headers: this.headers() },
    )
    return data.joined_rooms ?? []
  }

  /** 收到邀请但尚未加入的房间列表（用 /sync 拿 rooms.invite）。 */
  async invitedRooms(): Promise<string[]> {
    const data = await this.json<{ rooms?: { invite?: Record<string, unknown> } }>(
      `${this.baseUrl}/_matrix/client/v3/sync?timeout=0`,
      { headers: this.headers() },
    )
    return Object.keys(data.rooms?.invite ?? {})
  }

  /** 接受邀请加入房间。 */
  async joinRoom(roomId: string): Promise<void> {
    await this.json<{ room_id?: string }>(
      `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: '{}' },
    )
  }

  /** 房间成员 userId 列表。 */
  async getRoomMembers(roomId: string): Promise<string[]> {
    const data = await this.json<{ joined?: Record<string, unknown> }>(
      `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
      { headers: this.headers() },
    )
    return Object.keys(data.joined ?? {})
  }
}
