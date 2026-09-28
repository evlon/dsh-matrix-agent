/**
 * 通道无关的类型定义：任何 IM 通道（Matrix / 微信 / 钉钉 / 飞书…）实现 Channel
 * 接口时，都把这些类型投影为自己的协议结构。桥接层与工具层只依赖这些类型，
 * 不感知具体通道协议。
 *
 * @module @evlon/dsh-channel-core/types
 */

/** 媒体附件的归一化结构（入站扩展点）。 */
export interface MediaBlock {
  readonly msgtype: string
  readonly mimetype?: string
  readonly url?: string
  /** 通道原生媒体 URI（如 Matrix 的 mxc://；其它通道可映射为等价标识）。 */
  readonly mxc?: string
  readonly filename?: string
  readonly size?: number
  readonly body: string
  /** 图片宽高。 */
  readonly width?: number
  readonly height?: number
  /** 已下载到本地的绝对路径（桥接层下载后回填；未下载时为 undefined）。 */
  readonly localPath?: string
  /** 地理坐标（m.location 等）。 */
  readonly geoUri?: string
  /** 图注/说明（媒体消息正文，若不同于文件名则视为 caption）。 */
  readonly caption?: string
}

/** 入站消息（通道归一化后交给桥接层）。 */
export interface InboundMessage {
  readonly roomId: string
  readonly sender: string
  /** 文本正文；纯媒体消息时为空串，图文混排时保留 caption。 */
  readonly text: string
  /** 非文字附件（图片/文件/音视频/位置）。 */
  readonly media: MediaBlock[]
  readonly eventId: string
  /** 富文本正文（HTML）；存在时保留供结构化理解。 */
  readonly formattedHtml?: string
  /** 被回复的原消息 event_id。 */
  readonly replyToEventId?: string
  /** 所属线程根 event_id。 */
  readonly threadEventId?: string
  /** 是否为编辑消息。 */
  readonly isEdit?: boolean
  /** 若为编辑，被替换的原消息 event_id。 */
  readonly editTargetEventId?: string
  /** 是否为动作/表情文本（emote）。 */
  readonly isEmote?: boolean
}

/** 群/房间成员变化与资料变更事件种类。 */
export type RoomEventKind =
  | 'join'
  | 'leave'
  | 'invite'
  | 'profile'
  | 'room-name'
  | 'room-topic'
  | 'self-join'
  /**
   * 本账号自己收到的入群邀请（尚未加入）。
   * 与 `invite` 的区别：`invite` 指「已加入房间里别人被邀请」（来自 rooms.join 的 state），
   * `self-invite` 指「有人把本账号拉进一个新房间」（来自 rooms.invite），二者语义完全不同，
   * 绝不能混用——前者是旁观事件，后者是入群决策入口。
   * detail 约定：`inviter`（邀请人 userId）、`roomName`（群名，可能缺）、`isDirect`（是否 1:1）。
   */
  | 'self-invite'

/** 成员/资料/房间信息事件。与消息事件分离，经 ChannelOptions.onRoomEvent 抛出。 */
export interface RoomEvent {
  readonly kind: RoomEventKind
  readonly roomId: string
  /** 发生变化的成员 userId；房间信息事件（room-name/room-topic）为 undefined。 */
  readonly userId?: string
  readonly eventId: string
  /** 事件时间戳（ms）。 */
  readonly at: number
  readonly detail?: Record<string, unknown>
}

/** 群成员信息（成员列表投影）。 */
export interface ChannelMember {
  readonly userId: string
  readonly displayName?: string
  readonly avatarUrl?: string
}

/** 用户资料（profile 投影）。 */
export interface ChannelUserInfo {
  readonly userId: string
  readonly displayName?: string
  readonly avatarUrl?: string
}

/** 房间消息投影（历史消息列表的精简投影）。 */
export interface ChannelRoomMessage {
  readonly eventId: string
  readonly sender: string
  readonly body: string
  readonly timestamp: number
}
