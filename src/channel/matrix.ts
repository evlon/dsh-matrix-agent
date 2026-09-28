/**
 * Matrix 通道实现：零依赖的 Matrix client-server API 客户端（global fetch + /sync 长轮询），
 * 投影为 @evlon/dsh-channel-core 的 Channel 接口。
 *
 * 参照 telegram 插件自写 TelegramClient 的做法：协议面很小（sync / send / typing / join），
 * 不值得为一个 bot 引入带原生 crypto 依赖的 SDK。第一版只支持非加密房间。
 *
 * @module @evlon/dsh-channel-matrix
 */

import { randomUUID } from 'node:crypto'
import type { Channel, ChannelOptions } from './channel.js'
import type {
  ChannelMember,
  ChannelRoomMessage,
  ChannelUserInfo,
  InboundMessage,
  MediaBlock,
  RoomEvent,
  RoomEventKind,
} from './types.js'

/** /sync 响应中我们关心的最小结构。 */
interface SyncResponse {
  next_batch?: string
  rooms?: {
    join?: Record<string, {
      timeline?: { events?: MatrixEventJson[] }
      state?: { events?: MatrixEventJson[] }
    }>
    /**
     * 自己收到的入群邀请。invite_state.events 里含：
     *   - m.room.member（state_key=自己，sender=邀请人，content.membership='invite'）
     *   - m.room.create（sender/content.creator=建房人）
     *   - m.room.name（content.name=群名）
     * 这些字段是「请示主人」时说明「谁把你拉进了哪个群」的唯一来源。
     */
    invite?: Record<string, { invite_state?: { events?: MatrixEventJson[] } }>
  }
}

/** 时间线事件的最小结构。 */
interface MatrixEventJson {
  type?: string
  sender?: string
  event_id?: string
  origin_server_ts?: number
  state_key?: string
  content?: {
    msgtype?: string
    body?: string
    format?: string
    formatted_body?: string
    url?: string
    mimetype?: string
    filename?: string
    info?: { mimetype?: string; size?: number; w?: number; h?: number; filename?: string }
    geo_uri?: string
    'm.relates_to'?: {
      'm.in_reply_to'?: { event_id?: string }
      'm.thread'?: { event_id?: string }
    }
    'm.new_content'?: {
      body?: string
      format?: string
      formatted_body?: string
      msgtype?: string
      url?: string
    }
    membership?: string
    displayname?: string
    avatar_url?: string
    name?: string
    topic?: string
    /** m.room.member 的直聊标记（邀请是否声明为 1:1 私聊）。 */
    is_direct?: boolean
    /** m.room.create 的建房人（无 member 事件时作邀请人兜底）。 */
    creator?: string
  }
}

const SYNC_TIMEOUT_MS = 30_000
const SYNC_FILTER = JSON.stringify({ room: { timeline: { limit: 10 } } })
const BASE_BACKOFF_MS = 1000
const DM_CACHE_TTL_MS = 60_000
const NAME_CACHE_TTL_MS = 5 * 60_000
const COUNT_CACHE_TTL_MS = 5 * 60_000
const MEMBERS_CACHE_TTL_MS = 5 * 60_000
const USER_INFO_CACHE_TTL_MS = 10 * 60_000

export class MatrixChannel implements Channel {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly sleepFn: (ms: number) => Promise<void>
  private readonly warnedEncrypted = new Set<string>()
  private readonly dmCache = new Map<string, { isDm: boolean; at: number }>()
  private readonly nameCache = new Map<string, { name?: string; at: number }>()
  private readonly countCache = new Map<string, { count: number | undefined; at: number }>()
  private readonly membersCache = new Map<string, { value: ChannelMember[]; at: number }>()
  private readonly userInfoCache = new Map<string, { value: ChannelUserInfo; at: number }>()
  private readonly seenRoomEvents = new Set<string>()
  /**
   * 已上报过的待决邀请房间（防重复请示主人）。
   * Matrix 的邀请通常只投递一次，但 sync 重试 / 游标未推进时会重复返回同一房，
   * 若不去重会对主人重复私聊+重复入收件箱。加入或退出该房后清除。
   */
  private readonly reportedInvites = new Set<string>()
  /** 自己发起的私聊房映射：userId → roomId，避免 invite 未接受窗口内重复 create-room。 */
  private readonly dmRoomsByUser = new Map<string, string>()
  private stopped = false
  private loop: Promise<void> | undefined
  private lifecycleAbort: AbortController | undefined

