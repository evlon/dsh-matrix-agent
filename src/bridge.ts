/**
 * Matrix→harness 桥接层：多账号支持（主账号 + N 个数字分身）、per-room & per-account
 * agent 会话、入站消息注入（@提及路由 / 合并窗口）、出站投递、审批推送与聊天应答、
 * Owner 授权记忆（L1 静默 / L2 房间确认 / L3 红线强制）。
 *
 * 每个矩阵账号一个 AccountBridge：独立 sync 循环、独立状态文件、独立会话绑定。
 *
 * @module dsh-matrix-agent/bridge
 */

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TextBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Config, DigitalTwinAccount } from './config.js'
import { chunkText, markdownToHtml, formatToolCall, describeMedia, wantsProcess, formatToolResult, formatTurnEnd, formatRetry, formatRetryCircuitTripped, formatTasks, formatCwdGuide, formatRules, formatWorkspaceState, isProviderFailure, formatProviderFailure } from './format.js'
import type { Verbosity, WorkspaceState } from './format.js'
import { MatrixChannel } from './matrix.js'
import type { Channel, InboundMessage, MediaBlock, RoomEvent } from './matrix.js'
import { getDiag } from './diag.js'
import { ChatLog } from './chatlog.js'
import { BridgeState } from './store.js'
import type { MatrixTask, AllowDenyRule } from './store.js'
import { AuthStore } from './auth-store.js'
import { MemberStore } from './member-store.js'
import { soulText, rolePersonaFor, SOUL_PRESET_IDS } from './soul.js'
import type { SoulHandle } from './soul.js'
import type { TasksSnapshot, TimelineOps, SecretaryOps } from './settings.js'
import { TwinTimeline } from './timeline.js'
import type { TimelineKind } from './timeline.js'

const APPROVE_RE = /^(批准|同意|approve|yes|ok)$/i
const DENY_RE = /^(拒绝|驳回|deny|no|reject)$/i

/**
 * 自我时间线常驻提示词段（第 0 级暴露）：**恒定字符串**，内容与时间线无关，
 * 字节永不变化 → 不影响 KV 缓存命中率。只告知能力，摘要/详情按需工具查。
 */
const TIMELINE_MEMORY_SECTION_TEXT =
  '你有跨群的自我记忆。需要回忆自己做过的事时，用 twin_timeline 工具查询你的行动摘要；' +
  '想深入了解某个房间的细节时，用 matrix_get_recent_messages 查询该房间。'

/** 媒体 msgtype → 中文标签（入站媒体归一）。 */
const MEDIA_LABELS: Record<string, string> = {
  'm.image': '图片',
  'm.file': '文件',
  'm.audio': '音频',
  'm.video': '视频',
  'm.location': '位置',
}

/** 根据 mimetype 推断文件扩展名（含点前缀；未知返回空串）。 */
function mediaExtension(mimetype?: string): string {
  if (mimetype === undefined) return ''
  const table: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'image/svg+xml': '.svg', 'application/pdf': '.pdf', 'text/plain': '.txt',
    'application/json': '.json', 'application/zip': '.zip', 'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg', 'video/mp4': '.mp4',
  }
  return table[mimetype] ?? ''
}

/** 把 mimetype 归一为 harness 多模态接受的图片类型；非支持类型返回 undefined。 */
function normalizeImageMediaType(mimetype?: string): ImageMediaType | undefined {
  switch (mimetype) {
    case 'image/png': return 'image/png'
    case 'image/jpeg': return 'image/jpeg'
    case 'image/webp': return 'image/webp'
    case 'image/gif': return 'image/gif'
    default: return undefined
  }
}

const HELP_TEXT = [
  '/help — 显示本帮助',
  '/status — 查看本房间绑定会话与状态',
  '/new — 开始一个全新会话',
  '/clear — 重置当前会话（同 /new）',
  '/bind <session-id> — 把本房间绑定到已有会话（需要 session persistence）',
  '/auth list — 列出本分身在本房间的记忆授权',
  '/auth revoke <tool> — 吊销某工具的记忆授权（仅 Owner）',
  '/auth revoke-all — 吊销本房间全部记忆授权（仅 Owner）',
  '',
  '— Matrix 任务队列（数字分身收件箱）—',
  '/tasks — 查看本房间任务面板（待审/已办、工作目录状态）',
  '/queue — 同 /tasks，刷新任务列表',
  '/approve <N> — 执行第 N 条待审任务（新房间需先选工作目录）',
  '/reject <N> — 拒绝第 N 条待审任务',
  '/allow <人> <事> — 加白名单（人/事可填 * 通配）',
  '/deny <人> <事> — 加黑名单（人/事可填 * 通配）',
  '/rules — 查看黑白名单',
  '',
  '— 社交记忆 —',
  '/memory — 查看本房间已记住的成员',
  '/forget <userId> — 忘记某成员（仅 Owner）',
  '',
  '消息合并：以 `..` 结尾表示还有后续，以 `!!` 结尾表示立即提交，裸文本进入合并窗口。',
].join('\n')

interface MergeBuffer {
  parts: string[]
  sender?: string
  timer?: NodeJS.Timeout
  /** 合并窗口内累积的入站图片多模态附件，flush 时随文本一并注入。 */
  imageRefs: ImageAttachmentRef[]
}

interface PendingApproval {
  readonly request: ApprovalRequest
  /** 批准后是否写入记忆授权（红线工具为 false）。 */
  readonly grantOnApprove: boolean
  readonly settle: (outcome: ApprovalOutcome) => void
}

/**
 * 出站主力投影：把 harness 结构化 `assistant/message` 渲染成 Matrix 可见文本。
 *
 * 之前只取 `text` 块，导致模型调用工具的 `tool-call` 块在 Matrix 端不可见，
 * 模型被迫在 text 里裸写 `<invoke>` 协议而泄漏。这里按 content 顺序遍历：
 *  - `text` 块：原样保留（与 GUI `toAssistantBlocks` 的 text 块一致）。
 *  - `tool-call` 块：主动投影为可读的"调用工具 name + 参数摘要"。这样模型
 *    无需在文本中裸写工具协议，从根上消除 `<invoke>` 泄漏，并保证 Matrix
 *    与 GUI 的工具调用历史一致。
 *  - `reasoning`/`tool-result`/`image` 等：按契约不在用户可见文本中展开
 *    （reasoning 默认不可见，tool-result/image 由 GUI 折叠呈现，保持现状）。
 */
/** 类型谓词：把 harness 的 tool-call 块从 ContentBlock 联合中收窄出来。 */
function isToolCallBlock(block: { type: string }): block is { type: 'tool-call'; name: string; arguments: string } {
  return block.type === 'tool-call'
}

function assistantVisibleText(
  event: Extract<SessionEvent, { type: 'assistant/message' }>,
  verbosity: Verbosity,
): string | undefined {
  const showToolCalls = verbosity === 'process'
  const parts: string[] = []
  for (const block of event.data.message.content) {
    if (block.type === 'text') {
      parts.push((block as TextBlock).text)
    } else if (isToolCallBlock(block) && showToolCalls) {
      parts.push(formatToolCall(block))
    }
  }
  const joined = parts.join('\n\n').trim()
  return joined.length === 0 ? undefined : joined
}

/**
 * 出站兜底防线（非主力）：仅当模型仍偶发把工具协议以 XML 文本写进 text 块时
 * （典型 `<invoke name="bash">...</invoke>`），把泄漏文本折叠成一行提示，
 * 避免污染 Matrix 房间/截图。主力是上面的 `tool-call` 主动投影，本函数仅作
 * 最后防线，正常情况下不会命中。
 *
 * 保留：```围栏代码块```、行内 `code`、转义形式 `&lt;invoke ...&gt;` 原文不动。
 */
function sanitizeAssistantText(text: string): string {
  if (!text.includes('<invoke')) return text
  const lines = text.split('\n')
  const out: string[] = []
  let fence: string | null = null
  const replaced: string[] = []
  for (const line of lines) {
    const trimmed = line.trimStart()
    if (fence !== null) {
      out.push(line)
      if (trimmed.startsWith('```')) fence = null
      continue
    }
    if (trimmed.startsWith('```')) {
      fence = '```'
      out.push(line)
      continue
    }
    out.push(replaceInvokeOutsideInlineCode(line, replaced))
  }
  if (replaced.length > 0) {
    out.push(`（已折叠 ${replaced.length} 处偶发裸写的工具协议，避免污染输出）`)
  }
  return out.join('\n')
}

function replaceInvokeOutsideInlineCode(line: string, replaced: string[]): string {
  // 简易状态机：行内 `` 配对区间内保留原文；区间外执行剥除。
  let result = ''
  let i = 0
  let buffer = ''
  while (i < line.length) {
    if (line[i] === '`') {
      const close = line.indexOf('`', i + 1)
      if (close === -1) {
        buffer += line.slice(i)
        break
      }
      // 把刚刚累积的 buffer 提交/剥除，再原样吐出行内代码段。
      result += stripInvokeTags(buffer, replaced)
      buffer = ''
      result += line.slice(i, close + 1)
      i = close + 1
      continue
    }
    buffer += line[i]
    i += 1
  }
  result += stripInvokeTags(buffer, replaced)
  return result
}

