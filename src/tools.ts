/**
 * Matrix 专属工具：通过 ctx.tools.register(defineTool(...)) 注册到 ToolRuntime，
 * 一次性获得「模型可见 schema + 可执行体」。
 * 之前使用 systemPrompt.tools() 只提供 schema，导致模型调用时执行失败
 * （unknown tool），现改为原生工具注册方式。
 * @module dsh-matrix-agent/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MatrixChannel } from './matrix.js'
import type { MatrixMember, MatrixUserInfo, MatrixRoomMessage } from './matrix.js'

/** 轻量级工具诊断日志：写入 stateDir/diagnostics.log，不依赖 ctx.logger（工具层无 ctx 注入）。 */
let _logfn: ((message: string, ...args: unknown[]) => void) | undefined
export function setToolLogger(fn: (message: string, ...args: unknown[]) => void): void {
  _logfn = fn
}
function toolLog(message: string, ...args: unknown[]): void {
  _logfn?.(`[dsh-matrix-agent:tools] ${message}`, ...args)
}

/** Matrix 专属工具的名称常量 */
export const MATRIX_TOOL_NAMES = {
  GET_ROOM_MEMBERS: 'matrix_get_room_members',
  GET_RECENT_MESSAGES: 'matrix_get_recent_messages',
  GET_ROOM_INFO: 'matrix_get_room_info',
  GET_USER_INFO: 'matrix_get_user_info',
  SEND_ROOM_MESSAGE: 'matrix_send_room_message',
  SEND_DM: 'matrix_send_dm',
  MENTION_MEMBER: 'matrix_mention_member',
  LIST_ROOMS: 'matrix_list_rooms',
  GET_MEDIA: 'matrix_get_media',
  TIMELINE: 'twin_timeline',
  SET_ROOM_CWD: 'matrix_set_room_cwd',
  REQUEST_OWNER_DECISION: 'matrix_request_owner_decision',
  REPORT_OWNER: 'matrix_report_owner',
} as const

export type MatrixToolName = typeof MATRIX_TOOL_NAMES[keyof typeof MATRIX_TOOL_NAMES]

/** 通过 ctx.tools.register(definition) 注册矩阵工具的依赖。 */
export interface MatrixToolDeps {
  /** Matrix 通道层，用于执行真实的 API 调用。 */
  channel: MatrixChannel
  /** sessionId → roomId 反查（来自 BridgeState 的 roomSessions 映射）。 */
  roomForSession: (sessionId: string) => string | undefined
  /**
   * 主动消息（send_dm/send_room_message/mention_member）执行前的授权检查。
   * 返回 true 表示允许发送；false 表示拒绝（桥接层将抛出含原因的错）。
   * 未提供时回退为「允许」（即不强制授权，由配置关闭）。
   */
  approveProactiveSend?: (toolName: string, args: Record<string, unknown>, exec: ToolRunContext) => Promise<boolean> | boolean
  /**
   * 媒体保存目录：matrix_get_media 把下载的媒体字节写入该目录并返回本地路径。
   * 未提供时工具只返回 base64 与元信息（不落盘）。
   */
  mediaDirForSession?: (sessionId: string) => string | undefined
  /**
   * 自我时间线查询（twin_timeline）：返回跨房间的分身出站动作元数据。
   * 仅结构化元数据（kind/roomId/ts/tool/target/charCount/actor），不含聊天原文。
   */
  queryTimeline?: (filter: { roomId?: string; kind?: string; actor?: string; limit?: number; since?: number }) => Array<{
    id: string; ts: number; roomId: string; kind: string; actor?: string; tool?: string; target?: string; charCount?: number; sessionId?: string
  }>
  /**
   * 原子工具：把房间/会话绑定到工作目录（绝对路径）。校验存在性；失败抛错。
   * 这是「工作目录如何确定」的最小原子动作——具体策略（经验/协商）由技能/记忆层组合。
   */
  setRoomCwd?: (roomId: string, cwd: string) => Promise<void>
  /**
   * 原子工具：私下向主人（owner）发起一次请示/决策请求。返回是否送达与私聊房 id。
   * 正文由桥接层补全「群名/发起人/内容」上下文；「何时请示、问什么」由技能层决定。
   */
  requestOwnerDecision?: (roomId: string, question: string) => Promise<{ roomId: string; sent: boolean }>
  /**
   * 原子工具：私下向主人汇报进度/结果。用于「先请示后交付」工作流的汇报环节。
   */
  reportOwner?: (roomId: string, summary: string) => Promise<{ roomId: string; sent: boolean }>
}

