/**
 * 数字分身灵魂：性格配置、行为统计、灵魂 prompt 渲染。
 *
 * 职责：
 * - 把灵魂配置（persona/style/catchphrase/habits/replyLength）渲染成注入
 *   Matrix room agent system prompt 的中文人格文本（`soulText`，纯函数）；
 * - 采集行为统计（按 session id 前缀 `matrix-` 过滤，只统计 Matrix room
 *   agent 的回复数/字符数/工具调用/活跃时间），供设置页与工具展示；
 * - 注册模型可见工具 `twin_soul_status`（分身可读自己人设与近期行为）；
 * - `deriveDefaultOwner`：从分身账号推导默认 Owner（仅配置页提示用）。
 *
 * 说明：灵魂配置的持久化由 settings 统一管理（`dsh-matrix` ns，见 settings.ts），
 * 本模块不再自注册 settings。行为统计不引入 typert Remote 编译链；Client 设置页
 * 展示「行为模式」时经 `api.sessions.list`（`matrix-` 前缀）自行聚合。
 *
 * @module dsh-matrix-agent/soul
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SoulConfig } from './config.js'

/** 行为统计：单个房间（Matrix room agent）的聚合。 */
export interface RoomSoulStats {
  /** agent session id（形如 matrix-<localpart>-<hash>）。 */
  sessionId: string
  /** 该房间 agent 的回复条数（assistant/message）。 */
  replies: number
  /** 累计回复字符数。 */
  chars: number
  /** 工具调用次数（按工具名）。 */
  tools: Record<string, number>
  /** 最近活跃时间戳（turn/start）。 */
  activeAt: number
}

/** settings namespace 名称。 */
export const SOUL_NS = 'twin-soul'

/** 风格中文标签（展示用）。 */
export const STYLE_LABELS: Record<string, string> = {
  concise: '简洁干练',
  friendly: '亲切友好',
  formal: '正式专业',
  humorous: '幽默风趣',
  sassy: '毒舌犀利',
}

/** 回复长度中文标签（展示用）。 */
export const LENGTH_LABELS: Record<string, string> = {
  short: '简短（一两句）',
  normal: '适中（一段）',
  detailed: '详细（多段）',
}

/** 会话 id 是否属于 Matrix room agent（dsh-matrix-agent 的确定性会话前缀）。 */
export function isMatrixSession(sessionId: string): boolean {
  return sessionId.startsWith('matrix-')
}

/** 行为统计内存镜像：sessionId → stats，有界（超过上限丢弃最旧）。 */
export class SoulStatsCollector {
  private readonly map = new Map<string, RoomSoulStats>()
  private readonly cap: number

  constructor(cap = 200) {
    this.cap = cap
  }

  /** 处理一条 session/event；仅统计 Matrix room agent。 */
  handle(session: Session, event: SessionEvent): void {
    const sessionId = session.id.toString()
    if (!isMatrixSession(sessionId)) return
    const stats = this.statsOf(sessionId)
    const type = event.type as string
    if (type === 'assistant/message') {
      const data = event.data as { message?: { content?: Array<{ type?: string; text?: string }> } }
      const blocks = data?.message?.content ?? []
      let chars = 0
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string') chars += block.text.length
      }
      stats.replies += 1
      stats.chars += chars
    } else if (type === 'tool/call') {
      const name = (event.data as { name?: string })?.name ?? ''
      if (name !== '') stats.tools[name] = (stats.tools[name] ?? 0) + 1
    } else if (type === 'turn/start') {
      stats.activeAt = Date.now()
    }
  }

  private statsOf(sessionId: string): RoomSoulStats {
    let stats = this.map.get(sessionId)
    if (stats === undefined) {
      stats = { sessionId, replies: 0, chars: 0, tools: {}, activeAt: 0 }
      this.map.set(sessionId, stats)
      if (this.map.size > this.cap) {
        // 丢弃最旧（按插入序）。
        const oldest = this.map.keys().next().value
        if (oldest !== undefined) this.map.delete(oldest)
      }
    }
    return stats
  }

  /** 统计快照（纯 JSON，供工具展示）。 */
  snapshot(): { rooms: RoomSoulStats[]; totals: { replies: number; toolCalls: number; topTools: Array<{ name: string; count: number }> } } {
    const rooms = [...this.map.values()].sort((a, b) => b.activeAt - a.activeAt)
    const totals: Record<string, number> = {}
    let replies = 0
    let toolCalls = 0
    for (const room of rooms) {
      replies += room.replies
      toolCalls += Object.values(room.tools).reduce((sum, n) => sum + n, 0)
      for (const [name, count] of Object.entries(room.tools)) totals[name] = (totals[name] ?? 0) + count
    }
    const topTools = Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }))
    return { rooms, totals: { replies, toolCalls, topTools } }
  }

  clear(): void {
    this.map.clear()
  }
}

/** 把灵魂配置渲染为注入 system prompt 的中文人格文本（纯函数，可单测）。 */
export function soulText(config: SoulConfig): string {
  const style = STYLE_LABELS[config.style] ?? config.style
  const parts: string[] = []
  parts.push(`【你的性格】${config.persona}`)
  if (style !== '') {
    parts.push(`说话风格：${style}`)
  } else {
    // 动态模式（style 为空 = 百变员工）：不锁定单一风格，由模型按语境自主选择。
    parts.push('说话风格：不固定，根据当前房间与对话氛围自主选择最合适的语气')
  }
  const length = LENGTH_LABELS[config.replyLength] ?? config.replyLength
  parts.push(`回复习惯：${length}`)
  if (config.habits.trim() !== '') parts.push(`工作习惯：${config.habits.trim()}`)
  if (config.catchphrase.trim() !== '') parts.push(`口头禅：${config.catchphrase.trim()}`)
  return parts.join('\n')
}

