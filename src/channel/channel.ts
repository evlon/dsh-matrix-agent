/**
 * Channel 接口：任何 IM 通道（Matrix / 微信 / 钉钉 / 飞书…）实现的统一契约。
 * 桥接层（dsh-bridge）与通道工具（dsh-tools-channel）只依赖本接口，
 * 换通道 = 换一个实现本接口的 Channel 实例，其余不动。
 *
 * 方法分三类：
 *  - 生命周期/发送：start/stop/sendText/sendTyping/sendDm/sendMentionText
 *  - 感知能力（必需）：isDirectRoom/getRoomName/getRoomMemberCount/getRoomMembers/
 *    getUserInfo/getRecentMessages/listJoinedRooms —— 工具/桥接硬依赖，任何实现都须提供
 *  - 媒体（可选增强）：resolveMediaUrl/downloadMedia —— 未提供时工具回退 base64 元信息
 *
 * @module @evlon/dsh-channel-core/channel
 */

import type {
  ChannelMember,
  ChannelRoomMessage,
  ChannelUserInfo,
  InboundMessage,
  RoomEvent,
} from './types.js'
import type { ChannelState } from './state.js'

export interface Channel {
  start(): Promise<void>
  stop(): Promise<void>
  sendText(roomId: string, plain: string, html?: string): Promise<void>
  sendTyping(roomId: string, active: boolean): Promise<void>
  /** 主动给指定用户发私聊：查既有 1:1 房，无则创建+邀请，再发送。 */
  sendDm?(userId: string, plain: string, html?: string): Promise<{ roomId: string; eventId?: string }>
  /** 向房间发送消息并 @ 一个或多个成员。 */
  sendMentionText?(roomId: string, plain: string, mentions: string[], html?: string): Promise<void>
  /**
   * 接受入群邀请（加入房间）。由桥接层在「主人批准」或「白名单命中」后调用；
   * 通道自身绝不在收到邀请时自动加入——入群决策权归桥接层。
   */
  joinRoom?(roomId: string): Promise<void>
  /** 拒绝入群邀请 / 退出房间（邀请审批被拒时调用，清掉服务端挂起的邀请）。 */
  leaveRoom?(roomId: string): Promise<void>

  // ── 感知能力（通道必需契约）──
  /** 判断是否为私聊房间（2 人房间）。 */
  isDirectRoom(roomId: string): Promise<boolean>
  /** 读取房间名。 */
  getRoomName(roomId: string): Promise<string | undefined>
  /** 房间当前成员数。仅用于群聊上下文标签，绝不全量注入消息。 */
  getRoomMemberCount(roomId: string): Promise<number | undefined>
  /** 房间当前成员列表。 */
  getRoomMembers(roomId: string): Promise<ChannelMember[] | undefined>
  /** 用户资料。 */
  getUserInfo(userId: string): Promise<ChannelUserInfo | undefined>
  /** 房间最近消息（正序）。 */
  getRecentMessages(roomId: string, limit?: number): Promise<ChannelRoomMessage[]>
  /** 列出本账号已加入的房间，附名称/成员数。 */
  listJoinedRooms(): Promise<Array<{ roomId: string; name?: string; memberCount?: number }>>

  // ── 媒体（可选增强）──
  /** 把通道原生媒体 URI 解析为可下载的 HTTP URL。 */
  resolveMediaUrl?(mxc: string): string | undefined
  /** 下载媒体为字节。 */
  downloadMedia?(mxc: string, signal?: AbortSignal): Promise<{ buffer: Uint8Array; mimetype?: string; size: number }>
}

/** 创建 Channel 实例的连接参数（通道无关部分）。 */
export interface ChannelOptions {
  /** 通道接入点（如 Matrix homeserver base URL）。 */
  readonly homeserverUrl: string
  readonly accessToken: string
  readonly userId: string
  readonly state: ChannelState
  readonly onMessage?: (message: InboundMessage) => void
  /** 成员变化 / 资料变更 / 房间信息事件。桥接层按配置决定是否注入 agent。 */
  readonly onRoomEvent?: (event: RoomEvent) => void
  readonly isAllowed?: (sender: string) => boolean
  readonly logger?: {
    warn: (format: string, ...args: unknown[]) => void
    error: (format: string, ...args: unknown[]) => void
    info: (format: string, ...args: unknown[]) => void
  }
  /** 测试接缝。 */
  readonly fetchFn?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
}