function stripInvokeTags(segment: string, replaced: string[]): string {
  if (!segment.includes('<invoke')) return segment
  // 把模型裸回显的工具协议 XML 转成可读的"调用工具"提示，保留工具名与参数，
  // 而不是直接删除导致信息丢失，也避免裸 <invoke> 文本污染 Matrix 房间/截图。
  return segment.replace(/<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/g, (_whole, attrs: string, body: string) => {
    const nameMatch = attrs.match(/\bname\s*=\s*"([^"]*)"/)
    const name = nameMatch?.[1] ?? 'unknown'
    const params = [...body.matchAll(/<parameter\b[^>]*\bname\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/parameter>/g)]
      .map((m) => `  - ${m[1] ?? ''}: ${(m[2] ?? '').trim()}`)
      .join('\n')
    replaced.push(_whole)
    const header = `🔧 调用工具 \`${name}\``
    return params.length > 0 ? `${header}\n${params}` : header
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function localpartOf(mxid: string): string {
  const at = mxid.indexOf(':')
  return at > 0 ? mxid.slice(1, at) : mxid.slice(1)
}

/** 转义正则特殊字符，用于把 localpart 安全嵌入正则。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 稳定短哈希（FNV-1a 32bit → 8 位 hex），用于确定性会话 id。 */
function stableHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * 单个 Matrix 账号的桥接单元：独立 sync 循环、独立状态文件、独立会话绑定。
 */
export class AccountBridge {
  readonly userId: string
  readonly isMain: boolean
  readonly owner?: string
  private readonly respondToAll: boolean
  private readonly agentOptions: AgentOptions

  private readonly ctx: Context
  private readonly config: Config
  private readonly state: BridgeState
  private readonly authStore: AuthStore
  private readonly channel: Channel
  private readonly allAccountIds: readonly string[]
  /** 灵魂子系统句柄（index.ts 注册后传入），用于 agentSetup 注入灵魂 prompt。 */
  private readonly soulHandle?: SoulHandle
  /** 成员记忆库（记住每个房间里见过的成员）。 */
  private readonly memberStore: MemberStore
  /** 自我时间线（跨房间，仅元数据；MatrixBridge 传入的共享实例）。 */
  private readonly timeline: TwinTimeline
  /** 任务快照发布回调（由 MatrixBridge 传入，index.ts 提供 settings 写通道）。 */
  private readonly publishTasksSnapshot?: (snapshot: TasksSnapshot) => void
  /** 时间线快照发布回调（由 MatrixBridge 传入，index.ts 提供 settings 写通道）。 */
  private readonly publishTimelineSnapshot?: (snapshot: { entries: unknown[]; updatedAt: number }) => void
  /** 诊断日志：写入 stateDir/diagnostics.log，供事后文件排查（无需运行终端）。 */
  private readonly diag: ReturnType<typeof getDiag>
  /** 近期聊天记录（按房间，最近一周）：与响应门控解耦，无论是否 @都记录，供 @时被引用。 */
  private readonly chatlog: ChatLog
  /** 共享的「房间内有 pending 审批」集合（MatrixBridge 传入，多账号协调审批应答）。 */
  private readonly pendingRooms: Set<string>

  private readonly roomAgents = new Map<string, AgentHandle>()
  /** Matrix 工具是否已注册进 ToolRuntime（全局一次，主账号负责）。 */
  private toolsRegistered = false
  /** 并发单飞锁：避免同一 roomId 的消息同时进入 getRoomAgent 时重复创建会话。 */
  private readonly roomAgentInflight = new Map<string, Promise<Agent>>()
  private readonly mergeBuffers = new Map<string, MergeBuffer>()
  /**
   * 近期消息 eventId → {sender, text} 缓存（按房间），用于解析回复引用（m.in_reply_to）
   * 与编辑替换。有界（每房间保留最近 N 条），供 handleMessage 类人注入上下文。
   */
  private readonly recentByEvent = new Map<string, Map<string, { sender: string; text: string }>>()
  /** 每房间 recentByEvent 保留上限（防止无限增长）。 */
  private readonly recentEventCap = 200
  /** 已注入的房间事件 eventId 去重（防 sync 重放重复触发）。 */
  private readonly seenRoomEventIds = new Set<string>()
  /** 房间事件合并窗口（多人同批 join/leave 合并成一条注入）。 */
  private readonly roomEventBuffers = new Map<string, { events: RoomEvent[]; timer?: NodeJS.Timeout }>()
  private readonly pendingApprovals = new Map<string, PendingApproval[]>()
  /**
   * 工具名配对缓存：tool/result 事件只带 callId 不带 name，需经 tool/call 的
   * callId↔name 配对。turn 结束时随房间清理，避免内存增长。
   */
  private readonly toolNames = new Map<string, string>()
  /**
   * 房间级 verbosity 偏好：默认 'result'（结果党）；用户说"给我过程信息"等触发词
   * 时切到 'process'（过程党）。per-room 独立，不在房间间共享。
   */
  private readonly roomVerbosity = new Map<string, Verbosity>()
  /**
   * 重试熔断计数：按房间累计当前 turn 内 LLM 受限重试次数（取 llm/retry.retry 序号）。
   * 达 config.maxRetriesBeforeAbort 时主动 agent.cancel() 终止 turn 止损。
   * turn/end 时随 toolNames 一并清理，避免内存增长。
   */
  private readonly retryCounts = new Map<string, number>()
  /**
   * LLM provider 降级标记：按房间记录「配置的 provider 不可用」。
   * 一旦 turn/end 检测到 provider 类错误，就记下失败的 provider/model 并标记该房间；
   * 后续消息直接回复友好提示（不再触发 agent 循环崩溃），直到：
   *   - 用户修改了 provider/model 配置（handleMessage 时比对当前值），或
   *   - 用户发送 /new 重置会话。
   */
  private readonly providerBroken = new Map<string, { provider: string; model: string; at: number }>()
  /**
   * 房间级 matrix 任务队列（数字分身收件箱）：别的同事发来的待审工作。
   * 内存镜像，与 state.matrixTasks 同步；数字分身模式下入站消息进此队列，
   * 由 Owner 用 /approve 逐条授权后串行执行。
   */
  private readonly matrixTasks = new Map<string, MatrixTask[]>()
  /**
   * 等待选工作目录的房间：值为候选目录列表 + 暂存的待执行任务 id。
   * 新房间首次 /approve 时若尚未绑定工作目录则进入此态。
   */
  private readonly cwdPending = new Map<string, { candidates: string[]; taskId: string }>()
  /** 房间当前正在执行（已 approve、turn 进行中）的任务 id。 */
  private readonly runningTask = new Map<string, string>()

  constructor(
    ctx: Context,
    config: Config,
    state: BridgeState,
    authStore: AuthStore,
    account: DigitalTwinAccount,
    allAccountIds: readonly string[],
    pendingRooms: Set<string>,
    soulHandle?: SoulHandle,
    timeline?: TwinTimeline,
    publishTasksSnapshot?: (snapshot: TasksSnapshot) => void,
    publishTimelineSnapshot?: (snapshot: { entries: unknown[]; updatedAt: number }) => void,
    fetchFn?: typeof fetch,
    sleep?: (ms: number) => Promise<void>,
  ) {
    this.ctx = ctx
    this.config = config
    this.state = state
    this.authStore = authStore
    this.allAccountIds = allAccountIds
    this.pendingRooms = pendingRooms
    this.soulHandle = soulHandle
    this.timeline = timeline ?? new TwinTimeline(config.stateDir, config.timelineCap ?? 500)
    this.publishTasksSnapshot = publishTasksSnapshot
    this.publishTimelineSnapshot = publishTimelineSnapshot
    this.diag = getDiag('dsh-matrix-agent', config.stateDir)
    this.chatlog = new ChatLog(config.stateDir)
    this.memberStore = new MemberStore(config.stateDir)

    this.userId = account.userId
    this.isMain = account.userId === config.userId
    this.owner = account.owner !== '' ? account.owner : (this.isMain ? config.owner : undefined)
    // 响应策略：完全由配置决定（主账号 Schema 默认 true，分身默认 false）。
    // 不再强制主账号为 true，用户可显式设 false 让主账号也只响应 @ 自己的消息。
    this.respondToAll = account.respondToAll
    this.agentOptions = {
      provider: account.provider !== '' ? account.provider : config.provider,
      model: account.model !== '' ? account.model : config.model,
    }

    this.channel = new MatrixChannel({
      homeserverUrl: config.homeserverUrl,
      accessToken: account.accessToken,
      userId: this.userId,
      state: this.state,
      onMessage: (message) => {
        void this.handleMessage(message)
      },
      onRoomEvent: (event) => {
        void this.handleRoomEvent(event)
      },
      isAllowed: (sender) => this.authorized(sender),
      logger: ctx.logger,
      ...(fetchFn === undefined ? {} : { fetchFn }),
      ...(sleep === undefined ? {} : { sleep }),
    })
  }

  /** ---------- 生命周期 ---------- */

  async start(): Promise<void> {
    await this.state.load()
    if (this.config.memberMemory !== false) {
      await this.memberStore.load().catch((error: unknown) => {
        this.ctx.logger.warn('[dsh-matrix-agent] member store load failed: %s', messageOf(error))
      })
    }
    if (this.config.timelineEnabled !== false) {
      this.timeline.load()
    }
    // 恢复各房间任务队列到内存镜像（重启不丢审核进度）。
    for (const [roomId, tasks] of Object.entries(this.state.matrixTasksSnapshot())) {
      this.matrixTasks.set(roomId, tasks)
    }
    // 启动即发布一次快照（任务 + 时间线）：即使当前无活动，Client 也能读到
    // 空/历史数据，而不是永远"加载中"。
    this.publishTasks()
    this.publishTimeline()
    this.diag.log(`start: published initial snapshots (tasks rooms=${this.matrixTasks.size}, publishTasksSnapshot=${this.publishTasksSnapshot !== undefined}, publishTimelineSnapshot=${this.publishTimelineSnapshot !== undefined})`)
    // Matrix 专属工具：注册到 ToolRuntime（全局 layer），所有 agent 可见可调用。
    // 幂等守卫：多账号（主 + 分身）共享同一 ctx，只有主账号注册一次。
    if (this.isMain && !this.toolsRegistered) {
      this.toolsRegistered = true
      this.registerToolsOnce()
    }
    await this.connectWithRetry()
  }

  /**
   * 通过 ctx.tools.register(defineTool(...)) 把 4 个 Matrix 工具注册进 ToolRuntime。
   * 与旧的 systemPrompt.tools() 方式的本质区别：ToolRuntime 同时持有 schema 与
   * 执行体，模型既能看到工具也能真正执行；systemPrompt 的 provider 只投影 schema，
   * 调用时会报 unknown tool。roomId 绑定改为 execute 时通过 exec.agent.id 反查，
   * 不再需要 per-agent 注册。
   */
  private registerToolsOnce(): void {
    if (this.config.matrixTools === false) return
    if (this.ctx.get('tools') === undefined) {
      this.ctx.logger.warn('[dsh-matrix-agent] tools service unavailable; matrix tools not registered')
      return
    }
    void import('./tools.js').then(({ applyMatrixTools, setToolLogger }) => {
      setToolLogger((message: string, ...args: unknown[]) => {
        const rest = args.length > 0 ? ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') : ''
        this.diag.log(`${message}${rest}`)
      })
      applyMatrixTools(this.ctx, {
        channel: this.channel as MatrixChannel,
        roomForSession: (sessionId: string) => this.roomForSession(sessionId),
        approveProactiveSend: (toolName: string, args: Record<string, unknown>, exec: ToolRunContext) =>
          this.approveProactiveSend(toolName, args, exec),
        mediaDirForSession: (sessionId: string) => this.mediaDirForSession(sessionId),
        queryTimeline: (filter) => {
          const f = filter as { roomId?: string; kind?: string; actor?: string; limit?: number; since?: number }
          const kinds: TimelineKind[] = ['reply', 'tool-call', 'proactive', 'self-intro', 'approval', 'task']
          return this.timeline.query({
            ...(f.roomId !== undefined ? { roomId: f.roomId } : {}),
            ...(f.kind !== undefined && (kinds as string[]).includes(f.kind) ? { kind: f.kind as TimelineKind } : {}),
            ...(f.actor === 'secretary' || f.actor === 'worker' ? { actor: f.actor } : {}),
            ...(f.limit !== undefined ? { limit: f.limit } : {}),
            ...(f.since !== undefined ? { since: f.since } : {}),
          })
        },
      })
      this.ctx.logger.info('[dsh-matrix-agent] matrix tools registered into ToolRuntime')
    }).catch((error: unknown) => {
      this.ctx.logger.error('[dsh-matrix-agent] matrix tools registration failed: %s', messageOf(error))
    })
  }

  async stop(): Promise<void> {
    const handles = [...this.roomAgents.values()]
    this.roomAgents.clear()
    this.roomAgentInflight.clear()
    await Promise.allSettled(handles.map((handle) => handle.dispose()))
    await this.channel.stop()
    await this.state.dispose()
    if (this.config.memberMemory !== false) {
      await this.memberStore.dispose().catch((error: unknown) => {
        this.ctx.logger.warn('[dsh-matrix-agent] member store save failed: %s', messageOf(error))
      })
    }
  }

  private async connectWithRetry(): Promise<void> {
    let attempt = 0
    for (;;) {
      try {
        await this.channel.start()
        this.ctx.logger.info(
          '[dsh-matrix-agent] %s connected as %s%s',
          this.isMain ? 'main' : 'twin',
          this.userId,
          this.owner !== undefined ? ` (owner: ${this.owner})` : '',
        )
        return
      } catch (error) {
        attempt += 1
        this.ctx.logger.warn('[dsh-matrix-agent] sync failed for %s (attempt %d): %s', this.userId, attempt, messageOf(error))
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * attempt, 10000)))
      }
    }
  }

  /** ---------- 身份与权限 ---------- */

  private authorized(sender: string): boolean {
    if (this.config.allowAllUsers) return true
    if (this.owner !== undefined && sender === this.owner) return true
    return this.config.allowedUserIds.includes(sender)
  }

  /**
   * 消息路由（多账号协作语义）：
   * 1. 若消息 @提及 了任一已知账号（主账号或分身），则只有被 @提及 的账号响应，
   *    其余账号（含主账号）一律静默，避免抢答别人/别的数字人的对话；
   * 2. 无任何 @提及 时：私聊（≤2 人房间）始终响应；群聊里是否响应取决于 respondToAll——
   *    respondToAll=true（主账号默认，个人助手模式）响应群里所有消息；
   *    respondToAll=false（分身默认）只响应 @ 自己的消息，避免浪费 token 与抢答别人的对话。
   *    命令同样遵循该规则；审批应答不受此门控限制。
   */
  private async shouldRespond(message: InboundMessage): Promise<boolean> {
    const lower = message.text.toLowerCase()
    // 提及识别兼容三种 Matrix 渲染格式：
    //  1) '@名字'（Element 常见）
    //  2) '@名字:域名' 完整 ID
    //  3) '名字:' / '名字：'（部分客户端/桥接把 @提及 渲染为 "名字: 内容"，无 @ 无域名）
    const mentioned = this.allAccountIds.filter((id) => {
      const lp = localpartOf(id).toLowerCase()
      return (
        lower.includes(`@${lp}`) ||
        lower.includes(id.toLowerCase()) ||
        new RegExp(`(^|\\s)${escapeRegExp(lp)}[:：]`).test(lower)
      )
    })
    const isDm = this.channel.isDirectRoom ? await this.channel.isDirectRoom(message.roomId) : false
    // 诊断日志：每次门控决策都打印关键因子，便于事后从 diagnostics.log 排查"为何响应/静默"。
    this.diag.log(`shouldRespond room=${message.roomId} account=${this.userId} isMain=${this.isMain} respondToAll=${this.respondToAll} isDm=${isDm} mentioned=${mentioned.length > 0 ? mentioned.join(',') : '(none)'} text=${message.text.slice(0, 60).replace(/\n/g, ' ')}`)
    // 消息 @提及了某个已知账号：只有被 @的账号响应，其余全部静默（含主账号）。
    if (mentioned.length > 0) {
      const ok = mentioned.includes(this.userId)
      this.diag.log(`  -> mentioned-branch: respond=${ok} (${ok ? 'self' : 'other'} mentioned)`)
      return ok
    }
    // 无人被 @提及：私聊始终响应。
    if (isDm) {
      this.diag.log('  -> dm-branch: respond=true')
      return true
    }
    // 群聊：是否响应取决于 respondToAll。
    // respondToAll=true（主账号默认，个人助手模式）：响应群里所有消息。
    // respondToAll=false（分身默认）：只响应 @ 自己的消息，避免浪费 token 与抢答。
    if (this.respondToAll) {
      this.diag.log('  -> group-respondToAll-branch: respond=true')
      return true
    }
    // 群聊默认秘书（分身账号）：未 @ 的群聊消息也放行进后续流程（由 isTwinMode 决定
    // 是否进任务队列；私聊或 @ 提及仍按原逻辑）。避免工作任务被 shouldRespond 提前过滤。
    if (this.config.secretaryGroupDefault !== false && !this.isMain) {
      const dm = this.channel.isDirectRoom ? await this.channel.isDirectRoom(message.roomId) : false
      if (!dm) {
        this.diag.log('  -> group-secretary-branch: respond=true (queue gate)')
        return true
      }
    }
    this.diag.log('  -> group-silent-branch: respond=false')
    return false
  }

  private isRedline(toolName: string): boolean {
    return (this.config.redlineTools ?? []).includes(toolName)
  }

  /** ---------- 会话绑定 ---------- */

  roomForSession(sessionId: string): string | undefined {
    return this.state.sessionRoom(sessionId)
  }

  /**
   * 返回某会话（agent）对应的媒体保存目录。
   * 优先该房间绑定的工作目录下 .dsh-matrix/media；无 cwd 时回退 stateDir/media。
   * matrix_get_media 工具据此落盘下载的媒体。
   */
  private mediaDirForSession(sessionId: string): string | undefined {
    try {
      const roomId = this.state.sessionRoom(sessionId)
      if (roomId !== undefined) {
        const cwd = this.state.roomCwd(roomId)
        if (cwd !== undefined) return join(cwd, '.dsh-matrix', 'media')
      }
      return join(this.config.stateDir, 'media')
    } catch {
      return join(this.config.stateDir, 'media')
    }
  }

  private getRoomAgent(roomId: string): Promise<Agent> {
    // 已建立：直接返回缓存的 agent。
    const existing = this.roomAgents.get(roomId)
    if (existing !== undefined) return Promise.resolve(existing.agent)

    // 并发单飞：同一 roomId 同时到达的多条消息复用同一个建连 promise，
    // 杜绝对同一个确定性 sessionId 并发 create 导致 "while it is live"。
    const inflight = this.roomAgentInflight.get(roomId)
    if (inflight !== undefined) return inflight

    const promise = this.createRoomAgent(roomId).finally(() => {
      this.roomAgentInflight.delete(roomId)
    })
    this.roomAgentInflight.set(roomId, promise)
    return promise
  }

  private async createRoomAgent(roomId: string): Promise<Agent> {
    const cwd = this.state.roomCwd(roomId) ?? (this.config.cwdCandidates ?? [])[0] ?? process.cwd()

    let handle: AgentHandle | undefined
    const bindingId = this.state.roomSession(roomId)
    if (bindingId !== undefined) {
      try {
        handle = await this.ctx.agents.resume({
          resumeSessionId: SessionId(bindingId),
          agentOptions: this.agentOptions,
          setup: this.agentSetup(),
        })
      } catch (error) {
        const reason = messageOf(error)
        // 内核并发恢复导致已 live：直接取用（工具已全局注册，无需 setup 注入）。
        if (reason.includes('while it is live')) {
          const live = this.ctx.agents.get(SessionId(bindingId))
          if (live !== undefined) {
            handle = { agent: live, dispose: async () => {} }
          }
        }
        if (handle === undefined) {
          this.ctx.logger.warn('[dsh-matrix-agent] resume %s failed (%s); using deterministic id', bindingId, reason)
        }
      }
    }

    // 确定性会话 id：同一房间、同一代数下永远同一 id。
    // 代数（epoch）使 /clear 或损坏历史重建后生成全新 id，避免 resume 到旧会话。
    if (handle === undefined) {
      const epoch = this.state.sessionEpoch(roomId)
      const suffix = epoch > 0 ? `-e${epoch}` : ''
      const sessionId = SessionId(`matrix-${localpartOf(this.userId)}-${stableHash(roomId)}${suffix}`)
      handle = await this.acquireAgent(sessionId, { cwd })
    }

    // 损坏历史自愈：若会话历史里存在「孤立 tool-result」（前面没有带 tool_calls
    // 的 assistant 消息），说明上一代会话遗留了坏数据（常见于工具注册成功前的
    // 失败调用被额外 append）。此时丢弃该会话、代数 +1、用新 id 重建，否则每次
    // 请求都会被 LLM API 以 INVALID_REQUEST 拒绝。
    if (this.sessionHasOrphanToolResult(handle.agent)) {
      this.ctx.logger.warn('[dsh-matrix-agent] session %s has orphan tool-result history; rebuilding with new epoch (room=%s)', handle.agent.id, roomId)
      await handle.dispose().catch(() => {})
      this.state.deleteRoom(roomId)
      const nextEpoch = this.state.bumpSessionEpoch(roomId)
      const sessionId = SessionId(`matrix-${localpartOf(this.userId)}-${stableHash(roomId)}-e${nextEpoch}`)
      handle = await this.acquireAgent(sessionId, { cwd })
    }

    this.roomAgents.set(roomId, handle)
    this.state.setRoomSession(roomId, handle.agent.id)
    // 会话标题 = Matrix 房间名（pin 住，自动标题不再覆盖）。
    void this.nameSessionFromRoom(roomId, handle.agent)
    return handle.agent
  }

  /**
   * 检测会话历史里是否有「孤立 tool-result」：某条 user 消息带 tool-result 内容块，
   * 但往前最近的 assistant 消息没有 tool_calls（或没有声明足够的 tool_call）。
   * 这种历史会让 LLM API 拒绝请求（Messages with role 'tool' must be a response to
   * a preceding message with 'tool_calls'）。
   */
  private sessionHasOrphanToolResult(agent: Agent): boolean {
    try {
      const session = (agent as unknown as { session?: { deriveMessages?(): unknown[] } }).session
      if (!session || typeof session.deriveMessages !== 'function') return false
      const messages = session.deriveMessages()
      let openCalls = 0
      for (const message of messages) {
        const m = message as { role?: string; content?: Array<{ type: string }>; tool_calls?: unknown[] } | undefined
        if (!m || typeof m !== 'object') continue
        if (m.role === 'assistant') {
          openCalls += Array.isArray(m.tool_calls) ? m.tool_calls.length : 0
          continue
        }
        const toolResults = Array.isArray(m.content) ? m.content.filter((c) => c.type === 'tool-result').length : 0
        if (toolResults > openCalls) return true
        openCalls = Math.max(0, openCalls - toolResults)
      }
      return false
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix-agent] orphan tool-result check failed: %s', messageOf(error))
      return false
    }
  }

  /**
   * 构建 agent 的 setup 回调：在 agent scope 上 compose 配置指定的 preset，使
   * shell/file/检索/skills 等工具挂载到该 agent。harness 的 GUI 会话由 host 自动注入
   * 此 setup；dsh-matrix 直接走 ctx.agents.create/resume（底层 factory），必须自己传
   * setup，否则 agent 不 compose 任何 preset → 工具不可见。
   *
   * 注意：matrix 专属工具（matrix_get_room_members 等）不在此注册，而是在
   * start() 里通过 applyMatrixTools 一次性注册到全局 ToolRuntime layer。
   * 原因：ToolRuntime.register() 始终写入全局 layer（scopeOf(rootCtx)===undefined），
   * 与 setup 的 agentCtx 无关；execute 时通过 exec.agent.id 反查房间。
   */
  private agentSetup(): (agentCtx: Context) => Promise<void> {
    const preset = this.config.agentPreset ?? 'standard'
    return async (agentCtx: Context) => {
      // agentPresets 是 host 平面服务（host-plane），不在 dsh-matrix 插件 ctx 的类型声明里，
      // 不能用 this.ctx.agentPresets（会触发 cordis "without inject"）。用 this.ctx.get() 动态
      // 取 host 服务实例，再把 preset 挂载到 setup 回调传入的 agent scope（agentCtx）上。
      const presets = this.ctx.get('agentPresets') as
        | { mount(c: Context, id: string): Promise<unknown> }
        | undefined
      if (!presets) {
        throw new Error('agentPresets service is not available on the host context')
      }
      await presets.mount(agentCtx, preset)
      // 灵魂注入：在 agent scope 上注册 system prompt section（仅对该 room agent 生效）。
      // 用 agentCtx 的 systemPrompt（scope 化）注册，避免污染 GUI 会话。
      // 防御：agentCtx.get 在测试 mock/特殊上下文中可能不存在，缺失时跳过注入。
      const getSystemPrompt = (): { section(section: { name: string; order: number; text: string | (() => string) }): () => void } | undefined => {
        if (typeof agentCtx?.get !== 'function') return undefined
        return agentCtx.get('systemPrompt') as
          | { section(section: { name: string; order: number; text: string | (() => string) }): () => void }
          | undefined
      }
      const soul = this.soulHandle
      if (soul !== undefined && soul.getSoulConfig().enabled !== false) {
        const systemPrompt = getSystemPrompt()
        if (systemPrompt !== undefined) {
          agentCtx.effect(() => systemPrompt.section({
            name: 'twin:soul',
            order: 5,
            text: () => soulText(soul.getSoulConfig()),
          }), 'matrix-agent.soul')
        }
      }
      // 自我时间线常驻提示词段（第 0 级暴露）：恒定字符串，字节永不变化，
      // 不影响 KV 缓存命中率；只告知能力，摘要/详情按需工具查。
      // 高 order（尾部），避免其后的内容因顺序不稳定影响缓存前缀。
      if (this.config.timelineEnabled !== false && this.config.timelineInject !== false) {
        const systemPrompt = getSystemPrompt()
        if (systemPrompt !== undefined) {
          agentCtx.effect(() => systemPrompt.section({
            name: 'twin:memory',
            order: 1000,
            text: TIMELINE_MEMORY_SECTION_TEXT,
          }), 'matrix-agent.timeline-memory')
        }
      }
    }
  }

  /**
   * 取得（或恢复）某会话对应的 live agent，规避与内核自动加载的并发碰撞、以及
   * create 时 cwd 与磁盘持久化值不一致导致的 "id collision"。
   *
   * 顺序：
   *   1. 内核已加载并注册为 live agent —— 直接取用，绝不重复 prepare；
   *   2. 先 resume 续接历史（不传 cwd，复用磁盘持久化的 cwd，避免 cwd 不匹配的 id collision）；
   *   3. resume 因「无持久化 log」失败（全新会话）—— 用 create 新建（带 cwd）；
   *   4. resume 撞 "while it is live"（内核并发 prepare 刚好完成）—— 轮询等待内核把
   *      会话注册到 agents 表后取用，避免二次 prepare 撞车；
   *   5. 其它 resume 失败（如 live turn 未关闭）也先轮询一次内核是否已就绪，仍失败再抛出。
   */
  private async acquireAgent(sessionId: SessionId, meta: { cwd: string }): Promise<AgentHandle> {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const wrap = (agent: Agent): AgentHandle => ({ agent, dispose: async () => {} })
    const waitForLive = async (label: string): Promise<AgentHandle | undefined> => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const live = this.ctx.agents.get(sessionId)
        if (live !== undefined) {
          if (attempt > 0) this.ctx.logger.info('[dsh-matrix-agent] session %s live after %dms (%s)', sessionId, (attempt + 1) * 150, label)
          return wrap(live)
        }
        await sleep(150)
      }
      return undefined
    }

    // 1) 内核已加载并注册为 live agent：直接取用，绝不重复 prepare。
    const liveNow = this.ctx.agents.get(sessionId)
    if (liveNow !== undefined) return wrap(liveNow)

    // 2) resume 续接历史（不传 cwd，复用磁盘持久化 cwd，避免 cwd 不匹配的 id collision）。
    try {
      return await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.agentOptions,
        setup: this.agentSetup(),
      })
    } catch (resumeError) {
      const reason = messageOf(resumeError)
      // 3) 无持久化 log（全新会话）：create 新建（带 cwd）。
      if (reason.includes('not found') || reason.includes('no such') || reason.includes('has no persisted')) {
        this.ctx.logger.warn('[dsh-matrix-agent] session %s has no persisted log; creating fresh', sessionId)
        return this.ctx.agents.create({
          sessionId,
          meta: {
            cwd: meta.cwd,
            agentPreset: this.config.agentPreset ?? 'standard',
          },
          agentOptions: this.agentOptions,
          setup: this.agentSetup(),
        })
      }
      // 4) 内核并发 prepare 撞车：轮询等待内核把会话注册到 agents 表后取用。
      const waited = await waitForLive('resume-collision')
      if (waited !== undefined) return waited
      // 5) 其它 resume 失败：再轮询一次内核是否已就绪，仍失败抛出原始错误。
      if (reason.includes('while it is live')) {
        const waited2 = await waitForLive('resume-live')
        if (waited2 !== undefined) return waited2
      }
      throw resumeError
    }
  }


  /** 若 Matrix 房间有名字，把 agent 会话标题固定为房间名。 */
  private async nameSessionFromRoom(roomId: string, agent: Agent): Promise<void> {
    try {
      const roomName = await this.channel.getRoomName?.(roomId)
      if (roomName === undefined || roomName === '') return
      const title = this.ctx.get('sessionTitle')
      if (title === undefined) return
      title.rename(agent.session, roomName)
      this.ctx.logger.info('[dsh-matrix-agent] session %s titled "%s"', agent.id, roomName)
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix-agent] title rename failed: %s', messageOf(error))
    }
  }

  private async releaseRoom(roomId: string): Promise<void> {
    const handle = this.roomAgents.get(roomId)
    this.roomAgentInflight.delete(roomId)
    if (handle !== undefined) {
      this.roomAgents.delete(roomId)
      await handle.dispose()
    }
    // 代数 +1：下一次 createRoomAgent 生成全新的确定性会话 id，
    // 不再 resume 旧的（可能带损坏历史）会话。
    this.state.bumpSessionEpoch(roomId)
    this.state.deleteRoom(roomId)
    this.settleAll(roomId, 'unavailable')
    const buffer = this.mergeBuffers.get(roomId)
    if (buffer !== undefined) {
      if (buffer.timer !== undefined) clearTimeout(buffer.timer)
      this.mergeBuffers.delete(roomId)
    }
    this.toolNames.delete(roomId)
    this.roomVerbosity.delete(roomId)
    this.retryCounts.delete(roomId)
    this.matrixTasks.delete(roomId)
    this.cwdPending.delete(roomId)
    this.runningTask.delete(roomId)
  }

  /** ---------- 入站消息 ---------- */

  /**
   * 处理房间成员/资料变更事件（入群/离群/改名换头像/邀请/自己入群）。
   * 门控：
   *   - `self-join`（自己入群）：autoIntroduce 开启时主动 @ 成员自我介绍（独立于 notifyRoomEvents）。
   *   - 成员记忆（memberMemory 开）：join/profile 事件 upsert 到 memberStore。
   *   - `autoGreet` 开且房间已绑定 agent：新成员 join 注入系统事件引导主动打招呼。
   *   - 其余注入（notifyRoomEvents 开）保持原行为。
   */
  private async handleRoomEvent(event: RoomEvent): Promise<void> {
    const roomId = event.roomId
    // 自己入群：主动自我介绍（@ 成员）。
    if (event.kind === 'self-join') {
      if (this.config.autoIntroduce !== false) {
        this.diag.log(`handleRoomEvent room=${roomId} kind=self-join autoIntroduce=true`)
        await this.selfIntroduce(roomId)
      } else {
        this.diag.log(`handleRoomEvent room=${roomId} kind=self-join autoIntroduce=false; skip`)
      }
      return
    }
    // 成员记忆：join/profile 记录成员（其他数字人也记）。
    if (this.config.memberMemory !== false && event.userId !== undefined && event.userId !== this.userId) {
      this.memberStore.upsert(roomId, {
        userId: event.userId,
        ...(event.detail?.displayName !== undefined ? { displayName: String(event.detail.displayName) } : {}),
        ...(event.detail?.avatarUrl !== undefined ? { avatarUrl: String(event.detail.avatarUrl) } : {}),
      })
      this.memberStore.scheduleSave()
      this.diag.log(`handleRoomEvent room=${roomId} kind=${event.kind} member-memory upsert ${event.userId}`)
    }
    // autoGreet：新成员 join（含新数字人）且房间已绑定 agent → 提示主动打招呼。
    if (event.kind === 'join' && event.userId !== undefined && event.userId !== this.userId) {
      if (this.config.autoGreet !== false && this.roomAgents.has(roomId)) {
        const who = event.userId
        const known = this.memberStore.remembered(roomId, who)
        const text = `[系统事件] 新成员 ${who} 加入了本房间${known ? '（你之前见过 TA，可打招呼问候）' : '（这是你们第一次见面，请主动打个招呼，简单了解一下对方是谁、负责什么）'}。你可以主动向 TA 发一条消息互相认识。`
        void this.deliverRoomEvent(roomId, text)
        return
      }
    }
    // 原有门控：notifyRoomEvents 关闭时忽略其余事件。
    if (!this.config.notifyRoomEvents) return
    // 事件涉及的成员需在授权名单（join/leave/profile/invite 有 userId）。
    if (event.userId !== undefined && !this.authorized(event.userId)) {
      this.diag.log(`handleRoomEvent room=${roomId} kind=${event.kind} user=${event.userId} unauthorized; ignored`)
      return
    }
    // 房间信息事件（room-name/room-topic）没有 userId，用房间名判断是否已知房间。
    if (event.userId === undefined && !this.roomAgents.has(roomId)) {
      this.diag.log(`handleRoomEvent room=${roomId} kind=${event.kind} no bound agent; ignored`)
      return
    }
    // 事件注入去重（用 eventId）：已见过则不重复注入。
    if (this.seenRoomEventIds.has(event.eventId)) return
    this.seenRoomEventIds.add(event.eventId)

    // 合并窗口：同一房间 3 秒内的成员事件合并成一条，避免 join/leave 刷屏建多 turn。
    const key = roomId
    const buf = this.roomEventBuffers.get(key) ?? { events: [], timer: undefined }
    buf.events.push(event)
    if (buf.timer !== undefined) clearTimeout(buf.timer)
    buf.timer = setTimeout(() => {
      void this.flushRoomEvents(key)
    }, this.config.mergeTimeoutSecs * 1000)
    this.roomEventBuffers.set(key, buf)
  }

  /**
   * 自己入群后的自我介绍：模板渲染 → @ 房间成员发送。
   * @ 人数上限 maxSelfIntroMentions，超出截断并附「等 N 人」。
   */
  private async selfIntroduce(roomId: string): Promise<void> {
    try {
      const members = await this.channel.getRoomMembers?.(roomId)
      if (members === undefined) {
        this.diag.log(`selfIntroduce room=${roomId} no members; skip`)
        return
      }
      const template = this.config.selfIntroTemplate ?? ''
      const text = template
        .replaceAll('{{userId}}', this.userId)
        .replaceAll('{{role}}', this.isMain ? '主账号' : (this.owner !== undefined ? `数字分身（Owner: ${this.owner}）` : '数字分身'))
        .replaceAll('{{owner}}', this.owner ?? '')
      // 排除自己。
      const targets = members.filter((m) => m.userId !== this.userId).map((m) => m.userId)
      const cap = this.config.maxSelfIntroMentions ?? 20
      const mentions = targets.slice(0, cap)
      const rest = targets.length - mentions.length
      const mentionText = mentions.length > 0
        ? (rest > 0 ? `${text}\n（另有 ${rest} 位成员，很高兴认识大家！）` : text)
        : text
      this.diag.log(`selfIntroduce room=${roomId} targets=${targets.length} mentions=${mentions.length}`)
      if (mentions.length > 0 && this.channel.sendMentionText !== undefined) {
        await this.channel.sendMentionText(roomId, mentionText, mentions)
      } else {
        await this.channel.sendText(roomId, mentionText)
      }
      // 写 chatlog（分身自己发的消息也记录，便于回溯）。
      this.chatlog.append(roomId, {
        ts: Date.now(),
        sender: `${this.userId} (self-intro)`,
        text: mentionText,
      })
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix-agent] selfIntroduce room=%s failed: %s', roomId, messageOf(error))
    }
  }

  /** 把合并窗口内的房间事件组合成一条消息注入 agent。 */
  private flushRoomEvents(roomId: string): void {
    const buf = this.roomEventBuffers.get(roomId)
    if (buf === undefined) return
    this.roomEventBuffers.delete(roomId)
    if (buf.timer !== undefined) clearTimeout(buf.timer)
    if (buf.events.length === 0) return
    const lines = buf.events.map((e) => this.formatRoomEvent(e))
    const text = `[系统事件·${lines.length > 1 ? `${lines.length} 项` : '1 项'}]\n${lines.join('\n')}`
    this.diag.log(`flushRoomEvents room=${roomId} events=${buf.events.length} text=${text.slice(0, 80)}`)
    void this.deliverRoomEvent(roomId, text)
  }

  /** 把一条 RoomEvent 格式化为 agent 可读的一行文本。 */
  private formatRoomEvent(e: RoomEvent): string {
    const who = e.userId ?? '(房间)'
    switch (e.kind) {
      case 'join': return `新成员 ${who} 加入了本房间`
      case 'leave': return `成员 ${who} 离开了本房间`
      case 'invite': return `${who} 被邀请进本房间`
      case 'self-join': return `你（${who}）已加入本房间`
      case 'profile':
        return `成员 ${who} 更新了资料（${Object.entries(e.detail ?? {}).map(([k, v]) => `${k}=${String(v)}`).join(', ')}）`
      case 'room-name': return `房间名称变更为「${String(e.detail?.name ?? '')}」`
      case 'room-topic': return `房间主题更新`
      default: return `房间事件（${e.kind}）`
    }
  }

  /** 把房间事件文本注入房间 agent 会话（复用 roomContextLabel 前缀 + deliver 路径）。 */
  private async deliverRoomEvent(roomId: string, text: string): Promise<void> {
    try {
      // 仅注入已绑定会话的房间；未绑定不自动建会话。
      const handle = this.roomAgents.get(roomId)
      if (handle === undefined) {
        this.diag.log(`deliverRoomEvent room=${roomId} no bound agent; skip`)
        return
      }
      const label = await this.roomContextLabel(roomId)
      const body = `${label}\n${text}`
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: body }],
        source: { kind: 'user', sender: `@system:${this.userId}` },
      }))
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix-agent] deliverRoomEvent room=%s failed: %s', roomId, messageOf(error))
    }
  }

  /**
   * 把入站媒体归一为 agent 可读文本：尝试下载 mxc 媒体到本地并附上路径，
   * 让 agent 能真正处理图片/文件；下载失败则退化为占位文本。
   * 图片额外通过 ctx.attachments 持久化为多模态引用（imageRefs），供 deliver 附加为
   * 视觉内容块，使模型直接“看见”图片而无需调用文件读取工具。
   * 保存目录：优先该房间工作目录的 .dsh-matrix/media，无 cwd 时回退 stateDir/media。
   * 返回的 text 为空串表示无媒体。
   */
  private async describeMedia(roomId: string, media: readonly MediaBlock[]): Promise<{ text: string; imageRefs: ImageAttachmentRef[] }> {
    if (media.length === 0) return { text: '', imageRefs: [] }
    const parts: string[] = []
    const imageRefs: ImageAttachmentRef[] = []
    for (const m of media) {
      const label = MEDIA_LABELS[m.msgtype] ?? '附件'
      const name = m.filename ?? m.body ?? label
      if (m.mxc !== undefined && m.mxc !== '' && this.config.matrixTools) {
        try {
          const { buffer, mimetype } = await this.channel.downloadMedia!(m.mxc)
          const cwd = this.state.roomCwd(roomId)
          const dir = cwd !== undefined ? join(cwd, '.dsh-matrix', 'media') : join(this.config.stateDir, 'media')
          await mkdir(dir, { recursive: true })
          const ext = mediaExtension(mimetype)
          const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || `matrix-media-${Date.now()}${ext}`
          const target = join(dir, safe)
          await writeFile(target, buffer)
          this.diag.log(`describeMedia room=${roomId} saved=${target} size=${buffer.length}`)
          parts.push(`[${label}: ${name} — 已保存到 ${target}｜mxc: ${m.mxc}]`)
          // 图片额外持久化为多模态附件，供视觉输入。
          if (m.msgtype === 'm.image') {
            const mediaType = normalizeImageMediaType(mimetype)
            if (mediaType !== undefined) {
              try {
                const ref = await this.saveImageAttachment(buffer, mediaType, name)
                imageRefs.push(ref)
              } catch (error) {
                this.diag.log(`describeMedia room=${roomId} saveImage failed: ${messageOf(error)}`)
              }
            }
          }
          continue
        } catch (error) {
          this.diag.log(`describeMedia room=${roomId} download failed: ${messageOf(error)}`)
          // 下载失败：仍附 mxc 链接，供 agent 用 matrix_get_media 重新下载。
          parts.push(`[${label}: ${name} 下载失败 — 可用 matrix_get_media 工具重下｜mxc: ${m.mxc}]`)
          continue
        }
      }
      // 位置消息无 mxc，把坐标写进文本（geo_uri 形如 geo:37.78,-122.41;u=35）。
      if (m.msgtype === 'm.location' && m.geoUri !== undefined) {
        parts.push(`[位置: ${name} — ${m.geoUri}]`)
        continue
      }
      parts.push(`[${label}: ${name}${m.mimetype !== undefined ? ` (${m.mimetype})` : ''}]`)
    }
    return { text: '\n' + parts.join(' '), imageRefs }
  }

  /** 把图片字节持久化为 harness 多模态附件（ctx.attachments.saveImage）。 */
  private async saveImageAttachment(data: Uint8Array, mediaType: ImageMediaType, name: string): Promise<ImageAttachmentRef> {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) throw new Error('attachments service unavailable')
    return await attachments.saveImage({ data, mediaType, name })
  }

  /**
   * 类人上下文注入：把一条消息的回复引用 / 编辑标记 / 富文本结构补成可读文本，
   * 使 agent 像人一样理解"这条消息是在回复谁、是编辑后的最新版、含哪些富文本结构"。
   * 仅在 preserveRichText=true 时调用；返回已增强的文本。
   * 富文本保守策略：纯文本仍是主内容，富文本只做简短的结构注记，避免 token 失控。
   */
  private buildMessageContext(message: InboundMessage, baseText: string): string {
    const parts: string[] = []
    // 回复引用：把被回复的原消息文本作为前缀，模拟"人看到你在回复某某"。
    if (message.replyToEventId !== undefined) {
      const quoted = this.recentByEvent.get(message.roomId)?.get(message.replyToEventId)
      if (quoted !== undefined) {
        parts.push(`[回复 @${localpartOf(quoted.sender)} 的消息: ${quoted.text}]`)
      } else {
        parts.push('[回复了一条消息]')
      }
    }
    // 编辑标记：标注这是某条消息的编辑后最新版。
    if (message.isEdit) {
      parts.push(message.editTargetEventId !== undefined
        ? '[此消息是对其早前版本的编辑后最新版]'
        : '[此消息已编辑]')
    }
    // 富文本结构注记：保留链接/加粗/代码块/列表语义，供模型理解格式（不替换纯文本）。
    if (message.formattedHtml !== undefined) {
      const structure = this.richTextSummary(message.formattedHtml)
      if (structure !== '') parts.push(`[富文本含: ${structure}]`)
    }
    if (parts.length === 0) return baseText
    return `${parts.join(' ')}\n${baseText}`
  }

  /**
   * 从 Matrix HTML（formatted_body）里提取简短的结构注记（有链接/加粗/代码块/列表/标题时说明），
   * 供模型理解格式语义。不做完整渲染，仅保留"有哪些结构"这一层信息。
   */
  private richTextSummary(html: string): string {
    const tags: string[] = []
    if (/<a\b/i.test(html)) tags.push('链接')
    if (/<strong\b|<b\b/i.test(html)) tags.push('加粗')
    if (/<em\b|<i\b/i.test(html)) tags.push('斜体')
    if (/<code\b|<pre\b/i.test(html)) tags.push('代码')
    if (/<ul\b|<ol\b|<li\b/i.test(html)) tags.push('列表')
    if (/<h[1-6]\b/i.test(html)) tags.push('标题')
    if (/<blockquote\b/i.test(html)) tags.push('引用块')
    if (tags.length === 0) return ''
    return tags.join('/')
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    try {
      // 入站归一化：把文本与媒体占位合并成一条 message.text。
      // 媒体会尝试下载到本地并附上路径（图片/文件/音视频），让 agent 能真正处理；
      // 图片额外持久化为多模态附件（imageRefs），使模型直接看见图片。
      // 下载失败则退化为占位文本，不静默丢弃，避免用户发图后 agent 无响应。
      const { text: mediaText, imageRefs } = await this.describeMedia(message.roomId, message.media)
      let text = (message.text + mediaText).trim()

      // 类人上下文：回复引用 / 编辑标记 / 富文本结构注记（受 preserveRichText 门控）。
      // 先把本条消息写入近期缓存，供后续回复引用解析。
      if (text !== '' && message.eventId !== '') {
        const roomRecent = this.recentByEvent.get(message.roomId) ?? new Map<string, { sender: string; text: string }>()
        roomRecent.set(message.eventId, { sender: message.sender, text })
        // 有界：超出上限丢弃最旧。
        if (roomRecent.size > this.recentEventCap) {
          const oldest = roomRecent.keys().next().value
          if (oldest !== undefined) roomRecent.delete(oldest)
        }
        this.recentByEvent.set(message.roomId, roomRecent)
      }
      // 类人上下文：回复引用 / 编辑标记 / 富文本结构注记（受 preserveRichText 门控）。
      // 默认开启（undefined 视同 true）；显式设为 false 时回退纯文本。
      if (this.config.preserveRichText !== false) {
        text = this.buildMessageContext(message, text)
      }
      if (text === '') return

      // 剥离「已知账号」的 @提及 前缀后再判定命令/审批词（如 '@ai-dev /auth list'）。
      // 仅去除本插件已知账号的提及，避免误删命令参数里的人名（如 /deny @alice:hs.example 机密）。
      let stripped = text
      for (const id of this.allAccountIds) {
        const lp = localpartOf(id)
        stripped = stripped
          .replace(id, '')
          .replace(`@${lp}`, '')
          .replace(new RegExp(`(^|\\s)${escapeRegExp(lp)}[:：]`), '')
      }
      stripped = stripped.replace(/\s+/g, ' ').trim()

      // 偏好切换：检测过程模式触发词（"给我过程信息/我需要看到详细过程"等）。
      // 命中即把本房间切到 process；默认 result；命令不触发（命令以 '/' 开头）。
      if (!stripped.startsWith('/') && wantsProcess(stripped)) {
        const prev = this.roomVerbosity.get(message.roomId) ?? 'result'
        if (prev !== 'process') {
          this.roomVerbosity.set(message.roomId, 'process')
          this.ctx.logger.info('[dsh-matrix-agent] room %s verbosity → process', message.roomId)
          void this.safeSend(message.roomId, '🔍 已切换到「过程模式」：后续将展示工具调用、工具结果与重试等中间细节。', undefined)
        }
      }

      // 审批应答最优先（不受 @提及/私聊 路由门控限制）：
      // 配置了 owner 时仅 Owner 可应答；未配置 owner 时任意白名单用户可应答（旧行为）。
      const queue = this.pendingApprovals.get(message.roomId)
      const first = queue?.[0]
      const isApprovalWord = APPROVE_RE.test(stripped) || DENY_RE.test(stripped)
      if (first !== undefined && isApprovalWord) {
        if (this.owner !== undefined && message.sender !== this.owner) {
          this.ctx.logger.warn('[dsh-matrix-agent] approval reply from %s ignored (only %s may answer)', message.sender, this.owner)
          return
        }
        if (APPROVE_RE.test(stripped)) {
          if (first.grantOnApprove) {
            this.authStore.grant(this.userId, this.owner ?? this.userId, message.roomId, first.request.toolName)
            void this.authStore.save().catch((error: unknown) => {
              this.ctx.logger.error('[dsh-matrix-agent] auth save failed: %s', messageOf(error))
            })
          }
          first.settle('allowed-once')
          return
        }
        first.settle('rejected')
        return
      }
      // 多账号协调：房间里有别的账号的 pending 审批时，纯审批词归那个账号，
      // 本账号不把它当普通消息注入会话。
      if (isApprovalWord && this.pendingRooms.has(message.roomId)) {
        return
      }

      // 老板私聊回复路由（秘书编排）：消息来自老板且房间是某任务的请示/确认房时，
      // 回复按任务状态处理（开工指示 / 交付确认 / 修改意见），不进普通任务队列。
      if (this.owner !== undefined && message.sender === this.owner) {
        const taskInDm = this.findTaskByOwnerDm(message.roomId)
        if (taskInDm !== undefined) {
          await this.handleOwnerDmReply(message.roomId, taskInDm, stripped)
          return
        }
      }

      // 工作目录选择回复：房间处于 cwdPending 时，编号即选定目录（Owner 操作）。
      const pending = this.cwdPending.get(message.roomId)
      if (pending !== undefined) {
        const idx = Number.parseInt(stripped, 10)
        if (Number.isInteger(idx) && idx >= 1 && idx <= pending.candidates.length) {
          const cwd = pending.candidates[idx - 1]
          if (cwd === undefined) return
          this.state.setRoomCwd(message.roomId, cwd)
          this.cwdPending.delete(message.roomId)
          this.ctx.logger.info('[dsh-matrix-agent] room %s cwd set to %s', message.roomId, cwd)
          // 选定后创建会话并执行暂存的任务。
          const task = this.findTask(message.roomId, pending.taskId)
          void this.safeSend(message.roomId, `✅ 已设定工作目录：\n${cwd}\n正在创建会话并执行任务…`, undefined)
          if (task !== undefined) {
            await this.executeTask(message.roomId, task)
          }
          return
        }
        // 非编号回复：提示重选。
        void this.safeSend(message.roomId, '请回复编号选择工作目录，或发送 /reject 取消该任务。', undefined)
        return
      }

      this.diag.log(`handleMessage room=${message.roomId} from=${message.sender} digitalTwinMode=${this.config.digitalTwinMode} text=${text.slice(0, 60).replace(/\n/g, ' ')}`)
      // 成员记忆：消息来自其他成员时 upsert + 累计互动（记住每个人）。
      if (this.config.memberMemory !== false && message.sender !== this.userId) {
        this.memberStore.upsert(message.roomId, { userId: message.sender })
        this.memberStore.bumpInteraction(message.roomId, message.sender)
        this.memberStore.scheduleSave()
      }
      // 记录近期聊天（与响应门控解耦：无论是否 @都存，供被人 @ 时回溯上下文）。
      // 编辑消息用新内容替换原 eventId 记录，避免任务面板与回溯上下文出现重复旧版。
      if (text.trim().length > 0) {
        if (message.isEdit && message.editTargetEventId !== undefined) {
          this.chatlog.replace(message.roomId, message.editTargetEventId, {
            ts: Date.now(), sender: message.sender, text, eventId: message.eventId, editTargetEventId: message.editTargetEventId,
          })
        } else {
          this.chatlog.append(message.roomId, { ts: Date.now(), sender: message.sender, text, eventId: message.eventId })
        }
      }
      if (!(await this.shouldRespond(message))) return

      if (stripped.startsWith('/')) {
        this.flushMerge(message.roomId)
        await this.handleCommand(message.roomId, message.sender, stripped)
        return
      }

      // 秘书编排（任务入队/请示/确认）：同事/主管发来的工作进 matrix 任务队列待审，不直接执行。
      // 机器人自己账号发出的消息（如有）不进队列；命令已在上方处理。
      // 入队用 stripped（已剥 @提及 前缀）：任务面板与注入 agent 的文本不带原始提及标记。
      // 群聊默认秘书：未 @ 提及本账号的群聊消息按工作任务入队（@ 提及自己的即时交流仍直接回复）。
      if (await this.isTwinMode(message.roomId, message) && message.sender !== this.userId) {
        await this.enqueueTask(message.roomId, message.sender, stripped)
        return
      }

      // 合并窗口：'..' 继续、'!!' 立即提交、裸文本等待 mergeTimeoutSecs。
      // 用 stripped（已剥 @提及 前缀）：注入 agent 的提示词不带原始提及标记。
      let rest = stripped
      let flush = false
      if (stripped.endsWith('!!')) {
        rest = stripped.slice(0, -2).trim()
        flush = true
      } else if (stripped.endsWith('..')) {
        rest = stripped.slice(0, -2).trim()
      }
      if (rest === '') return
      const buffer = this.mergeBuffers.get(message.roomId) ?? { parts: [], sender: message.sender, imageRefs: [] }
      if (buffer.timer !== undefined) clearTimeout(buffer.timer)
      buffer.parts.push(rest)
      // 合并窗口内的图片附件一并携带，避免多图/图文同批时丢图。
      if (imageRefs !== undefined && imageRefs.length > 0) buffer.imageRefs.push(...imageRefs)
      buffer.timer = setTimeout(() => {
        this.flushMerge(message.roomId)
      }, this.config.mergeTimeoutSecs * 1000)
      this.mergeBuffers.set(message.roomId, buffer)
      if (flush) this.flushMerge(message.roomId)
    } catch (error) {
      this.ctx.logger.error('[dsh-matrix-agent] message %s failed: %s', message.eventId, messageOf(error))
    }
  }

  private flushMerge(roomId: string): void {
    const buffer = this.mergeBuffers.get(roomId)
    if (buffer === undefined) return
    this.mergeBuffers.delete(roomId)
    if (buffer.timer !== undefined) clearTimeout(buffer.timer)
    const text = buffer.parts.join('\n').trim()
    if (text === '') return
    void this.deliver(roomId, text, buffer.sender, buffer.imageRefs)
  }

  /**
   * 把房间消息注入 agent 会话。
   * source.kind 用 'user'（而非 'plugin'）：Harness GUI 对 user/message 事件按
   * source.kind 分类——'plugin' 会被渲染成"上下文"而非用户输入气泡，导致
   * Matrix 里看到的输入在 GUI 历史中不可见。'user' 让输入在两边一致可见。
   * sender 一并带上，多人群聊时 GUI 历史可区分说话人。
   */
  /**
   * 构造一条极小的房间上下文标签（约 1 行，token 与群人数无关）。
   * 仅用于让 agent 知道自己身处的会话类型（群聊/私聊）与身份，消除"把群聊当 1v1"的误判。
   * 绝不注入成员名单——大群也不会放大 token。群名/人数均走带缓存的接口。
   */
  /** 该房间是否启用秘书编排（任务入队/请示/确认）：
   * - 全局 digitalTwinMode=true → 全部启用（含 @ 提及，除非消息被 @ 自己的即时交流？——digitalTwinMode 显式开启时不豁免）；
   * - 房间名匹配 twinModeRoomPrefix → 该房间启用（如测试房间）；
   * - 群聊默认秘书（secretaryGroupDefault，默认 true）→ 非私聊房间启用；私聊保持直接回复。
   * @param message 入站消息：群聊默认秘书时，@ 提及本账号的消息视为即时交流直接回复（不入队列）。 */
  private async isTwinMode(roomId: string, message?: InboundMessage): Promise<boolean> {
    if (this.config.digitalTwinMode) return true
    const prefix = this.config.twinModeRoomPrefix
    if (prefix !== '') {
      try {
        const name = this.channel.getRoomName ? await this.channel.getRoomName(roomId) : undefined
        if (name !== undefined && name.includes(prefix)) return true
      } catch {
        // 房间名获取失败：回落到默认判断，不阻断秘书功能。
      }
    }
    // 仅数字分身账号（非主账号）启用默认秘书；主账号个人助手（isMain=true）保持直接回复，
    // 除非显式配置 digitalTwinMode 或前缀匹配（已在上面处理）。
    if (this.isMain) return false
    const isDm = this.channel.isDirectRoom ? await this.channel.isDirectRoom(roomId) : false
    if (isDm) {
      // 私聊：默认不启用秘书（直接对话）；secretaryDmDefault=true 时启用（所有私聊消息进队列待审）。
      return this.config.secretaryDmDefault === true
    }
    // 群聊：secretaryGroupDefault 默认启用；@ 提及本账号的消息视为即时交流，直接回复（不进任务队列）。
    if (this.config.secretaryGroupDefault !== false) {
      if (message !== undefined && this.isMentioningSelf(message)) return false
      return true
    }
    return false
  }

  /** 消息是否 @ 提及了本账号（用于群聊默认秘书时区分即时交流与工作任务）。 */
  private isMentioningSelf(message: InboundMessage): boolean {
    const lower = message.text.toLowerCase()
    const ids = [this.userId, `@${localpartOf(this.userId)}`]
    for (const id of ids) {
      if (id !== '' && lower.includes(id.toLowerCase())) return true
    }
    // 兼容 '名字: / 名字：' 渲染（无 @ 无域名）。
    const lp = localpartOf(this.userId).toLowerCase()
    if (lp !== '' && new RegExp(`(^|\\s)${escapeRegExp(lp)}[:：]`).test(lower)) return true
    return false
  }

  private async roomContextLabel(roomId: string): Promise<string> {
    const isDm = this.channel.isDirectRoom ? await this.channel.isDirectRoom(roomId) : false
    const me = `@${localpartOf(this.userId)}`
    if (isDm) {
      const name = this.channel.getRoomName ? await this.channel.getRoomName(roomId) : undefined
      const peer = name !== undefined ? `（${name}）` : ''
      return `[私聊${peer}，你是${me}]`
    }
    const roomName = this.channel.getRoomName ? await this.channel.getRoomName(roomId) : undefined
    const count = this.channel.getRoomMemberCount ? await this.channel.getRoomMemberCount(roomId) : undefined
    const head = roomName !== undefined ? `群聊「${roomName}」` : '群聊'
    const size = count !== undefined ? `，约${count}人` : ''
    // 测试环境声明：房间名匹配 testRoomPrefix 时提示数字人（避免真实执行任务/改文件/发真实消息）。
    let testNote = ''
    const prefix = this.config.testRoomPrefix
    if (prefix !== '' && roomName !== undefined && roomName.includes(prefix)) {
      testNote = ' ⚠️测试环境：请勿真实执行任务、修改文件、或向真实用户发送重要消息，仅配合测试对话。'
    }
    const label = `[${head}${size}，你是${me}]${testNote}`
    this.diag.log(`roomContextLabel room=${roomId} isDm=${isDm} name=${roomName ?? '(none)'} count=${count ?? '(unknown)'} testRoom=${testNote !== ''} label=${label}`)
    return label
  }

  private async deliver(roomId: string, text: string, sender?: string, imageRefs?: ImageAttachmentRef[]): Promise<void> {
    // LLM provider 健壮性降级：若该房间已标记「配置的 provider 不可用」且配置未变，
    // 直接回复友好提示，不再触发 agent 循环（避免每次消息都崩溃/烧 token）。
    // 用户修改 provider/model 配置或发送 /new 后自动恢复。
    const broken = this.providerBroken.get(roomId)
    if (broken !== undefined) {
      const sameProvider = this.agentOptions.provider === (broken.provider || undefined)
      const sameModel = this.agentOptions.model === (broken.model || undefined)
      if (sameProvider && sameModel) {
        this.ctx.logger.info('[dsh-matrix-agent] provider broken, skip agent room=%s (provider=%s model=%s)', roomId, broken.provider, broken.model)
        void this.safeSend(roomId, formatProviderFailure(broken.provider, broken.model), undefined)
        return
      }
      // 配置已变化（用户改了 provider/model）：清除降级标记，恢复正常流程。
      this.providerBroken.delete(roomId)
    }
    const agent = await this.getRoomAgent(roomId)
    // 群聊上下文：群名+人数+身份一行前缀，避免 agent 误把群消息当私聊对话。
    // 仅注入房间标签（约 1 行）；完整群聊历史已改由 matrix_get_recent_messages 工具按需获取。
    const label = await this.roomContextLabel(roomId)
    const body = `${label}\n${text}`
    const content: ContentBlock[] = [{ type: 'text', text: body }]
    // 入站图片作为多模态内容块附加，让模型直接“看见”图片，
    // 无需再调用文件读取工具（避免 read_image 这类未注册工具导致失败）。
    if (imageRefs !== undefined && imageRefs.length > 0) {
      for (const ref of imageRefs) content.push({ type: 'image', attachment: ref })
    }
    agent.followup(createUserMessage({
      content,
      source: {
        kind: 'user',
        ...(sender !== undefined ? { sender } : {}),
      },
    }))
  }

  /** ---------- Matrix 任务队列 ---------- */

  private tasksOf(roomId: string): MatrixTask[] {
    let tasks = this.matrixTasks.get(roomId)
    if (tasks === undefined) {
      tasks = this.state.loadTasks(roomId)
      this.matrixTasks.set(roomId, tasks)
    }
    return tasks
  }

  private persistTasks(roomId: string): void {
    this.state.saveTasks(roomId, this.tasksOf(roomId))
    this.publishTasks()
  }

  /**
   * 发布任务快照（运行时镜像）：把本账号各房间任务 + session↔room 映射
   * 写入 settings，供 DSH Web 的「任务」tab 与「所有任务」面板读取。
   */
  private publishTasks(): void {
    if (this.publishTasksSnapshot === undefined) return
    const rooms: Record<string, MatrixTask[]> = {}
    for (const [roomId, tasks] of this.matrixTasks) {
      rooms[roomId] = tasks
    }
    const sessionRooms: Record<string, string> = {}
    for (const [sessionId, roomId] of Object.entries(this.state.sessionRoomsSnapshot())) {
      sessionRooms[sessionId] = roomId
    }
    this.publishTasksSnapshot({ rooms, sessionRooms, updatedAt: Date.now() })
  }

  private findTask(roomId: string, taskId: string): MatrixTask | undefined {
    return this.tasksOf(roomId).find((t) => t.id === taskId)
  }

  /** 工作目录状态（供任务面板渲染）。 */
  private workspaceStateOf(roomId: string): { state: WorkspaceState; cwd?: string } {
    const cwd = this.state.roomCwd(roomId)
    if (cwd === undefined) return { state: 'none' }
    // 选了目录但路径不存在，提示（仅做轻量判定，不强制）。
    if (!existsSync(cwd)) return { state: 'missing', cwd }
    return { state: 'bound', cwd }
  }

  /** 把一条待审任务推给房间（精简面板）。 */
  private async pushTasks(roomId: string): Promise<void> {
    const text = formatTasks(this.tasksOf(roomId), this.workspaceStateOf(roomId))
    await this.safeSend(roomId, text, markdownToHtml(text))
  }

  /**
   * 入站消息进 matrix 任务队列：先查人+事黑白名单。
   * - 命中黑名单 → 自动拒绝（记原因）；命中白名单 → 自动批准（记"记忆授权"）；
   * - 否则 pending 等 Owner 用 /approve 审核。
   * 队列超 taskQueueMax 时最早 pending 任务被自动拒绝（防堆积）。
   */
  private async enqueueTask(roomId: string, sender: string, text: string): Promise<void> {
    const matter = this.classifyMatter(text)
    const rule = this.state.matchRule(sender, matter) ?? this.state.matchRule(sender, '*')
    const task: MatrixTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      roomId,
      sender,
      text,
      status: 'pending',
      createdAt: Date.now(),
    }
    if (rule !== undefined && rule.kind === 'deny') {
      task.status = 'rejected'
      task.note = `命中黑名单（人=${rule.person} 事=${rule.matter}）自动拒绝`
    } else if (rule !== undefined && rule.kind === 'allow') {
      task.status = 'approved'
      task.note = `命中白名单（人=${rule.person} 事=${rule.matter}）记忆授权`
    }
    const tasks = this.tasksOf(roomId)
    tasks.push(task)
    // 超限保护：拒绝最早的 pending。
    const max = this.config.taskQueueMax
    const pending = tasks.filter((t) => t.status === 'pending')
    if (pending.length > max) {
      const drop = pending[0]
      if (drop !== undefined) {
        drop.status = 'rejected'
        drop.note = `队列超限（>${max}）自动拒绝`
      }
    }
    this.persistTasks(roomId)

    if (task.status === 'rejected') {
      await this.safeSend(roomId, `🚫 任务已被拒绝：${task.note}\n${task.text}`, undefined)
      return
    }
    if (task.status === 'approved') {
      // 白名单命中：直接执行（仍受串行约束）。
      await this.executeTask(roomId, task)
      return
    }
    await this.safeSend(
      roomId,
      `📥 新任务已入队（待审）：\n来自 ${sender}：${text}\n发送 /tasks 查看，/approve N 执行。`,
      undefined,
    )
  }

  /** 粗粒度"事"分类：取消息首个有意义关键词（后续可接 LLM 分类）。 */
  private classifyMatter(text: string): string {
    const trimmed = text.trim()
    if (trimmed === '') return '*'
    // 取前 16 字作为事类别占位（人+事维度下"事"用关键词指代）。
    return trimmed.slice(0, 16)
  }

  /**
   * 执行一条已批准任务：先确保工作目录已设定（新房间引导），
   * 再走「开工前请示」（taskClarifyBeforeStart），最后创建会话注入执行。
   * 同一房间串行：runningTask 占用时排队等待 turn/end 释放。
   */
  private async executeTask(roomId: string, task: MatrixTask): Promise<void> {
    // 新房间（未绑定 cwd）先引导选目录。
    if (this.state.roomCwd(roomId) === undefined) {
      const candidates = await this.cwdCandidatesFor(roomId)
      this.cwdPending.set(roomId, { candidates, taskId: task.id })
      task.status = 'pending'
      task.note = '等待设定工作目录'
      this.persistTasks(roomId)
      await this.safeSend(roomId, formatCwdGuide(candidates), markdownToHtml(formatCwdGuide(candidates)))
      return
    }
    // 串行：若已有 running 任务，标记 approved 等 turn/end 消费。
    if (this.runningTask.get(roomId) !== undefined) {
      task.status = 'approved'
      task.note = '已批准，等待前序任务完成'
      this.persistTasks(roomId)
      await this.pushTasks(roomId)
      return
    }
    // 开工前请示：秘书私下问老板要求/优先级/范围；老板回复后注入执行，超时按原任务开始。
    if (this.config.taskClarifyBeforeStart && this.owner !== undefined && task.status !== 'clarifying') {
      const role = this.roleForTask(roomId, task)
      const dm = await this.channel.sendDm?.(
        this.owner,
        `【任务请示】收到任务：\n${task.text}\n角色：${role}\n\n如果你有要求/优先级/范围补充，请回复；否则我将按任务原样开工。`,
      )
      if (dm !== undefined) {
        // 秘书动作：记录时间线（仅元数据，actor=secretary）。
        this.recordTimeline(dm.roomId, 'approval', { target: this.owner }, 0, 'secretary')
        task.status = 'clarifying'
        task.ownerDmRoomId = dm.roomId
        task.role = role
        this.persistTasks(roomId)
        await this.pushTasks(roomId)
        // 超时兜底：老板没回复 → 按原任务开始。
        const timeout = this.config.taskClarifyTimeoutSecs ?? 120
        setTimeout(() => {
          const t = this.findTask(roomId, task.id)
          if (t !== undefined && t.status === 'clarifying') {
            t.status = 'approved'
            t.note = '老板未在时限内回复，按原任务开工'
            this.persistTasks(roomId)
            void this.consumeNextTask(roomId)
          }
        }, timeout * 1000)
        return
      }
    }
    await this.startTaskExecution(roomId, task)
  }

  /** 实际开工：标记 approved/running 并把任务（含角色/老板指示）注入干活会话。 */
  private async startTaskExecution(roomId: string, task: MatrixTask): Promise<void> {
    task.status = 'approved'
    this.runningTask.set(roomId, task.id)
    this.persistTasks(roomId)
    const ctxPrompt = this.buildTaskPrompt(roomId, task)
    await this.deliver(roomId, ctxPrompt, task.sender)
    await this.pushTasks(roomId)
  }

  /** 构造任务注入文本：秘书模式（owner 已配置）加角色 + 工作方式 + 老板指示；否则原样注入。 */
  private buildTaskPrompt(roomId: string, task: MatrixTask): string {
    const body = task.contextPrompt !== undefined ? `${task.contextPrompt}\n\n${task.text}` : task.text
    // 无 owner：非秘书模式，保持旧行为（直接任务内容）。
    if (this.owner === undefined) return body
    const role = this.roleForTask(roomId, task)
    const rolePersona = rolePersonaFor(role)
    const workStyle = [
      '【工作方式】你是数字员工。',
      `老板是 ${this.owner}（真实人）。`,
      '- 开工前：若任务有歧义、需要优先级或资源，先私聊老板确认（matrix_send_dm 发给老板），再开工。',
      '- 完成后：先私聊老板汇报结果并请求确认，老板确认后再在群里向同事交付。',
      '- 未经老板确认，不要直接在群里对外交付重要结果。',
    ].join('\n')
    const clarify = task.clarifyReply !== undefined && task.clarifyReply !== ''
      ? `\n【老板开工指示】${task.clarifyReply}`
      : ''
    const roleLine = `\n【本次任务角色】${role}：${rolePersona}`
    return `${roleLine}\n${workStyle}\n\n【任务内容】\n${body}${clarify}`
  }

  /** 任务的执行角色：任务级 role > 房间固定角色 > 百变员工。 */
  private roleForTask(roomId: string, task: MatrixTask): string {
    if (task.role !== undefined && task.role !== '') return task.role
    const roomRole = this.config.roomRoles?.[roomId]
    if (roomRole !== undefined && roomRole !== '') return roomRole
    return 'dynamic'
  }

  /** 候选工作目录：内核 workspaceRegistry 已登记的工作区 + 配置候选。 */
  private async cwdCandidatesFor(roomId: string): Promise<string[]> {
    const fromConfig = this.config.cwdCandidates.filter((c) => c !== undefined && c !== '')
    const fromRegistry: string[] = []
    try {
      const registry = this.ctx.get('workspaceRegistry') as
        | { list?: () => { path: string }[] }
        | undefined
      if (registry?.list !== undefined) {
        for (const ws of registry.list()) fromRegistry.push(ws.path)
      }
    } catch {
      /* 内核未提供 workspaceRegistry 时仅用配置候选 */
    }
    const set = new Set<string>([...fromRegistry, ...fromConfig, process.cwd()])
    return [...set]
  }

  /** turn/end 后处理当前 running 任务：默认标记 done；若开启交付前确认则进入 confirming 私下请示老板。 */
  private async consumeNextTask(roomId: string): Promise<void> {
    const runningId = this.runningTask.get(roomId)
    if (runningId !== undefined) {
      const t = this.findTask(roomId, runningId)
      if (t !== undefined) {
        const needsConfirm = this.shouldConfirmTask(t)
        if (needsConfirm) {
          await this.confirmBeforeDeliver(roomId, t)
          this.runningTask.delete(roomId)
          return
        }
        t.status = 'done'
        this.persistTasks(roomId)
      }
    }
    this.runningTask.delete(roomId)
    const next = this.tasksOf(roomId).find((t) => t.status === 'approved')
    if (next !== undefined) await this.executeTask(roomId, next)
  }

  /** 是否需要对任务做交付前确认：开关开 + 有 owner + 不在豁免清单。 */
  private shouldConfirmTask(task: MatrixTask): boolean {
    if (this.config.taskConfirmBeforeDeliver === false) return false
    if (this.owner === undefined) return false
    const exempt = this.config.taskConfirmExemptMatters ?? []
    if (exempt.some((m) => m !== '' && task.text.includes(m))) return false
    return true
  }

  /** 交付前确认：秘书私下 DM 老板结果摘要，老板确认后交付回原房间，给意见则修订。 */
  private async confirmBeforeDeliver(roomId: string, task: MatrixTask): Promise<void> {
    const deliverTo = task.deliverTo ?? roomId
    const dm = await this.channel.sendDm?.(
      this.owner!,
      `【交付确认】任务完成：\n${task.text}\n\n完成情况：${task.result ?? '（已完成，结果见原房间）'}\n\n回复「交付」确认对外交付，或直接回复修改意见。`,
    )
    if (dm === undefined) {
      // 私聊失败：直接交付（降级）。
      task.status = 'done'
      task.note = '交付确认 DM 失败，直接交付'
      this.persistTasks(roomId)
      await this.safeSend(deliverTo, `✅ 任务完成：\n${task.text}`, undefined, 'reply', undefined, 'secretary')
      return
    }
    // 秘书动作：记录交付确认 DM（仅元数据，actor=secretary）。
    this.recordTimeline(dm.roomId, 'approval', { target: this.owner! }, 0, 'secretary')
    task.status = 'confirming'
    task.ownerDmRoomId = dm.roomId
    task.deliverTo = deliverTo
    this.persistTasks(roomId)
    await this.safeSend(roomId, '🔐 任务已完成，正在等老板确认后交付。', undefined, 'approval', undefined, 'secretary')
    await this.pushTasks(roomId)
    // 超时处理。
    const timeout = this.config.taskConfirmTimeoutSecs ?? 600
    const action = this.config.taskConfirmTimeoutAction ?? 'hold'
    setTimeout(() => {
      const t = this.findTask(roomId, task.id)
      if (t === undefined || t.status !== 'confirming') return
      if (action === 'deliver') {
        t.status = 'done'
        t.note = '老板超时未确认，自动交付'
        this.persistTasks(roomId)
        void this.safeSend(deliverTo, `✅ 任务完成：\n${t.text}`, undefined, 'reply', undefined, 'secretary')
        void this.pushTasks(roomId)
      } else if (action === 'cancel') {
        t.status = 'rejected'
        t.note = '老板超时未确认，任务取消'
        this.persistTasks(roomId)
        void this.safeSend(roomId, '🕐 老板超时未确认，任务已取消。', undefined)
        void this.pushTasks(roomId)
      }
      // 'hold'：保持 confirming，群里已提示待确认。
    }, timeout * 1000)
  }

  /** 老板确认交付：标记 done 并把结果交付回原房间。 */
  private async deliverConfirmedTask(roomId: string, task: MatrixTask): Promise<void> {
    task.status = 'done'
    task.note = '老板已确认交付'
    this.persistTasks(roomId)
    const deliverTo = task.deliverTo ?? roomId
    await this.safeSend(deliverTo, `✅ 任务完成（老板已确认）：\n${task.text}\n${task.result ?? ''}`, undefined, 'reply', undefined, 'secretary')
    await this.pushTasks(roomId)
    await this.consumeNextTask(roomId)
  }

  /** 查找老板私聊房对应的任务（clarifying/confirming 状态）。 */
  private findTaskByOwnerDm(dmRoomId: string): MatrixTask | undefined {
    for (const [roomId, tasks] of this.matrixTasks) {
      const found = tasks.find((t) =>
        (t.status === 'clarifying' || t.status === 'confirming') &&
        t.ownerDmRoomId === dmRoomId,
      )
      if (found !== undefined) return found
    }
    return undefined
  }

  /** 处理老板在私聊房的回复：澄清回复 → 开工指示/批准；确认回复 → 交付；其它 → 修改意见。多轮确认。 */
  private async handleOwnerDmReply(dmRoomId: string, task: MatrixTask, reply: string): Promise<void> {
    const workRoomId = task.roomId
    if (task.status === 'clarifying') {
      // 多轮确认：老板回「批准/开工/ok」→ 开工；否则记录指示，继续留在 clarifying（可继续补充）。
      const startWords = /^(批准|开工|开始|ok|可以|yes|go)$/i
      if (startWords.test(reply.trim())) {
        await this.safeSend(dmRoomId, `✅ 已批准，开始执行任务。`, undefined)
        await this.startTaskExecution(workRoomId, task)
        return
      }
      // 记录指示，留在 clarifying（多轮：老板可继续给要求，直到批准开工）。
      task.clarifyReply = reply.trim() !== '' ? reply.trim() : task.clarifyReply
      task.status = 'clarifying'
      task.note = `老板指示（私聊）：${reply.slice(0, 40)}（可继续补充，或回复「批准」开工）`
      this.persistTasks(workRoomId)
      await this.safeSend(dmRoomId, `📝 已记录指示。你可以继续补充要求，或回复「批准」开工。`, undefined)
      return
    }
    if (task.status === 'confirming') {
      const confirmWords = /^(交付|可以|ok|确认|通过|yes|approve)$/i
      if (confirmWords.test(reply.trim())) {
        await this.safeSend(dmRoomId, '✅ 已确认，正在交付。', undefined)
        await this.deliverConfirmedTask(workRoomId, task)
        return
      }
      // 修改意见：注入干活会话让 agent 修订，再回到 confirming 等多轮确认。
      task.confirmReply = reply
      task.status = 'approved'
      task.note = `老板修改意见：${reply.slice(0, 40)}，重新执行后再确认`
      this.persistTasks(workRoomId)
      await this.safeSend(dmRoomId, `🛠 已收到修改意见，重新执行后再确认。`, undefined)
      await this.startTaskExecution(workRoomId, task)
      return
    }
    // 其它状态：忽略（不进队列）。
  }

  /** ---------- 命令 ---------- */

  private async handleCommand(roomId: string, sender: string, raw: string): Promise<void> {
    const [command, ...rest] = raw.split(/\s+/)
    const arg = rest.join(' ').trim()
    const reply = (text: string) => this.safeSend(roomId, text, markdownToHtml(text))

    switch (command) {
      case '/start':
      case '/help':
        await reply(HELP_TEXT)
        break
      case '/new':
      case '/clear':
        // 用户主动重置会话：清除 provider 降级标记（配置若已修正则恢复；未修正则下次错误时重新标记）。
        this.providerBroken.delete(roomId)
        await this.releaseRoom(roomId)
        await reply('已开始全新会话。')
        break
      case '/status': {
        const handle = this.roomAgents.get(roomId)
        const identity = this.isMain ? '主账号' : `数字分身（Owner: ${this.owner ?? '未配置'}）`
        if (handle === undefined) await reply(`本房间还没有绑定会话。\n身份：${identity}\n账号：${this.userId}`)
        else await reply(`当前会话：\`${handle.agent.id}\`（状态 ${handle.agent.status}）\n身份：${identity}\n账号：${this.userId}`)
        break
      }
      case '/bind': {
        if (arg === '') {
          await reply('用法：`/bind <session-id>`')
          break
        }
        await this.releaseRoom(roomId)
        try {
          const handle = await this.ctx.agents.resume({
            resumeSessionId: SessionId(arg),
            agentOptions: this.agentOptions,
          })
          this.roomAgents.set(roomId, handle)
          this.state.setRoomSession(roomId, handle.agent.id)
          await reply(`已绑定会话 \`${handle.agent.id}\`。`)
        } catch (error) {
          await reply(`绑定失败：${messageOf(error)}（需要在组合中配置 session persistence）`)
        }
        break
      }
      case '/auth': {
        const [subCmd, ...toolParts] = arg.split(/\s+/)
        const toolName = toolParts.join(' ').trim()
        switch (subCmd) {
          case 'list': {
            const record = this.authStore.getRecord(this.userId, roomId)
            if (record === undefined) {
              await reply(`📋 ${this.userId} 在本房间暂无记忆授权。`)
              break
            }
            await reply(
              `📋 ${this.userId} 在本房间的记忆授权\n` +
              `Owner：${record.ownerId}\n` +
              `工具：${record.allowedTools.length > 0 ? record.allowedTools.map((t) => `\`${t}\``).join('、') : '无'}\n` +
              `最后确认：${new Date(record.lastConfirmedAt).toLocaleString('zh-CN')}`,
            )
            break
          }
          case 'revoke': {
            if (this.owner !== undefined && sender !== this.owner) {
              await reply('❌ 只有 Owner 可以吊销授权。')
              break
            }
            if (toolName === '') {
              await reply('用法：`/auth revoke <tool>`')
              break
            }
            const ok = this.authStore.revoke(this.userId, roomId, toolName)
            await this.authStore.save().catch(() => {})
            await reply(ok ? `✅ 已吊销 \`${toolName}\` 的记忆授权。` : `⚠️ \`${toolName}\` 本来就没有授权。`)
            break
          }
          case 'revoke-all': {
            if (this.owner !== undefined && sender !== this.owner) {
              await reply('❌ 只有 Owner 可以吊销授权。')
              break
            }
            const ok = this.authStore.revoke(this.userId, roomId)
            await this.authStore.save().catch(() => {})
            await reply(ok ? '✅ 已吊销本房间全部记忆授权。' : '⚠️ 本房间本来就没有授权。')
            break
          }
          default:
            await reply('用法：`/auth list` | `/auth revoke <tool>` | `/auth revoke-all`')
        }
        break
      }
      case '/tasks':
      case '/queue':
        await this.pushTasks(roomId)
        break
      case '/approve': {
        if (arg === '') {
          await reply('用法：`/approve <N>`（N 为 /tasks 列表中的序号）')
          break
        }
        const n = Number.parseInt(arg, 10)
        const tasks = this.tasksOf(roomId)
        const pending = tasks.filter((t) => t.status === 'pending')
        if (!Number.isInteger(n) || n < 1 || n > pending.length) {
          await reply(`❌ 序号无效，当前待审 ${pending.length} 条（/tasks 查看）。`)
          break
        }
        const task = pending[n - 1]
        if (task === undefined) break
        await this.executeTask(roomId, task)
        break
      }
      case '/reject': {
        if (arg === '') {
          await reply('用法：`/reject <N>`')
          break
        }
        const n = Number.parseInt(arg, 10)
        const pending = this.tasksOf(roomId).filter((t) => t.status === 'pending')
        if (!Number.isInteger(n) || n < 1 || n > pending.length) {
          await reply(`❌ 序号无效，当前待审 ${pending.length} 条。`)
          break
        }
        const task = pending[n - 1]
        if (task === undefined) break
        task.status = 'rejected'
        task.note = `Owner 拒绝（${sender}）`
        this.persistTasks(roomId)
        await reply(`🚫 已拒绝第 ${n} 条任务。`)
        await this.pushTasks(roomId)
        break
      }
      case '/allow':
      case '/deny': {
        const [person, ...matterParts] = arg.split(/\s+/)
        const matter = matterParts.join(' ').trim() || '*'
        if (person === undefined || person === '') {
          await reply('用法：`/allow <人> <事>` 或 `/deny <人> <事>`（人/事可填 * 通配）')
          break
        }
        this.state.addRule({
          person,
          matter,
          kind: command === '/allow' ? 'allow' : 'deny',
          addedAt: Date.now(),
        })
        await reply(`✅ 已添加${command === '/allow' ? '白' : '黑'}名单：人=${person} 事=${matter}`)
        break
      }
      case '/rules':
        await reply(formatRules(this.state.listRules()))
        break
      case '/memory': {
        const records = this.memberStore.list(roomId)
        if (records.length === 0) {
          await reply('🧠 本房间暂无成员记忆（memberMemory 开启后会自动记住每个见过的成员）。')
          break
        }
        const lines = records.map((r, i) => {
          const name = r.displayName !== undefined && r.displayName !== '' ? r.displayName : r.userId
          const note = r.note !== undefined && r.note !== '' ? ` · ${r.note}` : ''
          const first = new Date(r.firstSeenAt).toLocaleDateString('zh-CN')
          return `${i + 1}. ${name}（${r.userId}）· 首次 ${first} · 互动 ${r.interactionCount} 次${note}`
        })
        await reply(`🧠 本房间已记住 ${records.length} 位成员：\n${lines.join('\n')}\n\n命令：/forget <userId> 忘记某人`)
        break
      }
      case '/forget': {
        if (arg === '') {
          await reply('用法：`/forget <userId>`（仅 Owner）')
          break
        }
        if (this.owner !== undefined && sender !== this.owner) {
          await reply('❌ 只有 Owner 可以忘记成员。')
          break
        }
        const ok = this.memberStore.forget(roomId, arg)
        if (ok) {
          await this.memberStore.save().catch(() => {})
          await reply(`✅ 已忘记 \`${arg}\`。`)
        } else {
          await reply(`⚠️ \`${arg}\` 不在本房间的成员记忆中。`)
        }
        break
      }
      default:
        await reply(`未知命令 \`${command ?? ''}\`，发送 /help 查看帮助。`)
    }
  }

  /** ---------- 出站投递 ---------- */

  handleSessionEvent(session: Session, event: SessionEvent): void {
     const roomId = this.roomForSession(session.id)
     if (roomId === undefined) return
     const verbosity = this.roomVerbosity.get(roomId) ?? 'result'
     const data = event.data as any
     // 用 string 比较放宽收窄，兼容宿主未导出的 'llm/retry' 等事件类型。
     switch (event.type as string) {
       case 'turn/start':
         void this.channel.sendTyping(roomId, true).catch((error: unknown) => {
           this.ctx.logger.warn('[dsh-matrix-agent] typing failed: %s', messageOf(error))
         })
         break
       case 'turn/end': {
         void this.channel.sendTyping(roomId, false).catch(() => {})
         const reason = data.reason ?? {}
         const msg = formatTurnEnd(reason)
         if (msg !== undefined) {
           this.ctx.logger.warn('[dsh-matrix-agent] turn/end not completed: %s', reason.kind)
           // LLM provider 健壮性降级：识别「配置的 provider 不可用」类错误，
           // 标记该房间并回复友好中文提示（替代原始英文堆栈），避免用户反复触发崩溃。
           const errMessage = (reason.error?.message ?? '') as string
           const provider = this.agentOptions.provider
           const model = this.agentOptions.model
           if (isProviderFailure(errMessage, provider, model)) {
             this.providerBroken.set(roomId, { provider: provider ?? '', model: model ?? '', at: Date.now() })
             this.ctx.logger.warn('[dsh-matrix-agent] provider failure detected room=%s provider=%s model=%s msg=%s', roomId, provider ?? '(none)', model ?? '(none)', errMessage)
             void this.safeSend(roomId, formatProviderFailure(provider, model), undefined)
           } else {
             void this.safeSend(roomId, msg, undefined)
           }
         }
         for (const key of this.toolNames.keys()) {
           if (key.startsWith(`${roomId}:`)) this.toolNames.delete(key)
         }
         this.retryCounts.delete(roomId)
         // 串行消费：前序任务结束后，执行下一条已批准任务（若有）。
         void this.consumeNextTask(roomId)
         break
       }
       case 'tool/call': {
         // tool/call 事件数据形状：{ turn, step, callId, name, arguments }
         // arguments 是原始 JSON 字符串，需 parse 后传给执行器
         const callId = (data.callId as string) ?? ''
         const name = (data.name as string) ?? ''
         const turn = (data.turn as number) ?? 0
         const step = (data.step as number) ?? 0
         if (callId !== '') this.toolNames.set(`${roomId}:${callId}`, name)

         // 自我时间线：记录工具调用（仅工具名，不含参数；不落盘聊天内容）。
         if (name !== '') this.recordTimeline(roomId, 'tool-call', { tool: name })

         // 工具执行由 harness 负责：harness 会调用 provider.execute(name, args) 取得结果，
         // 自行把 tool/result 追加回会话（dsh-llm 的 createToolResultMessage）。
         // 因此这里只做「观察」：记录工具调用 + 写 chatlog，绝不再自行 append，
         // 否则会与 harness 的 tool/result 重复追加，导致会话校验报错（即「执行工具报错」）。
         if (this.config.matrixTools !== false && name.startsWith('matrix_')) {
           let args: Record<string, unknown> = {}
           try {
             const rawArgs = (data.arguments as string) ?? '{}'
             args = rawArgs ? JSON.parse(rawArgs) : {}
           } catch {
             this.ctx.logger.warn('[dsh-matrix-agent] tool %s: invalid arguments JSON', name)
           }
           this.ctx.logger.info('[dsh-matrix-agent] tool/call %s (%s) args=%s', name, callId, JSON.stringify(args))
           this.chatlog.append(roomId, {
             ts: Date.now(),
             sender: `${this.userId} (tool)`,
             text: `🔧 调用工具 ${name} ${JSON.stringify(args)}`,
           })
         }
         break
       }
       case 'tool/result': {
         if (verbosity !== 'process') {
           // 结果党：仅错误时可见（否则折叠，避免噪声）。
           const isError = data.message?.content?.[0]?.isError === true
           if (!isError) break
         }
         const callId = (data.message?.source?.callId as string) ?? ''
         const name = callId !== '' ? (this.toolNames.get(`${roomId}:${callId}`) ?? '') : ''
         const result = formatToolResult(
           {
             callId,
             isError: data.message?.content?.[0]?.isError === true,
             content: data.message?.content?.[0]?.content ?? [],
           },
           name,
         )
         void this.safeSend(roomId, result, undefined)
         break
       }
       case 'llm/retry': {
         const retry = data.retry ?? 1
         const isUnbounded = data.maxRetries === undefined
         const failureMsg = data.failure?.message
         // 诊断：始终记录 retry 来源（mode/次数/原因），便于事后复盘 token 消耗。
         this.ctx.logger.info(
           '[dsh-matrix-agent] llm/retry room=%s retry=%d mode=%s%s',
           roomId,
           retry,
           isUnbounded ? 'always(无上限)' : `normal(上限${data.maxRetries})`,
           failureMsg ? ` reason=${failureMsg}` : '',
         )
         // 过程模式：展示完整重试提示（含 always 无上限警示）。
         if (verbosity === 'process') {
           void this.safeSend(
             roomId,
             formatRetry({ retry, maxRetries: data.maxRetries, delayMs: data.delayMs ?? 0, failure: data.failure }),
             undefined,
           )
         }
         // 熔断：累计重试次数达阈值即主动终止 turn 止损（harness always 模式会无限烧 token）。
         const threshold = this.config.maxRetriesBeforeAbort
         if (this.config.retryCircuitBreakerEnabled && threshold > 0 && retry >= threshold) {
           const handle = this.roomAgents.get(roomId)
           if (handle !== undefined && handle.agent.status === 'running') {
             this.ctx.logger.warn('[dsh-matrix-agent] retry circuit breaker tripped room=%s retry=%d>=%d', roomId, retry, threshold)
             handle.agent.cancel({ kind: 'hook', reason: `dsh-matrix: retry circuit breaker at ${retry}/${threshold}` })
             void this.safeSend(roomId, formatRetryCircuitTripped(retry, threshold), undefined)
           }
           // cancel 后 turn/end 会触发并清理 retryCounts；此处不再累加避免重复触发。
           break
         }
         this.retryCounts.set(roomId, retry)
         break
       }
       case 'assistant/message': {
         const text = assistantVisibleText(event as Extract<SessionEvent, { type: 'assistant/message' }>, verbosity)
         if (text !== undefined) void this.deliverText(roomId, text)
         break
       }
       default:
         // 按设计忽略（与 GUI 可视化语义对齐，不 1:1 复刻 token 级细节）：
         // - step/start / step/end：编排内部步骤标记，已由 assistant/message 吸收
         // - assistant/chunk：流式增量，由 assistant/message 聚合后统一投
         // - user/message：入站事件，由 handleMessage 处理，不在出站重投
         // - tool/call：配对记录已在上方处理，无需单独投文本
         // - request/header / compaction/* / attachment/* / run/* / agent/*：
         //   内部/低层协议事件，对终端用户无独立意义
         break
     }
   }

  private async deliverText(roomId: string, text: string): Promise<void> {
    const cleaned = sanitizeAssistantText(text)
    for (const chunk of chunkText(cleaned, this.config.chunkMaxChars)) {
      await this.safeSend(roomId, chunk.plain, chunk.html)
    }
  }

  private async safeSend(roomId: string, plain: string, html?: string, kind?: TimelineKind, meta?: { tool?: string; target?: string }, actor?: 'secretary' | 'worker'): Promise<void> {
    // 记录自我时间线（仅元数据，旁路；失败静默，绝不影响发送）。
    this.recordTimeline(roomId, kind ?? 'reply', meta, plain.length, actor)
    try {
      await this.channel.sendText(roomId, plain, html)
    } catch (error) {
      if (html !== undefined) {
        try {
          await this.channel.sendText(roomId, plain)
        } catch (fallbackError) {
          this.ctx.logger.error('[dsh-matrix-agent] delivery failed: %s', messageOf(fallbackError))
        }
      } else {
        this.ctx.logger.error('[dsh-matrix-agent] delivery failed: %s', messageOf(error))
      }
    }
  }

  /** 记录一条自我时间线（仅元数据；timelineEnabled 门控；旁路静默）。 */
  private recordTimeline(roomId: string, kind: TimelineKind, meta?: { tool?: string; target?: string }, charCount?: number, actor?: 'secretary' | 'worker'): void {
    if (this.config.timelineEnabled === false) return
    this.timeline.record({
      roomId,
      kind,
      ...(actor !== undefined ? { actor } : {}),
      ...(meta?.tool !== undefined ? { tool: meta.tool } : {}),
      ...(meta?.target !== undefined ? { target: meta.target } : {}),
      ...(charCount !== undefined ? { charCount } : {}),
    })
    this.publishTimeline()
  }

  /** 把时间线快照发布到 settings（供设置页「时间线」tab 与任务视图）。 */
  private publishTimeline(): void {
    if (this.publishTimelineSnapshot === undefined) return
    const snap = this.timeline.snapshot()
    this.publishTimelineSnapshot({ entries: snap.entries, updatedAt: snap.updatedAt })
  }

  /** 执行时间线管理命令（来自设置页 UI，经 settings timelineOps 传递）。 */
  handleTimelineOps(ops: TimelineOps): void {
    if (this.config.timelineEnabled === false) return
    if (ops.clearSeq !== 0) {
      const cleared = this.timeline.clear()
      if (cleared) {
        this.diag.log(`handleTimelineOps clear seq=${ops.clearSeq}`)
        this.publishTimeline()
      }
    }
    if (Array.isArray(ops.removeIds)) {
      let changed = false
      for (const id of ops.removeIds) {
        if (this.timeline.remove(id)) changed = true
      }
      if (changed) {
        this.diag.log(`handleTimelineOps remove ids=${ops.removeIds.length}`)
        this.publishTimeline()
      }
    }
  }

  /** 执行秘书工作台操作（来自 UI，经 settings secretaryOps 传递；幂等：非目标状态忽略）。 */
  handleSecretaryOps(ops: SecretaryOps): void {
    const { taskId, action, text, cwd } = ops
    // 全账号查找目标任务（共享任务快照按 roomId 分组，这里扫所有账号）。
    for (const [roomId, tasks] of this.matrixTasks) {
      const task = tasks.find((t) => t.id === taskId)
      if (task === undefined) continue
      this.diag.log(`handleSecretaryOps task=${taskId} action=${action} status=${task.status}`)
      switch (action) {
        case 'approve-start': {
          // clarifying → 直接开工（不注入指示）。
          if (task.status !== 'clarifying') return
          task.clarifyReply = undefined
          task.status = 'approved'
          task.note = '老板批准开工（工作台）'
          this.persistTasks(roomId)
          void this.startTaskExecution(roomId, task)
          return
        }
        case 'give-instruction': {
          // clarifying → 记录指示，**回到 clarifying**（多轮确认：老板可继续补充/调整，直到「批准开工」）。
          if (task.status !== 'clarifying' || text === undefined || text.trim() === '') return
          task.clarifyReply = text.trim()
          task.status = 'clarifying'
          task.note = `老板指示（工作台）：${text.slice(0, 40)}（可继续补充，或点「批准开工」启动）`
          this.persistTasks(roomId)
          void this.pushTasks(roomId)
          return
        }
        case 'confirm-deliver': {
          // confirming → 交付回原房间。
          if (task.status !== 'confirming') return
          task.confirmReply = '交付'
          void this.deliverConfirmedTask(roomId, task)
          return
        }
        case 'give-feedback': {
          // confirming → 记录意见，**回到 confirming 的修订流程**（多轮：重新执行后再确认）。
          if (task.status !== 'confirming' || text === undefined || text.trim() === '') return
          task.confirmReply = text.trim()
          task.status = 'approved'
          task.note = `老板修改意见（工作台）：${text.slice(0, 40)}，重新执行后再确认`
          this.persistTasks(roomId)
          void this.startTaskExecution(roomId, task)
          return
        }
        case 'set-cwd': {
          // 未设工作目录的任务 → 绑定工作目录（pending/clarifying 可设）。
          if (cwd === undefined || cwd.trim() === '') return
          if (task.status !== 'pending' && task.status !== 'clarifying') return
          this.state.setRoomCwd(roomId, cwd.trim())
          task.cwd = cwd.trim()
          task.note = `工作目录：${cwd.trim()}`
          this.persistTasks(roomId)
          void this.pushTasks(roomId)
          return
        }
        case 'approve': {
          // pending → 批准执行（复用 /approve 语义）。
          if (task.status !== 'pending') return
          void this.executeTask(roomId, task)
          return
        }
        case 'reject': {
          // pending → 拒绝。
          if (task.status !== 'pending') return
          task.status = 'rejected'
          task.note = '老板拒绝（工作台）'
          this.persistTasks(roomId)
          void this.pushTasks(roomId)
          return
        }
        default:
          return
      }
    }
  }

  /** ---------- 审批（三级授权） ---------- */

  /**
   * 主动消息工具执行前的授权检查（供工具 deps.approveProactiveSend 回调）。
   * - proactiveSendRequiresApproval=false：直接放行。
   * - 已有该工具的长期授权：放行。
   * - 否则发起一次 approval/request（推送到房间，Owner 回复批准/拒绝）；
   *   批准则记忆授权（grantOnApprove）并放行，拒绝则阻止发送。
   */
  private async approveProactiveSend(
    toolName: string,
    args: Record<string, unknown>,
    exec: ToolRunContext,
  ): Promise<boolean> {
    if (!this.config.proactiveSendRequiresApproval) {
      this.diag.log(`approveProactiveSend tool=${toolName} proactive approval disabled; allow`)
      return true
    }
    // 解析目标房间：显式 roomId 或 exec.agent.id 反查。
    const explicit = typeof args.roomId === 'string' && args.roomId.length > 0 ? args.roomId : undefined
    const sessionId = exec.agent?.id
    const roomId = explicit ?? (sessionId !== undefined ? this.roomForSession(sessionId) : undefined)
    if (roomId === undefined) {
      this.diag.log(`approveProactiveSend tool=${toolName} no room to push approval; deny`)
      return false
    }
    if (!this.isRedline(toolName) && this.authStore.isStandingAuthorized(this.userId, roomId, toolName, this.config.redlineTools ?? [])) {
      this.diag.log(`approveProactiveSend tool=${toolName} room=${roomId} standing auth; allow`)
      return true
    }
    if (exec.agent === undefined) {
      this.diag.log(`approveProactiveSend tool=${toolName} no agent context; deny`)
      return false
    }
    const request: ApprovalRequest = {
      agent: exec.agent,
      toolName,
      reason: `主动${toolName === 'matrix_send_dm' ? '私聊' : '发消息'}，需 Owner 批准`,
      ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
    }
    const outcome = await this.handleApproval(roomId, request)
    this.diag.log(`approveProactiveSend tool=${toolName} room=${roomId} outcome=${outcome}`)
    if (outcome === 'allowed-once') {
      // 记忆授权（grantOnApprove=true 的路径会写入；这里显式补一次以便后续自动放行）。
      this.authStore.grant(this.userId, this.owner ?? this.userId, roomId, toolName)
      void this.authStore.save().catch(() => {})
      return true
    }
    return false
  }

  handleApproval(roomId: string, request: ApprovalRequest): Promise<ApprovalOutcome> {
    const grantable = !this.isRedline(request.toolName)
    if (grantable && this.authStore.isStandingAuthorized(this.userId, roomId, request.toolName, this.config.redlineTools ?? [])) {
      this.ctx.logger.info('[dsh-matrix-agent] %s uses standing auth for `%s` in %s', this.userId, request.toolName, roomId)
      return Promise.resolve('allowed-once')
    }
    return this.askRoom(roomId, request, grantable)
  }

  private askRoom(
    roomId: string,
    request: ApprovalRequest,
    grantOnApprove: boolean,
  ): Promise<ApprovalOutcome> {
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => settle('unavailable'), this.config.approvalTimeoutSecs * 1000)
      let done = false
      const settle = (outcome: ApprovalOutcome): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        const queue = this.pendingApprovals.get(roomId)
        if (queue !== undefined) {
          const index = queue.findIndex((entry) => entry.settle === settle)
          if (index >= 0) queue.splice(index, 1)
          if (queue.length === 0) {
            this.pendingApprovals.delete(roomId)
            this.pendingRooms.delete(roomId)
          }
        }
        resolve(outcome)
      }
      const queue = this.pendingApprovals.get(roomId) ?? []
      queue.push({ request, grantOnApprove, settle })
      this.pendingApprovals.set(roomId, queue)
      this.pendingRooms.add(roomId)
      request.signal?.addEventListener('abort', () => settle('cancelled'), { once: true })

      const who = this.owner !== undefined ? `@${localpartOf(this.owner)}` : ''
      const redlineNote = this.isRedline(request.toolName) ? ' ⛔️红线工具，每次都需确认' : ''
      const scopeNote = this.owner !== undefined ? `\n👉 仅 Owner ${who} 可以应答。` : ''
      const text =
        `⚠️ [审批请求${redlineNote}] 账号 \`${this.userId}\` 的工具 \`${request.toolName}\` 需要批准` +
        `${request.reason ? `，原因：${request.reason}` : ''}。请在 ${this.config.approvalTimeoutSecs} 秒内回复「批准」或「拒绝」。${scopeNote}`
      void this.safeSend(roomId, text, markdownToHtml(text))
    })
  }

  private settleAll(roomId: string, outcome: ApprovalOutcome): void {
    const queue = this.pendingApprovals.get(roomId)
    if (queue === undefined) return
    this.pendingApprovals.delete(roomId)
    this.pendingRooms.delete(roomId)
    for (const entry of queue) entry.settle(outcome)
  }
}

