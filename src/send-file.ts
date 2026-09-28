/**
 * matrix_send_file：把工作目录内的文件作为 Matrix 附件发回房间。
 *
 * 为什么要这个工具：桥接目前只能“收”附件（入站 mxc:// 落盘 + 多模态），
 * 出站只有文本消息，agent 生成好的文档/图片没法交回聊天里的用户，
 * 用户只能在 Web UI 里找文件。本工具补的正是这条出站旁路。
 *
 * 实现边界（决定维护成本）：
 * - 只用 Matrix 两个稳定接口：`POST /_matrix/media/v3/upload` 与
 *   `PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}`；
 * - 工具注册走宿主官方 `ctx.tools.register`（与既有 matrix_* 工具同一注册面），
 *   不依赖通道包/桥接包的任何内部实现，因此不需要改动闭源的 @evlon/* 包；
 * - 房间解析复用桥接公开方法 `roomForSession`，与其它工具“不传 roomId 用当前会话房间”一致。
 *
 * @module dsh-matrix-agent/send-file
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { MAX_SEND_BYTES, isPathInside, mimeFor, msgtypeFor, sanitizeFileName } from './media-file.js'

/** 工具名：与既有 `matrix_*` 命名保持一致。 */
export const SEND_FILE_TOOL_NAME = 'matrix_send_file'

/** 上传阶段的超时：大文件在慢网络上可能耗时较久。 */
const SEND_FILE_TIMEOUT_MS = 120_000

/** 注册依赖：全部由插件入口（index.ts）注入，工具层不直接读配置。 */
export interface SendFileDeps {
  /** 当前 homeserver 基地址（live 读取合并配置，设置页改动立即生效）。 */
  homeserverUrl(): string
  /** 当前访问令牌（含 DSH_MATRIX_TOKEN 兜底）。 */
  accessToken(): string
  /**
   * 会话 id → 已绑定房间。
   * 绑定关系的唯一真源是桥接持久化状态（state.json 的 roomSessions）；
   * 由插件入口注入（见 createStateRoomResolver），工具层不直接读文件。
   */
  roomForSession(sessionId: string): Promise<string | undefined> | string | undefined
  /** 工作目录兜底：workspaceRegistry 首个工作区 → 配置候选目录。 */
  fallbackCwd(): string | undefined
  /** 诊断日志。 */
  log(message: string, ...args: unknown[]): void
}

/** 一次附件投递的输入。 */
export interface SendFileRequest {
  /** 目标房间 ID。 */
  roomId: string
  /** 待发送文件路径（相对 root 或 root 内的绝对路径）。 */
  filePath: string
  /** 允许发送的根目录（工作目录）。 */
  root: string
  /** homeserver 基地址，如 `https://im.10rig.com`。 */
  homeserverUrl: string
  /** 访问令牌。 */
  accessToken: string
  /** 随附件显示的说明，默认用文件名。 */
  caption?: string
  /** 取消信号（工具 exec.signal）。 */
  signal?: AbortSignal
  /** 大小上限覆盖（仅测试用）。 */
  maxBytes?: number
}

/** 一次附件投递的结果。 */
export interface SendFileResult {
  roomId: string
  eventId: string
  name: string
  size: number
  mimetype: string
  msgtype: string
}

function trimBase(homeserverUrl: string): string {
  return homeserverUrl.replace(/\/+$/, '')
}

/** 读取文件内容，并保证读取期间文件没有被继续写入（防止把“写了一半”的结果发出去）。 */
async function readStableFile(filePath: string, maxBytes: number): Promise<Uint8Array> {
  const before = await stat(filePath)
  if (!before.isFile()) throw new Error(`只能发送普通文件：${filePath}`)
  if (before.size > maxBytes) {
    throw new Error(`文件超过发送上限 ${Math.floor(maxBytes / 1024 / 1024)} MiB：${filePath}`)
  }
  const bytes = new Uint8Array(await readFile(filePath))
  const after = await stat(filePath)
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(`文件正在变化（可能仍在生成），请等生成完成后再发送：${filePath}`)
  }
  return bytes
}

/** 解析待发送文件：必须存在、必须是工作目录内的真实路径（符号链接按真实路径判定）。 */
async function resolveTargetFile(root: string, filePath: string): Promise<string> {
  const rootReal = await realpath(root)
  const candidate = isAbsolute(filePath) ? filePath : join(rootReal, filePath)
  let targetReal: string
  try {
    targetReal = await realpath(candidate)
  } catch {
    throw new Error(`文件不存在：${filePath}（工作目录 ${rootReal}）`)
  }
  if (!isPathInside(rootReal, targetReal)) {
    throw new Error(`只允许发送工作目录内的文件：${filePath}（工作目录 ${rootReal}）`)
  }
  return targetReal
}