/** 根据显式 roomId 或当前 agent 绑定的房间，解析实际的 roomId。 */
function resolveRoomId(
  args: Record<string, unknown>,
  exec: ToolRunContext,
  deps: MatrixToolDeps,
): string {
  const explicit = args.roomId as string | undefined
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const sessionId = exec.agent?.id
  if (sessionId !== undefined) {
    const bound = deps.roomForSession(sessionId)
    if (bound !== undefined) return bound
  }
  throw new Error(
    '缺少 roomId 参数，且当前会话未绑定 Matrix 房间，无法确定目标房间',
  )
}

/** 渲染器：把工具返回值格式化为模型可见的 ContentBlock[]。 */
function renderResult(_args: Record<string, unknown>, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** ---------- 4 个 Matrix 工具的 defineTool 定义 ---------- */

function makeGetRoomMembersTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.GET_ROOM_MEMBERS,
    description: '获取当前会话所在房间的成员列表（joined_members 投影）。不传 roomId 时自动使用当前会话绑定的房间，也可显式指定 roomId 查询其他房间。',
    parameters: {
      roomId: {
        type: 'string',
        description: 'Matrix 房间 ID（如 !roomid:server.com），可选，不传则使用当前会话所在房间',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          roomId: { type: 'string', required: true },
          members: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                userId: { type: 'string' },
                displayName: { type: 'string' },
                avatarUrl: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const roomId = resolveRoomId(args, exec, deps)
      toolLog(`execute getRoomMembers roomId=${roomId}`)
      const members = await deps.channel.getRoomMembers(roomId)
      if (members === undefined) {
        throw new Error('获取成员失败或房间不存在')
      }
      return { roomId, members }
    },
  })
}

function makeGetRecentMessagesTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.GET_RECENT_MESSAGES,
    description: '获取当前会话所在房间的最近 N 条消息（默认 20 条，最多 100 条）。不传 roomId 时自动使用当前会话绑定的房间，也可显式指定 roomId 查询其他房间。',
    parameters: {
      roomId: {
        type: 'string',
        description: 'Matrix 房间 ID（如 !roomid:server.com），可选，不传则使用当前会话所在房间',
      },
      limit: {
        type: 'integer',
        description: '要获取的消息条数，默认 20，最大 100',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          roomId: { type: 'string', required: true },
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                eventId: { type: 'string' },
                sender: { type: 'string' },
                body: { type: 'string' },
                timestamp: { type: 'integer' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const roomId = resolveRoomId(args, exec, deps)
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(100, args.limit)) : 20
      toolLog(`execute getRecentMessages roomId=${roomId} limit=${limit}`)
      const messages = await deps.channel.getRecentMessages(roomId, limit)
      return { roomId, messages }
    },
  })
}

function makeGetRoomInfoTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.GET_ROOM_INFO,
    description: '获取当前会话所在房间的基本信息（房间名、人数等）。不传 roomId 时自动使用当前会话绑定的房间，也可显式指定 roomId 查询其他房间。',
    parameters: {
      roomId: {
        type: 'string',
        description: 'Matrix 房间 ID（如 !roomid:server.com），可选，不传则使用当前会话所在房间',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          roomId: { type: 'string', required: true },
          roomName: { type: 'string' },
          memberCount: { type: 'integer' },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const roomId = resolveRoomId(args, exec, deps)
      toolLog(`execute getRoomInfo roomId=${roomId}`)
      const [roomName, memberCount] = await Promise.all([
        deps.channel.getRoomName(roomId),
        deps.channel.getRoomMemberCount(roomId),
      ])
      return {
        roomId,
        ...(roomName !== undefined ? { roomName } : {}),
        ...(memberCount !== undefined ? { memberCount } : {}),
      }
    },
  })
}

function makeGetUserInfoTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.GET_USER_INFO,
    description: '获取指定用户的显示名称和头像 URL。可先调用 matrix_get_room_members 获取房间成员列表，从中拿到 userId 后再调用此工具查询具体用户信息。',
    parameters: {
      userId: {
        type: 'string',
        required: true,
        description: 'Matrix user ID（如 @user:server.com）',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          userId: { type: 'string', required: true },
          info: {
            type: 'object',
            required: true,
            properties: {
              userId: { type: 'string' },
              displayName: { type: 'string' },
              avatarUrl: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const userId = args.userId
      if (!userId || typeof userId !== 'string') {
        throw new Error('缺少 userId 参数')
      }
      toolLog(`execute getUserInfo userId=${userId}`)
      const info = await deps.channel.getUserInfo(userId)
      if (info === undefined) {
        throw new Error('获取用户信息失败或用户不存在')
      }
      return { userId, info }
    },
  })
}

/** 主动消息工具执行前的授权门：走 deps.approveProactiveSend；拒绝则抛错阻止发送。 */
async function guardProactiveSend(
  toolName: string,
  args: Record<string, unknown>,
  exec: ToolRunContext,
  deps: MatrixToolDeps,
): Promise<void> {
  if (deps.approveProactiveSend === undefined) return
  const ok = await deps.approveProactiveSend(toolName, args, exec)
  if (!ok) {
    throw new Error(
      `主动发送被拒绝：${toolName} 未获授权。请让房间 Owner 批准后重试，或调整配置允许主动发送。`,
    )
  }
}

function makeSendRoomMessageTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.SEND_ROOM_MESSAGE,
    description: '向当前会话所在房间发送一条文本消息。不传 roomId 时自动使用当前会话绑定的房间，也可显式指定 roomId。用于主动向群里/私聊发言。',
    parameters: {
      roomId: {
        type: 'string',
        description: 'Matrix 房间 ID（如 !roomid:server.com），可选，不传则使用当前会话所在房间',
      },
      text: {
        type: 'string',
        required: true,
        description: '要发送的纯文本正文',
      },
      html: {
        type: 'string',
        description: '可选的 HTML 富文本正文（org.matrix.custom.html）；不传则用 text 作为纯文本',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          roomId: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 60_000,
    // 主动发消息有副作用，禁止并行调用，避免重复发送。
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const roomId = resolveRoomId(args, exec, deps)
      const text = args.text
      if (typeof text !== 'string' || text.trim() === '') throw new Error('缺少 text 参数')
      await guardProactiveSend(MATRIX_TOOL_NAMES.SEND_ROOM_MESSAGE, args, exec, deps)
      toolLog(`execute sendRoomMessage roomId=${roomId} text=${text.slice(0, 40)}`)
      const html = typeof args.html === 'string' ? args.html : undefined
      await deps.channel.sendText(roomId, text, html)
      return { roomId, ok: true }
    },
  })
}

function makeSendDmTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.SEND_DM,
    description: '主动给指定 Matrix 用户发送私聊消息。若已存在与该用户的私聊房则复用，否则自动创建私聊房并发送。用于私聊某人。',
    parameters: {
      userId: {
        type: 'string',
        required: true,
        description: '目标 Matrix user ID（如 @user:server.com）',
      },
      text: {
        type: 'string',
        required: true,
        description: '要发送的纯文本正文',
      },
      html: {
        type: 'string',
        description: '可选的 HTML 富文本正文',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          roomId: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const userId = args.userId
      if (typeof userId !== 'string' || userId === '') throw new Error('缺少 userId 参数')
      const text = args.text
      if (typeof text !== 'string' || text.trim() === '') throw new Error('缺少 text 参数')
      await guardProactiveSend(MATRIX_TOOL_NAMES.SEND_DM, args, exec, deps)
      toolLog(`execute sendDm to=${userId} text=${text.slice(0, 40)}`)
      const html = typeof args.html === 'string' ? args.html : undefined
      const { roomId } = await deps.channel.sendDm!(userId, text, html)
      return { roomId, ok: true }
    },
  })
}

function makeMentionMemberTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.MENTION_MEMBER,
    description: '向当前会话所在房间发送消息并 @ 一个或多个成员（HTML mention 锚点）。用于任务完成时 @ 某人、点名同事等。',
    parameters: {
      roomId: {
        type: 'string',
        description: 'Matrix 房间 ID，可选，不传则使用当前会话所在房间',
      },
      text: {
        type: 'string',
        required: true,
        description: '要发送的纯文本正文（可附带对被 @ 成员的说明）',
      },
      userIds: {
        type: 'array',
        required: true,
        items: { type: 'string', description: '要 @ 的 Matrix user ID' },
        description: '要 @ 的一个或多个成员 userId',
      },
      html: {
        type: 'string',
        description: '可选的 HTML 富文本正文（将自动追加 @ 锚点）',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          roomId: { type: 'string', required: true },
          mentioned: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
          ok: { type: 'boolean', required: true },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const roomId = resolveRoomId(args, exec, deps)
      const text = args.text
      if (typeof text !== 'string' || text.trim() === '') throw new Error('缺少 text 参数')
      const userIds = Array.isArray(args.userIds) ? args.userIds.filter((u): u is string => typeof u === 'string' && u !== '') : []
      if (userIds.length === 0) throw new Error('缺少 userIds 参数（至少 @ 一个成员）')
      await guardProactiveSend(MATRIX_TOOL_NAMES.MENTION_MEMBER, args, exec, deps)
      // 校验目标都是房间成员，避免 @ 非成员。
      const members = await deps.channel.getRoomMembers(roomId)
      if (members !== undefined) {
        const valid = new Set(members.map((m) => m.userId))
        const invalid = userIds.filter((u) => !valid.has(u))
        if (invalid.length > 0) {
          throw new Error(`以下 userId 不是房间成员，无法 @：${invalid.join(', ')}`)
        }
      }
      toolLog(`execute mentionMember roomId=${roomId} users=${userIds.join(',')} text=${text.slice(0, 40)}`)
      const html = typeof args.html === 'string' ? args.html : undefined
      await deps.channel.sendMentionText!(roomId, text, userIds, html)
      return { roomId, mentioned: userIds, ok: true }
    },
  })
}

function makeGetMediaTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.GET_MEDIA,
    description: '下载 Matrix 媒体（图片/文件/音视频）内容。传 mxc:// URL，返回本地保存路径与元信息；配置了媒体目录时落盘，否则返回 base64 与大小。用于处理群里发的图片、文件等。',
    parameters: {
      mxc: {
        type: 'string',
        required: true,
        description: 'Matrix 媒体 URL（mxc://server/mediaid），可从 matrix_get_recent_messages 或入站消息里取得',
      },
      filename: {
        type: 'string',
        description: '可选的保存文件名（含扩展名）；不传则根据 mimetype/内容推断',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          savedPath: { type: 'string' },
          filename: { type: 'string' },
          mimetype: { type: 'string' },
          size: { type: 'integer', required: true },
          base64: { type: 'string' },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const mxc = args.mxc
      if (typeof mxc !== 'string' || mxc === '') throw new Error('缺少 mxc 参数')
      toolLog(`execute getMedia mxc=${mxc}`)
      const { buffer, mimetype, size } = await deps.channel.downloadMedia!(mxc)
      const ext = extensionForMimetype(mimetype)
      const filename = (typeof args.filename === 'string' && args.filename.trim() !== '')
        ? args.filename.trim()
        : `matrix-media-${Date.now()}${ext}`
      const sessionId = exec.agent?.id
      const mediaDir = sessionId !== undefined ? deps.mediaDirForSession?.(sessionId) : undefined
      if (mediaDir !== undefined) {
        const savedPath = await writeMediaFile(mediaDir, filename, buffer)
        toolLog(`execute getMedia saved=${savedPath} size=${size}`)
        return {
          savedPath,
          filename,
          ...(mimetype !== undefined ? { mimetype } : {}),
          size,
        }
      }
      // 无媒体目录：返回 base64（调用方自行处理）。
      const base64 = Buffer.from(buffer).toString('base64')
      toolLog(`execute getMedia no-dir size=${size}`)
      return {
        filename,
        ...(mimetype !== undefined ? { mimetype } : {}),
        size,
        base64,
      }
    },
  })
}

function makeListRoomsTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.LIST_ROOMS,
    description: '列出当前 Matrix 账号已加入的房间及其名称/成员数。用于了解可发言的目标房间。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          rooms: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                roomId: { type: 'string' },
                name: { type: 'string' },
                memberCount: { type: 'integer' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute() {
      const rooms = await deps.channel.listJoinedRooms!()
      toolLog(`execute listRooms count=${rooms.length}`)
      return { rooms }
    },
  })
}