export interface MatrixBridgeOptions extends Config {
  readonly accessToken: string
  /** 灵魂子系统句柄（可选；由 index.ts 注册后传入）。 */
  readonly soulHandle?: SoulHandle
  /** 任务快照写回调（可选）：任务变更时把各房间任务镜像写入 settings（供 Web 任务视图）。 */
  readonly updateTasksSnapshot?: (snapshot: TasksSnapshot) => void
  /** 时间线快照写回调（可选）：时间线变更时写入 settings（供 Web 时间线 tab）。 */
  readonly updateTimelineSnapshot?: (snapshot: { entries: unknown[]; updatedAt: number }) => void
  /** 时间线管理命令回调（可选）：设置页 UI 删除/清空后由 Host 清零命令字段。 */
  readonly onTimelineOpsHandled?: () => void
  /** 秘书操作命令回调（可选）：工作台 UI 操作后由 Host 清零命令字段。 */
  readonly onSecretaryOpsHandled?: () => void
  /** 测试接缝：替换通道层的 fetch 与 sleep。 */
  readonly fetchFn?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * 多账号桥接编排器：
 * - 主账号 + config.digitalTwins 里的每个分身各对应一个 AccountBridge 实例；
 * - 共享同一个记忆授权库（AuthStore）；
 * - session/event 与 approval/request 统一分发到所属账号的 bridge 处理。
 */
export class MatrixBridge {
  private readonly ctx: Context
  private readonly config: MatrixBridgeOptions
  private readonly authStore: AuthStore
  private readonly accounts: AccountBridge[] = []
  private disposeEvents: (() => void) | undefined
  private disposeApproval: (() => void) | undefined