/** 上传媒体到 Matrix 媒体库，返回 mxc:// 地址。 */
async function uploadMedia(
  base: string,
  token: string,
  name: string,
  mimetype: string,
  bytes: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await fetch(`${base}/_matrix/media/v3/upload?filename=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': mimetype },
    body: bytes,
    ...(signal !== undefined ? { signal } : {}),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`上传附件失败：HTTP ${response.status} ${text.slice(0, 200)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Matrix 上传响应不是合法 JSON，无法取得媒体地址')
  }
  const contentUri = (parsed as { content_uri?: unknown }).content_uri
  if (typeof contentUri !== 'string' || !contentUri.startsWith('mxc://')) {
    throw new Error('Matrix 未返回有效的媒体地址（mxc://）')
  }
  return contentUri
}

/** 发送 m.room.message 附件事件；上传成功不等于投递成功，必须拿到 event_id。 */
async function sendMediaEvent(
  base: string,
  token: string,
  roomId: string,
  name: string,
  caption: string,
  contentUri: string,
  mimetype: string,
  size: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const msgtype = msgtypeFor(mimetype)
  const txnId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const response = await fetch(`${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      msgtype,
      body: caption,
      filename: name,
      url: contentUri,
      info: { mimetype, size },
    }),
    ...(signal !== undefined ? { signal } : {}),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`发送附件消息失败：HTTP ${response.status} ${text.slice(0, 200)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Matrix 发送响应不是合法 JSON，无法确认投递结果')
  }
  const eventId = (parsed as { event_id?: unknown }).event_id
  if (typeof eventId !== 'string' || eventId === '') {
    throw new Error('Matrix 未确认附件消息（响应缺少 event_id）')
  }
  return eventId
}

/**
 * 把工作目录内的文件作为附件发送到指定房间。
 * 与工具注册解耦，便于单测直接调用（伪造 homeserver 即可覆盖完整出站链路）。
 */
export async function sendFileToRoom(request: SendFileRequest): Promise<SendFileResult> {
  const base = trimBase(request.homeserverUrl)
  if (base === '') throw new Error('homeserverUrl 未配置，无法发送附件')
  if (request.accessToken === '') throw new Error('accessToken 未配置，无法发送附件')
  const targetReal = await resolveTargetFile(request.root, request.filePath)
  const bytes = await readStableFile(targetReal, request.maxBytes ?? MAX_SEND_BYTES)
  const name = sanitizeFileName(basename(targetReal))
  const mimetype = mimeFor(name, bytes)
  const contentUri = await uploadMedia(base, request.accessToken, name, mimetype, bytes, request.signal)
  const eventId = await sendMediaEvent(
    base,
    request.accessToken,
    request.roomId,
    name,
    request.caption !== undefined && request.caption !== '' ? request.caption : name,
    contentUri,
    mimetype,
    bytes.byteLength,
    request.signal,
  )
  return {
    roomId: request.roomId,
    eventId,
    name,
    size: bytes.byteLength,
    mimetype,
    msgtype: msgtypeFor(mimetype),
  }
}

/** 从 exec.agent 的会话 header 读工作目录（防御式读取：宿主版本差异下保持可用）。 */
function sessionCwd(agent: unknown): string | undefined {
  const session = (agent as { session?: { meta?: { cwd?: unknown } } } | undefined)?.session
  const cwd = session?.meta?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/** 读取宿主工作区注册表（workspaceRegistry）里的首个工作目录；内核未提供该服务时返回 undefined。 */
export function firstRegistryWorkspace(ctx: Context): string | undefined {
  try {
    const registry = (ctx as unknown as { get?: (key: string) => unknown }).get?.('workspaceRegistry') as
      | { list?: () => Array<{ path?: unknown }> }
      | undefined
    for (const workspace of registry?.list?.() ?? []) {
      const path = workspace?.path
      if (typeof path === 'string' && path !== '') return path
    }
  } catch {
    /* 内核未提供 workspaceRegistry：按未配置处理 */
  }
  return undefined
}

/** 依次尝试候选目录，返回第一个存在的真实目录路径。 */
async function firstExistingDir(candidates: readonly (string | undefined)[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === '') continue
    try {
      const real = await realpath(candidate)
      const info = await stat(real)
      if (info.isDirectory()) return real
    } catch {
      /* 候选目录不存在：继续尝试下一个 */
    }
  }
  return undefined
}

/** 桥接持久化状态（state.json）里 roomSessions 的单条形态：roomId → { sessionId }。 */
interface RoomSessionBinding {
  sessionId?: unknown
}

/** 读取一个状态文件里的「会话 → 房间」绑定；文件缺失或损坏时返回空表。 */
async function readBindingsFrom(filePath: string): Promise<Map<string, string>> {
  const bySession = new Map<string, string>()
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as { roomSessions?: Record<string, RoomSessionBinding> }
    for (const [roomId, binding] of Object.entries(parsed.roomSessions ?? {})) {
      const sessionId = binding?.sessionId
      if (typeof sessionId === 'string' && sessionId !== '') bySession.set(sessionId, roomId)
    }
  } catch {
    /* 状态文件未生成或不可读：按未绑定处理 */
  }
  return bySession
}

/**
 * 从桥接状态目录解析「会话 → 房间」。
 * 主账号固定写 state.json，数字分身写各自状态文件，因此扫描 `state*.json` 后合并；
 * 若桥接后续暴露公开查询方法，可替换本实现而不影响工具层。
 */
export function createStateRoomResolver(
  stateDir: string,
): (sessionId: string) => Promise<string | undefined> {
  return async (sessionId: string) => {
    let files: string[]
    try {
      files = (await readdir(stateDir)).filter((name) => /^state.*\.json$/.test(name))
    } catch {
      return undefined
    }
    for (const name of files) {
      const bySession = await readBindingsFrom(join(stateDir, name))
      const roomId = bySession.get(sessionId)
      if (roomId !== undefined) return roomId
    }
    return undefined
  }
}

/** 渲染器：与既有矩阵工具一致，把结构化返回值原样交给模型。 */
function renderResult<T>(_args: unknown, value: T): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * 注册 `matrix_send_file` 工具，返回注销函数（随桥接生命周期启停）。
 * 依赖宿主 tools 服务；缺失时记录日志并跳过注册（与桥接既有降级策略一致）。
 */
export function registerSendFileTool(ctx: Context, deps: SendFileDeps): () => void {
  const tool = defineTool({
    name: SEND_FILE_TOOL_NAME,
    description:
      '把工作目录内的文件作为附件发送到 Matrix 房间（图片/音频/视频自动按对应媒体类型发送）。' +
      '不传 roomId 时自动使用当前会话绑定的房间。生成文档/图片/报表后用它把文件真发给用户，' +
      '不要只回一句“已生成”——用户需要在聊天里直接看到并可下载。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '要发送的文件路径：相对当前工作目录，或工作目录内的绝对路径',
      },
      roomId: {
        type: 'string',
        description: 'Matrix 房间 ID（如 !roomid:server.com），可选，不传则使用当前会话所在房间',
      },
      caption: {
        type: 'string',
        description: '随附件显示的一句话说明，可选，默认用文件名',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          roomId: { type: 'string', required: true },
          eventId: { type: 'string', required: true },
          name: { type: 'string', required: true },
          size: { type: 'integer', required: true, description: '字节数' },
          mimetype: { type: 'string', required: true },
          msgtype: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: renderResult,
    },
    timeoutMs: SEND_FILE_TIMEOUT_MS,
    // 发送类工具串行执行，避免并行重复投递（与 matrix_send_room_message 等保持一致）。
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const sessionId = exec.agent?.id
      const explicitRoomId = typeof args.roomId === 'string' && args.roomId !== '' ? args.roomId : undefined
      const boundRoomId = sessionId !== undefined ? await deps.roomForSession(sessionId) : undefined
      const roomId = explicitRoomId ?? boundRoomId
      if (roomId === undefined) {
        throw new Error('缺少 roomId 参数，且当前会话未绑定 Matrix 房间，无法确定目标房间')
      }
      const root = await firstExistingDir([
        sessionCwd(exec.agent),
        deps.fallbackCwd(),
        process.cwd(),
      ])
      if (root === undefined) {
        throw new Error('无法确定工作目录（会话 cwd / 工作区候选目录都不存在），无法发送文件')
      }
      const result = await sendFileToRoom({
        roomId,
        filePath: args.path,
        root,
        homeserverUrl: deps.homeserverUrl(),
        accessToken: deps.accessToken(),
        ...(args.caption !== undefined ? { caption: args.caption } : {}),
        signal: exec.signal,
      })
      deps.log(
        'send file ok room=%s name=%s size=%d mimetype=%s event=%s',
        result.roomId,
        result.name,
        result.size,
        result.mimetype,
        result.eventId,
      )
      return result
    },
  })
  if (ctx.get('tools') === undefined) {
    deps.log('tools service unavailable; matrix_send_file not registered')
    return () => {}
  }
  return ctx.tools.register(tool)
}