/** 把设置用户层合并进灵魂配置（用户层字段存在即覆盖）。 */
export function mergeSoulConfig(base: SoulConfig, user: Partial<SoulConfig> | undefined): SoulConfig {
  if (user === undefined) return { ...base }
  return {
    enabled: user.enabled ?? base.enabled,
    persona: user.persona ?? base.persona,
    style: user.style ?? base.style,
    catchphrase: user.catchphrase ?? base.catchphrase,
    habits: user.habits ?? base.habits,
    replyLength: user.replyLength ?? base.replyLength,
  }
}

/** 灵魂子系统持有状态（供 registerSoul 返回，bridge 读取最新配置）。 */
export interface SoulHandle {
  dispose(): void
  getSoulConfig(): SoulConfig
  getStats(): ReturnType<SoulStatsCollector['snapshot']>
}

/**
 * 从分身账号推导默认 Owner（仅配置页提示用，运行期不做推导）。
 *
 * 规则：分身账号 `@ai-xxxxxx:domain` → Owner 默认 `@xxxxxx:domain`
 * （localpart 去掉 `ai-` 前缀，域名不变）。仅当 localpart 以小写 `ai-` 开头
 * 且去掉前缀后非空时返回；否则返回 undefined。
 *
 * 注意：这是**配置页易用性辅助**。运行期的 owner 解析（AccountBridge）不做
 * 任何推导，显式配置优先、未配置即 undefined。
 *
 * @param userId 分身 Matrix 用户 id，如 '@ai-niukunliang:im-ipm.ict.cmcc'
 * @returns 推导出的 Owner id，或 undefined
 */
export function deriveDefaultOwner(userId: string): string | undefined {
  if (typeof userId !== 'string' || !userId.startsWith('@')) return undefined
  const at = userId.indexOf(':')
  if (at === -1) return undefined
  const local = userId.slice(1, at)
  const domain = userId.slice(at) // ':domain'
  if (!local.startsWith('ai-')) return undefined
  const ownerLocal = local.slice(3)
  if (ownerLocal === '') return undefined
  return '@' + ownerLocal + domain
}

/**
 * 挂载灵魂子系统：
 * - 行为统计收集（session/event）；
 * - 模型工具 `twin_soul_status`（读取由 `getSoulConfig` 提供的当前灵魂配置）。
 *
 * 灵魂配置的持久化由 settings 统一管理（`dsh-matrix` ns，见 settings.ts），
 * 本函数不再自注册 settings；`getSoulConfig` 返回 merged 后的当前灵魂配置。
 * 返回 handle；stop 时 dispose 全部副作用。
 */
export function registerSoul(ctx: Context, getSoulConfig: () => SoulConfig): SoulHandle {
  const collector = new SoulStatsCollector()
  const disposers: Array<() => void> = []

  // 行为统计。
  disposers.push(ctx.on('session/event', (session: Session, event: SessionEvent) => {
    collector.handle(session, event)
  }))

  // 模型工具 twin_soul_status。
  const tools = ctx.get('tools') as { register(tool: unknown): void } | undefined
  if (tools !== undefined) {
    try {
      const tool = defineTool({
        name: 'twin_soul_status',
        description: '读取数字分身的灵魂配置（性格/说话风格/口头禅/工作习惯）与近期行为统计（回复数、Top 工具、活跃房间）。分身可用来了解自己是谁、以及自己最近的活跃情况。',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            properties: {
              config: {
                type: 'object',
                required: true,
                properties: {
                  enabled: { type: 'boolean', required: true },
                  persona: { type: 'string', required: true },
                  style: { type: 'string', required: true },
                  catchphrase: { type: 'string', required: true },
                  habits: { type: 'string', required: true },
                  replyLength: { type: 'string', required: true },
                },
                additionalProperties: false,
              },
              stats: {
                type: 'object',
                required: true,
                properties: {
                  rooms: {
                    type: 'array',
                    required: true,
                    items: {
                      type: 'object',
                      properties: {
                        sessionId: { type: 'string' },
                        replies: { type: 'integer' },
                        chars: { type: 'integer' },
                        tools: { type: 'json' },
                        activeAt: { type: 'integer' },
                      },
                      additionalProperties: false,
                    },
                  },
                  totals: {
                    type: 'object',
                    required: true,
                    properties: {
                      replies: { type: 'integer', required: true },
                      toolCalls: { type: 'integer', required: true },
                      topTools: {
                        type: 'array',
                        required: true,
                        items: {
                          type: 'object',
                          properties: {
                            name: { type: 'string' },
                            count: { type: 'integer' },
                          },
                          additionalProperties: false,
                        },
                      },
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          } as const,
          render: (_args: Record<string, unknown>, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
        },
        timeoutMs: 10_000,
        isConcurrencySafe: () => true,
        async execute() {
          return { config: getSoulConfig(), stats: collector.snapshot() }
        },
      })
      tools.register(tool)
    } catch (error) {
      ctx.logger.warn('[dsh-matrix-agent] twin_soul_status tool registration failed: %s', error instanceof Error ? error.message : String(error))
    }
  }

  return {
    dispose: () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
    getSoulConfig: () => getSoulConfig(),
    getStats: () => collector.snapshot(),
  }
}
