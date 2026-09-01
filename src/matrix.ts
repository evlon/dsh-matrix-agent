/**
 * Matrix 通道层向后兼容 shim：现在 MatrixChannel 与通道抽象已拆到独立包。
 * 本文件保留旧的导出面（MatrixMember/MatrixUserInfo/MatrixRoomMessage 等旧名），
 * 从 @evlon/dsh-channel-matrix / @evlon/dsh-channel-core 转发，避免一次性改动 bridge/tools。
 *
 * 后续阶段把 bridge.ts / tools.ts 的 import 直接改到新包后，本文件即可删除。
 *
 * @module dsh-matrix-agent/matrix（兼容 shim）
 */

import type {
  ChannelMember,
  ChannelRoomMessage,
  ChannelUserInfo,
} from '@evlon/dsh-channel-core'

export { MatrixChannel } from '@evlon/dsh-channel-matrix'
export type {
  Channel,
  ChannelOptions,
  ChannelState,
  InboundMessage,
  MediaBlock,
  RoomEvent,
  RoomEventKind,
} from '@evlon/dsh-channel-core'

/** 兼容旧名：群成员信息。 */
export type MatrixMember = ChannelMember
/** 兼容旧名：用户资料。 */
export type MatrixUserInfo = ChannelUserInfo
/** 兼容旧名：房间消息投影。 */
export type MatrixRoomMessage = ChannelRoomMessage