/** 根据 mimetype 推断文件扩展名（含点前缀；未知返回空串）。 */
function extensionForMimetype(mimetype?: string): string {
  if (mimetype === undefined) return ''
  const table: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/json': '.json',
    'application/zip': '.zip',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'video/mp4': '.mp4',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  }
  return table[mimetype] ?? ''
}

/** 把下载的媒体字节写入 mediaDir 并返回绝对路径（自动建目录，文件名安全化）。 */
async function writeMediaFile(mediaDir: string, filename: string, buffer: Uint8Array): Promise<string> {
  await mkdir(mediaDir, { recursive: true })
  // 文件名安全化：去掉路径分隔符与非法字符，避免路径穿越。
  const safe = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
  const target = join(mediaDir, safe)
  await writeFile(target, buffer)
  return target
}

/** 自我时间线查询工具：返回跨房间的分身出站动作元数据（无聊天原文）。 */
function makeTimelineTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.TIMELINE,
    description: '查询自己的跨房间时间线（仅结构化元数据，不含聊天原文）：我在各群最近回复过几次、调用过什么工具、主动发过什么消息、完成过什么任务。用于回忆自己在别处做过的事，避免在不同群之间「脑裂」。想深入了解某个房间的细节，再用 matrix_get_recent_messages 查该房间。',
    parameters: {
      roomId: {
        type: 'string',
        description: 'Matrix 房间 ID，可选；不传则返回全部房间（受配置 timelineCrossRoom 门控，默认隔离时仅本会话房间可见）',
      },
      kind: {
        type: 'string',
        description: '动作类型过滤：reply(回复)/tool-call(工具)/proactive(主动消息)/self-intro(自我介绍)/approval(审批)/task(任务)',
      },
      actor: {
        type: 'string',
        description: '动作主体过滤：secretary(秘书的请示/确认/交付调度) / worker(干活会话的执行回复/工具)',
      },
      limit: {
        type: 'integer',
        description: '返回条数，默认 20，最大 100',
      },
      since: {
        type: 'integer',
        description: '仅返回该时间戳(ms)之后的条目',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                ts: { type: 'integer' },
                roomId: { type: 'string' },
                kind: { type: 'string' },
                actor: { type: 'string' },
                tool: { type: 'string' },
                target: { type: 'string' },
                charCount: { type: 'integer' },
                sessionId: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (deps.queryTimeline === undefined) throw new Error('时间线服务不可用')
      const explicit = typeof args.roomId === 'string' && args.roomId.length > 0 ? args.roomId : undefined
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(100, Math.floor(args.limit))) : 20
      const since = typeof args.since === 'number' && Number.isFinite(args.since) ? args.since : undefined
      const kind = typeof args.kind === 'string' && args.kind !== '' ? args.kind : undefined
      const actor = typeof args.actor === 'string' && (args.actor === 'secretary' || args.actor === 'worker') ? args.actor : undefined
      const entries = deps.queryTimeline({
        ...(explicit !== undefined ? { roomId: explicit } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(actor !== undefined ? { actor } : {}),
        limit,
        ...(since !== undefined ? { since } : {}),
      })
      return { entries }
    },
  })
}

/**
 * 原子工具：把房间绑定到工作目录（绝对路径）。
 * 这是「工作目录如何确定」的最小动作——具体策略（秘书经验/主人协商/角色映射）
 * 由技能（skill）与记忆（memory）层组合，插件只提供这个可组合的原语。
 */
function makeSetRoomCwdTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.SET_ROOM_CWD,
    description: '把当前会话绑定的 Matrix 房间设定到指定工作目录（绝对路径）。用于在执行任务前确定工作目录；具体选哪个目录由你的工作流/记忆决定。目录必须存在。',
    parameters: {
      roomId: {
        type: 'string',
        description: 'Matrix 房间 ID，可选；不传则使用当前会话绑定的房间',
      },
      cwd: {
        type: 'string',
        required: true,
        description: '工作目录的绝对路径，如 E:/workspace/project',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          roomId: { type: 'string' },
          cwd: { type: 'string' },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    async execute(args, exec) {
      const roomId = resolveRoomId(args, exec, deps)
      const cwd = args.cwd
      if (typeof cwd !== 'string' || cwd.trim() === '') throw new Error('cwd 必须是绝对路径字符串')
      if (deps.setRoomCwd === undefined) throw new Error('工作目录设定服务不可用')
      await deps.setRoomCwd(roomId, cwd.trim())
      return { ok: true, roomId, cwd: cwd.trim() }
    },
  })
}

