/**
 * Matrix→harness 桥接层：多账号支持（主账号 + N 个数字分身）、per-room & per-account
 * agent 会话、入站消息注入（@提及路由 / 合并窗口）、出站投递、审批推送与聊天应答、
 * Owner 授权记忆（L1 静默 / L2 房间确认 / L3 红线强制）。
 *
 * 每个矩阵账号一个 AccountBridge：独立 sync 循环、独立状态文件、独立会话绑定。
 *
 * @module dsh-matrix-agent/bridge
 */

import { join, isAbsolute } from 'node:path'
import { existsSync, appendFileSync } from 'node:fs'
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TextBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Config, DigitalTwinAccount, ReceptionKindDef, RoomMode, AutoTune, ParallelOpts } from './config.js'
import { isRoomMode, autoTuneOf, normalizeAutoTune, normalizeParallel, parallelOf, DEFAULT_AUTOTUNE, DEFAULT_PARALLEL } from './config.js'
import {
  keywordModeHint,
  shouldApplyModeDirective,
  roomModeLabel,
  normalizeRoomModes,
  normalizeRoomPresets,
  modeConfirmText,
  isProbablyPureDirective,
  leaningFromWindow,
  nextLeaning,
  leaningLabel,
} from './room-mode.js'
import type { ModeDirective, Leaning, ShapeSample } from './room-mode.js'
import {
  shouldBatch,
  buildBatchPrompt,
  isInternallySplittable,
  buildSplittableHint,
} from './parallel.js'
import type { ParallelTaskItem } from './parallel.js'
import { chunkText, markdownToHtml, formatToolCall, describeMedia, wantsProcess, formatToolResult, formatTurnEnd, formatRetry, formatRetryCircuitTripped, formatRules, isProviderFailure, formatProviderFailure, buildSessionSummary } from './format.js'
import type { Verbosity } from './format.js'
import { MatrixChannel } from '../channel/matrix.js'
import type { Channel, ChannelOptions, InboundMessage, MediaBlock, RoomEvent } from '../channel/index.js'
import type { OwnerDecisionResult } from '../tools-channel/index.js'
import { applyMatrixTools, setToolLogger } from '../tools-channel/index.js'
import { getDiag } from './diag.js'
import { ChatLog } from './chatlog.js'
import { BridgeState } from './store.js'
import type { AllowDenyRule } from './store.js'
import { AuthStore } from './auth-store.js'
import { MemberStore } from './member-store.js'
import { InviteStore } from './invite-store.js'
import type { PendingInvite } from './invite-store.js'
import type { TimelineOps, OwnerInboxSnapshot, OwnerInboxItem, OwnerDecisionOps, TaskBoardSnapshot, TaskBoardRow, JobBoardRow, JobBoardSnapshot, JobSwitchOps } from './settings.js'
import { emptyJobBoard } from './settings.js'
import { TwinTimeline } from './timeline.js'
import type { TimelineKind } from './timeline.js'

const APPROVE_RE = /^(批准|同意|approve|yes|ok)$/i
const DENY_RE = /^(拒绝|驳回|deny|no|reject)$/i

/** 秘书会话固定的岗位 preset id（persona + 工具白名单已下沉到该 preset）。 */
const SECRETARY_PRESET = 'secretary'
/** 前台接待会话的岗位 preset id（persona + 判定契约已下沉到该 preset）。 */
const RECEPTION_PRESET = 'reception'

/**
 * ⚠️ 注入消息的 source 只允许写 `{ kind: 'user' }`。
 *
 * DSH 会话格式 v0 的冻结校验（dsh-session-format-v0-to-v1 `messageSourceValue`）对 user 来源
 * **只接受** `kind`（+ `rpcId`/`clientTimeZone`），多余字段会让整个会话迁移失败：
 *   `SessionFormatError: ... has unexpected member "sender"`
 *   → 历史加载失败：`@deepseek-ai/dsh-session-format-v0-to-v1 refuses this format v0 Session`
 *
 * 历史教训：本文件曾在 4 处写成 `{ kind: 'user', sender: ... }`。旧版 DSH 读取宽松故未暴露，
 * 升到 0.1.5-rc.1（严格迁移）后，**76/158 个会话直接加载失败**（非破坏性——DSH 拒绝迁移并原样保留原始日志）。
 *
 * 两条纪律：
 *   1. 派活人身份**不要**放 source——正文里已有「（来自 @xxx）」注记（见 senderNoteFor），source 里是冗余的；
 *   2. 也没有任何 DSH 代码读回 `source.sender`，删除它无副作用。
 *
 * 若将来确实需要标注来源，用合法形态 `{ kind: 'plugin', plugin: '<名字>' }`（见 MessageSourceMap）。
 */

/** 禁绑会话 id 前缀模式：秘书/接待等「平台内部固定会话」不允许被 /bind 房间占用。 */
const FORBIDDEN_BIND_PATTERNS: ReadonlyArray<{ label: string; test: (sessionId: string) => boolean }> = [
  {
    label: '秘书会话',
    test: (sessionId) => /-secretary-v\d+$/i.test(sessionId),
  },
  {
    label: '前台接待会话',
    test: (sessionId) => /-reception-v\d+$/i.test(sessionId),
  },
]

/** 会话 id 是否命中禁绑模式（秘书/接待固定会话；供 /bind 门与单元自查共用）。 */
export function isForbiddenBindSession(sessionId: string): string | undefined {
  const hit = FORBIDDEN_BIND_PATTERNS.find((f) => f.test(sessionId))
  return hit?.label
}

/**
 * 生成 deliver 的 sender 注记（身份审计建议②）：`（来自 @xxx）`，空串表示不注。
 * 规则：无 sender / 自己发言（回流）/ 系统事件（@system: 前缀）/ 内部并行提示（自带分条）不注。
 */
export function senderNoteFor(sender: string | undefined, selfUserId: string, text: string): string {
  const isInternalParallelPrompt = text.startsWith('[并行模式]') || text.startsWith('[并行提示]') || text.startsWith('[并行任务批次]')
  if (isInternalParallelPrompt) return ''
  if (sender === undefined || sender === '' || sender === selfUserId || sender.startsWith('@system')) return ''
  return `（来自 @${localpartOf(sender)}）`
}

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
  '/bind <session-id> — 把本房间绑定到已有会话（仅 Owner；秘书/接待会话禁绑）',
  '/auth list — 列出本分身在本房间的记忆授权',
  '/auth revoke <tool> — 吊销某工具的记忆授权（仅 Owner）',
  '/auth revoke-all — 吊销本房间全部记忆授权（仅 Owner）',
  '',
  '— 人+事黑白名单 —',
  '/allow <人> <事> — 加白名单（人/事可填 * 通配）',
  '/deny <人> <事> — 加黑名单（人/事可填 * 通配）',
  '/rules — 查看黑白名单',
  '',
  '— 社交记忆 —',
  '/memory — 查看本房间已记住的成员',
  '/forget <userId> — 忘记某成员（仅 Owner）',
  '',
  '— 入群邀请审批（仅 Owner）—',
  '/invites — 查看待批入群邀请与已批准/已拒绝的邀请人',
  '/invite-allow <userId> — 直接批准某邀请人（以后 TA 邀请我直接进群）',
  '/invite-deny <userId> — 拒绝某邀请人（以后 TA 的邀请直接静默拒绝）',
  '/invite-forget <userId> — 清除某邀请人的批准/拒绝记忆（下次邀请重新请示）',
  '',
  '消息合并：以 `..` 结尾表示还有后续，以 `!!` 结尾表示立即提交，裸文本进入合并窗口。',
].join('\n')

/** 合并窗口内单条独立消息（并行待派批分条用；保留各自 sender/text/flags，勿拼成一段）。 */
interface MergeTaskItem {
  /** 发送者（可能为空：系统/自身消息不进本队列）。 */
  sender?: string
  /** 单条消息剥离 @提及 前缀后的文本。 */
  text: string
  /** 本条消息是否 @ 提及了本账号（并行批候选门控：未提及且非任务不算可拆任务）。 */
  mentioned: boolean
  /** 本条消息是否"像任务"（@ + 非纯问答 + 内容够长）。 */
  taskLike: boolean
  /** 本条消息进入合并窗口的时间（ms；批次窗口延期的起点）。 */
  enteredAtMs: number
}

interface MergeBuffer {
  parts: string[]
  sender?: string
  timer?: NodeJS.Timeout
  /** 合并窗口内累积的入站图片多模态附件，flush 时随文本一并注入。 */
  imageRefs: ImageAttachmentRef[]
  /** 合并窗口首条消息是否 @ 提及了本账号（deliver 据此判定"待交付任务"）。 */
  mentioned: boolean
  /** 合并窗口首条消息是否"像任务"（@ + 非纯问答 + 内容够长）——阶段2请示门据此触发。 */
  taskLike: boolean
  /** 并行「待派批」逐条任务（阶段 2）：每条独立保留 sender/text/提及/任务标记；
   *  flush 时若窗口内 ≥2 条独立任务且该房为并行模式 → 结构化批次提示交 worker 拆；
   *  不足/非并行 → 走现状合并文本（parts.join）。 */
  items: MergeTaskItem[]
}

/**
 * 把合并窗口内的逐条消息按「连续同 sender」归并成会话轮次（与 parts.join 语义对齐：
 * '..' 续写/同人连发属于同一轮对话，不应被误拆成多条独立并行任务；跨 sender 才分条）。
 * 归并后每条 = 一次「独立发言轮」，供并行批判定使用。
 */
function mergeSenderTurns(items: readonly MergeTaskItem[]): MergeTaskItem[] {
  const out: MergeTaskItem[] = []
  for (const item of items) {
    const last = out[out.length - 1]
    if (last !== undefined && (last.sender ?? '') !== '' && last.sender === item.sender) {
      last.text = `${last.text}\n${item.text}`
      last.mentioned = last.mentioned || item.mentioned
      last.taskLike = last.taskLike || item.taskLike
      last.enteredAtMs = Math.min(last.enteredAtMs, item.enteredAtMs)
    } else {
      out.push({ ...item })
    }
  }
  return out
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

/**
 * 无主审批（秘书/前台接待/subagent 会话，不绑定工作房间）的合成队列 key。
 * 不是真实房间 id，仅用于承载 pendingApprovals 队列 + DM 房反查映射；
 * 不会发群聊消息（审批问人走 DM），故这个 key 只出现在内存结构里。
 */
const OWNERLESS_APPROVAL_ROOM = '__ownerless_approval__'

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
 * 判断一条入站消息是否应进入「群形态滚动窗口」（阶段 3）：
 * 只统计**人类/外部**消息——排除分身自己出站（sender = 本账号，Matrix 回流）、
 * '/' 命令、口播模式指令自身（keywordModeHint 命中会被前台消费/落配置，不该当形态样本）。
 * 纯媒体占位（[图片: x.png]/[文件: …] 无实质文字）也是中性事件，不进窗口。
 * 纯模式指令、系统事件不在此入口（RoomEvent 走 handleRoomEvent 不进来）。
 */
function isShapeSampleEligible(
  text: string,
  sender: string,
  selfUserId: string,
  isCommand: boolean,
  isModeDirective: boolean,
): boolean {
  if (sender === '' || sender === selfUserId) return false
  if (isCommand) return false
  if (isModeDirective) return false
  const t = text.trim()
  if (t === '') return false
  // 纯媒体占位（无实质用户文字）：开头就是 [图片/文件/音频/视频/位置: …] 且无后续文字。
  const mediaOnly = /^\[(图片|文件|音频|视频|位置|附件):[^\]]*\](?:\s*\[(?:图片|文件|音频|视频|位置|附件):[^\]]*\])*$/.exec(t)
  if (mediaOnly !== null) return false
  return true
}

/**
 * 解析当前 dsh 实例的会话命名空间（会话隔离身份）。
 * 优先显式 config.instanceKey；否则回退 process.env.DSH_HOME（每个实例的稳定身份锚，
 * 端口号会漂移/随机，不适合）。两者都缺省返回 undefined（旧行为：无命名空间）。
 * 返回 undefined 表示「不启用实例隔离」——state 文件里的旧绑定不会被作废。
 */
function resolveSessionNamespace(instanceKey: string | undefined): string | undefined {
  const explicit = typeof instanceKey === 'string' ? instanceKey.trim() : ''
  if (explicit !== '') return explicit
  const home = process.env.DSH_HOME
  if (home !== undefined && home.trim() !== '') return home.trim()
  return undefined
}

/**
 * 单个 Matrix 账号的桥接单元：独立 sync 循环、独立状态文件、独立会话绑定。
 */
export class AccountBridge {
  readonly userId: string
  readonly isMain: boolean
  readonly owner?: string
  /** 分身的 respondToAll（digitalTwins[i].respondToAll，部署固定，不随主配置热更）。 */
  private readonly twinRespondToAll: boolean
  private readonly agentOptions: AgentOptions

  private readonly ctx: Context
  /** 可变 config：volatile-update 热更后经 applyConfigUpdate() 原地替换引用。 */
  private config: Config
  private readonly state: BridgeState
  private readonly authStore: AuthStore
  private readonly channel: Channel
  private readonly allAccountIds: readonly string[]
  /** 会话命名空间（实例身份）：参与确定性会话 id，隔离不同 dsh 实例的同房间会话。 */
  private readonly sessionNamespace: string | undefined
  /** 成员记忆库（记住每个房间里见过的成员）。 */
  private readonly memberStore: MemberStore
  /** 入群邀请审批库（待决邀请 + 邀请人黑白名单），独立落盘防 sync 游标推进丢邀请。 */
  private readonly inviteStore: InviteStore
  /** 自我时间线（跨房间，仅元数据；MatrixBridge 传入的共享实例）。 */
  private readonly timeline: TwinTimeline
  /** 时间线快照发布回调（由 MatrixBridge 传入，index.ts 提供 settings 写通道）。 */
  private readonly publishTimelineSnapshot?: (snapshot: { entries: unknown[]; updatedAt: number }) => void
  /** 主人收件箱发布回调（由 MatrixBridge 传入，index.ts 提供 settings 写通道）。 */
  private readonly publishOwnerInbox?: (snapshot: OwnerInboxSnapshot) => void
  /** 任务看板发布回调（由 MatrixBridge 传入，index.ts 提供 settings 写通道）。 */
  private readonly publishTaskBoard?: (snapshot: TaskBoardSnapshot) => void
  /**
   * per-room 岗位覆盖内存镜像（roomId/群名 → 岗位 preset id）。
   * 初始从 config.roomPresets 装载；设置页变更后更新并（防抖）写回 settings 用户层。
   * 读接口统一走 roomPresetFor()：未收录 = 回退 config.agentPreset（全局默认岗位）。
   */
  private readonly roomPresetsMem = new Map<string, string>()
  /** config（yml/设置页 base 层）里钉死的岗位键：静态权威，settings 热更同步永不覆盖/清除。 */
  private readonly roomPresetsBaseKeys = new Set<string>()
  /** 岗位变更防抖定时器（写 settings 用）。 */
  private roomPresetsTimer: ReturnType<typeof setTimeout> | undefined
  /** 待写回的岗位增量（key → 新值；undefined=删除该键）。 */
  private roomPresetsDirty = new Map<string, string | undefined>()
  /** 房间名缓存：roomId → 最近一次 channel.getRoomName 结果（board 行展示用）。 */
  private readonly roomNameCache = new Map<string, string>()
  /** 每房间最近一位外部发言者（时间线摘要标注「回复谁」用；分身自己发言不更新）。 */
  private readonly lastSenderByRoom = new Map<string, string>()
  /**
   * per-room 群工作模式内存镜像（roomId/群名 → 显式钉死模式）。
   * 初始从 config.roomModes 装载；口播指令/设置页变更后更新并（防抖）写回 settings 用户层。
   * 读接口统一走 roomModeFor()：未收录 = auto（默认自适配）。
   */
  private readonly roomModesMem = new Map<string, RoomMode>()
  /** config（yml/设置页 base 层）里钉死的键：静态权威，settings 热更同步永不覆盖/清除它们。 */
  private readonly roomModesBaseKeys = new Set<string>()
  /** 群模式变更防抖定时器（写 settings 用，避免口播连发打爆写通道）。 */
  private roomModesTimer: ReturnType<typeof setTimeout> | undefined
  /** 待写回的群模式增量（key → 新值；undefined=删除该键）。 */
  private roomModesDirty = new Map<string, RoomMode | undefined>()

  // ── 阶段 3：per-room 群形态滚动器（auto 自适配软倾向，纯内存、重启即清）──
  /**
   * per-room 最近入站人类消息（滚动窗口，上限 windowN，仅供形态投票）。
   * 与 chatlog 解耦：只存 shapeVote 需要的 {sender,text,ts}，且只收外部人类消息
   * （排除分身自己出站 / '/' 命令 / 模式指令自身）。
   */
  private readonly roomShapeBuf = new Map<string, ShapeSample[]>()
  /**
   * per-room 当前有效倾向（auto 软信号）：roomId → 声明值 + 声明/切换时间戳。
   * 铁律：绝不写 settings.roomModes（那里只放显式钉死）；auto 才读（roomModeFor() 短路）；
   * 重启即清（倾向是运行时临时判断，重新积累即可）。
   */
  private readonly roomShapeLeaning = new Map<string, { lean: Leaning; at: number }>()
  /** 自上次倾向切换以来滚入窗口的新消息计数（整窗翻新判定 windowFresh 用）。 */
  private readonly roomShapeFreshCount = new Map<string, number>()
  /**
   * auto 阈值内存镜像：构造时从 config.autoTune 装载。autoTune 为部署固定（非 volatile）
   * 参数（0.1.7 无设置页热更场景），故仅装载一次，autoTune() 统一读此镜像。
   * （syncAutoTuneFromSettings 保留但不再被订阅调用，作未来恢复热更的现成实现。）
   */
  private autoTuneMem: AutoTune = autoTuneOf({ autoTune: undefined })

  /** 读当前生效的 auto 阈值（内存镜像；极端情况下回退出厂默认）。 */
  private autoTune(): AutoTune {
    return normalizeAutoTune(this.autoTuneMem) ?? DEFAULT_AUTOTUNE
  }

  /**
   * 阶段 2/调度统一读取口（设计 §4.2）：该房间当前软倾向（'parallel'|'cohesive'|'neutral'）。
   * 只返回**内存倾向**，不掺合钉死判定——调用方须先过 roomModeFor(roomId)==='auto' 再读本值
   * （钉死房不读倾向：铁律 2）。倾向超过 minGapMs×2 无新消息视为过期 → neutral。
   */
  roomShapeLeaningFor(roomId: string): Leaning {
    const entry = this.roomShapeLeaning.get(roomId)
    if (entry === undefined) return 'neutral'
    const auto = this.autoTune()
    // 过期判定：距声明时间已超 2 个冷却窗（默认 20 分钟）无更新 → 视为 neutral（群已冷却）。
    if (Date.now() - entry.at > auto.minGapMs * 2) return 'neutral'
    return entry.lean
  }

  /**
   * 阶段 3：入口更新 —— 每条入站人类消息推进 per-room 滚动窗口 + 防抖裁决。
   * 纯内存 O(窗口) 操作 + 一次缓存化 DM 判定（channel 60s TTL），零模型调用。
   * 窗口裁决语义（对齐设计 §三.2 与纯函数契约）：
   * - 只统计群聊房间（私聊无“群形态”，不采样）；
   * - 窗口不足 N 条：只积累不裁决（样本不足宁不声明）；
   * - 满 N 条后每次入站算窗口 verdict，经 nextLeaning 防抖裁决写 roomShapeLeaning；
   * - 首声明（neutral → parallel/cohesive）不强制整窗翻新：占比 ≥60% + 票差 ≥3 已足够保守；
   * - 同向续证（verdict 与当前同向）只刷新时间戳（保持倾向“存活”，供过期判定）；
   * - 反向切换需冷却 + 整窗翻新（freshCount 每次入站 +1，真正切换成功才清零）；
   * - 中立窗口多数：短暂 (<冷却窗) 不降级（防被瞬间混合形态打断），持续无同向证据才回 neutral。
   */
  private async updateRoomShape(roomId: string, text: string, sender: string, now = Date.now()): Promise<void> {
    const auto = this.autoTune()
    const isCmd = text.startsWith('/')
    const isDirective = keywordModeHint(text) !== undefined
    if (!isShapeSampleEligible(text, sender, this.userId, isCmd, isDirective)) return
    // 群形态只统计群聊房间：私聊不参与 auto 自适配（channel 层带 60s DM 缓存，非每消息网络请求）。
    const isDm = this.channel.isDirectRoom ? await this.channel.isDirectRoom(roomId).catch(() => false) : false
    if (isDm) return
    const buf = this.roomShapeBuf.get(roomId) ?? []
    buf.push({ sender, text, ts: now })
    // 有界滚动：超出 windowN 丢最旧（等价「最近 N 条」）。
    while (buf.length > auto.windowN) buf.shift()
    this.roomShapeBuf.set(roomId, buf)
    // 距上次倾向切换后滚入的新消息计数（整窗翻新判定；同向续证不清零，只在真正切换时清零）。
    this.roomShapeFreshCount.set(roomId, (this.roomShapeFreshCount.get(roomId) ?? 0) + 1)
    // 窗口未满 N 条不裁决（样本不足宁不声明）。
    if (buf.length < auto.windowN) return
    // 两级投票出窗口倾向版本。
    const verdict = leaningFromWindow(buf, {
      n: auto.windowN,
      parallelRatio: auto.parallelRatio,
      cohesiveRatio: auto.cohesiveRatio,
      minDelta: auto.minDelta,
    })
    const current = this.roomShapeLeaning.get(roomId)
    if (verdict === 'neutral') {
      // 中立投票结果：不立即清除——若距上次同向证据（current.at）仍在冷却窗内，说明窗口
      // 只是短暂被搅混（反向往返会被 nextLeaning 的冷却挡住），保留声明更稳（宁不切）；
      // 超过冷却窗仍无同向多数 → 才降回不声明（中性票/混合形态持续足够久 = 真实形态变化）。
      if (current !== undefined && now - current.at < auto.minGapMs) return
      if (current !== undefined) {
        this.roomShapeLeaning.delete(roomId)
        this.roomShapeFreshCount.delete(roomId)
        this.diag.log(`roomShape room=${roomId} leaning → neutral (window majority lost for >cooldown)`)
      }
      return
    }
    const prevLean = current?.lean ?? 'neutral'
    const prevAt = current?.at ?? 0
    // 整窗翻新 = 自上次倾向切换以来又滚入 ≥ windowN 条新样本。
    const windowFresh = (this.roomShapeFreshCount.get(roomId) ?? 0) >= auto.windowN
    const settled = nextLeaning(prevLean, prevAt, now, windowFresh, verdict, auto.minGapMs)
    // 此处 verdict 已非 neutral，nextLeaning 只可能返回 prev 或 proposed：
    if (settled !== prevLean) {
      // 真正切换（含首声明）：记录新倾向 + 清零翻新计数（新的冷却窗起点）。
      this.roomShapeLeaning.set(roomId, { lean: settled, at: now })
      this.roomShapeFreshCount.set(roomId, 0)
      this.diag.log(`roomShape room=${roomId} leaning ${prevLean} → ${settled} (verdict=${verdict} fresh=${windowFresh} buf=${buf.length})`)
    } else if (verdict === prevLean && current !== undefined) {
      // 同向续证：窗口 verdict 与当前倾向同向（proposed===prev）→ 刷新声明时间戳，
      // 使过期判定以“最近一次仍被窗口证据支持”为准（群里持续同形态 → 倾向保持存活）。
      // 反向被拦（verdict≠prev 但 settled===prev，即冷却/翻新不足）不进此分支——
      // 不刷新 at，避免把冷却基线不断后移造成永久锁死；翻新计数也保持累计，等满窗即可切。
      this.roomShapeLeaning.set(roomId, { lean: settled, at: now })
    }
    // 反向被防抖拦下（settled===prev 且 verdict≠prev）：保持现状（宁不切），静默等冷却/翻新。
  }