  constructor(private readonly options: ChannelOptions) {
    this.baseUrl = options.homeserverUrl.replace(/\/+$/, '')
    this.fetchFn = options.fetchFn ?? fetch
    this.sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** 通道层轻量诊断：优先写 options.logger（桥接层注入），否则静默。 */
  private log(format: string, ...args: unknown[]): void {
    this.options.logger?.info(format, ...args)
  }

  /** 完成首次成功同步后进入后台长轮询循环；首次失败则抛出。 */
  async start(): Promise<void> {
    if (this.loop !== undefined) return
    this.stopped = false
    this.lifecycleAbort = new AbortController()
    await this.syncOnce()
    this.loop = this.syncLoop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.lifecycleAbort?.abort()
    await this.loop
    this.loop = undefined
  }

  private async syncLoop(): Promise<void> {
    let backoff = BASE_BACKOFF_MS
    while (!this.stopped) {
      try {
        await this.syncOnce()
        backoff = BASE_BACKOFF_MS
      } catch (error) {
        if (this.stopped) return
        this.options.logger?.warn('[dsh-channel-matrix] sync failed: %s', messageOf(error))
        await this.sleepFn(backoff)
        backoff = Math.min(backoff * 2, 15_000)
      }
    }
  }

  private async syncOnce(): Promise<void> {
    if (this.stopped) return
    const signal = AbortSignal.any([this.lifecycleAbort!.signal, AbortSignal.timeout(SYNC_TIMEOUT_MS + 20_000)])
    const url = new URL(`${this.baseUrl}/_matrix/client/v3/sync`)
    url.searchParams.set('timeout', String(SYNC_TIMEOUT_MS))
    url.searchParams.set('filter', SYNC_FILTER)
    const since = this.options.state.syncToken
    if (since !== undefined) url.searchParams.set('since', since)
    const fetchPromise = this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.options.accessToken}` },
      signal,
    })
    const timeoutMs = SYNC_TIMEOUT_MS + 20_000
    const response = await Promise.race([
      fetchPromise,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          this.options.logger?.warn('[dsh-channel-matrix] sync hard-timeout after %dms', timeoutMs)
          reject(new Error(`sync hard-timeout after ${timeoutMs}ms`))
        }, timeoutMs)
        fetchPromise.then(() => clearTimeout(timer), () => clearTimeout(timer))
      }),
    ])
    if (!response.ok) throw new Error(`sync HTTP ${response.status}`)
    const data = (await response.json()) as SyncResponse
    if (typeof data.next_batch === 'string') this.options.state.syncToken = data.next_batch
    this.processRooms(data.rooms)
  }

  private processRooms(rooms: SyncResponse['rooms']): void {
    if (rooms === undefined) return
    if (rooms.invite !== undefined) {
      for (const [roomId, room] of Object.entries(rooms.invite)) {
        // 关键：通道层绝不自动入群。只把「谁邀请了我、什么群」投影成 self-invite 事件，
        // 由桥接层按「主人白名单 / 请示主人」决策后再回调 joinRoom / leaveRoom。
        // （旧实现在此无条件 joinRoom，等于任何人拉群即进，无任何门控。）
        // 去重：同一房间的邀请只上报一次，避免重复请示主人。
        if (this.reportedInvites.has(roomId)) continue
        this.reportedInvites.add(roomId)
        const info = this.parseInvite(room)
        this.options.onRoomEvent?.({
          kind: 'self-invite',
          roomId,
          ...(info.inviter !== undefined ? { userId: info.inviter } : {}),
          eventId: `self-invite-${roomId}-${Date.now()}`,
          at: Date.now(),
          detail: {
            ...(info.inviter !== undefined ? { inviter: info.inviter } : {}),
            ...(info.roomName !== undefined ? { roomName: info.roomName } : {}),
            isDirect: info.isDirect,
          },
        })
      }
    }
    if (rooms.join === undefined) return
    for (const [roomId, room] of Object.entries(rooms.join)) {
      const stateEvents = room.state?.events
      if (stateEvents !== undefined) {
        for (const event of stateEvents) this.onStateEvent(roomId, event)
      }
      const events = room.timeline?.events
      if (events === undefined) continue
      for (const event of events) this.onTimelineEvent(roomId, event)
    }
  }

  /**
   * 解析 rooms.invite[roomId].invite_state，取「邀请人 / 群名 / 是否私聊」。
   * 邀请人优先级：m.room.member（state_key=自己，membership=invite）的 sender
   *   → m.room.create 的 content.creator / sender。
   * 实测（im-ipm.ict.cmcc）：二者一致，member.sender 最可靠。
   */
  private parseInvite(room: { invite_state?: { events?: MatrixEventJson[] } } | undefined): { inviter?: string; roomName?: string; isDirect: boolean } {
    const events = room?.invite_state?.events ?? []
    let inviter: string | undefined
    let creator: string | undefined
    let roomName: string | undefined
    let isDirect = false
    for (const event of events) {
      if (event.type === 'm.room.member') {
        if (event.content?.membership === 'invite') {
          if (event.content?.is_direct === true) isDirect = true
          // state_key 是自己 → 这条就是「谁邀请了我」。
          if (event.state_key === this.options.userId && inviter === undefined) inviter = event.sender
        }
      } else if (event.type === 'm.room.create') {
        creator = event.content?.creator ?? event.sender
        if (event.content?.is_direct === true) isDirect = true
      } else if (event.type === 'm.room.name') {
        if (typeof event.content?.name === 'string' && event.content.name.trim() !== '') {
          roomName = event.content.name
        }
      }
    }
    const resolved = inviter ?? creator
    return {
      ...(resolved !== undefined ? { inviter: resolved } : {}),
      ...(roomName !== undefined ? { roomName } : {}),
      isDirect,
    }
  }

  private onStateEvent(roomId: string, event: MatrixEventJson): void {
    if (this.stopped) return
    const eventId = event.event_id
    if (eventId === undefined) return
    if (this.seenRoomEvents.has(eventId)) return
    this.seenRoomEvents.add(eventId)
    if (this.seenRoomEvents.size > 5000) {
      const toDelete = Array.from(this.seenRoomEvents).slice(0, 2500)
      for (const id of toDelete) this.seenRoomEvents.delete(id)
    }

    const sender = event.sender
    const at = event.origin_server_ts ?? Date.now()
    if (event.type === 'm.room.member') {
      const userId = event.state_key ?? event.sender
      if (userId === undefined) return
      const content = event.content
      const membership = content?.membership
      if (userId === this.options.userId) {
        this.invalidateMemberCaches(roomId)
        return
      }
      if (membership === 'invite' || membership === 'leave') {
        this.invalidateMemberCaches(roomId)
        const kind: RoomEventKind = membership === 'invite' ? 'invite' : 'leave'
        this.options.onRoomEvent?.({ kind, roomId, userId, eventId, at })
        return
      }
      if (membership === 'join') {
        this.invalidateMemberCaches(roomId)
        const alreadyMember = this.isKnownMember(roomId, userId)
        const hasProfile = content?.displayname !== undefined || content?.avatar_url !== undefined
        if (alreadyMember && hasProfile) {
          this.userInfoCache.delete(userId)
          this.options.onRoomEvent?.({
            kind: 'profile', roomId, userId, eventId, at,
            detail: {
              ...(content?.displayname !== undefined ? { displayName: content.displayname } : {}),
              ...(content?.avatar_url !== undefined ? { avatarUrl: content.avatar_url } : {}),
            },
          })
          return
        }
        this.options.onRoomEvent?.({ kind: 'join', roomId, userId, eventId, at })
        return
      }
      if (content?.displayname !== undefined || content?.avatar_url !== undefined) {
        this.userInfoCache.delete(userId)
        this.options.onRoomEvent?.({
          kind: 'profile', roomId, userId, eventId, at,
          detail: {
            ...(content?.displayname !== undefined ? { displayName: content.displayname } : {}),
            ...(content?.avatar_url !== undefined ? { avatarUrl: content.avatar_url } : {}),
          },
        })
      }
      return
    }
    if (event.type === 'm.room.name') {
      this.nameCache.delete(roomId)
      this.options.onRoomEvent?.({ kind: 'room-name', roomId, eventId, at, detail: { name: event.content?.name } })
      return
    }
    if (event.type === 'm.room.topic') {
      this.options.onRoomEvent?.({ kind: 'room-topic', roomId, eventId, at, detail: { topic: event.content?.topic } })
    }
  }

  private invalidateMemberCaches(roomId: string): void {
    this.membersCache.delete(roomId)
    this.countCache.delete(roomId)
    this.dmCache.delete(roomId)
  }

  private isKnownMember(roomId: string, userId: string): boolean {
    const cached = this.membersCache.get(roomId)
    if (cached === undefined) return false
    return cached.value.some((m) => m.userId === userId)
  }

  private onTimelineEvent(roomId: string, event: MatrixEventJson): void {
    if (this.stopped) return
    if (event.type === 'm.room.encrypted') {
      if (!this.warnedEncrypted.has(roomId)) {
        this.warnedEncrypted.add(roomId)
        this.options.logger?.warn('[dsh-channel-matrix] room %s is encrypted; cannot decrypt yet', roomId)
      }
      return
    }
    if (event.type === 'm.room.member' || event.type === 'm.room.name' || event.type === 'm.room.topic') {
      this.onStateEvent(roomId, event)
      return
    }
    if (event.type !== 'm.room.message') return
    const sender = event.sender
    if (sender === undefined || sender === this.options.userId) return
    const content = event.content
    if (content === undefined || typeof content.body !== 'string') return
    const msgtype = content.msgtype ?? 'm.text'
    const eventId = event.event_id
    if (eventId === undefined || this.options.state.hasSeen(eventId)) return
    this.options.state.markSeen(eventId)
    if (!(this.options.isAllowed?.(sender) ?? true)) return

    const MEDIA_MSGTYPES = new Set(['m.image', 'm.file', 'm.audio', 'm.video', 'm.location'])
    let text = content.body
    let media: MediaBlock[] = []
    if (MEDIA_MSGTYPES.has(msgtype)) {
      const isLocation = msgtype === 'm.location'
      const mxc = isLocation ? undefined : (content.url?.startsWith('mxc://') ? content.url : undefined)
      const filename = content.filename ?? content.info?.filename
      const caption = filename !== undefined && content.body !== filename ? content.body : undefined
      media = [{
        msgtype,
        body: content.body,
        mimetype: content.mimetype ?? content.info?.mimetype,
        url: content.url,
        mxc,
        size: content.info?.size,
        filename,
        width: content.info?.w,
        height: content.info?.h,
        geoUri: content.geo_uri,
        ...(caption !== undefined ? { caption } : {}),
      }]
      if (msgtype !== 'm.text' && msgtype !== 'm.notice' && caption === undefined) {
        text = ''
      }
    }

    const relatesTo = content['m.relates_to']
    const replyToEventId = relatesTo?.['m.in_reply_to']?.event_id
    const threadEventId = relatesTo?.['m.thread']?.event_id
    const isEdit = msgtype === 'm.replace'
    const newContent = content['m.new_content']
    let effectiveText = text
    let effectiveMedia = media
    if (isEdit && newContent !== undefined) {
      effectiveText = newContent.body ?? text
      if (newContent.body !== undefined && MEDIA_MSGTYPES.has(newContent.msgtype ?? msgtype)) {
        const nc = newContent
        const isLoc = (nc.msgtype ?? msgtype) === 'm.location'
        const ncMxc = isLoc ? undefined : (nc.url?.startsWith('mxc://') ? nc.url : undefined)
        effectiveMedia = [{
          msgtype: nc.msgtype ?? msgtype,
          body: nc.body ?? text,
          mimetype: content.mimetype ?? content.info?.mimetype,
          url: nc.url,
          mxc: ncMxc,
          size: content.info?.size,
          filename: content.filename ?? content.info?.filename,
          ...(nc.formatted_body !== undefined ? { caption: nc.body ?? text } : {}),
        }]
      }
    }
    const formattedHtml = content.formatted_body ?? newContent?.formatted_body
    const isEmote = msgtype === 'm.emote'

    this.options.onMessage?.({
      roomId,
      sender,
      text: effectiveText,
      media: effectiveMedia,
      eventId,
      ...(formattedHtml !== undefined ? { formattedHtml } : {}),
      ...(replyToEventId !== undefined ? { replyToEventId } : {}),
      ...(threadEventId !== undefined ? { threadEventId } : {}),
      ...(isEdit ? { isEdit: true, ...(relatesTo?.['m.in_reply_to']?.event_id !== undefined ? { editTargetEventId: relatesTo['m.in_reply_to'].event_id } : {}) } : {}),
      ...(isEmote ? { isEmote: true } : {}),
    })
  }

  async sendText(roomId: string, plain: string, html?: string): Promise<void> {
    const content: Record<string, unknown> = { msgtype: 'm.text', body: plain }
    if (html !== undefined) {
      content.format = 'org.matrix.custom.html'
      content.formatted_body = html
    }
    await this.sendEvent(roomId, 'm.room.message', content)
  }

  async sendTyping(roomId: string, active: boolean): Promise<void> {
    const body: Record<string, unknown> = { typing: active }
    if (active) body.timeout = 15_000
    const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.options.userId)}`
    const response = await this.fetchFn(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`typing HTTP ${response.status}`)
  }