  constructor(ctx: Context, config: MatrixBridgeOptions) {
    this.ctx = ctx
    this.config = config
    this.authStore = new AuthStore(config.stateDir, config.authStoreFile ?? 'auth-store.json')

    // 所有账号 id（主账号 + 分身），用于 @提及 路由裁决。
    const allAccountIds = [
      config.userId,
      ...(config.digitalTwins ?? []).map((t) => t.userId),
    ]
    // 共享「房间有 pending 审批」集合：多账号协调审批应答归属。
    const pendingRooms = new Set<string>()
    // 共享自我时间线（主 + 同进程分身共一份，都是本进程分身的活动）。
    const timeline = new TwinTimeline(config.stateDir, config.timelineCap ?? 500)

    // 1. 挂载主账号（保持 state.json 名字，向后兼容）。
    //    按用户架构：userId 即数字分身自己，owner 是真实人账号（仅在 Matrix 客户端登录）。
    const mainAccount: DigitalTwinAccount = {
      userId: config.userId,
      accessToken: config.accessToken,
      tokenEnv: '',
      owner: config.owner ?? '',
      role: 'main',
      respondToAll: config.respondToAll,
      provider: config.provider,
      model: config.model,
    }
    this.accounts.push(
      new AccountBridge(
        ctx,
        config,
        new BridgeState(join(config.stateDir, 'state.json')),
        this.authStore,
        mainAccount,
        allAccountIds,
        pendingRooms,
        config.soulHandle,
        timeline,
        config.updateTasksSnapshot,
        config.updateTimelineSnapshot,
        config.fetchFn,
        config.sleep,
      ),
    )

    // 2. 挂载额外的数字分身（每个拥有独立的 state 子文件，避免房间绑定键冲突）
    for (const twin of config.digitalTwins ?? []) {
      if (twin.userId === config.userId) continue
      const token = twin.accessToken !== '' ? twin.accessToken : (twin.tokenEnv !== '' ? process.env[twin.tokenEnv] : undefined)
      if (token === undefined || token === '') {
        ctx.logger.warn('[dsh-matrix-agent] twin %s skipped: no access token (set accessToken or tokenEnv)', twin.userId)
        continue
      }
      const twinState = new BridgeState(join(config.stateDir, 'twins', `${localpartOf(twin.userId)}.json`))
      this.accounts.push(
        new AccountBridge(
          ctx,
          config,
          twinState,
          this.authStore,
          { ...twin, accessToken: token },
          allAccountIds,
          pendingRooms,
          config.soulHandle,
          timeline,
          config.updateTasksSnapshot,
          config.updateTimelineSnapshot,
          config.fetchFn,
          config.sleep,
        ),
      )
    }
  }