  /**
   * 阶段 3：settings 用户层 autoTune 热更后的同步（MatrixBridge 分发）——
   * 阈值变化可能缩小窗口（旧样本超窗被裁）或改变裁决口径，立即按新阈值重算一次。
   * 纯内存，不改 roomModes / 不写任何 settings。
   * 入参 raw 可能是「整段用户层 autoTune」或「只改了一个字段的局部 patch」——
   * 先与当前生效阈值合并再归一，避免单字段热更把其它字段重置回默认。
   */
  syncAutoTuneFromSettings(raw: unknown): void {
    if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
    const current = this.autoTune()
    // 局部 patch 与当前阈值逐字段合并（settings 若给整段则等价覆盖）。
    const merged: Record<string, unknown> = { ...current }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value !== undefined) merged[key] = value
    }
    const next = normalizeAutoTune(merged)
    if (next === undefined) return
    if (next.windowN === current.windowN && next.parallelRatio === current.parallelRatio &&
        next.cohesiveRatio === current.cohesiveRatio && next.minDelta === current.minDelta &&
        next.minGapMs === current.minGapMs) return
    // 更新内存镜像并记录（config 对象引用在 settings 热更后未必更新，统一以本镜像为准）。
    this.autoTuneMem = next
    this.diag.log(`roomShape autoTune hot-applied windowN=${next.windowN} pRatio=${next.parallelRatio} cRatio=${next.cohesiveRatio} delta=${next.minDelta} gap=${next.minGapMs}`)
    // 阈值口径变了 → 旧倾向作废，清空后按新阈值从窗口重算（避免带着旧口径的倾向继续生效）。
    this.roomShapeLeaning.clear()
    this.roomShapeFreshCount.clear()
    for (const roomId of [...this.roomShapeBuf.keys()]) {
      const samples = this.roomShapeBuf.get(roomId)
      if (samples === undefined) continue
      if (samples.length > next.windowN) {
        this.roomShapeBuf.set(roomId, samples.slice(samples.length - next.windowN))
      }
      this.recomputeRoomShapeLeaning(roomId)
    }
    this.diag.log(`roomShape autoTune re-verdict done: rooms=${this.roomShapeLeaning.size}`)
  }

  /** 用当前窗口与阈值重算某房间倾向（首声明无需整窗翻新，nextLeaning 已处理）。 */
  private recomputeRoomShapeLeaning(roomId: string): void {
    const auto = this.autoTune()
    const buf = this.roomShapeBuf.get(roomId)
    if (buf === undefined || buf.length < auto.windowN) return
    const verdict = leaningFromWindow(buf, {
      n: auto.windowN,
      parallelRatio: auto.parallelRatio,
      cohesiveRatio: auto.cohesiveRatio,
      minDelta: auto.minDelta,
    })
    if (verdict === 'neutral') {
      this.roomShapeLeaning.delete(roomId)
      return
    }
    const now = Date.now()
    const current = this.roomShapeLeaning.get(roomId)
    const settled = nextLeaning(current?.lean ?? 'neutral', current?.at ?? 0, now, false, verdict, auto.minGapMs)
    if (settled !== (current?.lean ?? 'neutral')) {
      this.roomShapeLeaning.set(roomId, { lean: settled, at: now })
      this.roomShapeFreshCount.set(roomId, 0)
    }
  }
  /** 诊断日志：写入 stateDir/diagnostics.log，供事后文件排查（无需运行终端）。 */
  private readonly diag: ReturnType<typeof getDiag>
  /** 近期聊天记录（按房间，最近一周）：与响应门控解耦，无论是否 @都记录，供 @时被引用。 */
  private readonly chatlog: ChatLog
  /** 共享的「房间内有 pending 审批」集合（MatrixBridge 传入，多账号协调审批应答）。 */
  private readonly pendingRooms: Set<string>

  private readonly roomAgents = new Map<string, AgentHandle>()
  /** 已装 reasoningEffort 注入（agent/request waterfall）的 agent id 集合（幂等去重）。 */
  private readonly effortHookedAgents = new Set<string>()
  /**
   * 秘书会话：数字分身与主人之间的持久会话（DSH 里可查看历史）。
   * 所有请示/汇报/决策都作为记录注入这里，主人可在 GUI 查看「谁在什么群请示了什么、
   * 结果如何」。它不写入 state.roomSessions，所以 handleSessionEvent 对其出站天然屏蔽
   * （roomForSession 返回 undefined），秘书会话绝不会对外发群。
   */
  private secretaryAgent: Agent | undefined
  private secretaryInflight: Promise<Agent> | undefined
  /**
   * 前台接待会话：对入站消息做语义分类（AI 接待层）。
   * 独立 agent（preset=reception，独立 provider/model，reasoningEffort 恒 off）。
   * 只输出判定 JSON（kind id），由 bridge 查 receptionKinds 表执行礼貌层动作。
   * 不写 state.roomSessions → handleSessionEvent 对其出站天然屏蔽（绝不对群发消息）。
   */
  private receptionAgent: Agent | undefined
  private receptionInflight: Promise<Agent> | undefined
  /** 接待判定单轮等待：handleSessionEvent 收到该会话输出时 settle。FIFO（同一时刻至多一个）。 */
  private receptionPending: Array<{ settle: (text: string | undefined) => void }> = []
  /** per-room 判定节流：roomId → 上次判定时间。 */
  private readonly receptionLastAt = new Map<string, number>()
  /** per-room 判定节流：roomId → 上次判定结果（kind）。 */
  private readonly receptionLastKind = new Map<string, string>()
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
   * 决策等待表：workRoomId → 正在阻塞等待答复的 resolver。
   * agent 调 matrix_request_owner_decision / matrix_report_owner 后，工具 execute 阻塞
   * 等待答复；答复方 resolve(决策)，工具把决策回传给 agent，agent 在同一 turn 内继续。
   * 两类发起者共用此表，靠 initiatorSessionId 区分：
   *   - worker 会话（initiator=worker session id）：由 matrix_reply_worker resolve；
   *   - 秘书会话（initiator=秘书 session id）：由主人回复（handleOwnerReply / handleOwnerDecisionOps）resolve。
   */
  private readonly ownerPending = new Map<string, Array<{ resolve: (r: OwnerDecisionResult) => void; dmRoomId: string; kind: 'clarify' | 'report'; initiatorSessionId: string }>>()
  /**
   * 挂起待答表：workRoomId → 一次「请示/汇报已送达但等待方（秘书/主人）尚未答复」的记录。
   * 与 ownerPending 的区别：
   *   - ownerPending 只在工具 execute 阻塞期间存在（agent turn 内），resolve 后即删；
   *   - 挂起记录在发起方本轮结束（首次等待超时）后仍保留，直到答复方最终答复
   *     （主人 DM 回复 / inbox 决策 / 秘书 replyWorker）才清除。
   * 答复方晚到（无 active pending）时，命中此表 → 用 followup 唤醒等待方会话继续，
   * 实现「请示没成功就等领导在的时候再次请示/答复」而非限时判死。
   */
  private readonly pendingReasks = new Map<string, {
    /** 原请示/汇报正文（唤醒时作为上下文带给发起方）。 */
    text: string
    /** 房间显示名/上下文标签（唤醒时带上）。 */
    roomLabel: string
    kind: 'clarify' | 'report'
    /** 发起方会话 id（worker 会话 或 秘书会话），答复到达时向它 followup 唤醒。 */
    initiatorSessionId: string
    /** 等待对象：秘书（worker 请示秘书时）或 主人（秘书上呈主人时）。 */
    waitFor: 'secretary' | 'owner'
    /** 发起时间。 */
    at: number
  }>()
  /** pendingReasks 的 key 前缀分隔：roomId 与 waitFor 组合，worker/秘书两级挂起互不覆盖。 */
  private pendingReaskKey(roomId: string, waitFor: 'secretary' | 'owner'): string {
    return `${roomId}::${waitFor}`
  }
  private setPendingReask(roomId: string, waitFor: 'secretary' | 'owner', record: { text: string; roomLabel: string; kind: 'clarify' | 'report'; initiatorSessionId: string; waitFor: 'secretary' | 'owner'; at: number }): void {
    this.pendingReasks.set(this.pendingReaskKey(roomId, waitFor), record)
  }
  private removePendingReask(roomId: string, waitFor: 'secretary' | 'owner'): void {
    this.pendingReasks.delete(this.pendingReaskKey(roomId, waitFor))
  }
  /** 取某 roomId 下「某等待对象」的挂起记录（无则 undefined）。 */
  private getPendingReask(roomId: string, waitFor: 'secretary' | 'owner'): { text: string; roomLabel: string; kind: 'clarify' | 'report'; initiatorSessionId: string; waitFor: 'secretary' | 'owner'; at: number } | undefined {
    return this.pendingReasks.get(this.pendingReaskKey(roomId, waitFor))
  }
  /** 主人收件箱内存镜像（workRoomId → 条目），供 publishOwnerInbox 聚合后写 settings。 */
  private readonly inboxItems = new Map<string, OwnerInboxItem>()
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
   * 交付授权（彻底分层红线）：主人已确认「交付」的房间集合。
   * 数字分身（有 owner）对外发言 matrix_send_room_message 前，须先 matrix_report_owner
   * 汇报并等主人回「交付」；主人确认后置位，此后该房间的对外交付放行。
   * 内存级；/new 重置时清空。
   */
  private readonly deliveryAuthorized = new Set<string>()
  /**
   * 主人私聊房 → 工作房间 的映射。agent 用 matrix_request_owner_decision /
   * matrix_report_owner 发起请示/汇报时，桥接层记录「这个 DM 房对应哪个工作房间」，
   * 主人回复「批准/交付」时据此反查工作房间置位交付授权。
   */
  private readonly ownerDmToWorkRoom = new Map<string, string>()
  /**
   * 私聊房判定缓存（roomId → 是否 1:1 私聊）。
   * handleSessionEvent 是同步的，无法 await channel.isDirectRoom；入站门控
   * （shouldRespond）与上下文标签（roomContextLabel）已算过该值，就地缓存供出站读取。
   * 仅作「DM 房 assistant/message 直接投递」的判据：未命中 = 按旧行为（不投递）。
   */
  private readonly dmRoomCache = new Map<string, boolean>()
  /**
   * 本轮已用工具显式发过消息的房间（turn/start 清空）。
   * 用途：DM 房放开 assistant/message 自动投递后，若 agent 本轮已调
   * matrix_send_room_message / matrix_send_dm 显式发言，则不再自动重投，避免同一条文本发两遍。
   */
  private readonly turnOutboundRooms = new Set<string>()

  /**
   * 单例任务看板（per-room bridge state）：worker 正在处理哪个房间的任务、何时开始。
   * deliver() 注入任务时置位（since=开始时间,label=任务摘要）；
   * handleMessage 收到本账号自己的回复回流时清除（视为该房间任务完成）。
   * 前台接待层据此判断「是否忙」并播报已耗时/ETA。
   */
  private readonly roomBusy = new Map<string, { since: number; label: string }>()

  /**
   * 任务跟进（阶段 1：前台接待升级为「任务跟进者」）：
   * - roomPendingReply：某房间有待交付的任务（deliver 收到 @任务置位；worker 实质发群后清除）。
   * - roomLastOutboundAt：该房间最后一次工具发群时间（approveProactiveSend 放行时更新）。
   * - 跟进改为超时轮询（agent/status 的 idle 在长任务中不触发，不可靠）：start() 里启 followupTimer
   *   每 FOLLOWUP_POLL_MS 扫一次 pendingReply，超过 FOLLOWUP_DELAY_MS 无实质交付 → followup 提醒 worker 补发，
   *   remindCount 限次防循环；超次后接待层代发占位并移除。
   */
  private readonly roomPendingReply = new Map<string, { at: number; label: string; remindCount: number; lastRemindAt: number }>()
  /** 阶段2：房间「请示中」标记——该房间有未决的开工请示（防止同房间重复请示）。 */
  private readonly roomPendingClarify = new Set<string>()
  private followupTimer: ReturnType<typeof setInterval> | undefined
  private readonly roomLastOutboundAt = new Map<string, number>()

  // ── A 路径：并行「批次收集窗口」运行时（只做输入预处理；执行机制在 preset+skill 的 subagent）──
  /** 并行批次窗口配置内存镜像：构造时从 config.parallel 装载（部署固定非 volatile，无热更场景）。
   *  （syncParallelFromSettings 保留但不再被订阅调用，作未来恢复热更的现成实现。） */
  private parallelMem: ParallelOpts = DEFAULT_PARALLEL

  /** 并行批次窗口是否启用（本账号级总开关：config.parallel.enabled；false=提示层全关）。 */
  private parallelEnabled(): boolean {
    return this.parallelMem.enabled !== false
  }

  /**
   * 该房间当前是否按「并行模式」放行批次/拆分提示（群模式联动，纯提示层）：
   * - 总开关 enabled 关闭 → false（零行为变化）；
   * - roomModeFor==='parallel'（显式钉死）→ true；
   * - roomModeFor==='auto' 且形状软倾向 leaning==='parallel' → true（阶段 3 auto 联动）；
   * - cohesive / auto 中性 → false（cohesive 永不拆，auto 默认不拆）。
   */
  private parallelModeFor(roomId: string): boolean {
    if (!this.parallelEnabled()) return false
    const mode = this.roomModeFor(roomId)
    if (mode === 'parallel') return true
    if (mode === 'auto' && this.roomShapeLeaningFor(roomId) === 'parallel') return true
    return false
  }

  /** settings 用户层 parallel 热更后的同步（MatrixBridge 分发；局部 patch 与当前值合并再归一）。 */
  syncParallelFromSettings(raw: unknown): void {
    if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
    const current = this.parallelOf()
    const merged: Record<string, unknown> = { ...current }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value !== undefined) merged[key] = value
    }
    const next = normalizeParallel(merged)
    if (next === undefined) return
    if (next.enabled === current.enabled &&
        next.batchWindowSecs === current.batchWindowSecs && next.maxBatchItems === current.maxBatchItems) return
    this.parallelMem = next
    this.diag.log(`parallel hot-applied enabled=${next.enabled} windowSecs=${next.batchWindowSecs} maxItems=${next.maxBatchItems}`)
  }

  /** 读当前生效的并行批次窗口配置（内存镜像；极端情况回退出厂默认）。 */
  private parallelOf(): ParallelOpts {
    return normalizeParallel(this.parallelMem) ?? DEFAULT_PARALLEL
  }

  /**
   * 并行批次触发（A 路径提示层）：在 flushMerge 合并处收集窗口内多条独立任务
   * （各自 sender/text 保留）→ shouldBatch ≥2 且该房并行模式 → 注入 buildBatchPrompt
   * 结构化提示（措辞指向 subagent 工具）→ worker 模型自决拆/不拆。
   * 不吞消息、不改 deliver 现有语义；模型不认可拆分就退回现状（宁可串行不可拆错）。
   * @returns true=已走并行批次路径（调用方不再走合并 deliver）。
   */
  private tryDispatchParallelBatch(roomId: string, items: readonly MergeTaskItem[], imageRefs: readonly ImageAttachmentRef[]): boolean {
    if (items.length === 0) return false
    if (!this.parallelModeFor(roomId)) return false
    // 只收「外部派活」性质的消息（@提及 或 像任务）为可拆候选；纯闲聊不强行拼批。
    const candidates = items.filter((it) => (it.mentioned || it.taskLike) && it.text.trim() !== '')
    if (candidates.length < 2) return false
    const opts = this.parallelOf()
    if (candidates.length > opts.maxBatchItems) candidates.length = opts.maxBatchItems
    const tasks: ParallelTaskItem[] = candidates.map((it, index) => ({
      seq: index + 1,
      sender: it.sender ?? '(unknown)',
      text: it.text.trim(),
    }))
    if (!shouldBatch(tasks, 2)) return false
    const prompt = buildBatchPrompt(tasks)
    const body = `[并行模式] 本群当前按并行处理。\n${prompt}`
    // 复用 deliver 的完整注入路径（含房间标签 + 请示门等既有门控），只替换文本为批次提示。
    void this.deliver(roomId, body, tasks[0]?.sender, [...imageRefs], true, true)
    this.diag.log(`[parallel] batch dispatch room=${roomId} tasks=${tasks.length}`)
    return true
  }

  /** 单条内部可拆任务的弱触发：把任务原文与可拆提示一并注入（模型不认可就退回现状）。 */
  private maybeHintSplittable(roomId: string, text: string, sender?: string, imageRefs?: ImageAttachmentRef[], mentioned = false, taskLike = false): boolean {
    if (!this.parallelModeFor(roomId)) return false
    if (!isInternallySplittable(text)) return false
    const prompt = buildSplittableHint(text)
    void this.deliver(roomId, prompt, sender, imageRefs, mentioned, taskLike)
    this.diag.log(`[parallel] splittable hint room=${roomId} len=${text.length}`)
    return true
  }

  constructor(
    ctx: Context,
    config: Config,
    state: BridgeState,
    authStore: AuthStore,
    account: DigitalTwinAccount,
    allAccountIds: readonly string[],
    pendingRooms: Set<string>,
    channelFactory: (opts: ChannelOptions) => Channel,
    timeline?: TwinTimeline,
    publishTimelineSnapshot?: (snapshot: { entries: unknown[]; updatedAt: number }) => void,
    publishOwnerInbox?: (snapshot: OwnerInboxSnapshot) => void,
    publishTaskBoard?: (snapshot: TaskBoardSnapshot) => void,
    fetchFn?: typeof fetch,
    sleep?: (ms: number) => Promise<void>,
    sessionNamespace?: string,
  ) {
    this.ctx = ctx
    this.config = config
    this.state = state
    this.authStore = authStore
    this.allAccountIds = allAccountIds
    this.pendingRooms = pendingRooms
    this.sessionNamespace = sessionNamespace
    this.timeline = timeline ?? new TwinTimeline(config.stateDir, config.timelineCap ?? 500)
    this.publishTimelineSnapshot = publishTimelineSnapshot
    this.publishOwnerInbox = publishOwnerInbox
    this.publishTaskBoard = publishTaskBoard
    this.diag = getDiag('dsh-matrix-agent', config.stateDir)
    this.chatlog = new ChatLog(config.stateDir)
    this.memberStore = new MemberStore(config.stateDir)
    this.inviteStore = new InviteStore(config.stateDir)
    // 群工作模式内存镜像：初始装载 config 的显式钉死（base 静态权威），再叠加 state.json
    // 的运行时口播覆盖（0.1.7 起替代 settings 用户层，见 store.ts roomModes）。
    for (const [key, mode] of Object.entries(normalizeRoomModes(config.roomModes))) {
      this.roomModesMem.set(key, mode)
      this.roomModesBaseKeys.add(key)
    }
    for (const [key, mode] of Object.entries(normalizeRoomModes(this.state.roomModes()))) {
      if (this.roomModesBaseKeys.has(key)) continue
      this.roomModesMem.set(key, mode)
    }
    // per-room 岗位覆盖内存镜像：初始装载 config.roomPresets 的显式钉死（base 静态权威），
    // 再叠加 state.json 的运行时口播覆盖。
    for (const [key, presetId] of Object.entries(config.roomPresets ?? {})) {
      if (key === '' || presetId.trim() === '') continue
      this.roomPresetsMem.set(key, presetId)
      this.roomPresetsBaseKeys.add(key)
    }
    for (const [key, presetId] of Object.entries(this.state.roomPresets())) {
      if (key === '' || presetId.trim() === '' || this.roomPresetsBaseKeys.has(key)) continue
      this.roomPresetsMem.set(key, presetId)
    }
    // auto 阈值内存镜像：初始装载 config.autoTune（缺省回退出厂默认）。
    this.autoTuneMem = autoTuneOf(config)
    // 并行批次窗口配置内存镜像：初始装载 config.parallel（缺省回退出厂默认）。
    // A 路径：无 agentTeams 探测——执行机制由 worker 岗位 preset 的 delegation 组提供，
    // 桥接层只按群模式 + 窗口条件注入「可并行」提示，worker 模型自主决定拆/不拆。
    this.parallelMem = parallelOf(config)
    this.diag.log(`parallel runtime init: enabled=${config.parallel?.enabled ?? DEFAULT_PARALLEL.enabled} windowSecs=${this.parallelOf().batchWindowSecs} maxItems=${this.parallelOf().maxBatchItems} (A-path: preset+skill drives subagent)`)

    this.userId = account.userId
    this.isMain = account.userId === config.userId
    this.owner = account.owner !== '' ? account.owner : (this.isMain ? config.owner : undefined)
    // 响应策略：主账号运行时读 config.respondToAll（volatile，可热更）；分身用 digitalTwins
    // 配置的 respondToAll（部署固定）。见 respondToAll getter。
    this.twinRespondToAll = account.respondToAll
    this.agentOptions = {
      provider: account.provider !== '' ? account.provider : config.provider,
      model: account.model !== '' ? account.model : config.model,
    }

    this.channel = channelFactory({
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
    await this.state.load(this.sessionNamespace)
    if (this.config.memberMemory !== false) {
      await this.memberStore.load().catch((error: unknown) => {
        this.ctx.logger.warn('[dsh-matrix-agent] member store load failed: %s', messageOf(error))
      })
    }
    // 邀请审批库无条件加载：待决邀请必须在进程重启后仍能恢复（否则重启即丢主人未答的邀请）。
    await this.inviteStore.load().catch((error: unknown) => {
      this.ctx.logger.warn('[dsh-matrix-agent] invite store load failed: %s', messageOf(error))
    })
    // 重启后重放待决邀请：sync 不会再投递它们，只能靠落盘记录重新请示主人。
    this.replayPendingInvites()
    if (this.config.timelineEnabled !== false) {
      this.timeline.load()
    }
    // 启动即发布一次时间线快照，Client 能读到历史数据而非"加载中"。
    this.publishTimeline()
    this.diag.log(`start: published initial timeline snapshot (publishTimelineSnapshot=${this.publishTimelineSnapshot !== undefined})`)
    // 启动即发布一次任务看板（重启后 Client 工作台能读到当前状态）。
    this.publishTaskBoardSnapshot()
    // Matrix 专属工具：注册到 ToolRuntime（全局 layer），所有 agent 可见可调用。
    // 幂等守卫：多账号（主 + 分身）共享同一 ctx，只有主账号注册一次。
    if (this.isMain && !this.toolsRegistered) {
      this.toolsRegistered = true
      this.registerToolsOnce()
    }
    await this.connectWithRetry()
    // 阶段 1 任务跟进：启动超时轮询（每 20s 扫一次待交付房间；stop 时清理）。
    if (this.followupTimer === undefined) {
      this.followupTimer = setInterval(() => {
        void this.checkPendingReplies()
        void this.checkInviteTimeouts()
      }, 20_000)
      this.diag.log('[dsh-matrix-agent] followupTimer started (poll 20s)')
    }
  }

  /**
   * 待决邀请超时扫描（每 20s）。
   * inviteApprovalTimeoutSecs=0（默认）→ 一直保持待决，等主人有空再答（邀请已持久化，不会丢）。
   * >0 → 超过该时长后按 inviteApprovalTimeoutAction 处置（默认 reject，安全优先）。
   */
  private async checkInviteTimeouts(): Promise<void> {
    const secs = this.config.inviteApprovalTimeoutSecs ?? 0
    if (secs <= 0) return
    const deadline = Date.now() - secs * 1000
    for (const invite of this.inviteStore.listPending()) {
      if (invite.at > deadline) continue
      const label = this.inviteLabel(invite.roomName, invite.roomId)
      const action = this.config.inviteApprovalTimeoutAction ?? 'reject'
      this.diag.log(`checkInviteTimeouts room=${invite.roomId} age=${Math.round((Date.now() - invite.at) / 1000)}s action=${action}`)
      if (action === 'reject') {
        await this.rejectInvite(invite.roomId, invite.inviter, label, 'timeout')
      } else {
        // 保持待决：仅从收件箱移除再重放，避免重复打扰（仍保留落盘记录）。
        this.popInbox(invite.roomId)
      }
    }
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
    setToolLogger((message: string, ...args: unknown[]) => {
      const rest = args.length > 0 ? ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') : ''
      this.diag.log(`${message}${rest}`)
    })
    try {
      applyMatrixTools(this.ctx, {
        channel: this.channel,
        roomForSession: (sessionId: string) => this.roomForSession(sessionId),
        approveProactiveSend: (toolName: string, args: Record<string, unknown>, exec: ToolRunContext) =>
          this.approveProactiveSend(toolName, args, exec),
        mediaDirForSession: (sessionId: string) => this.mediaDirForSession(sessionId),
        setRoomCwd: (roomId: string, cwd: string) => this.setRoomCwdAtomic(roomId, cwd),
        requestOwnerDecision: (roomId: string, question: string, initiatorSessionId?: string) => this.requestOwnerDecisionAtomic(roomId, question, initiatorSessionId),
        reportOwner: (roomId: string, summary: string, initiatorSessionId?: string) => this.reportOwnerAtomic(roomId, summary, initiatorSessionId),
        // 传入调用者会话 id：replyWorkerAtomic 校验只有秘书会话能调（防 worker 自我批准绕过授权）。
        replyWorker: (roomId: string, decision: 'approved' | 'rejected', reply?: string, callerSessionId?: string) => this.replyWorkerAtomic(roomId, decision, reply, callerSessionId),
        listWorkspaceFiles: (roomId: string) => this.listWorkspaceFilesAtomic(roomId),
        readWorkspaceFile: (roomId: string, filename: string) => this.readWorkspaceFileAtomic(roomId, filename),
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
    } catch (error: unknown) {
      this.ctx.logger.error('[dsh-matrix-agent] matrix tools registration failed: %s', messageOf(error))
    }
  }

  async stop(): Promise<void> {
    if (this.followupTimer !== undefined) {
      clearInterval(this.followupTimer)
      this.followupTimer = undefined
    }
    // 冲刷未写回的群模式增量（stop 前兜底落盘）。
    this.disposeRoomModesFlush()
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
    await this.inviteStore.dispose().catch((error: unknown) => {
      this.ctx.logger.warn('[dsh-matrix-agent] invite store save failed: %s', messageOf(error))
    })
  }

  /** volatile 字段热更后更新本账号的 config 引用（respondToAll/allowAllUsers 等运行时读取生效）。 */
  applyConfigUpdate(next: Config): void {
    this.config = next
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
        // 连接就绪信号必须写进 diagnostics.log（不能只写 ctx.logger）：
        // launcher 的「配置数字分身」向导轮询的是 stateDir/diagnostics.log，
        // 只认文件里的 "bridge started" / "Matrix bridge started" 等串；而
        // ctx.logger 走 dsh 终端日志，两者是**不同的 sink**。此前只在
        // index.ts 的 onConfigChange 分支用 ctx.logger 打过 "config complete"，
        // 初次启动（向导路径）既不经过该分支、也不落文件 → 向导必然超时。
        this.diag.log(
          `[dsh-matrix-agent] Matrix bridge started: connected as ${this.isMain ? 'main' : 'twin'} ${this.userId}${this.owner !== undefined ? ` (owner: ${this.owner})` : ''}`,
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

  /**
   * 本账号是否响应群里所有消息（运行时读）：主账号读 config.respondToAll（volatile，可热更），
   * 分身读 digitalTwins 配置的 respondToAll（部署固定，twinRespondToAll）。
   */
  private get respondToAll(): boolean {
    return this.isMain ? this.config.respondToAll : this.twinRespondToAll
  }

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
    // 就地缓存 DM 判定：出站 handleSessionEvent 是同步的，读这份缓存决定是否投递。
    this.dmRoomCache.set(message.roomId, isDm)
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
    // 数字分身（配置了 owner）在群聊里：未 @ 自己的群聊消息也放行进后续流程，
    // 直接注入 agent，由 agent 按 skill 决定是否请示主人、如何回应。
    if (this.config.secretaryGroupDefault !== false && this.owner !== undefined && this.owner !== '') {
      const dm = this.channel.isDirectRoom ? await this.channel.isDirectRoom(message.roomId) : false
      if (!dm) {
        this.diag.log('  -> group-secretary-branch: respond=true (inject to agent)')
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
   * 判断某个 agent 会话 id 是否由本账号创建（秘书/前台接待/subagent 等确定性会话）。
   * 这些会话都以 `matrix-<localpart(userId)>-` 为前缀，且不绑定工作房间（roomForSession 返回 undefined）。
   * 用于 approval/request 无主兜底：把这类会话发起的审批归属到本账号，走 DM 请示主人，
   * 而不是漏给 web answerer 静默 fail-closed（违反「问人必到主人手机」）。
   */
  ownsAgentSession(sessionId: string): boolean {
    const prefix = `matrix-${localpartOf(this.userId)}-`
    return sessionId.startsWith(prefix)
  }

  /** 判断某房间是否归属本账号（roomAgents 有 live 绑定，或 state.roomSessions 有持久绑定）。 */
  ownsRoom(roomId: string): boolean {
    if (this.roomAgents.has(roomId)) return true
    return this.state.roomSession(roomId) !== undefined
  }

  /**
   * 切换某房间的岗位 preset（设置页岗位切换入口）。
   * - 先钉死 roomPresets（内存 + settings 写回），使新建会话按新岗位；
   * - 若该房间已有 live agent 且已产出内容：官方 recompose 只对空白会话合法，
   *   已产出会话切换会让旧工具调用成孤儿。故走「释放旧会话 + 代数 +1 新建会话」——
   *   切换后【立即】重建会话（不等下条消息）：提取旧会话要点摘要 → 释放 → 建新会话
   *   （挂新 preset）→ 注入摘要 → 主动发一条上线消息让新岗位立即就位。
   * - 若 live agent 空白（未产出）：直接 recompose 到新岗位（原地切换，零重建）。
   */
  async switchRoomPreset(roomId: string, presetId: string): Promise<void> {
    await this.setRoomPreset(roomId, presetId, 'settings-page')
    const handle = this.roomAgents.get(roomId)
    if (handle === undefined) {
      // 无 live agent：仅钉死岗位，下次消息到达时按新岗位新建/恢复会话。
      this.diag.log(`roomPresets switch room=${roomId} preset=${presetId}: no live agent, pinned only`)
      return
    }
    const hasProduced = this.sessionHasProduced(handle.agent)
    if (!hasProduced) {
      // 空白会话：原地 recompose（官方契约允许）。
      try {
        const presets = this.ctx.get('agentPresets') as
          | { recompose?(agentCtx: unknown, id: string): Promise<unknown> }
          | undefined
        const agentCtx = (handle.agent as unknown as { ctx?: unknown }).ctx
        if (presets?.recompose !== undefined && agentCtx !== undefined) {
          await presets.recompose(agentCtx, presetId)
          this.diag.log(`roomPresets switch room=${roomId} preset=${presetId}: recompose in place (blank session)`)
          return
        }
      } catch (error) {
        this.diag.log(`roomPresets recompose room=${roomId} failed: ${messageOf(error)}, fallback to rebuild`)
      }
    }
    // 已产出会话（或 recompose 不可用）：立即重建会话。
    // 1) 提取旧会话的历史要点摘要（summary 同步，非全文），供新会话首条注入。
    const summary = this.extractSessionSummary(handle.agent)
    if (summary !== '') {
      this.state.setRoomJobSwitchSummary(roomId, summary)
      this.diag.log(`roomPresets switch room=${roomId} preset=${presetId}: history summary captured (${summary.length} chars)`)
    }
    this.diag.log(`roomPresets switch room=${roomId} preset=${presetId}: produced session, release + rebuild immediately`)
    // 2) 释放旧会话（代数 +1，清空 live 绑定），随后立即按新岗位重建。
    await this.releaseRoom(roomId)
    // 3) 立即新建会话（createRoomAgent 会按 roomPresetFor 挂新 preset，并注入 switchSummary）。
    try {
      const agent = await this.createRoomAgent(roomId)
      this.diag.log(`roomPresets switch room=${roomId} preset=${presetId}: new session built (id=${agent.id})`)
      // 4) 主动上线：发一条系统提示让新岗位立即跑一次，而非等用户下条消息。
      try {
        agent.followup(createUserMessage({
          content: [{
            type: 'text',
            text: `【岗位已切换】本群岗位已切换为「${presetId}」。请熟悉你的新职责与工具集，准备好处理本群的后续任务。如需了解此前工作上下文，见上一条交接摘要。`,
          }],
          source: { kind: 'user' },
        }))
        this.diag.log(`roomPresets switch room=${roomId} preset=${presetId}: active onboard message sent`)
      } catch (error) {
        this.ctx.logger.warn('[dsh-matrix-agent] onboard message failed: %s', messageOf(error))
      }
    } catch (error) {
      this.ctx.logger.error('[dsh-matrix-agent] immediate rebuild after preset switch failed (room=%s, preset=%s): %s; will rebuild lazily on next message', roomId, presetId, messageOf(error))
    }
  }

  /**
   * 原子工具：把房间绑定到工作目录（绝对路径，必须存在）。
   * 同时回写「工作内容→目录」经验记忆（matterCwds），让秘书对同类工作形成记忆。
   */
  private async setRoomCwdAtomic(roomId: string, cwd: string): Promise<void> {
    if (!isAbsolute(cwd)) throw new Error(`工作目录必须是绝对路径：${cwd}`)
    if (!existsSync(cwd)) throw new Error(`工作目录不存在：${cwd}`)
    this.state.setRoomCwd(roomId, cwd)
    this.ctx.logger.info('[dsh-matrix-agent] room %s cwd set to %s', roomId, cwd)
  }

  /** 拼接「群名/发起人」上下文，供请示/汇报 DM 用。 */
  private async ownerDmContext(roomId: string, sender?: string): Promise<string> {
    const name = this.channel.getRoomName ? await this.channel.getRoomName(roomId).catch(() => undefined) : undefined
    const group = name !== undefined && name !== '' ? `群聊「${name}」` : `房间 ${roomId}`
    const who = sender !== undefined && sender !== '' ? `发起人：${sender}` : '发起人：（未记录）'
    return `${group}\n${who}`
  }

  /**
   * 原子工具：发起请示。按调用者分流：
   * - worker 会话调用 → 投递给秘书（requestSecretaryDecisionAtomic，阻塞等秘书回传）；
   * - 秘书会话调用 → 上呈主人（走 DM + 阻塞，现有逻辑）。
   */
  private async requestOwnerDecisionAtomic(roomId: string, question: string, initiatorSessionId?: string): Promise<OwnerDecisionResult> {
    if (initiatorSessionId !== undefined && initiatorSessionId === this.secretarySessionId()) {
      return this.requestOwnerFromOwnerAtomic(roomId, question)
    }
    return this.requestSecretaryDecisionAtomic(roomId, question, initiatorSessionId)
  }

  /** worker → 秘书：把请示投递给秘书会话，阻塞等待秘书用 matrix_reply_worker 回传决策。 */
  private async requestSecretaryDecisionAtomic(roomId: string, question: string, initiatorSessionId?: string): Promise<OwnerDecisionResult> {
    if (this.owner === undefined || this.owner === '') return { roomId, sent: false, decision: 'no-owner' }
    try {
      const name = await this.channel.getRoomName?.(roomId).catch(() => undefined)
      // 秘书会话落盘请示 + 唤醒秘书 LLM（source.kind='user' → 右对齐气泡，sender=worker）。
      // 显式带上 roomId，让秘书 agent 能提取并回传给 matrix_reply_worker(roomId=…)。
      const secretary = await this.getSecretaryAgent()
      const body = `[请示] ${name !== undefined ? `群「${name}」` : ''}（roomId: ${roomId}）\n${question}`
      secretary.followup(createUserMessage({
        content: [{ type: 'text', text: body }],
        source: { kind: 'user' },
      }))
      this.recordTimeline(roomId, 'approval', { target: 'secretary' }, 0, 'secretary', `[请示] ${this.timelineExcerpt(question)}`)
      // 阻塞等待秘书回传（首次等待 secretaryDecisionTimeoutSecs；超时转挂起待答，非判死）。
      return this.waitOwnerDecision(roomId, body, '', 'clarify', initiatorSessionId ?? this.userId)
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix-agent] requestSecretaryDecision failed: %s', messageOf(error))
      return { roomId, sent: false, decision: 'timeout' }
    }
  }

  /** 秘书 → 主人：把请示上呈主人（DM + 收件箱），阻塞等待主人答复。 */
  private async requestOwnerFromOwnerAtomic(roomId: string, question: string): Promise<OwnerDecisionResult> {
    if (this.owner === undefined || this.owner === '') return { roomId, sent: false, decision: 'no-owner' }
    const ctx = await this.ownerDmContext(roomId)
    try {
      const dm = await this.channel.sendDm?.(this.owner, `【任务请示】\n${ctx}\n\n${question}`)
      if (dm === undefined) return { roomId, sent: false, decision: 'timeout' }
      this.ownerDmToWorkRoom.set(dm.roomId, roomId)
      // 新一轮请示 = 需重新授权：清除旧交付授权，防 agent 复用上一轮授权直接发群。
      this.deliveryAuthorized.delete(roomId)
      this.recordTimeline(dm.roomId, 'approval', { target: this.owner }, 0, 'secretary', `[请示主人] ${this.timelineExcerpt(question)}`)
      // 写入主人收件箱（DSH 侧待批列表）。
      this.pushInbox(roomId, 'clarify', question)
      // 注意：此处处于秘书 agent 的 turn/step 内，绝不能往秘书会话 session.append
      // （会破坏 tool/call↔tool/result 平衡导致 INVALID_REQUEST）。上呈动作已由
      // matrix_request_owner_decision 的 tool/call + tool/result 事件天然记录。
      // 阻塞等待主人答复（首次等待 taskClarifyTimeoutSecs；超时转挂起待答，非判死）。
      const result = await this.waitOwnerDecision(roomId, `【任务请示】\n${ctx}\n\n${question}`, dm.roomId, 'clarify', this.secretarySessionId())
      // 转挂起（pending）时保留收件箱条目：主人还没答，GUI 待批列表应继续显示。
      if (result.decision !== 'pending') this.popInbox(roomId)
      return result
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix-agent] requestOwnerDecision DM failed: %s', messageOf(error))
      return { roomId, sent: false, decision: 'timeout' }
    }
  }

  /**
   * 原子工具：汇报。按调用者分流：worker → 秘书；秘书 → 主人。
   * worker 汇报投秘书（reportSecretaryAtomic），由秘书决策回传或上呈主人；
   * 秘书超时未回传时，测试房间由 waitOwnerDecision 超时兜底自动放行交付
   * （生产房间仍转挂起待答等秘书/主人晚答复）。
   */
  private async reportOwnerAtomic(roomId: string, summary: string, initiatorSessionId?: string): Promise<OwnerDecisionResult> {
    if (initiatorSessionId !== undefined && initiatorSessionId === this.secretarySessionId()) {
      return this.reportOwnerFromOwnerAtomic(roomId, summary)
    }
    return this.reportSecretaryAtomic(roomId, summary, initiatorSessionId)
  }

  /** worker → 秘书：把汇报投递给秘书会话，阻塞等待秘书回传决策。 */
  private async reportSecretaryAtomic(roomId: string, summary: string, initiatorSessionId?: string): Promise<OwnerDecisionResult> {
    if (this.owner === undefined || this.owner === '') return { roomId, sent: false, decision: 'no-owner' }
    try {
      const name = await this.channel.getRoomName?.(roomId).catch(() => undefined)
      const secretary = await this.getSecretaryAgent()
      const body = `[汇报] ${name !== undefined ? `群「${name}」` : ''}（roomId: ${roomId}）\n${summary}`
      secretary.followup(createUserMessage({
        content: [{ type: 'text', text: body }],
        source: { kind: 'user' },
      }))
      this.recordTimeline(roomId, 'approval', { target: 'secretary' }, 0, 'secretary', `[汇报] ${this.timelineExcerpt(summary)}`)
      return this.waitOwnerDecision(roomId, body, '', 'report', initiatorSessionId ?? this.userId)
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix-agent] reportSecretary failed: %s', messageOf(error))
      return { roomId, sent: false, decision: 'timeout' }
    }
  }

  /** 秘书 → 主人：把汇报上呈主人（DM + 收件箱），阻塞等待主人「交付/批准」。 */
  private async reportOwnerFromOwnerAtomic(roomId: string, summary: string): Promise<OwnerDecisionResult> {
    if (this.owner === undefined || this.owner === '') return { roomId, sent: false, decision: 'no-owner' }
    const ctx = await this.ownerDmContext(roomId)
    try {
      const dm = await this.channel.sendDm?.(this.owner, `【进度汇报】\n${ctx}\n\n${summary}`)
      if (dm === undefined) return { roomId, sent: false, decision: 'timeout' }
      this.ownerDmToWorkRoom.set(dm.roomId, roomId)
      // 新一轮汇报 = 需重新授权：清除旧的交付授权，防 agent 用上一轮的「交付」授权重复发群。
      this.deliveryAuthorized.delete(roomId)
      this.recordTimeline(dm.roomId, 'approval', { target: this.owner }, 0, 'secretary', `[汇报主人] ${this.timelineExcerpt(summary)}`)
      // 写入主人收件箱（DSH 侧待批列表）。
      this.pushInbox(roomId, 'report', summary)
      // 注意：此处处于秘书 agent 的 turn/step 内，绝不能往秘书会话 session.append
      // （会破坏 tool/call↔tool/result 平衡导致 INVALID_REQUEST）。上呈动作已由
      // matrix_report_owner 的 tool/call + tool/result 事件天然记录。
      // 阻塞等待主人答复（首次等待 taskConfirmTimeoutSecs；超时转挂起待答，非判死）。
      const result = await this.waitOwnerDecision(roomId, `【进度汇报】\n${ctx}\n\n${summary}`, dm.roomId, 'report', this.secretarySessionId())
      // 转挂起（pending）时保留收件箱条目：主人还没答，GUI 待批列表应继续显示。
      if (result.decision !== 'pending') this.popInbox(roomId)
      return result
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix-agent] reportOwner DM failed: %s', messageOf(error))
      return { roomId, sent: false, decision: 'timeout' }
    }
  }

  /**
   * 秘书 → worker：把决策回传给某个正在阻塞等待的 worker（数字分身）。
   * 找到该 roomId 的 pending（initiator=worker session），resolve 它，让 worker
   * 在同一 turn 内拿到决策继续（approved→发群交付 / rejected→停止）。
   * 注意：本方法在秘书 agent 的工具执行器内被同步调用，此时秘书会话正处于
   * turn/step 中间；绝不能在此往秘书会话 session.append（会破坏 tool/call↔tool/result
   * 平衡，导致 INVALID_REQUEST）。决策的可视化由 tool/call + tool/result 事件天然承载。
   */
  private async replyWorkerAtomic(roomId: string, decision: 'approved' | 'rejected', reply?: string, callerSessionId?: string): Promise<{ roomId: string; ok: boolean }> {
    // 授权红线：matrix_reply_worker 是秘书→worker 的决策回传工具，只有秘书会话能调。
    // worker（执行岗）调用即视为「自我批准绕过主人授权」，一律拒绝并记录。
    // 无法确认调用者身份（callerSessionId 缺失）时同样拒绝——宁可少放行，不可放行未授权。
    if (callerSessionId === undefined || callerSessionId !== this.secretarySessionId()) {
      this.ctx.logger.warn('[dsh-matrix-agent] replyWorker DENIED: caller=%s is not secretary (secretary=%s); self-approval blocked room=%s', callerSessionId ?? '(none)', this.secretarySessionId(), roomId)
      this.diag.log(`[dsh-matrix-agent] replyWorker DENIED room=${roomId} caller=${callerSessionId ?? '(none)'} != secretary=${this.secretarySessionId()}`)
      return { roomId, ok: false }
    }
    // 越权守卫（真实测试暴露：manual 主人未批时，秘书在群内施压下对 worker 自主 approved，
    // 绕过已上呈主人的未决请示，导致「未经主人批准发群」）。规则：
    // 秘书若已把该房间的请示/汇报上呈主人（ownerPending 中秘书等主人，或已转
    // pendingReasks waitFor=owner 挂起待答），主人尚未裁决 → 秘书不得再自主 approved
    // 放行 worker（那等于替主人越权决定）；只允许 rejected（或返回 ok:false 让秘书
    // 继续等主人）。无上呈记录（秘书职权内直接决策）不受影响。
    if (decision === 'approved') {
      const ownerPendingUnresolved = this.getOwnerPendingFor(roomId, this.secretarySessionId()) !== undefined
      const ownerReaskPending = this.getPendingReask(roomId, 'owner') !== undefined
      if (ownerPendingUnresolved || ownerReaskPending) {
        this.ctx.logger.warn('[dsh-matrix-agent] replyWorker DENIED: secretary self-approval while owner decision pending room=%s (ownerPending=%s ownerReask=%s); must wait owner', roomId, ownerPendingUnresolved, ownerReaskPending)
        this.diag.log(`[dsh-matrix-agent] replyWorker DENIED room=${roomId} decision=approved blocked: owner decision pending (ownerPending=${ownerPendingUnresolved} ownerReask=${ownerReaskPending}); secretary must wait owner before approving worker`)
        return { roomId, ok: false }
      }
    }
    const pending = this.getWorkerOwnerPending(roomId)
    // 只有「发起者是 worker（非秘书会话）」的 pending 才能被回传 resolve；
    // 秘书会话的 pending 由主人回复 resolve，不能串号。
    if (pending !== undefined) {
      const result: OwnerDecisionResult = {
        roomId,
        sent: true,
        decision,
        ...(reply !== undefined ? { reply } : {}),
      }
      pending.resolve(result)
      // 秘书直接批准 = 秘书替主人做了交付决策：置位交付授权，让 worker 拿到
      // approved 后能直接 matrix_send_room_message 发群，而不是被「还没到发群的时候」
      // 门控拦截再回头上呈主人（那会造成不必要的超时）。
      // 拒绝则撤销授权，防止 worker 复用旧授权发群。
      if (decision === 'approved') this.deliveryAuthorized.add(roomId)
      else this.deliveryAuthorized.delete(roomId)
      this.ctx.logger.info('[dsh-matrix-agent] secretary replied to worker room=%s decision=%s', roomId, decision)
      this.recordTimeline(roomId, 'approval', { target: 'worker' }, 0, 'secretary', decision === 'approved' ? `✅ 秘书批准交付` : `🚫 秘书拒绝交付`)
      return { roomId, ok: true }
    }
    // 无 active pending：可能是 worker 首次等待已超时转「挂起待答」——晚答复不丢弃，
    // 命中挂起记录并 followup 唤醒 worker 继续（实现「领导晚答复也能送达」）。
    // 秘书 replyWorker 答 worker → 查 waitFor=secretary 的挂起。
    const reask = this.getPendingReask(roomId, 'secretary')
    this.diag.log(`replyWorkerAtomic room=${roomId} decision=${decision} reask=${reask !== undefined ? `init=${reask.initiatorSessionId}` : 'none'}`)
    if (reask !== undefined && reask.initiatorSessionId !== this.secretarySessionId()) {
      this.removePendingReask(roomId, 'secretary')
      if (decision === 'approved') this.deliveryAuthorized.add(roomId)
      else this.deliveryAuthorized.delete(roomId)
      const wake = this.wakePendingWaiter(roomId, reask.initiatorSessionId, 'decision', decision, reply)
      this.ctx.logger.info('[dsh-matrix-agent] secretary late-reply woke worker room=%s decision=%s ok=%s', roomId, decision, wake)
      this.recordTimeline(roomId, 'approval', { target: 'worker' }, 0, 'secretary', decision === 'approved' ? `✅ 秘书批准交付（补答）` : `🚫 秘书拒绝交付（补答）`)
      return { roomId, ok: wake }
    }
    // 无 pending 也无挂起记录（worker 未在等/已清理），或 initiator 是秘书：不 resolve，仅记录。
    this.ctx.logger.info('[dsh-matrix-agent] replyWorker room=%s no worker pending (or secretary-owned); ignored', roomId)
    return { roomId, ok: false }
  }

  /**
   * 唤醒一个已转「挂起待答」的等待方会话（worker 或秘书）：
  /**
   * 前台接待层 ETA 播报：把「已耗时秒数」格式化成人类可读的中文进度表达。
   * <15s 刚开工；<1h 报分钟；>=1h 报小时+分。
   */
  private formatEta(sec: number): string {
    if (sec < 15) return '刚开工，马上就好'
    if (sec < 3600) return `已经做了约 ${Math.max(1, Math.round(sec / 60))} 分钟`
    const h = Math.floor(sec / 3600)
    const m = Math.round((sec % 3600) / 60)
    return `已经做了约 ${h} 小时${m > 0 ? `${m} 分` : ''}`
  }

  /**
   * 前台接待层话术模板渲染：取 config 模板（留空=不发送），替换占位符。
   * 占位符：{{lp}} 发送者 localpart / {{taskHint}} 任务摘要 / {{taskDesc}} 「正在做…」段 /
   * {{eta}} ETA 段（已含逗号前缀）/ {{summary}} 任务摘要（含「」）。返回 '' = 不发送。
   * 默认文案在 config.ts Schema（receptionAckNewTask 等 .default()）集中维护，此处不重复。
   */
  private receptionText(templateKey: string, vars: Record<string, string>): string {
    const key = templateKey as keyof typeof this.config
    const template = (this.config[key] as string | undefined) ?? ''
    if (template === '') return ''
    let out = template
    for (const [name, value] of Object.entries(vars)) {
      out = out.replaceAll('{{' + name + '}}', value)
    }
    return out
  }

  /**
   * 唤醒一个已转「挂起待答」的等待方会话（worker 或秘书）：
   * 往它的会话 followup 一条消息，触发新 turn 让它继续/停止。
   * @param mode 'decision'：领导已答复（approved/rejected），按决策继续或停止；
   *             'remind'：领导在场提醒（reply 为完整提醒文案），由等待方决定是否再请示。
   * 返回是否成功投递（目标会话存在且 followup 未抛错）。
   */
  private wakePendingWaiter(roomId: string, initiatorSessionId: string, mode: 'decision' | 'remind', decision?: 'approved' | 'rejected', reply?: string): boolean {
    try {
      const agent = this.ctx.agents.get(SessionId(initiatorSessionId))
      this.diag.log(`wakePendingWaiter room=${roomId} session=${initiatorSessionId} mode=${mode} agent=${agent !== undefined ? 'found' : 'MISSING'}`)
      if (agent === undefined) return false
      let text: string
      if (mode === 'remind') {
        text = reply !== undefined && reply !== '' ? reply : `【领导已在场】你之前对房间 ${roomId} 的请示还没有答复，可再次请示。`
      } else {
        const verdict = decision === 'approved' ? '批准/同意' : '拒绝'
        const note = reply !== undefined && reply !== '' ? `（${reply.slice(0, 200)}）` : ''
        text = [
          `【领导已答复】你之前对房间 ${roomId} 的请示/汇报，现在有了结果：${verdict}${note}。`,
          decision === 'approved'
            ? '请据此继续你之前的工作：执行/交付，完成后在群里交付。'
            : '请停止该工作，不要在群里交付。',
        ].join('\n')
      }
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      return true
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix-agent] wakePendingWaiter room=%s session=%s failed: %s', roomId, initiatorSessionId, messageOf(error))
      return false
    }
  }

  /** 把一条待批请示/汇报写入主人收件箱（内存 + settings 镜像）。 */
  private pushInbox(roomId: string, kind: 'clarify' | 'report' | 'invite', text: string, roomLabel?: string): void {
    const item: OwnerInboxItem = {
      id: roomId,
      roomId,
      roomName: roomLabel ?? this.roomNameCache.get(roomId) ?? roomId,
      kind,
      text,
      createdAt: Date.now(),
    }
    this.inboxItems.set(roomId, item)
    this.publishInbox()
  }

  /** 从主人收件箱移除某条（已决策/超时）。 */
  private popInbox(roomId: string): void {
    if (this.inboxItems.delete(roomId)) this.publishInbox()
  }

  /** 把当前收件箱镜像发布到 settings（防抖由 settings 层处理）。 */
  private publishInbox(): void {
    this.publishOwnerInbox?.({
      items: [...this.inboxItems.values()],
      updatedAt: Date.now(),
    })
  }

  /**
   * 聚合任务看板（per-room 当前活跃状态）并发布到 settings（防抖由 settings 层处理）。
   * 只含活跃态房间（busy/awaiting-delivery/clarifying），空闲房间不进看板。
   * 调用点：roomBusy / roomPendingReply / roomPendingClarify 每次变更后 + start() 初始。
   */
  private publishTaskBoardSnapshot(): void {
    if (this.publishTaskBoard === undefined) return
    const now = Date.now()
    const rows: TaskBoardRow[] = []
    const seen = new Set<string>()
    // 1) 请示中（roomPendingClarify）。
    for (const roomId of this.roomPendingClarify) {
      const busy = this.roomBusy.get(roomId)
      const pending = this.roomPendingReply.get(roomId)
      seen.add(roomId)
      rows.push({
        roomId,
        sessionId: this.sessionIdForRoom(roomId),
        roomName: this.roomNameCache.get(roomId) ?? roomId,
        state: 'clarifying',
        label: pending?.label ?? busy?.label ?? '请示中',
        since: pending?.at ?? busy?.since ?? now,
        remindCount: pending?.remindCount,
      })
    }
    // 2) 待交付（roomPendingReply）。
    for (const [roomId, pending] of this.roomPendingReply) {
      if (seen.has(roomId)) continue
      seen.add(roomId)
      rows.push({
        roomId,
        sessionId: this.sessionIdForRoom(roomId),
        roomName: this.roomNameCache.get(roomId) ?? roomId,
        state: 'awaiting-delivery',
        label: pending.label,
        since: pending.at,
        remindCount: pending.remindCount,
        lastOutboundAt: this.roomLastOutboundAt.get(roomId),
      })
    }
    // 3) 忙（roomBusy）。
    for (const [roomId, busy] of this.roomBusy) {
      if (seen.has(roomId)) continue
      rows.push({
        roomId,
        sessionId: this.sessionIdForRoom(roomId),
        roomName: this.roomNameCache.get(roomId) ?? roomId,
        state: 'busy',
        label: busy.label,
        since: busy.since,
      })
    }
    rows.sort((a, b) => a.since - b.since)
    this.publishTaskBoard({ rows, updatedAt: now })
    this.diag.log(`[dsh-matrix-agent] taskBoard publish rows=${rows.length} busy=${this.roomBusy.size} pending=${this.roomPendingReply.size} clarify=${this.roomPendingClarify.size}`)
  }

  /** roomId → 对应 agent 会话 id（供看板行跳转会话；无绑定返回 undefined）。 */
  private sessionIdForRoom(roomId: string): string | undefined {
    const handle = this.roomAgents.get(roomId)
    return handle?.agent?.id
  }

  /**
   * 阻塞等待对某房间请示/汇报的答复。
   * 发完消息后注册一个 pending，等答复方（秘书回传 or 主人回复）resolve。
   * 首次等待超时后**不判死**：pending 转「挂起待答」（pendingReasks），返回 decision='pending'，
   * 让发起方本轮正常结束；答复方晚到时会命中挂起记录并 followup 唤醒发起方继续。
   * initiatorSessionId 标记「谁在等」：worker 会话等秘书回传；秘书会话等主人回复。
   */
  private async waitOwnerDecision(roomId: string, text: string, dmRoomId: string, kind: 'clarify' | 'report', initiatorSessionId: string): Promise<OwnerDecisionResult> {
    // 谁在等决定首次等待时长：秘书会话等主人 → taskClarifyTimeoutSecs/taskConfirmTimeoutSecs；
    // worker 会话等秘书回传 → secretaryDecisionTimeoutSecs（覆盖秘书思考 + 可能的上呈）。
    // 超时后转挂起待答（不删除），resolve 'pending' 让发起方本轮结束。
    const isSecretaryWaiting = initiatorSessionId === this.secretarySessionId()
    // 测试房间缩短 worker 等秘书的窗口：秘书 LLM 偶发丢 replyWorker（收到汇报"决定回传
    // 却忘调工具"），等满 secretaryDecisionTimeoutSecs 会让 worker 干等 180s 后被 followup
    // 催逼自行收尾。测试护栏下给秘书 20s 处理，超时即走下方 auto-approve 兜底。
    const testRoomShortWait = !isSecretaryWaiting && await this.isTestRoom(roomId).catch(() => false)
    const timeoutMs = isSecretaryWaiting
      ? (kind === 'clarify' ? this.config.taskClarifyTimeoutSecs : this.config.taskConfirmTimeoutSecs) * 1000
      : (testRoomShortWait ? 20 : this.config.secretaryDecisionTimeoutSecs) * 1000
    return new Promise<OwnerDecisionResult>((resolve) => {
      // 同 roomId 可能有多级等待（worker 等秘书 + 秘书等主人），用数组承载。
      // 超时/resolve 只移除「本实例」，绝不用 roomId 全局删除（会误删同 room 的另一级）。
      const entry = {
        resolve: (r: OwnerDecisionResult) => {
          clearTimeout(timer)
          this.removeOwnerPending(roomId, entry)
          this.removePendingReask(roomId, isSecretaryWaiting ? 'owner' : 'secretary')
          resolve(r)
        },
        dmRoomId,
        kind,
        initiatorSessionId,
      }
      const timer = setTimeout(() => {
        this.removeOwnerPending(roomId, entry)
        // 测试房间自动放行兜底：worker 汇报交付后，若秘书在等待窗口内未回传决策
        // （秘书 LLM 丢动作/空转，如 15:56 决定回传却忘调 replyWorker），测试房间
        // 直接按「已批准交付」放行——汇报本身已含完整结果与质量自述，测试护栏下
        // 安全，避免 worker 被 followup 反复催逼后在无批准下自行收尾。生产房间不
        // 受影响：仍转「挂起待答」等秘书/主人晚答复。
        // kind=clarify（开工请示）不在此兜底——开工前必须真有主人/秘书批准。
        // testRoomShortWait 已在函数体顶部 await 预计算（超时回调非 async，不能 await）。
        if (kind === 'report' && !isSecretaryWaiting && testRoomShortWait) {
          this.deliveryAuthorized.add(roomId)
          this.diag.log(`waitOwnerDecision room=${roomId} kind=report init=${initiatorSessionId} → AUTO-APPROVED (test-room, secretary timeout)`)
          this.ctx.logger.info('[dsh-matrix-agent] waitOwnerDecision %s (%s by %s) → auto-approved (test room, secretary timeout)', roomId, kind, initiatorSessionId)
          resolve({ roomId, sent: true, decision: 'approved', reply: '（测试房间自动放行：秘书未在时限内回传，视为批准交付）' })
          return
        }
        // 转挂起待答：记录保留，等答复方晚到后唤醒。
        // key 含 waitFor，worker（等秘书）与秘书（等主人）的挂起互不覆盖。
        const waitFor = isSecretaryWaiting ? 'owner' as const : 'secretary' as const
        this.setPendingReask(roomId, waitFor, {
          text,
          roomLabel: text,
          kind,
          initiatorSessionId,
          waitFor,
          at: Date.now(),
        })
        this.diag.log(`waitOwnerDecision room=${roomId} kind=${kind} init=${initiatorSessionId} waitFor=${waitFor} → PENDING (kept for late reply)`)
        this.ctx.logger.info('[dsh-matrix-agent] waitOwnerDecision %s (%s by %s) → pending (kept for late reply)', roomId, kind, initiatorSessionId)
        resolve({ roomId, sent: true, decision: 'pending' })
      }, timeoutMs)
      const list = this.ownerPending.get(roomId)
      if (list === undefined) this.ownerPending.set(roomId, [entry])
      else list.push(entry)
    })
  }

  /** 从 ownerPending 移除一个具体等待实例（按引用），列表空则删 key。 */
  private removeOwnerPending(roomId: string, entry: { resolve: (r: OwnerDecisionResult) => void; dmRoomId: string; kind: 'clarify' | 'report'; initiatorSessionId: string }): void {
    const list = this.ownerPending.get(roomId)
    if (list === undefined) return
    const idx = list.indexOf(entry)
    if (idx >= 0) list.splice(idx, 1)
    if (list.length === 0) this.ownerPending.delete(roomId)
  }

  /** 取该 roomId 下「等待方是指定会话」的 active pending（无则 undefined）。 */
  private getOwnerPendingFor(roomId: string, initiatorSessionId: string): { resolve: (r: OwnerDecisionResult) => void; dmRoomId: string; kind: 'clarify' | 'report'; initiatorSessionId: string } | undefined {
    const list = this.ownerPending.get(roomId)
    if (list === undefined) return undefined
    return list.find((p) => p.initiatorSessionId === initiatorSessionId)
  }

  /** 取该 roomId 下「任一非秘书等待方（worker）」的 active pending（无则 undefined）。 */
  private getWorkerOwnerPending(roomId: string): { resolve: (r: OwnerDecisionResult) => void; dmRoomId: string; kind: 'clarify' | 'report'; initiatorSessionId: string } | undefined {
    const list = this.ownerPending.get(roomId)
    if (list === undefined) return undefined
    return list.find((p) => p.initiatorSessionId !== this.secretarySessionId())
  }

  /** 解析工作目录：房间绑定 cwd > workspaceRegistry 首个工作区。list/read 工具用。 */
  private async resolveWorkspaceCwd(roomId: string): Promise<string | undefined> {
    const bound = this.state.roomCwd(roomId)
    if (bound !== undefined && bound !== '' && existsSync(bound)) return bound
    const registryCwd = await this.registryFirstCwd()
    if (registryCwd !== undefined && registryCwd !== '' && existsSync(registryCwd)) return registryCwd
    return bound
  }

  /** 原子工具：列出当前会话工作目录下的文件。 */
  private async listWorkspaceFilesAtomic(roomId: string): Promise<Array<{ name: string; kind: 'file' | 'dir' }>> {
    const cwd = await this.resolveWorkspaceCwd(roomId)
    if (cwd === undefined || cwd === '' || !existsSync(cwd)) {
      throw new Error(`工作目录未设定或不存在（${cwd ?? '(未设定)'}），先用 matrix_set_room_cwd 设定`)
    }
    try {
      const entries = await readdir(cwd, { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, kind: e.isDirectory() ? 'dir' as const : 'file' as const }))
    } catch (error) {
      throw new Error(`读取工作目录失败：${messageOf(error)}`)
    }
  }

  /** 原子工具：读取工作目录下某文件的文本内容。 */
  private async readWorkspaceFileAtomic(roomId: string, filename: string): Promise<{ filename: string; content: string }> {
    const cwd = await this.resolveWorkspaceCwd(roomId)
    if (cwd === undefined || cwd === '' || !existsSync(cwd)) {
      throw new Error(`工作目录未设定或不存在（${cwd ?? '(未设定)'}），先用 matrix_set_room_cwd 设定`)
    }
    // 安全：拒绝路径穿越（只允许工作目录内的相对文件名）。
    const target = join(cwd, filename)
    if (!target.startsWith(cwd)) throw new Error(`非法文件名：${filename}`)
    try {
      const content = await readFile(target, 'utf8')
      return { filename, content }
    } catch (error) {
      throw new Error(`读取文件失败：${messageOf(error)}`)
    }
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

  /**
   * 取（或建）本分身的秘书会话：一个确定性 id 的持久 agent 会话，用于沉淀
   * 请示/汇报/决策记录，供主人在 DSH GUI 查看历史。不写入 state.roomSessions，
   * 因此其出站事件（assistant/message 等）经 roomForSession 反查不到房间而自动屏蔽。
   */
  private getSecretaryAgent(): Promise<Agent> {
    if (this.secretaryAgent !== undefined) return Promise.resolve(this.secretaryAgent)
    if (this.secretaryInflight !== undefined) return this.secretaryInflight
    const sessionId = SessionId(this.secretarySessionId())
    this.secretaryInflight = (async () => {
      const cwd = (this.config.cwdCandidates ?? [])[0] ?? process.cwd()
      // 秘书固定挂 secretary 岗位 preset（persona + 协调白名单工具全部由该 preset 提供）。
      // 建连 meta 携带 agentPreset，使会话 header 记录秘书 preset；任何恢复路径（含内核
      // 自动恢复）都能按 header 组出秘书 preset。挂载失败（preset 缺失/不可用）会抛错，
      // 让秘书会话在缺 preset 时明确报错而不是裸奔成普通 worker。
      const handle = await this.acquireAgent(sessionId, { cwd, agentPreset: SECRETARY_PRESET })
      this.secretaryAgent = handle.agent
      // 挂到 cwd 对应的 workspace（GUI 分组：秘书会话不落「未分组」）。
      void this.attachSessionToWorkspace(sessionId, cwd)
      // 思考级别注入（秘书档）——live agent ctx 上装 waterfall，独立于 agentSetup。
      this.ensureEffortHook(handle.agent.id, (handle.agent as unknown as { ctx?: { on(event: string, listener: unknown): unknown } }).ctx, 'secretary')
      // 标题固定为「秘书（分身 localpart）」。
      try {
        const title = this.ctx.get('sessionTitle') as { rename(s: Session, t: string): unknown } | undefined
        title?.rename(handle.agent.session, `秘书 · @${localpartOf(this.userId)}`)
      } catch { /* 标题失败忽略 */ }
      return handle.agent
    })().finally(() => {
      this.secretaryInflight = undefined
    })
    return this.secretaryInflight
  }

  /** 秘书会话的确定性 id 字符串（与 getSecretaryAgent 建连用的 id 一致）。
   *  -v2 后缀：秘书从「记录本」升级为「协调者」，旧会话（挂 pm 岗位 preset）作废，
   *  新 id 走 create 全新创建（当时不挂岗位 preset，只挂协调者 persona）。
   *  -v3 后缀：秘书行为（persona + 协调白名单）整体下沉到 secretary 岗位 preset，
   *  v2 会话的 header 未记录 preset（裸会话），作废换新 id，使 header 从创建起就带
   *  agentPreset:'secretary'，任何恢复路径都能按 header 组出秘书 preset。 */
  private secretarySessionId(): string {
    return `matrix-${localpartOf(this.userId)}-secretary-v3`
  }

  /** 前台接待会话的确定性 id。 */
  private receptionSessionId(): string {
    return `matrix-${localpartOf(this.userId)}-reception-v1`
  }

  /**
   * 取（或建）前台接待会话：确定性 id 的 agent，preset=reception（零工具），
   * 独立 provider/model（receptionProvider/receptionModel，空则沿用 worker 档），
   * reasoningEffort 恒 off（receptionReasoningEffort，默认 off）。
   * 不写 state.roomSessions → 出站对群天然屏蔽。
   */
  private getReceptionAgent(): Promise<Agent> {
    if (this.receptionAgent !== undefined) return Promise.resolve(this.receptionAgent)
    if (this.receptionInflight !== undefined) return this.receptionInflight
    const sessionId = SessionId(this.receptionSessionId())
    this.receptionInflight = (async () => {
      const cwd = (this.config.cwdCandidates ?? [])[0] ?? process.cwd()
      const handle = await this.acquireAgent(sessionId, { cwd, agentPreset: this.config.receptionPreset || RECEPTION_PRESET })
      this.receptionAgent = handle.agent
      void this.attachSessionToWorkspace(sessionId, cwd)
      // 思考级别：接待档（恒 off 或按配置）。
      this.ensureEffortHook(handle.agent.id, (handle.agent as unknown as { ctx?: { on(event: string, listener: unknown): unknown } }).ctx, 'reception')
      try {
        const title = this.ctx.get('sessionTitle') as { rename(s: Session, t: string): unknown } | undefined
        title?.rename(handle.agent.session, `前台接待 · @${localpartOf(this.userId)}`)
      } catch { /* 标题失败忽略 */ }
      return handle.agent
    })().finally(() => {
      this.receptionInflight = undefined
    })
    return this.receptionInflight
  }

  /**
   * AI 接待判定：把入站消息交给接待 agent 做一次快速语义分类（单次推理顺带输出
   * 群工作模式指令信号，见下方 mode 契约——复用同一轮 LLM，不额外烧 token）。
   * @returns {kind?, modeHint?}：kind=分类 id（receptionKinds 表键）；
   *   modeHint=LLM 判定的口播模式指令（仅当消息是「设置本群模式」类指令）；
   *   失败/超时/未启用时返回 undefined（调用方走正则降级）。
   */
  private async classifyIncoming(roomId: string, text: string, sender: string): Promise<{ kind?: string; modeHint?: RoomMode } | undefined> {
    const kinds = this.config.receptionKinds ?? {}
    const busy = this.roomBusy.has(roomId)
    const task = busy ? this.roomBusy.get(roomId) : undefined
    // 构造分类提示：当前消息 + 忙状态 + 分类标签表。
    const kindLines = Object.entries(kinds)
      .map(([id, k]) => `- ${id}：${k.describe}`)
      .join('\n')
    const busyNote = busy
      ? `（该房间 worker 当前忙：${task !== undefined ? `正在做「${task.label}」` : '处理任务中'}）`
      : '（该房间 worker 当前空闲）'
    // 模式指令契约：只有当消息整体是「设置/钉死本群工作模式」的指令时才给 mode；
    // 闲聊/疑问/泛词（如"别拆太细""这是客服群吧"）一律 mode:"no"（拿不准不落配置）。
    const prompt = [
      '【前台接待分类任务】请判断下面这条群消息应该归为哪一类，只输出 JSON：' +
      '{"kind":"<分类id>","mode":"no|parallel|cohesive|unsure","reason":"<一句话≤30字>"}',
      '',
      `发送者：${sender}`,
      `忙状态：${busyNote}`,
      '',
      '【待分类消息】',
      text.slice(0, 800),
      '',
      '【可用分类（只能选其中 id）】',
      kindLines,
      '',
      '判定要点：验收/确认/致谢/收尾 → closing-ack（绝不当新任务）；命令式、指向未来产出 → new-task；',
      '对进行中任务的追问 → busy-question；忙时普通同步 → busy-plain；闲聊/答疑 → chat。',
      '',
      '【模式指令附加判定（mode 字段）】只有当消息是明确要求设置本群工作模式的指令时才算，例如：',
      '"这是客服群，用并行模式/开并行/群里的问题各自独立处理" → mode:"parallel"；',
      '"这是项目群/协同群，别拆任务，串行推进" → mode:"cohesive"。',
      '以下一律 mode:"no"（不算模式指令，只是普通消息）：疑问句（"能开并行吗？"）、建议未定（"要不要开并行"）、',
      '泛词闲聊（"这个问题别拆太细""这活真多"）、任何未明确说要把本群设成某模式的话。',
      '真拿不准 → mode:"unsure"（宁可不落配置）。',
    ].join('\n')
    try {
      const agent = await this.getReceptionAgent()
      // 注册一次性结果监听（handleSessionEvent 的 reception 分支 resolve）。
      // 接待判定串行：同一时刻至多一个等待者（每次 followup 一轮），用 FIFO。
      const timeoutMs = Math.max(500, (this.config.receptionTimeoutSecs ?? 3) * 1000)
      const result = await new Promise<string | undefined>((resolve) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const settle = (text: string | undefined): void => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          // 从队列移除自己（若还在队首/队中）。
          const idx = this.receptionPending.findIndex((w) => w.settle === settle)
          if (idx >= 0) this.receptionPending.splice(idx, 1)
          resolve(text)
        }
        timer = setTimeout(() => settle(undefined), timeoutMs)
        this.receptionPending.push({ settle })
        try {
          agent.followup(createUserMessage({
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'user' },
          }))
        } catch (error) {
          settle(undefined)
        }
      })
      // undefined = followup 失败或超时 → 调用方走正则降级。
      if (result === undefined) return undefined
      // 解析 JSON（容忍围栏/前后缀）。
      const cleaned = result.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
      const parsed = JSON.parse(cleaned) as { kind?: unknown; mode?: unknown }
      const out: { kind?: string; modeHint?: RoomMode } = {}
      const kind = typeof parsed.kind === 'string' ? parsed.kind : ''
      if (kind !== '' && kinds[kind] !== undefined) out.kind = kind
      // mode 字段：只收窄为合法模式（no/unsure/其它 → 不带，等同无指令）。
      if (isRoomMode(parsed.mode)) out.modeHint = parsed.mode
      if (out.kind === undefined && out.modeHint === undefined) return undefined
      return out
    } catch {
      return undefined
    }
  }

  /**
   * 判定的外层入口：开关门控 + 节流 + 查表。
   * @returns receptionKinds 表的 kind 条目（含 kind id）+ 可选的 modeHint；未启用/失败/节流内 → undefined。
   */
  private async classifyMessageIfEnabled(
    message: InboundMessage,
    stripped: string,
    mentionedSelf: boolean,
  ): Promise<((ReceptionKindDef & { kind: string }) & { modeHint?: RoomMode }) | undefined> {
    const cfg = this.config
    if (cfg.receptionEnabled !== true) return undefined
    const kinds = cfg.receptionKinds ?? {}
    if (Object.keys(kinds).length === 0) return undefined
    // 只对 @ 到本账号的消息做判定（未 @ 的群消息不判定——除非 respondToAll 且是群聊）。
    if (!mentionedSelf && !this.respondToAll) return undefined
    // 过短消息（问候/表情/单字）不判（receptionMinLength 阈值）。
    if (stripped.length < (cfg.receptionMinLength ?? 0)) return undefined
    // 房间级节流：间隔内直接复用上次 kind（避免每条消息都烧一次 LLM）。
    const throttle = (cfg.receptionThrottleSecs ?? 0) * 1000
    if (throttle > 0) {
      const last = this.receptionLastAt.get(message.roomId)
      const lastKind = this.receptionLastKind.get(message.roomId)
      if (last !== undefined && lastKind !== undefined && Date.now() - last < throttle) {
        const reuse = kinds[lastKind]
        if (reuse !== undefined) return { ...reuse, kind: lastKind }
      }
    }
    const result = await this.classifyIncoming(message.roomId, stripped, message.sender ?? '')
    if (result === undefined) return undefined
    if (result.kind === undefined) return undefined
    const entry = kinds[result.kind]
    if (entry === undefined) return undefined  // AI 输出了表外 id → 视为失败（走正则降级）
    this.receptionLastAt.set(message.roomId, Date.now())
    this.receptionLastKind.set(message.roomId, result.kind)
    this.diag.log(`[dsh-matrix-agent] reception classify room=${message.roomId} kind=${result.kind} modeHint=${result.modeHint ?? 'no'} from=${message.sender ?? ''}`)
    const out: (ReceptionKindDef & { kind: string }) & { modeHint?: RoomMode } = { ...entry, kind: result.kind }
    if (result.modeHint !== undefined) out.modeHint = result.modeHint
    return out
  }

  /** 渲染接待 ack 话术：kindEntry.ackText 优先，空则回退旧散键模板。 */
  private renderReceptionAck(kind: string, ackText: string, vars: { lp: string; taskHint: string; taskDesc: string; eta: string }): string {
    let template = ackText
    if (template === '') {
      template = this.receptionText(this.legacyAckKeyForKind(kind), vars)
    }
    if (template === '') return ''
    return template
      .replaceAll('{{lp}}', vars.lp)
      .replaceAll('{{taskHint}}', vars.taskHint !== '' ? `「${vars.taskHint}」` : '')
      .replaceAll('{{taskDesc}}', vars.taskDesc)
      .replaceAll('{{eta}}', vars.eta !== '' ? `，${vars.eta}` : '')
  }

  /** kind → 旧散键话术键（receptionAckNewTask/BusyQuestion/Busy 兼容迁移）。 */
  private legacyAckKeyForKind(kind: string): string {
    switch (kind) {
      case 'new-task': return 'receptionAckNewTask'
      case 'busy-question': return 'receptionAckBusyQuestion'
      case 'busy-plain': return 'receptionAckBusy'
      default: return ''
    }
  }

  /**
   * 正则兜底接待规则（receptionEnabled=false 或 AI 判定失败时）。
   * @returns 是否判定为「新任务」（taskLike，供 deliver 置忙/请示门用）。
   */
  private applyLegacyReceptionRules(message: InboundMessage, stripped: string, text: string): boolean {
    const isQuestion = /[?？]|吗|怎么|哪个|什么|啥|谁|何时|为什么|是否|多少|是不是/.test(text)
    const mentionedSelf = this.isMentioningSelf(message)
    // 收尾/确认/致谢消息（如「收到，清单没问题，辛苦了」）：不是新任务，不触发 new-task ack。
    const isClosingAck = /^(收到|好的|好|嗯|ok|👌|了解|清楚了|没问题|可以|行)/i.test(stripped) &&
      /(没问题|辛苦了|谢谢|收到|清楚了|没别的|就这样|可以了|对了|对得上|行，|先这样|不打扰|再见|拜拜|ok|👌)/i.test(stripped)
    const isNewTask = mentionedSelf && !isQuestion && !isClosingAck && stripped.length > 8 && !this.roomBusy.has(message.roomId)
    if (
      isNewTask &&
      message.sender !== undefined && message.sender !== '' && message.sender !== this.userId &&
      !(this.owner !== undefined && message.sender === this.owner)
    ) {
      const lp = localpartOf(message.sender)
      const taskHint = stripped.replace(/@\S+/g, '').replace(/[\u3000\u3001\uFF0C\u3002\uFF01\uFF1F]/g, ' ').trim().slice(0, 24)
      const ack = this.receptionText('receptionAckNewTask', { lp, taskHint: taskHint !== '' ? `「${taskHint}」` : '' })
      if (ack !== '') {
        void this.safeSend(message.roomId, ack, undefined)
        this.diag.log('[dsh-matrix-agent] reception ack (new-task) room=' + message.roomId + ' from=' + lp + ' text=' + text.slice(0, 40))
      }
    }
    if (
      this.roomBusy.has(message.roomId) &&
      message.sender !== undefined && message.sender !== '' && message.sender !== this.userId &&
      !(this.owner !== undefined && message.sender === this.owner)
    ) {
      const lp = localpartOf(message.sender)
      const isQuestion2 = /[?？]|吗|怎么|哪个|什么|啥|谁|何时|为什么|是否|多少/.test(text)
      const task = this.roomBusy.get(message.roomId)
      const taskDesc = task !== undefined && task.label !== '' && task.label !== '处理任务中' ? `（正在做「${task.label}」）` : ''
      const eta = task !== undefined ? this.formatEta((Date.now() - task.since) / 1000) : ''
      const ack = this.receptionText(isQuestion2 ? 'receptionAckBusyQuestion' : 'receptionAckBusy', {
        lp, taskDesc, eta: eta !== '' ? `，${eta}` : '',
      })
      if (ack !== '') {
        void this.safeSend(message.roomId, ack, undefined)
        this.diag.log('[dsh-matrix-agent] reception ack (busy) room=' + message.roomId + ' from=' + lp + ' question=' + isQuestion2 + ' eta=' + eta)
      }
    }
    return isNewTask
  }

  /** 取 workspaceRegistry 里主人注册的第一个工作区路径（无则 undefined）。 */
  private async registryFirstCwd(): Promise<string | undefined> {
    try {
      const registry = this.ctx.get('workspaceRegistry') as
        | { list?: () => { path: string }[] }
        | undefined
      if (registry?.list !== undefined) {
        for (const ws of registry.list()) {
          if (ws.path !== undefined && ws.path !== '') return ws.path
        }
      }
    } catch {
      /* 内核未提供 workspaceRegistry 时返回 undefined */
    }
    return undefined
  }

  /**
   * 在 live agent 的 ctx 上装 reasoningEffort 注入（agent/request waterfall）。
   * 与 host-apiproxy 的 installModelSelection(agent.ctx) 同机制：直接挂 agent scope，
   * 不依赖 agentSetup（resume/live agent 的 setup 可能不完整，重复 mount 会挂起）。
   * 幂等：同一 agent id 只装一次（agentScopeHookSet）。配置实时读 this.config（热更新生效）。
   * worker/秘书/接待 各自档位由 role 区分：worker→workerReasoningEffort、
   * secretary→secretaryReasoningEffort、reception→receptionReasoningEffort（恒 off）。
   */
  private ensureEffortHook(agentId: string, agentCtx: { on(event: string, listener: unknown): unknown } | undefined, role: 'worker' | 'secretary' | 'reception'): void {
    if (agentCtx === undefined) return
    if (this.effortHookedAgents.has(agentId)) return
    this.effortHookedAgents.add(agentId)
    const applyEffort = (): string => {
      const effort = role === 'secretary'
        ? this.config.secretaryReasoningEffort
        : role === 'reception'
          ? this.config.receptionReasoningEffort
          : this.config.workerReasoningEffort
      return (effort ?? '').trim()
    }
    try {
      const onWaterfall = agentCtx.on.bind(agentCtx) as (
        event: string,
        listener: (payload: unknown, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>,
      ) => () => void
      const disposer = onWaterfall('agent/request', async (_payload: unknown, next: () => Promise<Record<string, unknown>>) => {
        const resolved = await next()
        const effort = applyEffort()
        if (effort === '') return resolved
        const existing = (resolved as { reasoningEffort?: unknown }).reasoningEffort
        this.diag.log(`[dsh-matrix-agent] reasoningEffort request agent=${agentId.slice(-8)} role=${role} existing=${existing ?? '(none)'} effort=${effort}`)
        if (existing !== effort) {
          return { ...resolved, reasoningEffort: effort }
        }
        return resolved
      })
      // agent ctx 生命周期跟随 agent；disposer 在 agent dispose 时由 cordis 清理。
      if (disposer !== undefined && typeof disposer === 'function') {
        const ctxAny = agentCtx as unknown as { effect?(fn: () => unknown, label?: string): unknown }
        ctxAny.effect?.(() => disposer, 'matrix-agent.reasoning-effort')
      }
      this.diag.log(`[dsh-matrix-agent] reasoningEffort hooked agent=${agentId.slice(-8)} role=${role} effort=${applyEffort() || '(none)'}`)
    } catch (error) {
      this.diag.log(`[dsh-matrix-agent] reasoningEffort hook error agent=${agentId}: ${messageOf(error).slice(0, 200)}`)
    }
  }

  /**
   * 把会话挂到与其 cwd 匹配的 workspace（dsh GUI 分组），使 bridge 创建的
   * worker/秘书会话不落「未分组」。
   * bridge 直接 ctx.agents.create/resume 建会话时不传 workspaceId，内核不会
   * 自动 attach（api-proxy 只在显式 workspaceId 时 attach），导致会话永远在
   * Ungrouped。这里补上：按会话 header 的 cwd 找同名 workspace，没有则自动
   * create（registry.create 对已存在目录幂等），再 attachSession（cwd 校验
   * 由 workspace 实体完成——cwd 与 workspace path 不匹配会抛错，忽略即可）。
   * @param sessionId 会话 id
   * @param cwd 会话工作目录（header 记录值；与 workspace path 需一致）
   */
  private async attachSessionToWorkspace(sessionId: SessionId, cwd: string | undefined): Promise<void> {
    if (cwd === undefined || cwd === '') return
    try {
      const registry = this.ctx.get('workspaceRegistry') as
        | {
            create?: (path: string, title?: string) => Promise<{ path: string; sessionIds: readonly string[]; attachSession(s: string): Promise<void> }>
            resolveByPath?: (path: string) => Promise<{ path: string; attachSession(s: string): Promise<void> } | undefined>
            list?: () => { path: string; attachSession(s: string): Promise<void> }[]
          }
        | undefined
      if (registry === undefined) return
      let workspace: { attachSession(s: string): Promise<void> } | undefined
      // 先按规范路径找现成 workspace；找不到就 create（幂等，同路径复用）。
      if (registry.resolveByPath !== undefined) {
        workspace = await registry.resolveByPath(cwd).catch(() => undefined)
      } else if (registry.list !== undefined) {
        const norm = cwd.replace(/[\\/]+$/, '').toLowerCase()
        workspace = registry.list().find((ws) => ws.path.replace(/[\\/]+$/, '').toLowerCase() === norm)
      }
      if (workspace === undefined && registry.create !== undefined) {
        workspace = await registry.create(cwd).catch(() => undefined)
      }
      if (workspace === undefined) return
      await workspace.attachSession(sessionId as unknown as string).catch((error: unknown) => {
        // cwd 与 workspace path 不匹配等校验错误：不致命，仅记录。
        this.diag.log(`attachSessionToWorkspace skip session=${sessionId} cwd=${cwd} err=${messageOf(error).slice(0, 120)}`)
      })
      this.diag.log(`attachSessionToWorkspace session=${sessionId} cwd=${cwd} ok`)
    } catch (error) {
      // workspaceRegistry 缺失或异常：静默失败（分组只是 GUI 展示，不影响功能）。
      this.diag.log(`attachSessionToWorkspace error session=${sessionId}: ${messageOf(error).slice(0, 120)}`)
    }
  }

  private async createRoomAgent(roomId: string): Promise<Agent> {
    // 工作目录优先级：房间已绑定 cwd > workspaceRegistry 首个工作区 > 配置候选 > process.cwd()。
    // workspaceRegistry 是主人注册的工作区（含 ai-test-data 等），是 agent 的合理默认落点。
    const registryCwd = await this.registryFirstCwd()
    const cwd = this.state.roomCwd(roomId) ?? registryCwd ?? (this.config.cwdCandidates ?? [])[0] ?? process.cwd()

    let handle: AgentHandle | undefined
    const bindingId = this.state.roomSession(roomId)
    if (bindingId !== undefined) {
      try {
        // resume 沿会话 header 已记录的岗位 preset 组出（不按 roomPresetFor 改岗：
        // 已产出内容的会话切换岗位需走 recompose/新建会话，见 createRoomAgent 上方的
        // 岗位切换语义）。setup 不传 presetId，agentSetup 内部按 header 解析。
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
      const sessionId = SessionId(`matrix-${localpartOf(this.userId)}-${this.roomHash(roomId)}${suffix}`)
      handle = await this.acquireAgent(sessionId, { cwd, agentPreset: this.roomPresetFor(roomId) })
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
      const sessionId = SessionId(`matrix-${localpartOf(this.userId)}-${this.roomHash(roomId)}-e${nextEpoch}`)
      handle = await this.acquireAgent(sessionId, { cwd, agentPreset: this.roomPresetFor(roomId) })
    }

    this.roomAgents.set(roomId, handle)
    this.state.setRoomSession(roomId, handle.agent.id)
    // 岗位切换后的历史摘要同步：新建会话（新 epoch）不 resume 旧历史，故把切换时
    // 捕获的旧对话要点注入为首条 user 消息，让新岗位 agent 理解上下文（summary 非全文）。
    const switchSummary = this.state.roomJobSwitchSummary(roomId)
    if (switchSummary !== undefined && switchSummary !== '') {
      this.state.clearRoomJobSwitchSummary(roomId)
      const presetId = this.roomPresetFor(roomId)
      try {
        handle.agent.followup(createUserMessage({
          content: [{
            type: 'text',
            text: `【岗位切换】本群此前由另一岗位处理，现将工作交接给你（当前岗位：${presetId}）。以下是此前对话要点，请据此理解上下文并继续：\n\n${switchSummary}`,
          }],
          source: { kind: 'user' },
        }))
        this.diag.log(`roomPresets switch room=${roomId}: history summary injected into new session (${switchSummary.length} chars)`)
      } catch (error) {
        this.ctx.logger.warn('[dsh-matrix-agent] inject job-switch summary failed: %s', messageOf(error))
      }
    }
    // 挂到 cwd 对应的 workspace（GUI 分组：worker 会话不落「未分组」）。
    void this.attachSessionToWorkspace(SessionId(handle.agent.id), cwd)
    // 思考级别注入（worker 档）——live agent ctx 上装 waterfall，独立于 agentSetup。
    this.ensureEffortHook(handle.agent.id, (handle.agent as unknown as { ctx?: { on(event: string, listener: unknown): unknown } }).ctx, 'worker')
    // 会话标题 = Matrix 房间名（pin 住，自动标题不再覆盖）。
    void this.nameSessionFromRoom(roomId, handle.agent)
    return handle.agent
  }

  /**
   * 房间 → 确定性 hash：把实例命名空间混入 hash 输入，使同一房间在不同 dsh 实例
   * 下得到不同会话 id（互不 resume）。无命名空间时退化为旧的 stableHash(roomId)。
   */
  private roomHash(roomId: string): string {
    const ns = this.sessionNamespace
    return ns === undefined || ns === '' ? stableHash(roomId) : stableHash(`${ns}\n${roomId}`)
  }

  /**
   * 检测会话历史里的工具序列损坏，两种形态都会让 LLM API 拒绝请求
   * （CodeBuddy 返回 11148 "tool calls and tool results do not match"）：
   *   1. 「孤立 tool-result」：某条 user 消息带 tool-result 内容块，但往前最近的
   *      assistant 消息没有 tool_calls（或没有声明足够的 tool_call）。
   *   2. 「悬挂 tool-call」：历史末尾仍有未配对的 tool_calls（assistant 声明了
   *      调用但从未收到结果——常见于步骤被中断/失败后工具结果未落地）。
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
      // 历史末尾仍有未配对 tool_calls：后端会以 11148 拒绝请求。
      return openCalls > 0
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix-agent] orphan tool-result check failed: %s', messageOf(error))
      return false
    }
  }

  /**
   * 构建 agent 的 setup 回调：在 agent scope 上 compose 指定的 preset（缺省用配置的
   * 岗位 preset），使 shell/file/检索/skills 等工具挂载到该 agent。harness 的 GUI
   * 会话由 host 自动注入此 setup；dsh-matrix 直接走 ctx.agents.create/resume（底层
   * factory），必须自己传 setup，否则 agent 不 compose 任何 preset → 工具不可见。
   *
   * presetId 用于覆盖默认岗位：秘书会话传 'secretary'（固定秘书 preset）。preset 的
   * persona + 工具白名单全部由 preset 自身（agent.cordis.yml）承载，此 setup 不再
   * 注入任何硬编码 persona/白名单——只负责把 agent scope 挂到 preset 的 standing mount。
   *
   * 注意：matrix 专属工具（matrix_get_room_members 等）不在此注册，而是在
   * start() 里通过 applyMatrixTools 一次性注册到全局 ToolRuntime layer。
   * 原因：ToolRuntime.register() 始终写入全局 layer（scopeOf(rootCtx)===undefined），
   * 与 setup 的 agentCtx 无关；execute 时通过 exec.agent.id 反查房间。
   */

  /** 读取「用户选的默认岗位」：agent-presets 的 defaultId（= selectedDefault ?? default）。
   *  未设置 / 服务不可用 → undefined（回退到 config.agentPreset）。 */
  private defaultPresetId(): string | undefined {
    try {
      const presets = this.ctx.get('agentPresets') as
        | { defaultId?: string }
        | undefined
      const id = presets?.defaultId
      return id !== undefined && id !== '' ? id : undefined
    } catch {
      return undefined
    }
  }

  private agentSetup(presetId?: string): (agentCtx: Context) => Promise<void> {
    // 岗位优先级：显式 presetId（秘书/前台等固定岗）→ 用户选的默认岗位（agent-presets.default）
    // → cordis.patch.yml 的 config.agentPreset（安全兜底）→ 'standard'。
    // 只有 worker 会话走「默认岗位」回退链：presetId 为 undefined 时读 defaultId，
    // 让「分身工作台选岗位 / 激活时选的默认岗位」真正生效，而非被包内写死值压制。
    const preset = presetId ?? this.defaultPresetId() ?? this.config.agentPreset ?? 'standard'
    this.diag.log('[dsh-matrix-agent] agentSetup preset=' + preset + ' (presetId=' + (presetId ?? '(none)') + ' config.agentPreset=' + (this.config.agentPreset ?? '(none)') + ')')
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
      try {
        await presets.mount(agentCtx, preset)
        this.diag.log(`[dsh-matrix-agent] agentSetup preset=${preset} mounted ok`)
      } catch (error) {
        this.diag.log(`[dsh-matrix-agent] agentSetup preset=${preset} mount ERROR: ${messageOf(error).slice(0, 300)}`)
        throw error
      }
      // worker 岗位统一 deny 秘书专属的决策回传工具：matrix_reply_worker 是「秘书回传决策
      // 给 worker」用的，worker 本不该持有——虽然 bridge 侧 replyWorkerAtomic 已有机制层红线
      // （callerSessionId 非秘书一律 DENIED），但工具仍对 worker 可见会占目录 token、且语义上
      // 误导模型「以为自己能回传决策」。这里在 agent scope 上 deny 掉，让它从 worker 的工具
      // 面彻底消失（secretary 岗保留；reception 零工具无影响）。
      if (preset !== 'secretary') {
        const tools = typeof agentCtx?.get === 'function'
          ? agentCtx.get('tools') as { restrict?: (filter: { deny?: string[] }) => any } | undefined
          : undefined
        if (tools?.restrict !== undefined) {
          try {
            agentCtx.effect(() => tools.restrict!({ deny: ['matrix_reply_worker'] }), 'matrix-agent.worker-deny-reply-worker')
            this.diag.log(`[dsh-matrix-agent] agentSetup preset=${preset} denied matrix_reply_worker`)
          } catch (error) {
            this.diag.log(`[dsh-matrix-agent] agentSetup preset=${preset} deny matrix_reply_worker ERROR: ${messageOf(error).slice(0, 300)}`)
          }
        }
      }
      // 岗位 persona 与秘书工作流由岗位 preset（agent.cordis.yml 的 persona 行）提供，
      // 不再在此注入（人格完全由 skill/preset 承载）。
      // 保留 systemPrompt 读取能力：时间线提示词段仍需注入。
      const getSystemPrompt = (): { section(section: { name: string; order: number; text: string | (() => string) }): () => void } | undefined => {
        if (typeof agentCtx?.get !== 'function') return undefined
        return agentCtx.get('systemPrompt') as
          | { section(section: { name: string; order: number; text: string | (() => string) }): () => void }
          | undefined
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
      this.diag.log(`[dsh-matrix-agent] agentSetup preset=${preset} timeline done`)
      // 思考级别注入已从 agentSetup 移除：resume/live agent 的 setup 可能不完整执行
      // （重复 mount 挂起），不可靠。改为 getSecretaryAgent/createRoomAgent 拿到
      // live agent 后直接在 agent.ctx 上装 agent/request waterfall（见 ensureEffortHook）。
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
  private async acquireAgent(sessionId: SessionId, meta: { cwd: string; agentPreset?: string }): Promise<AgentHandle> {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const wrap = (agent: Agent): AgentHandle => ({ agent, dispose: async () => {} })
    const setupFn = this.agentSetup(meta.agentPreset)
    // setup 回调（agentSetup）通过 agentPresets.mount() 把 agent scope 绑到 preset 的
    // standing scope key。对内核已加载的 live agent 绝不补跑 setup：
    //   1) bindScopeParent 是「一次绑定」—— scope key 已有 parent 再 bind 会抛
    //      "already bound to a parent"，补跑必然失败；
    //   2) live agent 的组成已由创建它的 setup/header 保证，无需（也无法）重挂。
    // 对 bridge 自己 create/resume 的会话，setup 在 agent 发布前执行（factory 的
    // setupAndPublish），mount 一次完成，无重复问题。
    const waitForLive = async (label: string): Promise<AgentHandle | undefined> => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const live = this.ctx.agents.get(sessionId)
        if (live !== undefined) {
          if (attempt > 0) this.ctx.logger.info('[dsh-matrix-agent] session %s live after %dms (%s)', sessionId, (attempt + 1) * 150, label)
          return await wrap(live)
        }
        await sleep(150)
      }
      return undefined
    }

    // 1) 内核已加载并注册为 live agent：直接取用，绝不补跑 setup。
    const liveNow = this.ctx.agents.get(sessionId)
    if (liveNow !== undefined) return await wrap(liveNow)

    // 2) resume 续接历史（不传 cwd，复用磁盘持久化 cwd，避免 cwd 不匹配的 id collision）。
    try {
      return await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.agentOptions,
        setup: setupFn,
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
            // agentPreset 写入会话 header：worker 会话缺省用配置的岗位 preset，
            // 秘书会话显式传 'secretary'（固定秘书 preset）。任何恢复路径都能按
            // header 组出会话应有的 preset。
            agentPreset: meta.agentPreset ?? this.config.agentPreset ?? 'standard',
          },
          agentOptions: this.agentOptions,
          setup: setupFn,
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
    this.deliveryAuthorized.delete(roomId)
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
    // 收到入群邀请（尚未加入）：走邀请审批状态机，绝不自动进群。
    // 注意与 kind='invite' 的区别：那个是「已加入房间里别人被邀请」（旁观事件），
    // 本分支才是「有人把本账号拉进新房间」（入群决策入口）。
    if (event.kind === 'self-invite') {
      await this.handleSelfInvite(event)
      return
    }
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
   * 入群邀请审批状态机（非阻塞）。
   *
   * 为什么不能用 waitOwnerDecision：那套机制依赖「发起方 agent turn 挂起等 resolve」
   * （initiatorSessionId + ownerPending 队列），而邀请是通道事件驱动、**没有 agent turn
   * 可挂起**。硬套会导致请示无处 resolve。所以这里用独立的非阻塞流程：
   *
   *   收到邀请
   *     ├─ 审批功能关闭（inviteApprovalEnabled=false）→ 直接进群（旧行为）
   *     ├─ 邀请人在【批准名单】→ 直接进群（不再打扰主人）
   *     ├─ 邀请人在【拒绝名单】→ 直接静默拒绝（不再反复打扰主人）
   *     └─ 其余 → ① 立刻落盘待决（关键：sync 游标一推进，未处理邀请永久消失）
   *               ② pushInbox(kind='invite') 请示主人
   *               ③ 主人决策 → join / leave + 记入黑白名单
   *
   * 决策入口：收件箱 ownerDecisionOps（id=roomId）或主人私聊回复。
   * 决策到达**不唤醒任何会话**（本流程无会话可唤醒）。
   */
  private async handleSelfInvite(event: RoomEvent): Promise<void> {
    const roomId = event.roomId
    const inviter = event.detail?.inviter !== undefined ? String(event.detail.inviter) : event.userId
    const roomName = event.detail?.roomName !== undefined ? String(event.detail.roomName) : undefined
    const isDirect = event.detail?.isDirect === true
    const label = this.inviteLabel(roomName, roomId)
    this.diag.log(`handleSelfInvite room=${roomId} inviter=${inviter ?? '(unknown)'} name=${roomName ?? '(none)'} direct=${isDirect} approval=${this.config.inviteApprovalEnabled !== false}`)

    // 功能关闭：回退旧行为（无条件进群）。仅用于可信测试环境。
    if (this.config.inviteApprovalEnabled === false) {
      await this.acceptInvite(roomId, inviter, label, 'approval-disabled')
      return
    }

    // 无邀请人信息：无法判断可信度 → 一律请示主人（绝不放行）。
    if (inviter === undefined || inviter === '') {
      this.pendingInviteAndAsk(roomId, undefined, roomName, isDirect, label, '无法识别邀请人')
      return
    }
    // 自己邀请自己 / 主人邀请：视为可信，直接进群。
    if (inviter === this.userId || (this.owner !== undefined && inviter === this.owner)) {
      await this.acceptInvite(roomId, inviter, label, inviter === this.owner ? 'owner-invite' : 'self-invite')
      return
    }
    // 已批准过的邀请人 → 直接进群（用户要求：以前同意过就直接进）。
    if (this.inviteStore.isApproved(inviter)) {
      this.diag.log(`handleSelfInvite room=${roomId} inviter=${inviter} already-approved; auto-join`)
      await this.acceptInvite(roomId, inviter, label, 'approved-inviter')
      return
    }
    // 已拒绝过的邀请人 → 直接静默拒绝（不反复打扰主人）。
    if (this.inviteStore.isDenied(inviter)) {
      this.diag.log(`handleSelfInvite room=${roomId} inviter=${inviter} already-denied; auto-reject`)
      await this.rejectInvite(roomId, inviter, label, 'denied-inviter')
      return
    }
    // 首次遇到该邀请人 → 落盘待决 + 请示主人。
    this.pendingInviteAndAsk(roomId, inviter, roomName, isDirect, label, '首次邀请')
  }

  /** 邀请的房间展示标签（有群名用群名，否则用 roomId 截断）。 */
  private inviteLabel(roomName: string | undefined, roomId: string): string {
    if (roomName !== undefined && roomName !== '') return `群「${roomName}」`
    return `房间 ${roomId.length > 24 ? `${roomId.slice(0, 24)}…` : roomId}`
  }

  /** 落盘待决邀请 + 写入主人收件箱（请示）。 */
  private pendingInviteAndAsk(roomId: string, inviter: string | undefined, roomName: string | undefined, isDirect: boolean, label: string, reason: string): void {
    const invite: PendingInvite = {
      roomId,
      ...(inviter !== undefined ? { inviter } : {}),
      ...(roomName !== undefined ? { roomName } : {}),
      isDirect,
      at: Date.now(),
    }
    // ① 先落盘：这是「等主人同意」能成立的前提（sync 不会再投递这条邀请）。
    this.inviteStore.addPending(invite)
    this.diag.log(`handleSelfInvite room=${roomId} pending persisted inviter=${inviter ?? '(unknown)'} reason=${reason}`)
    // ② 请示主人（复用收件箱 UI，kind='invite'）。
    const who = inviter !== undefined ? `「${localpartOf(inviter)}」（${inviter}）` : '一个无法识别的账号'
    const text = [
      `${who} 邀请我加入${label}${isDirect ? '（1:1 私聊）' : ''}。`,
      '',
      '批准后我会进群并按社交设置打招呼；批准会记住这位邀请人，以后 TA 再邀请我直接进群，不再打扰你。',
      '拒绝则记住 TA，以后 TA 的邀请直接静默拒绝。',
    ].join('\n')
    this.pushInbox(roomId, 'invite', text, label)
    // ③ 同步私聊告知主人（若配置了主人且能发私聊）。
    if (this.owner !== undefined && this.owner !== '') {
      void this.channel.sendDm?.(this.owner, `【入群邀请待批】\n${text}`)
        .then((dm) => {
          if (dm === undefined) return
          this.ownerDmToWorkRoom.set(dm.roomId, roomId)
          // 持久化 DM↔邀请 映射：主人可能在重启后才回复，内存映射会丢。
          this.inviteStore.setPendingDmRoom(roomId, dm.roomId)
        })
        .catch((error: unknown) => {
          this.ctx.logger.warn('[dsh-matrix-agent] invite DM failed: %s', messageOf(error))
        })
    }
  }

  /**
   * 重启后重放待决邀请：sync 不会再投递已推进游标的邀请，只能靠落盘记录
   * 重新写入收件箱，让主人仍能看到并裁决（否则重启即「邀请悄悄消失」）。
   */
  private replayPendingInvites(): void {
    const pending = this.inviteStore.listPending()
    if (pending.length === 0) return
    this.diag.log(`replayPendingInvites count=${pending.length}`)
    for (const invite of pending) {
      const label = this.inviteLabel(invite.roomName, invite.roomId)
      const who = invite.inviter !== undefined ? `「${localpartOf(invite.inviter)}」（${invite.inviter}）` : '一个无法识别的账号'
      const text = [
        `${who} 邀请我加入${label}${invite.isDirect ? '（1:1 私聊）' : ''}。`,
        '',
        '（重启后恢复的待批邀请）批准后我会进群；批准会记住这位邀请人，以后 TA 再邀请我直接进群。',
      ].join('\n')
      this.pushInbox(invite.roomId, 'invite', text, label)
      // 重启后内存 DM 映射已丢：重建映射（已持久化的 dmRoomId 优先，否则重发一次私聊）。
      if (invite.dmRoomId !== undefined && invite.dmRoomId !== '') {
        this.ownerDmToWorkRoom.set(invite.dmRoomId, invite.roomId)
      } else if (this.owner !== undefined && this.owner !== '') {
        void this.channel.sendDm?.(this.owner, `【入群邀请待批】\n${text}`)
          .then((dm) => {
            if (dm === undefined) return
            this.ownerDmToWorkRoom.set(dm.roomId, invite.roomId)
            this.inviteStore.setPendingDmRoom(invite.roomId, dm.roomId)
          })
          .catch(() => {})
      }
    }
  }

  /** 接受邀请：进群 + 记入批准名单 + 清待决。 */
  private async acceptInvite(roomId: string, inviter: string | undefined, label: string, reason: string): Promise<void> {
    if (this.channel.joinRoom === undefined) {
      this.ctx.logger.warn('[dsh-matrix-agent] channel does not support joinRoom; cannot accept invite room=%s', roomId)
      return
    }
    try {
      await this.channel.joinRoom(roomId)
      // 原子裁决：名单 + 清待决一次落盘（分两次写会留下「名单已记但待决还在」的中间态，
      // 重启后表现为已批准过的人又被请示一次）。await 确保落盘后再继续。
      await this.inviteStore.resolve(roomId, 'approve', inviter, label)
      this.popInbox(roomId)
      this.diag.log(`acceptInvite room=${roomId} inviter=${inviter ?? '(unknown)'} reason=${reason} ok`)
      this.recordTimeline(roomId, 'approval', { target: this.owner ?? '' }, 0, 'worker', `✅ 已接受入群邀请（${reason}）`)
    } catch (error) {
      const message = messageOf(error)
      // 邀请已失效（邀请人撤回 / 房间已解散）：403/404 属终态，继续保留待决会让它
      // 永远卡在收件箱里（主人再批也进不去）。此时直接清掉待决，不写名单。
      if (/join HTTP (403|404)/.test(message)) {
        this.inviteStore.removePending(roomId)
        this.popInbox(roomId)
        this.diag.log(`acceptInvite room=${roomId} reason=${reason} invite no longer valid (${message}); pending dropped`)
        return
      }
      // 其它失败（网络/5xx）保留待决：主人可重试，或重启时重放。
      this.ctx.logger.warn('[dsh-matrix-agent] acceptInvite room=%s failed: %s', roomId, message)
      this.diag.log(`acceptInvite room=${roomId} reason=${reason} FAILED: ${message}`)
    }
  }

  /** 拒绝邀请：退群/清挂起邀请 + 记入拒绝名单 + 清待决。 */
  private async rejectInvite(roomId: string, inviter: string | undefined, label: string, reason: string): Promise<void> {
    try {
      await this.channel.leaveRoom?.(roomId)
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix-agent] rejectInvite leave room=%s failed: %s', roomId, messageOf(error))
    }
    if (inviter !== undefined && inviter !== '') await this.inviteStore.resolve(roomId, 'deny', inviter, label)
    else this.inviteStore.removePending(roomId)
    this.popInbox(roomId)
    this.diag.log(`rejectInvite room=${roomId} inviter=${inviter ?? '(unknown)'} reason=${reason}`)
    this.recordTimeline(roomId, 'approval', { target: this.owner ?? '' }, 0, 'worker', `🚫 已拒绝入群邀请（${reason}）`)
  }

  /**
   * 主人对入群邀请的裁决（收件箱 / 私聊回复共用）。
   * 与请示/汇报不同：**不唤醒任何会话**（邀请审批无 agent turn 挂起）。
   * 返回是否命中一条待决邀请。
   */
  private async handleInviteDecision(roomId: string, decision: 'approve' | 'reject'): Promise<boolean> {
    const pending = this.inviteStore.getPending(roomId)
    if (pending === undefined) return false
    const label = this.inviteLabel(pending.roomName, pending.roomId)
    if (decision === 'approve') {
      await this.acceptInvite(roomId, pending.inviter, label, 'owner-approved')
    } else {
      await this.rejectInvite(roomId, pending.inviter, label, 'owner-rejected')
    }
    return true
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
        source: { kind: 'user' },
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
      // 阶段 3 群形态采样底稿：**未装饰的**原文（去本插件已知账号 @提及前缀）。
      // 不能拿 buildMessageContext 装饰后的 text（[回复 …]/[富文本含: …] 前缀会把别的消息
      // 内容掺进来，污染长度/问句/主题重叠判定）；与 chatlog.append 存装饰文本互不影响。
      let shapeRaw = text
      if (shapeRaw !== '') {
        for (const id of this.allAccountIds) {
          const lp = localpartOf(id)
          shapeRaw = shapeRaw
            .replace(id, '')
            .replace(`@${lp}`, '')
            .replace(new RegExp(`(^|\\s)${escapeRegExp(lp)}[:：]`), '')
        }
        shapeRaw = shapeRaw.replace(/\s+/g, ' ').trim()
      }

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

      // ── 阶段 3：群形态滚动器（auto 自适配）——每条入站人类消息推进 per-room 窗口 + 防抖裁决。
      // 放在所有早退（审批应答/命令/路由门控）之前：与 chatlog.append 同理，无论本账号是否响应，
      // 只要能看到这条消息就采样——「群形态」以整群消息流为准（分身自己出站/命令/模式指令/
      // 私聊房在 updateRoomShape 内部被排除）。喂给滚动器的是未装饰原文 shapeRaw。
      // 纯内存 O(window) + 一次缓存化 DM 判定，零模型调用。
      await this.updateRoomShape(message.roomId, shapeRaw, message.sender ?? '', Date.now())

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
      // 审批「问人」已改为 DM 私聊 Owner，故主人回复可能落在 DM 房而非工作房间；
      // 先经 ownerDmToWorkRoom 反查工作房间，再命中 pendingApprovals（key=工作房间）。
      const isApprovalWord = APPROVE_RE.test(stripped) || DENY_RE.test(stripped)
      const workRoomFromDm = this.ownerDmToWorkRoom.get(message.roomId)
      const queue = this.pendingApprovals.get(workRoomFromDm ?? message.roomId)
      const first = queue?.[0]
      if (first !== undefined && isApprovalWord) {
        if (this.owner !== undefined && message.sender !== this.owner) {
          this.ctx.logger.warn('[dsh-matrix-agent] approval reply from %s ignored (only %s may answer)', message.sender, this.owner)
          return
        }
        const approvalRoom = workRoomFromDm ?? message.roomId
        if (APPROVE_RE.test(stripped)) {
          if (first.grantOnApprove) {
            this.authStore.grant(this.userId, this.owner ?? this.userId, approvalRoom, first.request.toolName)
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
      if (isApprovalWord && (this.pendingRooms.has(message.roomId) || (workRoomFromDm !== undefined && this.pendingRooms.has(workRoomFromDm)))) {
        return
      }

      // 老板私聊回复路由（彻底分层）：主人回复「批准/交付」→ 按 DM 房反查工作房间，
      // 置位交付授权（deliveryAuthorized），让 agent 后续 matrix_send_room_message 放行。
      // 主人回复目录路径 → 设工作目录并回写经验。不再代发群消息、不再走任务状态机。
      if (this.owner !== undefined && message.sender === this.owner) {
        const workRoom = this.ownerDmToWorkRoom.get(message.roomId)
        if (workRoom !== undefined) {
          await this.handleOwnerReply(message.roomId, workRoom, stripped)
          return
        }
        // 重启兜底：内存 DM 映射会丢，但待决邀请的 dmRoomId 是持久化的。
        // 不查这一条的话，主人重启后回复「批准」会被当普通消息漏给 agent（实测踩过）。
        const byDm = this.inviteStore.pendingByDmRoom(message.roomId)
        if (byDm !== undefined) {
          await this.handleOwnerReply(message.roomId, byDm.roomId, stripped)
          return
        }
      }


      this.diag.log(`handleMessage room=${message.roomId} from=${message.sender} digitalTwinMode=${this.config.digitalTwinMode} text=${text.slice(0, 60).replace(/\n/g, ' ')}`)
      this.diag.log('[dsh-matrix-agent] hm-busy room=' + message.roomId + ' sender=' + message.sender + ' userId=' + this.userId + ' busy=' + this.roomBusy.has(message.roomId) + ' keys=' + JSON.stringify(Array.from(this.roomBusy.keys())))
      // 任务结束信号：数字人自己的回复回流到房间（sender 为本账号）即视为该房间任务完成，清除忙碌标记。
      if (message.sender === this.userId) {
        if (this.roomBusy.delete(message.roomId)) this.publishTaskBoardSnapshot()
      }
      // 成员记忆：消息来自其他成员时 upsert + 累计互动（记住每个人）。
      if (this.config.memberMemory !== false && message.sender !== this.userId) {
        this.memberStore.upsert(message.roomId, { userId: message.sender })
        this.memberStore.bumpInteraction(message.roomId, message.sender)
        this.memberStore.scheduleSave()
      }
      // 记录最近外部发言者（时间线摘要「回复谁」用；限自身非空外部账号）。
      if (message.sender !== undefined && message.sender !== '' && message.sender !== this.userId) {
        this.lastSenderByRoom.set(message.roomId, message.sender)
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
      // ── AI 接待层：入站消息语义分类（优先）→ 按 receptionKinds 表执行礼貌层动作。
      // 判定只影响「是否插即时 ack / 是否置忙 / 是否转发」，绝不吞消息（forward 决定）。
      // receptionEnabled=false / 判定超时 / JSON 失败 → 回退下方正则兜底。
      const mentionedSelf = this.isMentioningSelf(message)
      let receptionKind: string | undefined
      let legacyTaskLike = false
      let llmModeHint: RoomMode | undefined
      const kindEntry = await this.classifyMessageIfEnabled(message, stripped, mentionedSelf)
      if (kindEntry !== undefined) {
        receptionKind = kindEntry.kind
        llmModeHint = kindEntry.modeHint
        // 按表执行：busy 标记 → ack → forward 决定是否继续走 deliver。
        if (kindEntry.busy && !this.roomBusy.has(message.roomId)) {
          this.roomBusy.set(message.roomId, { since: Date.now(), label: stripped.slice(0, 24) })
          this.publishTaskBoardSnapshot()
        }
        // ack 发送条件：表要求 ack，且该 kind 语义与当前状态匹配。
        //  - new-task：任何时候可发「收到去整理」（它自己会置忙）；
        //  - busy-question/busy-plain：话术是「手头正忙」——只有 worker 真忙（roomBusy 已有）才说忙，
        //    否则是 AI 误判（worker 其实空闲），不该发「我正忙」，按 chat 处理让 worker 直接答。
        const isBusyKind = kindEntry.kind === 'busy-question' || kindEntry.kind === 'busy-plain'
        const ackAllowed = isBusyKind ? this.roomBusy.has(message.roomId) : true
        if (kindEntry.ack && ackAllowed && message.sender !== undefined && message.sender !== '' && message.sender !== this.userId) {
          const lp = localpartOf(message.sender)
          const taskHint = stripped.replace(/@\S+/g, '').replace(/[\u3000\u3001\uFF0C\u3002\uFF01\uFF1F]/g, ' ').trim().slice(0, 24)
          const task = this.roomBusy.get(message.roomId)
          const taskDesc = task !== undefined && task.label !== '' && task.label !== '处理任务中' ? `（正在做「${task.label}」）` : ''
          const eta = task !== undefined ? this.formatEta((Date.now() - task.since) / 1000) : ''
          const ack = this.renderReceptionAck(kindEntry.kind, kindEntry.ackText, { lp, taskHint, taskDesc, eta })
          if (ack !== '') {
            void this.safeSend(message.roomId, ack, undefined)
            this.diag.log(`[dsh-matrix-agent] reception ack (ai kind=${kindEntry.kind}) room=${message.roomId} from=${lp}`)
          }
        }
        if (!kindEntry.forward) return  // 接待层消化（如 worker 空闲时的收尾确认）：不转 worker
        // forward=true：继续走下方合并窗口 → deliver → worker。
      } else {
        // ── 正则兜底（receptionEnabled=false / AI 判定失败）──
        legacyTaskLike = this.applyLegacyReceptionRules(message, stripped, text)
      }
      if (!(await this.shouldRespond(message))) return

      // ── 群工作模式：口播指令识别（关键词 + LLM 双保险，拿不准不落配置）──
      // 放在 shouldRespond 之后：仅对「本账号应响应的消息」（@到/respondToAll）处理，
      // 避免分身在不响应房间（未 @ 且 respondToAll=false）里落配置 + 主动发确认造成越权发言。
      // 仅在显式设置语气（keywordModeHint 命中）时处理；近纯指令且命中则整条吞掉不转 worker。
      {
        const directiveHint = keywordModeHint(stripped)
        if (directiveHint !== undefined) {
          const pure = isProbablyPureDirective(stripped)
          const consumed = await this.applyModeDirectiveIfAny(message.roomId, stripped, directiveHint, llmModeHint, pure)
          if (consumed) {
            this.diag.log(`[dsh-matrix-agent] roomModes pure directive consumed room=${message.roomId} mode=${directiveHint.mode}`)
            return
          }
          // 夹带任务/非纯指令：模式已（可能）落，消息继续走下方 worker 流程。
        }
      }

      if (stripped.startsWith('/')) {
        this.flushMerge(message.roomId)
        await this.handleCommand(message.roomId, message.sender, stripped)
        return
      }

      // 彻底分层：普通消息直接注入 agent（不再进任务队列/自动请示）。
      // agent 按 skill 用原子工具（matrix_request_owner_decision / matrix_read_workspace_file /
      // matrix_report_owner / matrix_send_room_message）自行完成「请示→读数据→整理→私发→交付」。
      // bridge 只守住红线：出站分流（assistant/message 吞掉）+ 交付授权门控。
      // 合并窗口：'..' 继续、'!!' 立即提交、裸文本等待 mergeTimeoutSecs。
      let rest = stripped
      let flush = false
      if (stripped.endsWith('!!')) {
        rest = stripped.slice(0, -2).trim()
        flush = true
      } else if (stripped.endsWith('..')) {
        rest = stripped.slice(0, -2).trim()
      }
      if (rest === '') return
      const taskLikeHere = receptionKind === 'new-task' || legacyTaskLike
      const buffer = this.mergeBuffers.get(message.roomId) ?? {
        parts: [], sender: message.sender, imageRefs: [], mentioned: mentionedSelf,
        taskLike: taskLikeHere, items: [],
      }
      if (buffer.timer !== undefined) clearTimeout(buffer.timer)
      buffer.parts.push(rest)
      // 逐条独立记录（并行「待派批」数据源）：保留本条 sender/text/提及/任务标记/进入时间。
      if (message.sender !== undefined && message.sender !== '' && message.sender !== this.userId) {
        buffer.items.push({ sender: message.sender, text: rest, mentioned: mentionedSelf, taskLike: taskLikeHere, enteredAtMs: Date.now() })
      }
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
    // 并行模式批次判定（A 路径提示层）：窗口内 ≥2 条独立任务 → 走批次提示（不吞消息）。
    // 同 sender 连续发言视为同一轮对话（'..' 续写/补充），先归并再判批。
    if (this.parallelEnabled() && buffer.items.length > 0) {
      const turns = mergeSenderTurns(buffer.items)
      if (this.tryDispatchParallelBatch(roomId, turns, buffer.imageRefs)) {
        return
      }
      const single = turns.length === 1 ? turns[0] : undefined
      const opts = this.parallelOf()
      const text = buffer.parts.join('\n').trim()
      const taskishSingle = single !== undefined && this.parallelModeFor(roomId) && text !== '' &&
        single.text.trim() !== '' && (single.mentioned || single.taskLike)
      // ① 单条可拆候选且「内部可拆」→ 立即弱触发提示（本身即可并行，不必等凑批）。
      if (taskishSingle && isInternallySplittable(single.text)) {
        if (this.maybeHintSplittable(roomId, single.text, single.sender, buffer.imageRefs, single.mentioned, single.taskLike)) {
          return
        }
      }
      // ② 单条普通任务候选：进入窗口未满 parallelBatchWindowSecs → 延期到批次窗口满再 flush，
      //    给后续独立任务一个凑批机会（「宁可串行不可拆错」兜底：延期不是吞消息——窗口满后
      //    若仍只有 1 条则照常串行投递）。
      if (taskishSingle && opts.batchWindowSecs > 0 &&
          Date.now() - single.enteredAtMs < opts.batchWindowSecs * 1000) {
        const remainMs = Math.max(200, single.enteredAtMs + opts.batchWindowSecs * 1000 - Date.now())
        this.mergeBuffers.set(roomId, buffer)
        buffer.timer = setTimeout(() => {
          this.flushMerge(roomId)
        }, remainMs)
        this.diag.log(`[parallel] batch window extend room=${roomId} remainMs=${remainMs} (await more independent tasks)`)
        return
      }
    }
    const finalText = buffer.parts.join('\n').trim()
    if (finalText === '') return
    void this.deliver(roomId, finalText, buffer.sender, buffer.imageRefs, buffer.mentioned, buffer.taskLike)
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
   * - 全局 digitalTwinMode=true → 全部启用；
   * - 房间名匹配 twinModeRoomPrefix → 该房间启用（如测试房间）；
   * - 群聊默认秘书（secretaryGroupDefault，默认 true）→ 非私聊房间启用；
   * - 私聊默认秘书（secretaryDmDefault，默认 false）→ 私聊房间启用；
   * - **主人不在场即秘书**：无论私聊/群聊，只要 owner 不在房间成员里，分身不得擅作主张，
   *   一律走秘书编排（请示不在场的主人）。这是分身自治的红线。
   * @param message 入站消息：群聊默认秘书时，@ 提及本账号的消息视为即时交流直接回复（不入队列）。
   *   但「主人不在场」的红线优先：即使 @ 提及自己，主人不在也仍走秘书队列。 */
  /**
   * 主人（owner）是否在当前房间成员中。三态：
   * - true：明确在场（成员列表含 owner）
   * - false：明确不在场（成员列表非空且不含 owner）
   * - undefined：无法确定（未配置 owner，或成员列表获取失败/为空）
   */
  private async isOwnerInRoom(roomId: string): Promise<boolean | undefined> {
    if (this.owner === undefined || this.owner === '') return undefined
    const members = this.channel.getRoomMembers ? await this.channel.getRoomMembers(roomId).catch(() => undefined) : undefined
    if (members === undefined || members.length === 0) return undefined
    return members.some((m) => m.userId === this.owner)
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

  /** 房间名是否命中测试前缀（testRoomPrefix，如「【测试】」）。测试群无真实 owner，发言不走交付门禁。 */
  private async isTestRoom(roomId: string): Promise<boolean> {
    const prefix = this.config.testRoomPrefix
    if (prefix === undefined || prefix === '') return false
    const roomName = this.channel.getRoomName ? await this.channel.getRoomName(roomId).catch(() => undefined) : undefined
    return roomName !== undefined && roomName.includes(prefix)
  }

  /** 取房间显示名：缓存优先（board 行等同步场景用）；未命中异步取并回写缓存。 */
  private async roomDisplayName(roomId: string): Promise<string> {
    const cached = this.roomNameCache.get(roomId)
    if (cached !== undefined) return cached
    if (this.channel.getRoomName === undefined) return roomId
    const name = await this.channel.getRoomName(roomId).catch(() => undefined)
    if (name !== undefined && name !== '') this.roomNameCache.set(roomId, name)
    return name ?? roomId
  }

  private async roomContextLabel(roomId: string): Promise<string> {
    const isDm = this.channel.isDirectRoom ? await this.channel.isDirectRoom(roomId) : false
    // 同上：出站投递判据与入站门控共用这一份缓存。
    this.dmRoomCache.set(roomId, isDm)
    const me = `@${localpartOf(this.userId)}`
    if (isDm) {
      const name = this.channel.getRoomName ? await this.channel.getRoomName(roomId) : undefined
      if (name !== undefined && name !== '') this.roomNameCache.set(roomId, name)
      const peer = name !== undefined ? `（${name}）` : ''
      return `[私聊${peer}，你是${me}]`
    }
    const roomName = this.channel.getRoomName ? await this.channel.getRoomName(roomId) : undefined
    if (roomName !== undefined && roomName !== '') this.roomNameCache.set(roomId, roomName)
    const count = this.channel.getRoomMemberCount ? await this.channel.getRoomMemberCount(roomId) : undefined
    const head = roomName !== undefined ? `群聊「${roomName}」` : '群聊'
    const size = count !== undefined ? `，约${count}人` : ''
    // 群工作模式（轻量一行）：显式钉死时告知 worker 当前群按并行/协同处理；auto 不注（默认行为，不添噪）。
    const mode = this.roomModeFor(roomId)
    const modeNote = mode === 'parallel' || mode === 'cohesive' ? ` 当前群模式：${roomModeLabel(mode)}` : ''
    // A 路径并行能力声明：仅并行模式 + 总开关打开时注入一行更明确的能力声明
    // （配合批次提示：worker 收到相互独立的多个任务时，可用 subagent 工具派子代理并发执行并汇总）。
    // cohesive / auto 中性不注（cohesive 永不拆；auto 默认不拆，行为不变）。
    const parallelNote = this.parallelModeFor(roomId)
      ? ' 本群为并行模式：收到相互独立的多个任务时，可用 subagent 工具（delegation 组）各派一个子代理并行处理，收齐后分条汇总交付；有依赖则保持串行。'
      : ''
    // 阶段 3 auto 自适配软行：仅当该房是 auto（roomModeFor()==='auto'，钉死房短路）且
    // 当前有效倾向 ≠ neutral 时追加一行「近况判断」软声明（低噪、明示是临时判断，提示非命令）。
    // 倾向实时读 roomShapeLeaning（防抖已保证不横跳）；中性/过期 → 不注（走现状）。
    // auto+parallel 联动且并行模式放行时上方 parallelNote 已带并行能力声明，不再重复 shapeNote。
    const lean = mode === 'auto' ? this.roomShapeLeaningFor(roomId) : 'neutral'
    const shapeNote = mode === 'auto' && !(this.parallelModeFor(roomId) && lean === 'parallel')
      ? leaningLabel(lean)
      : ''
    // 测试环境声明：房间名匹配 testRoomPrefix 时提示数字人。按 testEnvAllowExecute 分两档：
    // true（默认）= 允许配合执行验证任务（读文件/分析/产出），仅提示别影响真实数据/真实用户；
    // false = 旧行为：禁止真实执行，仅配合测试对话。
    let testNote = ''
    const prefix = this.config.testRoomPrefix
    if (prefix !== '' && roomName !== undefined && roomName.includes(prefix)) {
      testNote = this.config.testEnvAllowExecute === false
        ? ' ⚠️测试环境：请勿真实执行任务、修改文件、或向真实用户发送重要消息，仅配合测试对话。'
        : ' 🧪测试环境：可配合执行验证类任务（读工作目录/分析/产出结果），注意勿影响真实数据或向真实用户发送重要消息。'
    }
    const label = `[${head}${size}，你是${me}]${modeNote}${parallelNote}${shapeNote}${testNote}`
    this.diag.log(`roomContextLabel room=${roomId} isDm=${isDm} name=${roomName ?? '(none)'} count=${count ?? '(unknown)'} mode=${this.roomModeFor(roomId)} shape=${this.roomShapeLeaningFor(roomId)} parallel=${this.parallelModeFor(roomId)} testRoom=${testNote !== ''} label=${label}`)
    return label
  }

  /**
   * 该房间当前的群工作模式（对外查询接口，供秘书/worker/阶段 2 调度使用）。
   * 显式钉死（roomModes 命中 roomId 或群名）优先；否则 auto（默认自适配，不阻断行为）。
   */
  roomModeFor(roomId: string): RoomMode {
    // 先精确 roomId，再 roomNameCache 里的群名（设置页/口播可能按群名配置）。
    const pinned = this.roomModesMem.get(roomId)
    if (pinned !== undefined) return pinned
    const name = this.roomNameCache.get(roomId)
    if (name !== undefined && name !== '') {
      const byName = this.roomModesMem.get(name)
      if (byName !== undefined) return byName
    }
    return 'auto'
  }

  /**
   * 该房间当前生效的岗位 preset id（对外查询接口，供 createRoomAgent 建连与设置页展示）。
   * 显式钉死（roomPresets 命中 roomId 或群名）优先；否则回退全局 config.agentPreset（默认 'standard'）。
   * @param pinned - 输出参数：是否由 roomPresets 显式钉死（true）还是回退全局默认（false）。
   */
  roomPresetFor(roomId: string, pinned?: { value: boolean }): string {
    const exact = this.roomPresetsMem.get(roomId)
    if (exact !== undefined && exact !== '') {
      if (pinned !== undefined) pinned.value = true
      return exact
    }
    const name = this.roomNameCache.get(roomId)
    if (name !== undefined && name !== '') {
      const byName = this.roomPresetsMem.get(name)
      if (byName !== undefined && byName !== '') {
        if (pinned !== undefined) pinned.value = true
        return byName
      }
    }
    if (pinned !== undefined) pinned.value = false
    return this.config.agentPreset ?? 'standard'
  }

  /**
   * 外部（设置页/其它账号）改了 settings 用户层 roomPresets 后的热更同步（MatrixBridge 分发）。
   * settings 是持久权威：以它的键（roomId 或群名）为准重建「钉死键」；
   * 群名别名（roomId → 群名缓存里反查）一并重建。自己 flushRoomPresetsNow 的回声也走这里。
   */
  syncRoomPresetsFromSettings(raw: unknown): void {
    const next = normalizeRoomPresets(raw)
    const pinned = new Map<string, string>()
    for (const [key, presetId] of Object.entries(next)) {
      if (key === '' || presetId.trim() === '') continue
      pinned.set(key, presetId)
    }
    for (const key of this.roomPresetsBaseKeys) {
      const presetId = this.roomPresetsMem.get(key)
      if (presetId !== undefined && presetId !== '') pinned.set(key, presetId)
    }
    const alias = new Map<string, string>()
    for (const [roomId, name] of this.roomNameCache) {
      const p = pinned.get(roomId)
      if (p !== undefined && name !== roomId) alias.set(name, p)
    }
    this.roomPresetsMem.clear()
    for (const [key, presetId] of pinned) this.roomPresetsMem.set(key, presetId)
    for (const [key, presetId] of alias) {
      if (!this.roomPresetsMem.has(key)) this.roomPresetsMem.set(key, presetId)
    }
    this.diag.log(`roomPresets sync from settings: pinned=${pinned.size} alias=${alias.size}`)
  }

  /** 显式设置某房间的岗位（设置页共用入口）：更新内存并安排写回 settings。
   * presetId 为空串视为「取消钉死」：删除该房间的显式配置，回到全局默认岗位。 */
  async setRoomPreset(roomId: string, presetId: string, reason: string): Promise<void> {
    const roomLabel = await this.roomDisplayName(roomId)
    if (presetId.trim() === '') {
      const hadRoom = this.roomPresetsMem.delete(roomId)
      const hadName = roomLabel !== roomId ? this.roomPresetsMem.delete(roomLabel) : false
      if (hadRoom || hadName) {
        this.roomPresetsDirty.set(roomId, undefined)
        this.scheduleRoomPresetsFlush()
        this.diag.log(`roomPresets unset room=${roomId} name=${roomLabel} reason=${reason}`)
      }
      return
    }
    this.roomPresetsMem.set(roomId, presetId)
    if (roomLabel !== roomId) this.roomPresetsMem.set(roomLabel, presetId)
    this.roomPresetsDirty.set(roomId, presetId)
    this.scheduleRoomPresetsFlush()
    this.diag.log(`roomPresets set room=${roomId} name=${roomLabel} preset=${presetId} reason=${reason}`)
  }

  /** 把 roomPresets 内存态防抖写回 settings 用户层（path 寻址 mutate，无读改写竞态）。 */
  private scheduleRoomPresetsFlush(): void {
    if (this.roomPresetsTimer !== undefined) clearTimeout(this.roomPresetsTimer)
    this.roomPresetsTimer = setTimeout(() => {
      this.roomPresetsTimer = undefined
      if (this.roomPresetsDirty.size === 0) return
      const dirty = new Map(this.roomPresetsDirty)
      this.roomPresetsDirty.clear()
      this.flushRoomPresetsNow(dirty)
    }, 1000)
  }

  /** 立即把一批岗位增量写入状态文件（0.1.7：替代 settings 用户层，供 stop/冲刷时兜底）。 */
  private flushRoomPresetsNow(dirty: Map<string, string | undefined>): void {
    if (dirty.size === 0) return
    try {
      this.state.applyRoomPresetDeltas(dirty)
      this.diag.log(`roomPresets persisted to state.json ops=${dirty.size}`)
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix-agent] roomPresets persist failed: %s', messageOf(error))
      this.diag.log(`roomPresets persist FAILED: ${messageOf(error)}`)
    }
  }

  /** 停用时清理岗位防抖定时器并冲刷未写回的增量。 */
  private disposeRoomPresetsFlush(): void {
    if (this.roomPresetsTimer !== undefined) {
      clearTimeout(this.roomPresetsTimer)
      this.roomPresetsTimer = undefined
    }
    if (this.roomPresetsDirty.size > 0) {
      const dirty = new Map(this.roomPresetsDirty)
      this.roomPresetsDirty.clear()
      this.flushRoomPresetsNow(dirty)
    }
  }

  /** 列出本账号当前所有绑定房间的岗位视图（jobBoard 行）。供 MatrixBridge 聚合发布。 */
  jobBoardRows(): JobBoardRow[] {
    const rows: JobBoardRow[] = []
    for (const [roomId, handle] of this.roomAgents) {
      const pinned = { value: false }
      const presetId = this.roomPresetFor(roomId, pinned)
      rows.push({
        roomId,
        roomName: this.roomNameCache.get(roomId) ?? roomId,
        presetId,
        pinned: pinned.value,
        sessionId: handle.agent.id,
        hasProduced: this.sessionHasProduced(handle.agent),
      })
    }
    // 已绑定会话但当前无 live agent 的房间（重启后未 resume）也纳入视图。
    for (const roomId of this.state.roomIds()) {
      if (this.roomAgents.has(roomId)) continue
      const pinned = { value: false }
      const presetId = this.roomPresetFor(roomId, pinned)
      rows.push({
        roomId,
        roomName: this.roomNameCache.get(roomId) ?? roomId,
        presetId,
        pinned: pinned.value,
        sessionId: this.state.roomSession(roomId),
      })
    }
    return rows
  }

  /** 该 agent 会话是否已产出内容（供「切换岗位需新建会话」判定）。 */
  private sessionHasProduced(agent: Agent): boolean {
    try {
      const session = (agent as unknown as { session?: { events?: unknown[]; header?: { agentPreset?: string } } }).session
      if (session === undefined || !Array.isArray(session.events)) return false
      // 产出内容 = 出现过 assistant 消息或工具调用（比空会话多任何 model-visible 内容）。
      return session.events.some((e) => {
        const ev = e as { type?: string }
        return ev?.type === 'assistant/message' || ev?.type === 'turn/start' || ev?.type?.startsWith('agent/')
      })
    } catch {
      return false
    }
  }

  /**
   * 提取会话的「历史要点摘要」：从会话派生消息（deriveMessages）里取最近若干条
   * user/assistant 消息的文本，逐条截断后拼接。用于切换岗位时把旧上下文同步进新会话
   * （summary 而非全文，符合「切换岗位=新建会话+摘要同步」的产品约定）。
   * 纯文本截断（见 format.ts buildSessionSummary），无 LLM 调用，不阻塞切换流程。
   */
  private extractSessionSummary(agent: Agent): string {
    try {
      const session = (agent as unknown as { session?: { deriveMessages?(): unknown[] } }).session
      if (session === undefined || typeof session.deriveMessages !== 'function') return ''
      return buildSessionSummary(session.deriveMessages())
    } catch {
      return ''
    }
  }

  /**
   * 外部（设置页/其它账号）改了 settings 用户层 roomModes 后的热更同步（MatrixBridge 分发）。
   * settings 是持久权威：以它的键（roomId 或群名）为准重建「钉死键」；
   * 群名别名（roomId → 群名缓存里反查）一并重建，使 roomModeFor 的按名回退不失效。
   * 自己 flushRoomModesNow 的回声也走这里（幂等覆盖同值，无副作用）。
   */
  syncRoomModesFromSettings(raw: unknown): void {
    const next = normalizeRoomModes(raw)
    // 钉死键重建：settings 里的非 auto 值 + config base 静态键（永不因回声丢失）。
    const pinned = new Map<string, RoomMode>()
    for (const [key, mode] of Object.entries(next)) {
      if (mode !== 'auto') pinned.set(key, mode)
    }
    for (const key of this.roomModesBaseKeys) {
      const mode = this.roomModesMem.get(key)
      if (mode !== undefined && mode !== 'auto') pinned.set(key, mode)
    }
    // 群名别名重建：roomId 已钉死且 roomNameCache 有群名 → 别名也钉（roomModeFor 按名回退）。
    const alias = new Map<string, RoomMode>()
    for (const [roomId, name] of this.roomNameCache) {
      const m = pinned.get(roomId)
      if (m !== undefined && name !== roomId) alias.set(name, m)
    }
    this.roomModesMem.clear()
    for (const [key, mode] of pinned) this.roomModesMem.set(key, mode)
    for (const [key, mode] of alias) {
      if (!this.roomModesMem.has(key)) this.roomModesMem.set(key, mode)
    }
    this.diag.log(`roomModes sync from settings: pinned=${pinned.size} alias=${alias.size}`)
  }

  /** 显式设置某房间的群工作模式（口播指令/设置页共用入口）：更新内存并安排写回 settings。
   * mode='auto' 视为「取消钉死」：删除该房间的显式配置，回到默认自适配（settings 层 unset 键）。 */
  private async setRoomMode(roomId: string, mode: RoomMode, reason: string): Promise<void> {
    const roomLabel = await this.roomDisplayName(roomId)
    if (mode === 'auto') {
      // 取消钉死：删除 roomId 与群名两个键位的显式记录。
      const hadRoom = this.roomModesMem.delete(roomId)
      const hadName = roomLabel !== roomId ? this.roomModesMem.delete(roomLabel) : false
      if (hadRoom || hadName) {
        this.roomModesDirty.set(roomId, undefined)
        this.scheduleRoomModesFlush()
        this.diag.log(`roomModes unset room=${roomId} name=${roomLabel} reason=${reason}`)
      }
      try {
        await this.safeSend(roomId, `已把「${roomLabel !== roomId ? roomLabel : '本群'}」恢复为自动模式：我会按群内消息情况自行判断，需要时可随时指定并行或协同。`, undefined)
      } catch { /* 确认失败静默 */ }
      return
    }
    this.roomModesMem.set(roomId, mode) // roomId 精确键优先（群名可能变化）
    if (roomLabel !== roomId) this.roomModesMem.set(roomLabel, mode) // 群名键方便设置页/人读
    this.roomModesDirty.set(roomId, mode)
    this.scheduleRoomModesFlush()
    this.diag.log(`roomModes set room=${roomId} name=${roomLabel} mode=${mode} reason=${reason}`)
    // 群内确认回复（口播指令成功落配置后向群里播报，让用户明确知道已生效）。
    const confirm = modeConfirmText(mode, roomLabel !== roomId ? roomLabel : '本群')
    try {
      await this.safeSend(roomId, confirm, undefined)
    } catch {
      // 确认回复失败静默：模式已生效，不影响后续。
    }
  }

  /**
   * 模式指令裁决与消费（关键词 + LLM 双保险）：
   * 满足 shouldApplyModeDirective 才落配置；命中且近纯指令（无夹带任务）时整条吞掉
   * 不再转发 worker；夹带任务则仅落模式、消息照常走 deliver。返回 true=已消费（本消息不再转 worker）。
   */
  private async applyModeDirectiveIfAny(roomId: string, text: string, hint: ModeDirective | undefined, llmMode: RoomMode | undefined, pure: boolean): Promise<boolean> {
    if (hint === undefined) return false
    if (!shouldApplyModeDirective(hint, llmMode, text)) {
      this.diag.log(`roomModes directive rejected room=${roomId} hint=${hint.mode}(${hint.strong ? 'strong' : 'weak'}) llm=${llmMode ?? 'no'}`)
      return false
    }
    this.diag.log(`roomModes directive accepted room=${roomId} mode=${hint.mode} strong=${hint.strong} llm=${llmMode ?? 'no'} pure=${pure}`)
    // 已钉死同模式则不必重复确认回复（避免每条设置消息都播报）。
    const current = this.roomModeFor(roomId)
    if (current !== hint.mode) {
      await this.setRoomMode(roomId, hint.mode, 'voice-directive')
    }
    return pure
  }

  /**
   * 把 roomModes 内存态防抖写回 settings 用户层（path 寻址 mutate，无读改写竞态）。
   * 直写 `dsh-matrix` ns 的 roomModes.房间键；settings 服务不可用/写失败静默（配置仍在内存生效）。
   */
  private scheduleRoomModesFlush(): void {
    if (this.roomModesTimer !== undefined) clearTimeout(this.roomModesTimer)
    this.roomModesTimer = setTimeout(() => {
      this.roomModesTimer = undefined
      if (this.roomModesDirty.size === 0) return
      const dirty = new Map(this.roomModesDirty)
      this.roomModesDirty.clear()
      this.flushRoomModesNow(dirty)
    }, 1000)
  }

  /** 立即把一批群模式增量写入状态文件（0.1.7：替代 settings 用户层，供 stop/冲刷时兜底）。 */
  private flushRoomModesNow(dirty: Map<string, RoomMode | undefined>): void {
    if (dirty.size === 0) return
    try {
      this.state.applyRoomModeDeltas(dirty)
      this.diag.log(`roomModes persisted to state.json ops=${dirty.size}`)
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix-agent] roomModes persist failed: %s', messageOf(error))
      this.diag.log(`roomModes persist FAILED: ${messageOf(error)}`)
    }
  }

  /** 停用时清理群模式防抖定时器并冲刷未写回的增量（防残留写回/丢失）。 */
  private disposeRoomModesFlush(): void {
    if (this.roomModesTimer !== undefined) {
      clearTimeout(this.roomModesTimer)
      this.roomModesTimer = undefined
    }
    if (this.roomModesDirty.size > 0) {
      const dirty = new Map(this.roomModesDirty)
      this.roomModesDirty.clear()
      this.flushRoomModesNow(dirty)
    }
  }

  private async deliver(roomId: string, text: string, sender?: string, imageRefs?: ImageAttachmentRef[], mentioned = false, taskLike = false): Promise<void> {
    // 在场自动再请示：若本房间有「秘书等主人答复」的挂起记录，且主人（owner）在本
    // 房间发言，说明主人已现身——向秘书会话 followup 一条「主人已在场」提醒，让它
    // 有机会再次上呈/推进，而非一直干等。秘书不对外发群（红线），故不存在
    // 「worker 等秘书 → 秘书在群里发言」的自然触发；worker 等秘书的唤醒由秘书
    // matrix_reply_worker 晚答复承担（replyWorkerAtomic → pendingReasks 命中）。
    // 只提醒一次：提醒后清除挂起记录，避免反复打扰。
    const reask = this.getPendingReask(roomId, 'owner')
    if (reask !== undefined && sender !== undefined && sender !== '') {
      const isOwnerMessage = this.owner !== undefined && sender === this.owner
      const waitForOwnerBySecretary = reask.initiatorSessionId === this.secretarySessionId()
      if (waitForOwnerBySecretary && isOwnerMessage) {
        this.removePendingReask(roomId, 'owner')
        const verb = reask.kind === 'clarify' ? '请示' : '汇报'
        const note = text.slice(0, 80)
        const reminder = [
          `【主人已在场】你之前发起的${verb}（${reask.roomLabel.slice(0, 100)}）还没有得到主人答复。`,
          `主人刚在群里发言：${note}${note.length < text.length ? '…' : ''}`,
          '如果仍需要主人拍板，请趁现在再次上呈；若已自行解决可忽略本条。',
        ].join('\n')
        this.ctx.logger.info('[dsh-matrix-agent] reask reminder sent room=%s waitFor=owner by %s', roomId, sender)
        void this.wakePendingWaiter(roomId, reask.initiatorSessionId, 'remind', undefined, reminder)
      }
    }
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
    // 单例任务看板（per-room bridge state）：worker 接到任务即标记忙碌，作为前台接待层「是否忙」的唯一真相。
    // 不再依赖未实现的 session/event(turn/start)，改为在 deliver（真正的任务注入点）置位。
    // 只在「像任务」（taskLike）时置忙——纯对话/确认/问答消息（同事说「收到，辛苦了」
    // 「这个功能怎么实现的」）worker 秒回，不该算「忙」。否则 worker 交付完清单后同事的
    // 验收确认也会把 worker 重新置忙，导致后续消息全部触发「手头正忙」占位累积
    // （channel 层过滤了自己消息回流，roomBusy 只能靠实质交付/新任务覆盖来清）。
    if (taskLike) {
      this.roomBusy.set(roomId, { since: Date.now(), label: text.slice(0, 24) })
    }
    // 任务跟进（阶段 1）：外部 @ 派活 → 标记该房间「有待交付」，供 agent/status idle 时检查是否漏发。
    // 判定：text 提及本账号（@userId 或 @localpart）+ 发送者非本账号（外部派活/追问）。
    // mentioned 由 handleMessage 的 isMentioningSelf 判定（合并窗口剥离 @ 前缀后 text 已不含 @）。
    if (mentioned && sender !== undefined && sender !== '' && sender !== this.userId) {
      this.roomPendingReply.set(roomId, { at: Date.now(), label: text.slice(0, 24), remindCount: 0, lastRemindAt: 0 })
    }
    if (taskLike || (mentioned && sender !== undefined && sender !== '' && sender !== this.userId)) {
      this.publishTaskBoardSnapshot()
    }
    // 阶段2：机制强制「开工请示」——像任务的 @消息先问秘书，批准才真正下发干活。
    // 只对「像任务」（taskLike，非纯问答）+ 外部派活者 + 非 owner 触发；同房间请示未决时不重复。
    if (
      taskLike && mentioned && sender !== undefined && sender !== '' && sender !== this.userId &&
      !(this.owner !== undefined && sender === this.owner) &&
      !this.roomPendingClarify.has(roomId)
    ) {
      this.roomPendingClarify.add(roomId)
      this.publishTaskBoardSnapshot()
      this.diag.log(`[dsh-matrix-agent] clarify-gate room=${roomId} asking secretary before start`)
      try {
        const summary = text.replace(/@\S+/g, '').trim().slice(0, 120)
        // 直接请示主人（测试环境 AI BossAgent 自动批准，确定性高）；秘书 LLM 空转不可靠，不依赖。
        const result = await this.requestOwnerFromOwnerAtomic(roomId, `收到任务请示开工，任务内容：${summary}`)
        this.diag.log(`[dsh-matrix-agent] clarify-gate room=${roomId} decision=${result.decision}`)
        if (result.decision === 'rejected') {
          this.roomPendingReply.delete(roomId)
          const rejected = this.receptionText('receptionRejected', { summary: summary.slice(0, 20) })
          if (rejected !== '') void this.safeSend(roomId, rejected, undefined)
          this.publishTaskBoardSnapshot()
          return
        }
        // approved / pending(超时但秘书可能晚批) / timeout：均继续下发（pending 场景 worker 先干，秘书晚批时补充）
      } catch (error) {
        this.ctx.logger.warn('[dsh-matrix-agent] clarify-gate room=%s failed: %s', roomId, messageOf(error))
      } finally {
        this.roomPendingClarify.delete(roomId)
        this.publishTaskBoardSnapshot()
      }
    }
    // 群聊上下文：群名+人数+身份一行前缀，避免 agent 误把群消息当私聊对话。
    // 仅注入房间标签（约 1 行）；完整群聊历史已改由 matrix_get_recent_messages 工具按需获取。
    const label = await this.roomContextLabel(roomId)
    // sender 注入（A 路径安全加固，身份审计建议②）：正文带一行「来自 @xxx」，
    // 让 worker/子代理明确知道每条派活是谁发的。系统事件/内部并行提示不注（见 senderNoteFor）。
    const senderNote = senderNoteFor(sender, this.userId, text)
    const body = `${label}\n${senderNote}${text}`
    const content: ContentBlock[] = [{ type: 'text', text: body }]
    // 入站图片作为多模态内容块附加，让模型直接“看见”图片，
    // 无需再调用文件读取工具（避免 read_image 这类未注册工具导致失败）。
    if (imageRefs !== undefined && imageRefs.length > 0) {
      for (const ref of imageRefs) content.push({ type: 'image', attachment: ref })
    }
    agent.followup(createUserMessage({
      content,
      source: { kind: 'user' },
    }))
  }

  /**
   * 处理主人在私聊房的回复（彻底分层，无任务状态机）。
   * - 回复「批准/交付/可以/ok」→ 置位交付授权（deliveryAuthorized），让 agent 后续发群放行。
   * - 回复目录路径 → 设工作目录并回写经验。
   * - 其它 → 记录为「主人指示」写回时间线，不做状态机动作。
   */
  private async handleOwnerReply(dmRoomId: string, workRoomId: string, reply: string): Promise<void> {
    const trimmed = reply.trim()
    // 入群邀请审批优先：主人对邀请的「批准/拒绝」只需 join/leave + 记名单，不唤醒会话。
    // 必须放在最前——邀请审批与「请示/汇报」共用 approve/deny 词表，但语义完全不同：
    // 前者的 workRoomId 是一个「尚未加入的房间」，后者是「已绑定会话的工作房间」。
    if (this.inviteStore.getPending(workRoomId) !== undefined) {
      const approveWords = /^(批准|同意|可以|进|进群|接受|ok|可以|yes|go|确认|通过|approve)$/i
      const denyWords = /^(拒绝|驳回|不|不进|no|reject|不行|不可以)$/i
      if (approveWords.test(trimmed) || denyWords.test(trimmed)) {
        const decision = approveWords.test(trimmed) ? 'approve' : 'reject'
        const hit = await this.handleInviteDecision(workRoomId, decision)
        this.diag.log(`handleOwnerReply invite room=${workRoomId} decision=${decision} hit=${hit}`)
        await this.safeSend(dmRoomId, decision === 'approve' ? '✅ 已接受入群邀请。' : '🚫 已拒绝该入群邀请。', undefined)
        return
      }
      // 其余回复不改变邀请状态，提示一次可用词。
      await this.safeSend(dmRoomId, '📝 收到。若要对入群邀请表态，请回复「批准」或「拒绝」。', undefined)
      return
    }
    // 目录路径 → 设工作目录 + 回写经验。
    const pathLike = /^(?:用|使用|目录|在|到)?\s*([A-Za-z]:[\\/][^\s]*|(?:\/|~)[^\s]*)$/.exec(trimmed)
    if (pathLike !== null && pathLike[1] !== undefined) {
      const candidate = pathLike[1].replace(/^~/, process.env.USERPROFILE ?? process.env.HOME ?? '')
      if (isAbsolute(candidate) && existsSync(candidate)) {
        this.state.setRoomCwd(workRoomId, candidate)
        await this.safeSend(dmRoomId, `✅ 已设定工作目录：${candidate}。`, undefined)
        return
      }
      await this.safeSend(dmRoomId, `⚠️ 目录不存在或不是绝对路径：${candidate}，请重新指定。`, undefined)
      return
    }
    // 批准/交付词 → 置位交付授权，并 resolve 正在等待主人决策的工具调用。
    const approveWords = /^(批准|交付|开工|开始|ok|可以|yes|go|确认|通过|approve)$/i
    if (approveWords.test(trimmed)) {
      this.deliveryAuthorized.add(workRoomId)
      this.ctx.logger.info('[dsh-matrix-agent] owner authorized delivery for room=%s (dm=%s)', workRoomId, dmRoomId)
      // 只 resolve「秘书会话发起的请示/汇报」的 pending（秘书等主人）；
      // worker 的 pending（等秘书回传）只能由 matrix_reply_worker resolve，不在此串号。
      // 注意：此刻秘书 turn 仍挂起在工具 execute（step 开放），不能往秘书会话 append。
      const pending = this.getOwnerPendingFor(workRoomId, this.secretarySessionId())
      if (pending !== undefined) {
        pending.resolve({ roomId: workRoomId, sent: true, decision: 'approved', reply: trimmed })
      } else if (!this.ownerLateReplyWake(workRoomId, 'approved', trimmed)) {
        // 既无 active pending 也未唤醒成功（无挂起记录或目标会话不在）：仅提示。
        this.ctx.logger.info('[dsh-matrix-agent] owner approve for room=%s: no secretary pending & no reask to wake', workRoomId)
      }
      await this.safeSend(dmRoomId, '✅ 已确认，可以交付。', undefined)
      this.recordTimeline(workRoomId, 'approval', { target: this.owner ?? '' }, 0, 'worker', `✅ 主人批准开工/交付`)
      return
    }
    // 拒绝词 → 撤销授权，并 resolve pending 为 rejected。
    const denyWords = /^(拒绝|驳回|no|reject|不行|不可以)$/i
    if (denyWords.test(trimmed)) {
      this.deliveryAuthorized.delete(workRoomId)
      const pending = this.getOwnerPendingFor(workRoomId, this.secretarySessionId())
      if (pending !== undefined) {
        pending.resolve({ roomId: workRoomId, sent: true, decision: 'rejected', reply: trimmed })
      } else {
        this.ownerLateReplyWake(workRoomId, 'rejected', trimmed)
      }
      await this.safeSend(dmRoomId, '🚫 已拒绝，暂不交付。', undefined)
      this.recordTimeline(workRoomId, 'approval', { target: this.owner ?? '' }, 0, 'worker', `🚫 主人拒绝开工/交付`)
      return
    }
    // 其它：主人给了意见/指示，回一句已收到（agent 可继续请示或等进一步指示）。
    await this.safeSend(dmRoomId, `📝 已收到您的意见：${trimmed.slice(0, 60)}`, undefined)
  }

  /**
   * 主人晚答复唤醒：主人的决策到达时，若对应秘书会话的 pending 已转「挂起待答」
   * （秘书本轮已结束），则 followup 唤醒秘书会话，让它把主人的决策带回 worker。
   * 命中并唤醒返回 true；无挂起记录返回 false（调用方按「无人在等」处理）。
   */
  private ownerLateReplyWake(workRoomId: string, decision: 'approved' | 'rejected', reply: string): boolean {
    const reask = this.getPendingReask(workRoomId, 'owner')
    this.diag.log(`ownerLateReplyWake room=${workRoomId} reask=${reask !== undefined ? `init=${reask.initiatorSessionId} waitFor=owner` : 'none'} decision=${decision}`)
    if (reask === undefined || reask.initiatorSessionId !== this.secretarySessionId()) return false
    this.removePendingReask(workRoomId, 'owner')
    this.popInbox(workRoomId)
    const ok = this.wakePendingWaiter(workRoomId, reask.initiatorSessionId, 'decision', decision, reply)
    this.ctx.logger.info('[dsh-matrix-agent] owner late-reply woke secretary room=%s decision=%s ok=%s', workRoomId, decision, ok)
    return true
  }

  /**
   * 处理 DSH 主人收件箱的决策命令（Client→Host，经 settings ownerDecisionOps 字段）。
   * 与 Matrix 私聊回复等价：找到 workRoomId 对应的阻塞等待，resolve 决策。
   * 收件箱点「批准/交付」→ approve；「拒绝」→ reject。不依赖 Matrix 私聊房路由。
   */
  handleOwnerDecisionOps(ops: OwnerDecisionOps): void {
    const workRoomId = ops.id
    // 入群邀请审批优先：它无 agent turn 挂起，决策只需 join/leave + 记名单，不唤醒会话。
    // 必须先于 pending 分支判断——否则会被「无 secretary pending; ignored」吞掉。
    if (this.inviteStore.getPending(workRoomId) !== undefined) {
      void this.handleInviteDecision(workRoomId, ops.decision === 'approve' ? 'approve' : 'reject')
        .then((hit) => {
          this.ctx.logger.info('[dsh-matrix-agent] owner invite decision via inbox room=%s decision=%s hit=%s', workRoomId, ops.decision, hit)
        })
        .catch((error: unknown) => {
          this.ctx.logger.warn('[dsh-matrix-agent] invite decision failed room=%s: %s', workRoomId, messageOf(error))
        })
      return
    }
    const pending = this.getOwnerPendingFor(workRoomId, this.secretarySessionId())
    // 只 resolve「秘书会话发起的请示/汇报」的 pending；worker 的 pending 由 matrix_reply_worker resolve。
    // 注意：此刻秘书 turn 仍挂起在工具 execute（step 开放），不能往秘书会话 append。
    if (pending !== undefined) {
      if (ops.decision === 'approve') {
        this.deliveryAuthorized.add(workRoomId)
        pending.resolve({ roomId: workRoomId, sent: true, decision: 'approved', reply: ops.reply ?? '批准' })
        this.ctx.logger.info('[dsh-matrix-agent] owner approved via inbox for room=%s', workRoomId)
        this.recordTimeline(workRoomId, 'approval', { target: this.owner ?? '' }, 0, 'worker', `✅ 主人批准开工/交付（工作台）`)
      } else {
        this.deliveryAuthorized.delete(workRoomId)
        pending.resolve({ roomId: workRoomId, sent: true, decision: 'rejected', reply: ops.reply ?? '拒绝' })
        this.ctx.logger.info('[dsh-matrix-agent] owner rejected via inbox for room=%s', workRoomId)
        this.recordTimeline(workRoomId, 'approval', { target: this.owner ?? '' }, 0, 'worker', `🚫 主人拒绝开工/交付（工作台）`)
      }
    } else if (this.ownerLateReplyWake(workRoomId, ops.decision === 'approve' ? 'approved' : 'rejected', ops.reply ?? (ops.decision === 'approve' ? '批准' : '拒绝'))) {
      // 秘书已转挂起待答（本轮已结束），晚答复唤醒秘书会话继续。
      this.ctx.logger.info('[dsh-matrix-agent] owner inbox decision woke secretary for room=%s', workRoomId)
    } else {
      this.ctx.logger.info('[dsh-matrix-agent] owner decision for room=%s but no secretary-owned pending; ignored', workRoomId)
    }
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
          await reply('用法：`/bind <session-id>`（仅 Owner）')
          break
        }
        // Owner 门（安全，身份审计①）：只有 Owner 可以把房间绑定到既有会话，
        // 防止普通群成员把本分身房间绑到别人的/内部的会话上劫持上下文。
        if (this.owner !== undefined && this.owner !== '' && sender !== this.owner) {
          await reply(`❌ 只有 Owner（@${localpartOf(this.owner)}）可以绑定会话。`)
          break
        }
        // 禁绑内部固定会话（秘书/前台接待）：这些会话无房间绑定、天然屏蔽发群，
        // 一旦被 /bind 到房间就会绕过红线直接获得发群能力——必须拒绝。
        const forbidden = FORBIDDEN_BIND_PATTERNS.find((f) => f.test(arg))
        if (forbidden !== undefined) {
          await reply(`❌ 禁止绑定${forbidden.label}（\`${arg}\`）：内部固定会话不能被房间占用。`)
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
      case '/invites': {
        if (this.owner !== undefined && sender !== this.owner) {
          await reply('❌ 只有 Owner 可以查看入群邀请审批。')
          break
        }
        const pending = this.inviteStore.listPending()
        const approved = this.inviteStore.listApproved()
        const denied = this.inviteStore.listDenied()
        const fmt = (r: { userId: string; at: number; roomName?: string }) =>
          `${localpartOf(r.userId)}（${r.userId}）· ${new Date(r.at).toLocaleDateString('zh-CN')}${r.roomName !== undefined ? ` · ${r.roomName}` : ''}`
        const lines = [
          `📨 待批邀请（${pending.length}）：`,
          ...(pending.length === 0
            ? ['（无）']
            : pending.map((p) => `· ${p.inviter !== undefined ? localpartOf(p.inviter) : '(未知邀请人)'} 邀请进 ${this.inviteLabel(p.roomName, p.roomId)}`)),
          '',
          `✅ 已批准邀请人（${approved.length}，TA 的邀请直接进群）：`,
          ...(approved.length === 0 ? ['（无）'] : approved.map(fmt)),
          '',
          `🚫 已拒绝邀请人（${denied.length}，TA 的邀请直接静默拒绝）：`,
          ...(denied.length === 0 ? ['（无）'] : denied.map(fmt)),
          '',
          '命令：/invite-allow <userId> · /invite-deny <userId> · /invite-forget <userId>',
        ]
        await reply(lines.join('\n'))
        break
      }
      case '/invite-allow':
      case '/invite-deny': {
        if (this.owner !== undefined && sender !== this.owner) {
          await reply('❌ 只有 Owner 可以管理入群邀请审批。')
          break
        }
        if (arg === '') {
          await reply(`用法：\`${command} <userId>\``)
          break
        }
        const decision = command === '/invite-allow' ? 'approve' : 'deny'
        if (decision === 'approve') this.inviteStore.approve(arg, roomId)
        else this.inviteStore.deny(arg, roomId)
        await reply(decision === 'approve'
          ? `✅ 已批准 \`${arg}\`：以后 TA 邀请我直接进群。`
          : `🚫 已拒绝 \`${arg}\`：以后 TA 的邀请直接静默拒绝。`)
        break
      }
      case '/invite-forget': {
        if (this.owner !== undefined && sender !== this.owner) {
          await reply('❌ 只有 Owner 可以管理入群邀请审批。')
          break
        }
        if (arg === '') {
          await reply('用法：`/invite-forget <userId>`')
          break
        }
        const ok = this.inviteStore.forget(arg)
        await reply(ok ? `✅ 已清除 \`${arg}\` 的邀请审批记忆（下次邀请会重新请示你）。` : `⚠️ \`${arg}\` 没有批准/拒绝记录。`)
        break
      }
      default:
        await reply(`未知命令 \`${command ?? ''}\`，发送 /help 查看帮助。`)
    }
  }

  /** ---------- 出站投递 ---------- */

  handleSessionEvent(session: Session, event: SessionEvent): void {
     const roomId = this.roomForSession(session.id)
     // 前台接待会话（无房间绑定）：只消费它的 assistant/message 判定输出，
     // 其它事件忽略。判定输出 resolve 给 receptionPending 的等待者。
     if (roomId === undefined && this.receptionPending.length > 0 && session.id === this.receptionSessionId()) {
       if (event.type === 'assistant/message') {
         const ev = event as Extract<SessionEvent, { type: 'assistant/message' }>
         const text = (ev.data.message.content ?? [])
           .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
           .map((b) => b.text)
           .join('\n')
         const trimmed = text.trim()
         if (trimmed !== '') {
           const waiter = this.receptionPending.shift()
           waiter?.settle(trimmed)
         }
       } else if (event.type === 'turn/end') {
         // 本轮结束但没产出文本（如空回复/异常）：settle undefined 触发调用方降级。
         const waiter = this.receptionPending.shift()
         waiter?.settle(undefined)
       }
       return
     }
     if (roomId === undefined) return
     const verbosity = this.roomVerbosity.get(roomId) ?? 'result'
     const data = event.data as any
     // 用 string 比较放宽收窄，兼容宿主未导出的 'llm/retry' 等事件类型。
     switch (event.type as string) {
       case 'turn/start':
         // 新一轮：清空「本轮已显式发言」标记（见 assistant/message 的 DM 去重）。
         this.turnOutboundRooms.delete(roomId)
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

         // 自我时间线不记逐工具调用（噪音）；只记里程碑（reply/approval/proactive 等）。工具级审计看 chatlog（tools.ts execute 打点）。


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
         // 彻底分层：数字分身（有 owner）的工具结果（含错误）是 agent 内部过程，
         // 不自动发群；只有 agent 显式 matrix_send_room_message 才对外发言。
         if (this.owner !== undefined && this.owner !== '') break
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
         // 彻底分层：数字分身（配置了 owner）的 assistant/message 是「内心独白/过程」，
         // 不自动发群；对外发言必须由 agent 显式调用 matrix_send_room_message。
         // 真人主助手（无 owner）保持原行为：assistant/message 直接发群。
         //
         // ⭐ 私聊房例外（治本）：私聊房听众只有主人一人，「内心独白泄群」风险为零；
         // 吞掉它会让主人私聊分身时「等半天没反应」（实测 agentPreset=standard 时
         // 模型根本不知道要调 matrix_send_room_message；7 个岗位 preset 的 persona
         // 也无此硬禁令 → 回复全被吞）。故 DM 房直接投递，任何 preset 都生效。
         // 去重：本轮 agent 若已用工具显式发过（turnOutboundRooms），不再自动重投。
         const isDmRoom = this.dmRoomCache.get(roomId) === true
         const alreadySent = this.turnOutboundRooms.has(roomId)
         if (this.owner === undefined || this.owner === '' || (isDmRoom && !alreadySent)) {
           const text = assistantVisibleText(event as Extract<SessionEvent, { type: 'assistant/message' }>, verbosity)
           if (text !== undefined) {
             this.diag.log(`assistant-message room=${roomId} isDm=${isDmRoom} alreadySent=${alreadySent} deliver=true len=${text.length}`)
             void this.deliverText(roomId, text)
           }
         } else {
           this.diag.log(`assistant-message room=${roomId} isDm=${isDmRoom} alreadySent=${alreadySent} deliver=false (内心独白不投递)`)
         }
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

  /** 分身自己发出消息的摘要：去首尾空白/换行后取前 60 字（仅分身产出，非同事内容）。 */
  private timelineExcerpt(plain: string): string {
    const t = (plain ?? '').replace(/\s+/g, ' ').trim()
    if (t === '') return ''
    return t.length > 60 ? t.slice(0, 60) + '…' : t
  }

  /** 时间线条目的「回复对象」：显式 target 优先，否则该房间最近一位外部发言者。 */
  private timelineTarget(roomId: string, meta?: { tool?: string; target?: string }): string | undefined {
    if (meta?.target !== undefined && meta.target !== '') return meta.target
    const last = this.lastSenderByRoom.get(roomId)
    if (last !== undefined && last !== '') return last
    return undefined
  }

  private async safeSend(roomId: string, plain: string, html?: string, kind?: TimelineKind, meta?: { tool?: string; target?: string }, actor?: 'secretary' | 'worker'): Promise<void> {
    // 记录自我时间线（仅元数据，旁路；失败静默，绝不影响发送）。
    const target = this.timelineTarget(roomId, meta)
    this.recordTimeline(roomId, kind ?? 'reply', target !== undefined ? { ...meta, target } : meta, plain.length, actor, this.timelineExcerpt(plain))
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
  private recordTimeline(roomId: string, kind: TimelineKind, meta?: { tool?: string; target?: string }, charCount?: number, actor?: 'secretary' | 'worker', excerpt?: string): void {
    if (this.config.timelineEnabled === false) return
    this.timeline.record({
      roomId,
      kind,
      ...(actor !== undefined ? { actor } : {}),
      ...(meta?.tool !== undefined ? { tool: meta.tool } : {}),
      ...(meta?.target !== undefined ? { target: meta.target } : {}),
      ...(charCount !== undefined ? { charCount } : {}),
      ...(excerpt !== undefined && excerpt !== '' ? { excerpt } : {}),
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
    const allowed = await this.approveProactiveSendInner(toolName, args, exec)
    // 放行的「显式发言」记账：DM 房 assistant/message 自动投递据此去重
    // （本轮 agent 已自己发过 → 不再把同一条文本自动重投一遍）。
    if (allowed && (toolName === 'matrix_send_room_message' || toolName === 'matrix_send_dm')) {
      const explicit = typeof args.roomId === 'string' && args.roomId.length > 0 ? args.roomId : undefined
      const sessionId = exec.agent?.id
      const targetRoom = explicit ?? (sessionId !== undefined ? this.roomForSession(sessionId) : undefined)
      if (targetRoom !== undefined) this.turnOutboundRooms.add(targetRoom)
    }
    return allowed
  }

  /** 授权判定的实体（见 {@link approveProactiveSend} 的记账包装）。 */
  private async approveProactiveSendInner(
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
    // 彻底分层红线：数字分身（有 owner）对外发言（matrix_send_room_message / matrix_mention_member）
    // 只受「交付授权」门控（先 matrix_report_owner 等主人「交付」），不再走 proactiveSend 审批
    // （那是真人主助手主动发言的机制）。这是「交付物先私发主人→确认后发群」的兜底，
    // 防 agent 跳过 skill 流程直接发群，也防 @成员 这类主动发言在群里泄露「审批/排队」提示。
    // matrix_send_dm 例外：它本就是私聊（发给 owner 或指定用户），不对外发群，可继续走通用审批。
    // 测试房间豁免：房间名命中 testRoomPrefix（如「【测试】」）时，数字分身在该群的
    // 普通对话发言（回复追问/问答/闲聊）直接放行——测试群无真实 owner，本就不走
    // 「汇报→等交付」链路；若仍要模拟交付门禁可在测试里显式验证。真实群不受影响。
    // 澄清提问豁免（情形 1：任务没说清楚 → @ 派活的同事问清需求）：
    // 交付门禁保护的是「对外承诺产出」（结果/报告/结论），须 Owner 把关；而需求澄清问的是
    // 「你刚才说的 X 指哪个」——只有派活人能答，Owner 无从代答。若也要求 Owner 批准，
    // 疑问只能憋在内部（与 communication 技能红线冲突：严禁把需要对方回答的疑问只留内部）。
    // 故本工具单独放行，不走交付授权门控。注意：不调 noteOutboundSent——那是「实质交付」信号，
    // 提问不代表任务已完成，清 pendingReply 会导致后续不再跟进该任务。
    if (toolName === 'matrix_ask_requester') {
      this.diag.log(`approveProactiveSend tool=${toolName} room=${roomId} clarify-exempt; allow`)
      return true
    }
    if ((toolName === 'matrix_send_room_message' || toolName === 'matrix_mention_member') && this.config.testRoomPrefix !== undefined && this.config.testRoomPrefix !== '') {
      const test = await this.isTestRoom(roomId)
      if (test) {
        this.diag.log(`approveProactiveSend tool=${toolName} room=${roomId} test-room bypass; allow`)
                this.noteOutboundSent(roomId, toolName, typeof args.text === 'string' ? args.text : undefined)
      return true
      }
    }
    if ((toolName === 'matrix_send_room_message' || toolName === 'matrix_mention_member') && this.owner !== undefined && this.owner !== '') {
      // 三态门控：只有 owner 明确「在场」（=== true）才直接放行；明确「不在场」（false）
      // 或「不确定」（undefined，成员列表获取失败/为空）都要求交付授权（fail-closed）。
      // 之前用 `=== false` 判定 ownerAbsent，导致 isOwnerInRoom 返回 undefined 时被误判
      // 为「在场」而跳过请示直接发群。
      const ownerPresent = (await this.isOwnerInRoom(roomId)) === true
      if (!ownerPresent && !this.deliveryAuthorized.has(roomId)) {
        this.diag.log(`approveProactiveSend tool=${toolName} room=${roomId} owner not confirmed present & not delivery-authorized; deny`)
        // 抛带明确指引的错误，让 agent 知道下一步是先私下汇报主人，而非直接在群里发。
        throw new Error('还没到发群的时候：请先把整理好的结果私下汇报给主人，等主人回复「交付」后，再把结果发到群里。')
      }
      // 已获授权（或主人明确在场）：放行，不再走 proactiveSend 审批。
      this.diag.log(`approveProactiveSend tool=${toolName} room=${roomId} delivery-authorized (or owner present); allow`)
            this.noteOutboundSent(roomId, toolName, typeof args.text === 'string' ? args.text : undefined)
      return true
    }
    if (!this.isRedline(toolName) && this.authStore.isStandingAuthorized(this.userId, roomId, toolName, this.config.redlineTools ?? [])) {
      this.diag.log(`approveProactiveSend tool=${toolName} room=${roomId} standing auth; allow`)
            this.noteOutboundSent(roomId, toolName, typeof args.text === 'string' ? args.text : undefined)
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
            this.noteOutboundSent(roomId, toolName, typeof args.text === 'string' ? args.text : undefined)
      return true
    }
    return false
  }

  /**
   * 阶段 1 任务跟进：worker 用工具对外发群（放行）时记录。
   * 区分「占位回复」与「实质交付」：
   *  - 占位（如"收到，我来整理""收到👌"等承诺词、无实质内容）只更新 lastOutboundAt，不清 pendingReply——
   *    因为任务还没真正交付，idle 后仍要跟进。
   *  - 实质回复/交付（内容够长或有实际结论）清除 pendingReply，视为任务完成。
   * 同时：实质交付 = worker 不再忙 → 同步清除 roomBusy（channel 层过滤了自己消息回流，
   * handleMessage 的 sender===userId 分支永远不会执行，busy 必须在此主动清，否则会一直挂到
   * 下一条外部消息触发 ack，造成「同事已确认收货 worker 还在补发手头正忙占位」的累积）。
   */
  private noteOutboundSent(roomId: string | undefined, toolName: string, text?: string): void {
    if (roomId === undefined) return
    if (toolName !== 'matrix_send_room_message' && toolName !== 'matrix_mention_member') return
    this.roomLastOutboundAt.set(roomId, Date.now())
    const raw = (text ?? '').trim()
    // 占位特征：短 或 以「收到/好的/了解/OK/👌」开头且含 整理/稍后/马上/我来/正在/这就 等承诺词。
    const isPlaceholder = raw.length < 8 ||
      (/^(收到|好的|了解|ok|👌|嗯|好|行)/i.test(raw) && /(整理|稍后|马上|我来|正在|这就|回头|先记|稍等)/.test(raw))
    if (!isPlaceholder) {
      const had = this.roomPendingReply.delete(roomId)
      if (had) this.diag.log(`[dsh-matrix-agent] outbound-sent (real) room=${roomId}; pendingReply cleared len=${raw.length}`)
      // 实质交付/回复 → worker 不再忙：清除忙碌标记，避免后续同事消息被误判为「忙时追问」触发占位 ack。
      if (this.roomBusy.delete(roomId)) {
        this.diag.log(`[dsh-matrix-agent] outbound-sent (real) room=${roomId}; roomBusy cleared (substantive reply)`)
      }
      if (had) this.publishTaskBoardSnapshot()
    } else {
      this.diag.log(`[dsh-matrix-agent] outbound-sent (placeholder) room=${roomId} len=${raw.length}; pendingReply kept`)
    }
  }

  /**
   * 阶段 1 任务跟进（由 MatrixBridge 的 agent/status 订阅分发）：
   * 该房间 agent 这轮干完（status=idle）却仍有待交付（roomPendingReply）且本轮未对外发群
   * （roomLastOutboundAt 缺失或早于任务开始）→ 说明 worker 把回复写成内心独白没发出去。
   * 前台接待 followup 一条提醒，重新激活 worker 补发；remindCount 限次防循环。
   */
  async handleAgentStatus(_agentId: string, status: string, roomId: string): Promise<void> {
    // idle 触发作为补充信号；主驱动是 followupTimer 的 checkPendingReplies（长任务中 idle 不触发）。
    // 不在此清除 pendingReply（占位发群也更新 lastOut，不能当完成）；统一交给 remindRoom 判断。
    if (status !== 'idle') return
    await this.remindRoom(roomId)
  }

  /** 阶段 1：超时轮询——扫所有待交付房间，超时未实质交付则提醒/代发。 */
  private async checkPendingReplies(): Promise<void> {
    this.diag.log('[dsh-matrix-agent] followup poll pending=' + this.roomPendingReply.size)
    const now = Date.now()
    const due: string[] = []
    // 注意：不清除 pendingReply——它只由 noteOutboundSent 的「实质交付」分支清除；
    // 占位发群（"收到，我来整理"）也会更新 roomLastOutboundAt，不能当作已完成。
    for (const [roomId, pending] of this.roomPendingReply) {
      if (now - pending.at >= 90_000) due.push(roomId)
    }
    for (const roomId of due) await this.remindRoom(roomId)
    // 周期兜底 publish：即使漏了某个事件触达点，看板也每轮刷新（防 UI 陈旧）。
    this.publishTaskBoardSnapshot()
  }

  /** 提醒一个房间的 worker 补发；remindCount 限次，超次代发占位并移除。 */
  private async remindRoom(roomId: string): Promise<void> {
    const pending = this.roomPendingReply.get(roomId)
    if (pending === undefined) return
    // 距上次提醒 < 60s：不重复打扰。
    if (Date.now() - pending.lastRemindAt < 60_000 && pending.lastRemindAt !== 0) return
    if (pending.remindCount >= 2) {
      // 已提醒 2 次仍无果：前台接待直接替 worker 发一条占位，避免同事空等。
      this.roomPendingReply.delete(roomId)
      this.diag.log(`[dsh-matrix-agent] followup give-up room=${roomId} after ${pending.remindCount} reminds; send placeholder`)
      const giveUp = this.receptionText('receptionGiveUp', { summary: pending.label.slice(0, 20) })
      if (giveUp !== '') void this.safeSend(roomId, giveUp, undefined)
      this.publishTaskBoardSnapshot()
      return
    }
    pending.remindCount += 1
    pending.lastRemindAt = Date.now()
    this.roomPendingReply.set(roomId, pending)
    this.diag.log(`[dsh-matrix-agent] followup-remind room=${roomId} count=${pending.remindCount} label=${pending.label.slice(0, 20)}`)
    this.publishTaskBoardSnapshot()
    try {
      const handle = this.roomAgents.get(roomId)
      if (handle === undefined) {
        this.diag.log(`[dsh-matrix-agent] followup-remind room=${roomId} no bound agent; skip`)
        return
      }
      const label = await this.roomContextLabel(roomId).catch(() => undefined)
      const body = (label !== undefined ? label + '\n' : '') +
        '【系统提醒】你刚才处理的任务似乎还没有把消息发到群里（同事还没收到你的回复）。' +
        '若你已有结论或回答，请立即调用 matrix_send_room_message 把消息发出去；若仍在处理请发一条进度说明。' +
        '注意：只把文字写在回复里不算已发送，必须调用工具才能真正发到群里。'
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: body }],
        source: { kind: 'user' },
      }))
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix-agent] followup-remind room=%s failed: %s', roomId, messageOf(error))
    }
  }

  handleApproval(roomId: string, request: ApprovalRequest): Promise<ApprovalOutcome> {
    const grantable = !this.isRedline(request.toolName)
    if (grantable && this.authStore.isStandingAuthorized(this.userId, roomId, request.toolName, this.config.redlineTools ?? [])) {
      this.ctx.logger.info('[dsh-matrix-agent] %s uses standing auth for `%s` in %s', this.userId, request.toolName, roomId)
      return Promise.resolve('allowed-once')
    }
    return this.askRoom(roomId, request, grantable)
  }

  /**
   * 无主审批兜底：秘书/前台接待/subagent 会话（不绑定工作房间）发起的 approval/request，
   * 没有 roomId 可路由。这里用一个合成房间 key 承载审批队列，并把「问人」走 DM 私聊主人——
   * 绝不再 next() 漏给 web answerer（那会静默 fail-closed，请示到不了主人手机）。
   * grantOnApprove 恒为 false：无主审批不写「(分身, 房间) 记忆授权」——没有真实房间可记，
   * 若用合成 key 会落一条无意义的脏授权记录；且无主场景（秘书/前台自主发起）本就该每次都问主人。
   * 超时 settle('unavailable') 不卡死，与 askRoom 一致。
   */
  handleOwnerlessApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    return this.askRoom(OWNERLESS_APPROVAL_ROOM, request, false)
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
      // 审批「问人」走私聊（DM）给 Owner，不往群聊房间发——请示内容与主人的批准/拒绝
      // 不应被房间其他成员看见。设了 owner 且有 sendDm 能力时走 DM；否则退回房间（旧行为）。
      if (this.owner !== undefined && this.owner !== '' && this.channel.sendDm !== undefined) {
        void this.channel.sendDm(this.owner, text, markdownToHtml(text)).then((dm) => {
          // 记 DM 房 → 工作房间映射，使主人在 DM 房回复「批准/拒绝」时能反查到本审批队列。
          this.ownerDmToWorkRoom.set(dm.roomId, roomId)
        }).catch((error: unknown) => {
          this.ctx.logger.warn('[dsh-matrix-agent] approval DM to owner failed, fallback to room: %s', messageOf(error))
          void this.safeSend(roomId, text, markdownToHtml(text))
        })
      } else {
        void this.safeSend(roomId, text, markdownToHtml(text))
      }
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
  /** 时间线快照写回调（可选）：时间线变更时写入 settings（供 Web 时间线 tab）。 */
  readonly updateTimelineSnapshot?: (snapshot: { entries: unknown[]; updatedAt: number }) => void
  /** 时间线管理命令回调（可选）：设置页 UI 删除/清空后由 Host 清零命令字段。 */
  readonly onTimelineOpsHandled?: () => void
  /** 主人收件箱写回调（可选）：请示/汇报发起时把待批条目写入 settings（供 Web 主人收件箱）。 */
  readonly updateOwnerInbox?: (snapshot: OwnerInboxSnapshot) => void
  /** 主人决策命令回调（可选）：收件箱 UI 点「批准/拒绝」后由 Host 清零命令字段。 */
  readonly onOwnerDecisionOpsHandled?: () => void
  /** 任务看板写回调（可选）：各房间忙/待交付/请示中状态变更时写入 settings（供分身工作台任务 tab）。 */
  readonly updateTaskBoard?: (snapshot: TaskBoardSnapshot) => void
  /** 岗位看板写回调（可选）：已安装岗位/每房间岗位/默认岗位变更时写入 settings（供数字分身岗位设置页）。 */
  readonly updateJobBoard?: (snapshot: JobBoardSnapshot) => void
  /** 岗位切换命令回调（可选）：设置页 UI 切换岗位后由 Host 清零命令字段。 */
  readonly onJobSwitchOpsHandled?: () => void
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
  /** 可变 config：volatile-update 热更后经 applyConfigUpdate() 原地替换引用。 */
  private config: MatrixBridgeOptions
  private readonly authStore: AuthStore
  private readonly accounts: AccountBridge[] = []
  private disposeEvents: (() => void) | undefined
  private disposeApproval: (() => void) | undefined
  /** 岗位看板聚合发布定时器（防抖）。 */
  private jobBoardTimer: ReturnType<typeof setTimeout> | undefined
  /** 已安装岗位缓存（agentPresets.list() 结果），供 jobBoard 聚合。 */
  private installedPresets: Array<{ id: string; name: string; isDefault: boolean }> = []

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
    // 实例命名空间：隔离不同 dsh 实例（端口/profile/DSH_HOME）的同房间会话。
    const sessionNamespace = resolveSessionNamespace(config.instanceKey)
    if (sessionNamespace !== undefined) {
      ctx.logger.info('[dsh-matrix-agent] session namespace: %s', sessionNamespace)
    }

    // 通道工厂：桥接层面向 Channel 接口，具体通道实现（MatrixChannel）在此注入。
    // 后续接其它 IM 时，替换此工厂即可，AccountBridge 逻辑不变。
    const channelFactory = (opts: ChannelOptions): Channel => new MatrixChannel(opts)

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
        channelFactory,
        timeline,
        config.updateTimelineSnapshot,
        config.updateOwnerInbox,
        config.updateTaskBoard,
        config.fetchFn,
        config.sleep,
        sessionNamespace,
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
          channelFactory,
          timeline,
          config.updateTimelineSnapshot,
          config.updateOwnerInbox,
          config.updateTaskBoard,
          config.fetchFn,
          config.sleep,
          sessionNamespace,
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

    // 注：0.1.7 下 roomModes/roomPresets 已改走状态文件（state.json）持久化，autoTune/parallel
    // 为部署固定（非 volatile）参数，均无「设置页热更」场景，故不再订阅 settings 热更事件。

    // ── 任务跟进（阶段 1）：agent/status（idle↔running）→ 分发各账号处理 ──
    try {
      this.ctx.on('agent/status', (payload: { agent?: { id?: string }; status?: string }) => {
        const agentId = payload?.agent?.id ?? ''
        const status = payload?.status ?? ''
        if (agentId === '') return
        for (const account of this.accounts) {
          const rid = account.roomForSession(agentId)
          if (rid !== undefined) {
            try { appendFileSync(join(this.config.stateDir, 'diagnostics.log'), '[agent-status] ' + new Date().toISOString() + ' agent=' + agentId + ' status=' + status + ' room=' + rid + '\n') } catch {}
            account.handleAgentStatus(agentId, status, rid)
            break
          }
        }
      }, { global: true } as never)
      this.ctx.logger.info('[dsh-matrix-agent] agent/status subscribed (task follow-up)')
    } catch (e) {
      this.ctx.logger.warn('[dsh-matrix-agent] agent/status subscribe failed: %s', e instanceof Error ? e.message : String(e))
    }

    this.ctx.inject(['approval'], (approvalCtx) => {
      this.disposeApproval = approvalCtx.on('approval/request', async (req, next) => {
        for (const account of this.accounts) {
          const roomId = account.roomForSession(req.agent.id)
          if (roomId !== undefined) return account.handleApproval(roomId, req)
        }
        // 无主审批兜底：秘书/前台接待/subagent 会话不绑定房间（roomForSession=undefined）。
        // 找到创建该 agent 的账号（会话 id 以 matrix-<localpart(userId)>- 前缀），
        // 走 handleOwnerlessApproval 把「问人」发 DM 私聊主人——绝不 next() 漏给 web
        // answerer（那会静默 fail-closed，请示到不了主人手机，违反「问人必到主人手机」）。
        for (const account of this.accounts) {
          if (account.ownsAgentSession(req.agent.id)) {
            return account.handleOwnerlessApproval(req)
          }
        }
        // 仍无法归属（不属于任何已知账号的 agent）→ 交给下一个 answerer（web），
        // 官方框架会 fail-closed（无 answerer 时 resolve unavailable，不会卡死）。
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

  /** 分发主人决策命令到各账号（收件箱点批准/拒绝），执行后清零命令字段。 */
  handleOwnerDecisionOps(ops: OwnerDecisionOps): void {
    for (const account of this.accounts) {
      account.handleOwnerDecisionOps(ops)
    }
    this.config.onOwnerDecisionOpsHandled?.()
  }

  /**
   * 分发岗位切换命令到各账号（设置页切换岗位），执行后清零命令字段并重发岗位看板。
   * ops.roomId 为空 = 修改全局默认岗位（写入 agent-presets 的 selectedDefault 字段）；
   * 非空 = 修改该房间的 roomPresets（per-room 钉死）。已产出内容的会话切换岗位需新建会话
   * 并同步历史（由 account.switchRoomPreset 处理），见其内部语义。
   */
  async handleJobSwitchOps(ops: JobSwitchOps): Promise<void> {
    const targetPreset = ops.presetId.trim()
    if (targetPreset === '') {
      this.config.onJobSwitchOpsHandled?.()
      return
    }
    if (ops.roomId.trim() === '') {
      // 全局默认岗位：写 agent-presets 的 selectedDefault 字段。
      await this.setDefaultPreset(targetPreset)
    } else {
      for (const account of this.accounts) {
        if (account.ownsRoom(ops.roomId)) {
          await account.switchRoomPreset(ops.roomId, targetPreset)
          break
        }
      }
    }
    this.config.onJobSwitchOpsHandled?.()
    this.scheduleJobBoardPublish()
  }

  /** 写全局默认岗位：经 agent-presets 的 selectedDefault 字段（0.1.7 volatile，agentPresets.defaultId 读它）。 */
  private async setDefaultPreset(presetId: string): Promise<void> {
    try {
      const presets = this.ctx.get('agentPresets') as
        | { defaultId?: string; list?(): Promise<Array<{ id: string; name?: string; default?: boolean }>> }
        | undefined
      // 校验岗位存在，避免写进不存在的 default 导致后续会话全挂。
      const installed = await presets?.list?.()
      const exists = installed?.some((p) => p.id === presetId) ?? false
      if (!exists) {
        this.ctx.logger.warn('[dsh-matrix-agent] setDefaultPreset: unknown preset %s, ignored', presetId)
        return
      }
    } catch { /* list 失败不阻断，直接尝试写 settings */ }
    const settings = this.ctx.get('settings') as
      | { mutate?(ns: string, ops: Array<{ op: 'set'; path: string[]; value?: unknown }>): Promise<void> }
      | undefined
    if (settings?.mutate === undefined) {
      this.ctx.logger.warn('[dsh-matrix-agent] setDefaultPreset: settings service unavailable')
      return
    }
    try {
      await settings.mutate('agent-presets', [{ op: 'set', path: ['selectedDefault'], value: presetId }])
      this.ctx.logger.info('[dsh-matrix-agent] default preset set to %s', presetId)
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix-agent] setDefaultPreset failed: %s', messageOf(error))
    }
  }

  /** 聚合各账号房间岗位行，读取已安装岗位清单，发布 jobBoard 快照（防抖）。 */
  scheduleJobBoardPublish(): void {
    if (this.config.updateJobBoard === undefined) return
    if (this.jobBoardTimer !== undefined) clearTimeout(this.jobBoardTimer)
    this.jobBoardTimer = setTimeout(() => {
      this.jobBoardTimer = undefined
      void this.publishJobBoardSnapshot()
    }, 300)
  }

  /** 读取「用户选的默认岗位」：agent-presets 的 defaultId（= selectedDefault ?? default）。
   *  未设置 / 服务不可用 → undefined（回退到 config.agentPreset）。 */
  private defaultPresetId(): string | undefined {
    try {
      const presets = this.ctx.get('agentPresets') as
        | { defaultId?: string }
        | undefined
      const id = presets?.defaultId
      return id !== undefined && id !== '' ? id : undefined
    } catch {
      return undefined
    }
  }

  /** 立即聚合发布岗位看板快照（读 agentPresets.list() 枚举已安装岗位 + 各账号房间行）。 */
  async publishJobBoardSnapshot(): Promise<void> {
    if (this.config.updateJobBoard === undefined) return
    const defaultId = this.defaultPresetId() ?? 'standard'
    try {
      const presets = this.ctx.get('agentPresets') as
        | { defaultId?: string; list?(): Promise<Array<{ id: string; name?: string; default?: boolean }>> }
        | undefined
      const list = await presets?.list?.()
      this.installedPresets = (list ?? []).map((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        isDefault: p.id === defaultId,
      }))
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix-agent] jobBoard list presets failed: %s', messageOf(error))
    }
    const rows: JobBoardRow[] = []
    for (const account of this.accounts) {
      rows.push(...account.jobBoardRows())
    }
    this.config.updateJobBoard({
      defaultPresetId: defaultId,
      installedPresets: this.installedPresets,
      rows,
      updatedAt: Date.now(),
    })
  }

  async stop(): Promise<void> {
    if (this.disposeEvents !== undefined) {
      this.disposeEvents()
      this.disposeEvents = undefined
    }
    this.disposeApproval?.()
    this.disposeApproval = undefined
    if (this.jobBoardTimer !== undefined) {
      clearTimeout(this.jobBoardTimer)
      this.jobBoardTimer = undefined
    }
    await Promise.allSettled(this.accounts.map((account) => account.stop()))
    this.accounts.length = 0
    await this.authStore.save().catch(() => {})
  }

  /** volatile 字段热更后更新配置引用：传播到各 AccountBridge，使 respondToAll/allowAllUsers 等运行时读取生效。 */
  applyConfigUpdate(next: Config): void {
    // 保留 MatrixBridgeOptions 的额外字段（回调/接缝），只覆盖 Config 部分。
    this.config = { ...this.config, ...next }
    for (const account of this.accounts) {
      account.applyConfigUpdate({ ...this.config })
    }
  }
}