/**
 * 原子工具：私下向主人（owner）发起一次请示/决策请求。
 * 桥接层自动补全「群名/发起人/工作内容」上下文。何时请示、问什么由技能层决定。
 */
function makeRequestOwnerDecisionTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.REQUEST_OWNER_DECISION,
    description: '私下向主人（owner）发起一次请示，请求其决策/批准/补充要求。用于需要主人拍板的事项（如工作目录、任务优先级、是否开工）。请示内容会私下送达主人，不会在群里暴露。',
    parameters: {
      roomId: {
        type: 'string',
        description: 'Matrix 房间 ID，可选；不传则使用当前会话绑定的房间',
      },
      question: {
        type: 'string',
        required: true,
        description: '要向主人请示的问题或事项，尽量说清楚',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sent: { type: 'boolean', required: true },
          roomId: { type: 'string' },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    async execute(args, exec) {
      const roomId = resolveRoomId(args, exec, deps)
      const question = args.question
      if (typeof question !== 'string' || question.trim() === '') throw new Error('question 不能为空')
      if (deps.requestOwnerDecision === undefined) throw new Error('主人请示服务不可用')
      return deps.requestOwnerDecision(roomId, question.trim())
    },
  })
}

/**
 * 原子工具：私下向主人汇报进度/结果。用于「先请示后交付」工作流的汇报环节。
 */
function makeReportOwnerTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.REPORT_OWNER,
    description: '私下向主人（owner）汇报任务进度或结果。用于完成任务后、对外交付前向主人汇报。汇报内容私下送达主人，不会在群里暴露。',
    parameters: {
      roomId: {
        type: 'string',
        description: 'Matrix 房间 ID，可选；不传则使用当前会话绑定的房间',
      },
      summary: {
        type: 'string',
        required: true,
        description: '要汇报的进度或结果摘要',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sent: { type: 'boolean', required: true },
          roomId: { type: 'string' },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    async execute(args, exec) {
      const roomId = resolveRoomId(args, exec, deps)
      const summary = args.summary
      if (typeof summary !== 'string' || summary.trim() === '') throw new Error('summary 不能为空')
      if (deps.reportOwner === undefined) throw new Error('主人汇报服务不可用')
      return deps.reportOwner(roomId, summary.trim())
    },
  })
}

/** 将 Matrix 工具通过 ctx.tools.register() 注册到 ToolRuntime（全局 layer）。
 * 必须在 agent factory 的 `setup` 或 host apply 中由 plugin ctx 调用。
 * 注册后即对所有 agent 可见，模型既能看见 schema 也能直接调用执行体。
 * @param ctx 当前 plugin/context
 * @param deps MatrixToolDeps（channel + roomForSession + 可选主动发送授权）
 */
export function applyMatrixTools(ctx: Context, deps: MatrixToolDeps): void {
  if (ctx.get('tools') === undefined) {
    ctx.logger.warn('[dsh-matrix-agent] tools service unavailable; matrix tools not registered')
    return
  }
  toolLog('applying matrix tools via ctx.tools.register')

  const tools = [
    makeGetRoomMembersTool(deps),
    makeGetRecentMessagesTool(deps),
    makeGetRoomInfoTool(deps),
    makeGetUserInfoTool(deps),
    makeSendRoomMessageTool(deps),
    makeSendDmTool(deps),
    makeMentionMemberTool(deps),
    makeListRoomsTool(deps),
    makeGetMediaTool(deps),
    makeTimelineTool(deps),
    makeSetRoomCwdTool(deps),
    makeRequestOwnerDecisionTool(deps),
    makeReportOwnerTool(deps),
  ]

  for (const tool of tools) {
    try {
      ctx.tools.register(tool)
      toolLog(`registered tool: ${tool.name}`)
    } catch (e) {
      toolLog(`failed to register tool ${tool.name}: ${e instanceof Error ? e.message : e}`)
    }
  }
}