  async isDirectRoom(roomId: string): Promise<boolean> {
    const cached = this.dmCache.get(roomId)
    if (cached !== undefined && Date.now() - cached.at < DM_CACHE_TTL_MS) return cached.isDm
    try {
      const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) throw new Error(`joined_members HTTP ${response.status}`)
      const data = (await response.json()) as { joined?: Record<string, unknown> }
      const count = data.joined === undefined ? 0 : Object.keys(data.joined).length
      const isDm = count > 0 && count <= 2
      this.dmCache.set(roomId, { isDm, at: Date.now() })
      return isDm
    } catch {
      return false
    }
  }

  async getRoomName(roomId: string): Promise<string | undefined> {
    const cached = this.nameCache.get(roomId)
    if (cached !== undefined && Date.now() - cached.at < NAME_CACHE_TTL_MS) return cached.name
    try {
      const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`
      this.log('[dsh-channel-matrix] GET room-name %s', roomId)
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) return undefined
      const data = (await response.json()) as { name?: string }
      const name = typeof data.name === 'string' && data.name.trim() !== '' ? data.name.trim() : undefined
      this.nameCache.set(roomId, { name, at: Date.now() })
      return name
    } catch {
      return undefined
    }
  }

  async getRoomMemberCount(roomId: string): Promise<number | undefined> {
    const cached = this.countCache.get(roomId)
    if (cached !== undefined && Date.now() - cached.at < COUNT_CACHE_TTL_MS) return cached.count
    try {
      const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`
      this.log('[dsh-channel-matrix] GET member-count %s', roomId)
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) return undefined
      const data = (await response.json()) as { joined?: Record<string, unknown> }
      const count = data.joined === undefined ? undefined : Object.keys(data.joined).length
      this.countCache.set(roomId, { count, at: Date.now() })
      return count
    } catch {
      return undefined
    }
  }

  async getRoomMembers(roomId: string): Promise<ChannelMember[] | undefined> {
    const cached = this.membersCache.get(roomId)
    if (cached !== undefined && Date.now() - cached.at < MEMBERS_CACHE_TTL_MS) return cached.value
    try {
      const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`
      this.log('[dsh-channel-matrix] GET members %s', roomId)
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) return undefined
      const data = (await response.json()) as {
        joined?: Record<string, { display_name?: string; avatar_url?: string }>
      }
      const joined = data.joined ?? {}
      const members: ChannelMember[] = Object.entries(joined).map(([userId, info]) => ({
        userId,
        ...(typeof info?.display_name === 'string' && info.display_name !== '' ? { displayName: info.display_name } : {}),
        ...(typeof info?.avatar_url === 'string' && info.avatar_url !== '' ? { avatarUrl: info.avatar_url } : {}),
      }))
      this.membersCache.set(roomId, { value: members, at: Date.now() })
      return members
    } catch {
      return undefined
    }
  }

  async getUserInfo(userId: string): Promise<ChannelUserInfo | undefined> {
    const cached = this.userInfoCache.get(userId)
    if (cached !== undefined && Date.now() - cached.at < USER_INFO_CACHE_TTL_MS) return cached.value
    try {
      const url = `${this.baseUrl}/_matrix/client/v3/profile/${encodeURIComponent(userId)}`
      this.log('[dsh-channel-matrix] GET profile %s', userId)
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) return undefined
      const data = (await response.json()) as { displayname?: string; avatar_url?: string }
      const info: ChannelUserInfo = {
        userId,
        ...(typeof data.displayname === 'string' && data.displayname !== '' ? { displayName: data.displayname } : {}),
        ...(typeof data.avatar_url === 'string' && data.avatar_url !== '' ? { avatarUrl: data.avatar_url } : {}),
      }
      this.userInfoCache.set(userId, { value: info, at: Date.now() })
      return info
    } catch {
      return undefined
    }
  }

  async getRecentMessages(roomId: string, limit = 20): Promise<ChannelRoomMessage[]> {
    try {
      const url = new URL(`${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`)
      url.searchParams.set('dir', 'b')
      url.searchParams.set('limit', String(Math.max(1, Math.min(limit, 100))))
      this.log('[dsh-channel-matrix] GET messages %s', roomId)
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) return []
      const data = (await response.json()) as {
        chunk?: Array<{
          event_id?: string
          sender?: string
          origin_server_ts?: number
          type?: string
          content?: { body?: string; msgtype?: string }
        }>
      }
      const chunk = data.chunk ?? []
      const messages: ChannelRoomMessage[] = []
      for (const event of chunk.reverse()) {
        if (event.type !== 'm.room.message') continue
        if (event.sender === this.options.userId) continue
        const body = event.content?.body
        if (typeof body !== 'string' || body.trim() === '') continue
        messages.push({
          eventId: event.event_id ?? '',
          sender: event.sender ?? '',
          body: body.trim(),
          timestamp: event.origin_server_ts ?? 0,
        })
      }
      return messages
    } catch {
      return []
    }
  }

  /**
   * 接受入群邀请（POST /rooms/{roomId}/join）。
   * 由桥接层在「邀请人已在批准名单」或「主人本次批准」后调用。
   * 通道层自身绝不调用本方法——入群决策权归桥接层。
   */
  async joinRoom(roomId: string): Promise<void> {
    const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.options.accessToken}` },
      body: '{}',
    })
    if (!response.ok) throw new Error(`join HTTP ${response.status}`)
    this.reportedInvites.delete(roomId)
    this.options.onRoomEvent?.({
      kind: 'self-join',
      roomId,
      eventId: `self-join-${roomId}-${Date.now()}`,
      at: Date.now(),
    })
  }

  /**
   * 拒绝入群邀请 / 退出房间（POST /rooms/{roomId}/leave）。
   * 主人拒绝邀请时调用：清掉服务端挂起的邀请，避免它一直挂在账号上。
   * 对已加入的房间则等价于退群（同样用于「主人事后反悔」的场景）。
   */
  async leaveRoom(roomId: string): Promise<void> {
    const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.options.accessToken}` },
      body: '{}',
    })
    if (!response.ok) throw new Error(`leave HTTP ${response.status}`)
    this.reportedInvites.delete(roomId)
    this.invalidateMemberCaches(roomId)
    this.dmRoomsByUser.delete(roomId)
    this.options.logger?.info('[dsh-channel-matrix] left room %s', roomId)
  }

  resolveMediaUrl(mxc: string): string | undefined {
    const m = /^mxc:\/\/([^/]+)\/([^/]+)$/.exec(mxc)
    if (!m || m[1] === undefined || m[2] === undefined) return undefined
    return `${this.baseUrl}/_matrix/media/v3/download/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`
  }

  async downloadMedia(mxc: string, signal?: AbortSignal): Promise<{ buffer: Uint8Array; mimetype?: string; size: number }> {
    const httpUrl = this.resolveMediaUrl(mxc)
    if (httpUrl === undefined) throw new Error(`无效的 mxc URL: ${mxc}`)
    const response = await this.fetchFn(httpUrl, {
      headers: { Authorization: `Bearer ${this.options.accessToken}` },
      ...(signal !== undefined ? { signal } : {}),
    })
    if (!response.ok) throw new Error(`media download HTTP ${response.status}`)
    const arrayBuffer = await response.arrayBuffer()
    const buffer = new Uint8Array(arrayBuffer)
    const mimetype = response.headers?.get?.('content-type') ?? undefined
    return { buffer, mimetype, size: buffer.length }
  }

  async listJoinedRooms(): Promise<Array<{ roomId: string; name?: string; memberCount?: number }>> {
    try {
      const url = `${this.baseUrl}/_matrix/client/v3/joined_rooms`
      this.log('[dsh-channel-matrix] GET joined_rooms')
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) return []
      const data = (await response.json()) as { joined_rooms?: string[] }
      const rooms = data.joined_rooms ?? []
      const result = await Promise.all(rooms.map(async (roomId) => {
        const [name, memberCount] = await Promise.all([
          this.getRoomName(roomId),
          this.getRoomMemberCount(roomId),
        ])
        return {
          roomId,
          ...(name !== undefined ? { name } : {}),
          ...(memberCount !== undefined ? { memberCount } : {}),
        }
      }))
      return result
    } catch {
      return []
    }
  }

  async sendEvent(roomId: string, type: string, content: Record<string, unknown>): Promise<void> {
    const txnId = `${Date.now()}-${randomUUID()}`
    const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${type}/${txnId}`
    const response = await this.fetchFn(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(content),
    })
    if (!response.ok) throw new Error(`send HTTP ${response.status}`)
  }

  async sendDm(userId: string, plain: string, html?: string): Promise<{ roomId: string; eventId?: string }> {
    const remembered = this.dmRoomsByUser.get(userId)
    if (remembered !== undefined) {
      await this.sendText(remembered, plain, html)
      return { roomId: remembered }
    }
    const existing = await this.findDirectRoomWith(userId)
    if (existing !== undefined) {
      this.dmRoomsByUser.set(userId, existing)
      await this.sendText(existing, plain, html)
      return { roomId: existing }
    }
    const roomId = await this.createDirectRoom(userId)
    this.dmRoomsByUser.set(userId, roomId)
    await this.sendText(roomId, plain, html)
    return { roomId }
  }

  private async findDirectRoomWith(userId: string): Promise<string | undefined> {
    try {
      const url = `${this.baseUrl}/_matrix/client/v3/joined_rooms`
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) throw new Error(`joined_rooms HTTP ${response.status}`)
      const data = (await response.json()) as { joined_rooms?: string[] }
      const rooms = data.joined_rooms ?? []
      for (const roomId of rooms) {
        const members = await this.getRoomMembers(roomId)
        if (members === undefined) continue
        if (members.length <= 2 && members.some((m) => m.userId === userId)) {
          return roomId
        }
      }
      return undefined
    } catch {
      return undefined
    }
  }

  private async createDirectRoom(userId: string): Promise<string> {
    const url = `${this.baseUrl}/_matrix/client/v3/createRoom`
    const body = {
      preset: 'private_chat',
      invite: [userId],
      is_direct: true,
    }
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`createRoom HTTP ${response.status}`)
    const data = (await response.json()) as { room_id?: string }
    const roomId = data.room_id
    if (roomId === undefined) throw new Error('createRoom returned no room_id')
    this.dmCache.delete(roomId)
    return roomId
  }

  async sendMentionText(roomId: string, plain: string, mentions: string[], html?: string): Promise<void> {
    const links = await Promise.all(mentions.map(async (userId) => {
      let name = localpartOf(userId)
      try {
        const info = await this.getUserInfo(userId)
        if (info?.displayName !== undefined && info.displayName !== '') name = info.displayName
      } catch {
        // 保持 localpart 兜底
      }
      return { userId, name }
    }))
    const htmlBody = links.map((l) => `<a href="https://matrix.to/#/${encodeURIComponent(l.userId)}">${escapeHtml(l.name)}</a>`).join(' ')
    const fallback = links.map((l) => `@${l.name}`).join(' ')
    const content: Record<string, unknown> = {
      msgtype: 'm.text',
      body: html !== undefined ? `${html}\n\n${fallback}` : `${plain}\n\n${fallback}`,
      format: 'org.matrix.custom.html',
      formatted_body: html !== undefined ? `${html}<br/>${htmlBody}` : `${escapeHtml(plain)}<br/>${htmlBody}`,
    }
    await this.sendEvent(roomId, 'm.room.message', content)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function localpartOf(userId: string): string {
  const at = userId.indexOf(':')
  return userId.startsWith('@') && at > 0 ? userId.slice(1, at) : userId
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