  async start(): Promise<void> {
    if (this.disposeEvents !== undefined) return
    await this.authStore.load()

    this.disposeEvents = this.ctx.on('session/event', (session, event) => {
      for (const account of this.accounts) {
        account.handleSessionEvent(session, event)
      }
    })

    this.ctx.inject(['approval'], (approvalCtx) => {
      this.disposeApproval = approvalCtx.on('approval/request', async (req, next) => {
        for (const account of this.accounts) {
          const roomId = account.roomForSession(req.agent.id)
          if (roomId !== undefined) return account.handleApproval(roomId, req)
        }
        return next()
      })
    })

    await Promise.all(this.accounts.map((account) => account.start()))
  }

  /** 分发时间线管理命令到各账号（共享 timeline，任一执行即可），执行后清零命令字段。 */
  handleTimelineOps(ops: TimelineOps): void {
    for (const account of this.accounts) {
      account.handleTimelineOps(ops)
    }
    this.config.onTimelineOpsHandled?.()
  }

  /** 分发秘书操作到各账号（任务只在一个账号的队列里），执行后清零命令字段。 */
  handleSecretaryOps(ops: SecretaryOps): void {
    for (const account of this.accounts) {
      account.handleSecretaryOps(ops)
    }
    this.config.onSecretaryOpsHandled?.()
  }

  async stop(): Promise<void> {
    if (this.disposeEvents !== undefined) {
      this.disposeEvents()
      this.disposeEvents = undefined
    }
    this.disposeApproval?.()
    this.disposeApproval = undefined
    await Promise.allSettled(this.accounts.map((account) => account.stop()))
    this.accounts.length = 0
    await this.authStore.save().catch(() => {})
  }
}
