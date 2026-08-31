/**
 * 数字分身统一配置的 settings namespace：把可在设置页编辑的账号级字段与灵魂
 * 字段合并为一个 `dsh-matrix` settings 用户层，构造 bridge 前 merge 进 config。
 *
 * 原则（与 README「整个 config 值替换，不深合并」对齐的扩展）：
 * - 用户层字段存在即覆盖 config 对应字段（优先级：settings 用户层 > yml config）；
 * - `soul` 为嵌套对象，用户层 soul 子字段存在即覆盖（深合并一层）；
 * - 连接类字段（homeserverUrl/accessToken/userId/digitalTwinMode）改动需重启生效，
 *   本模块只负责读 merge，不重建 channel；
 * - 可变字段（respondToAll/allowedUserIds/owner/provider/model/agentPreset/
 *   chunkMaxChars 等）可在运行时经 watch 更新 AccountBridge。
 * - `tasksSnapshot` 是**运行时只读镜像**（非用户配置）：Host 把各房间任务队列
 *   快照写入，供 DSH Web 的任务视图（会话「任务」tab / 「所有任务」面板）读取。
 *
 * @module dsh-matrix-agent/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Config, SoulConfig } from './config.js'
import type { MatrixTask } from './store.js'

/** 文件诊断日志（固定绝对路径 ~/.dsh/dsh-matrix-diag.log + stateDir/.dsh-matrix/diagnostics.log）。 */
function fileLog(stateDir: string, message: string): void {
  const line = `${new Date().toISOString()} [dsh-matrix-agent:settings] ${message}\n`
  const targets = [join(homedir(), '.dsh', 'dsh-matrix-diag.log')]
  try {
    const dir = join(stateDir, '.dsh-matrix')
    mkdirSync(dir, { recursive: true })
    targets.push(join(dir, 'diagnostics.log'))
  } catch { /* 忽略 */ }
  for (const target of targets) {
    try {
      appendFileSync(target, line, 'utf8')
    } catch { /* 忽略 */ }
  }
}

/** settings namespace 名称（单入口单 ns：灵魂 + 账号 + 社交统一存放）。 */
export const MATRIX_NS = 'dsh-matrix'

/** 任务快照：按房间分组 + sessionId↔roomId 映射（供 Client 跳转）。 */
export interface TasksSnapshot {
  /** roomId → 任务列表（按 createdAt 升序）。 */
  rooms: Record<string, MatrixTask[]>
  /** sessionId → roomId（Matrix 会话反查房间）。 */
  sessionRooms: Record<string, string>
  /** 最近更新时间（ms）。 */
  updatedAt: number
}

/** 空任务快照。 */
export function emptyTasksSnapshot(): TasksSnapshot {
  return { rooms: {}, sessionRooms: {}, updatedAt: 0 }
}

/** 时间线管理命令（Client→Host，Host 处理后清零，防重启重放）。 */
export interface TimelineOps {
  /** 非 0 即触发清空（用递增/时间戳唯一值）。 */
  clearSeq: number
  /** 待删除的时间线条目 id。 */
  removeIds: string[]
}

/** 空时间线管理命令。 */
export function emptyTimelineOps(): TimelineOps {
  return { clearSeq: 0, removeIds: [] }
}

/** 秘书工作台操作（Client→Host，Host 处理后清零，防重启重放）。 */
export interface SecretaryOps {
  /** 目标任务 id。 */
  taskId: string
  /** 操作类型。 */
  action: 'approve-start' | 'give-instruction' | 'confirm-deliver' | 'give-feedback' | 'approve' | 'reject' | 'set-cwd'
  /** 指示/意见文本（give-instruction/give-feedback 必填）。 */
  text?: string
  /** 工作目录路径（set-cwd 必填）。 */
  cwd?: string
}

/** 空秘书操作。 */
export function emptySecretaryOps(): SecretaryOps | undefined {
  return undefined
}

/** 灵魂默认配置（与 config.ts 的 soul 默认值一致，默认百变员工）。 */
export const DEFAULT_SOUL: SoulConfig = {
  enabled: true,
  persona: '你是「百变员工」：会根据所在房间的名称、讨论氛围与收到的消息，自动选择最合适的人设与语气（比如在技术群里像靠谱的研发、在需求讨论里像产品经理、面对新同事像乐于帮助的前辈）。你不需要固定一种性格。',
  style: '',
  catchphrase: '',
  habits: '先理解当前对话的语境与对象，再选择合适的人设与语气；如果切换了人设，主动用一句话告知对方你现在以什么角色出现，并提示可以在「数字分身」设置页修改灵魂。',
  replyLength: 'normal',
}

/**
 * 把 settings 用户层 merge 进 config（用户层字段存在即覆盖）。
 * `soul` 子字段做一层深合并（用户层 soul 子键存在即覆盖 base soul 子键）。
 */
export function mergeMatrixConfig(base: Config, user: Record<string, unknown> | undefined): Config {
  if (user === undefined) return base
  const out: Config = { ...base }
  const record = out as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(user)) {
    // 只接受 Config 顶层已有的键；类型收窄交给调用侧。
    if (key === 'soul' && typeof value === 'object' && value !== null) {
      const baseSoul = base.soul ?? DEFAULT_SOUL
      record.soul = {
        enabled: (value as Partial<SoulConfig>).enabled ?? baseSoul.enabled,
        persona: (value as Partial<SoulConfig>).persona ?? baseSoul.persona,
        style: (value as Partial<SoulConfig>).style ?? baseSoul.style,
        catchphrase: (value as Partial<SoulConfig>).catchphrase ?? baseSoul.catchphrase,
        habits: (value as Partial<SoulConfig>).habits ?? baseSoul.habits,
        replyLength: (value as Partial<SoulConfig>).replyLength ?? baseSoul.replyLength,
      }
      continue
    }
    if (key in base) {
      record[key] = value
    }
  }
  return out
}

/** 可变字段名单：settings watch 后可在运行时热更新（无需重启）。 */
export const LIVE_APPLY_KEYS = new Set([
  'respondToAll',
  'allowedUserIds',
  'allowAllUsers',
  'owner',
  'provider',
  'model',
  'agentPreset',
  'chunkMaxChars',
  'mergeTimeoutSecs',
  'approvalTimeoutSecs',
  'maxRetriesBeforeAbort',
  'retryCircuitBreakerEnabled',
  'taskQueueMax',
  'matrixTools',
  'notifyRoomEvents',
  'proactiveSendRequiresApproval',
  'preserveRichText',
  'autoIntroduce',
  'maxSelfIntroMentions',
  'memberMemory',
  'autoGreet',
  'selfIntroTemplate',
  'timelineEnabled',
  'timelineInject',
  'timelineCrossRoom',
  'timelineCap',
  'testRoomPrefix',
  'twinModeRoomPrefix',
  'secretaryGroupDefault',
  'secretaryDmDefault',
  'roomRoles',
  'taskClarifyBeforeStart',
  'taskClarifyTimeoutSecs',
  'taskConfirmBeforeDeliver',
  'taskConfirmTimeoutSecs',
  'taskConfirmTimeoutAction',
  'taskConfirmExemptMatters',
  'soul',
])

/** 连接类字段名单：改动需重启才生效。 */
export const RESTART_KEYS = new Set([
  'homeserverUrl',
  'accessToken',
  'userId',
  'digitalTwinMode',
  'digitalTwins',
  'stateDir',
  'authStoreFile',
  'redlineTools',
  'cwdCandidates',
])

/** 从 config 提取 settings namespace 声明过的字段作为 base（避免多余键）。 */
function pickMatrixBase(config: Config): Record<string, unknown> {
  return {
    homeserverUrl: config.homeserverUrl,
    accessToken: config.accessToken,
    userId: config.userId,
    owner: config.owner,
    respondToAll: config.respondToAll,
    allowedUserIds: config.allowedUserIds,
    allowAllUsers: config.allowAllUsers,
    provider: config.provider,
    model: config.model,
    agentPreset: config.agentPreset,
    chunkMaxChars: config.chunkMaxChars,
    mergeTimeoutSecs: config.mergeTimeoutSecs,
    approvalTimeoutSecs: config.approvalTimeoutSecs,
    maxRetriesBeforeAbort: config.maxRetriesBeforeAbort,
    retryCircuitBreakerEnabled: config.retryCircuitBreakerEnabled,
    taskQueueMax: config.taskQueueMax,
    matrixTools: config.matrixTools,
    notifyRoomEvents: config.notifyRoomEvents,
    proactiveSendRequiresApproval: config.proactiveSendRequiresApproval,
    preserveRichText: config.preserveRichText,
    autoIntroduce: config.autoIntroduce,
    maxSelfIntroMentions: config.maxSelfIntroMentions,
    memberMemory: config.memberMemory,
    autoGreet: config.autoGreet,
    selfIntroTemplate: config.selfIntroTemplate,
    timelineEnabled: config.timelineEnabled,
    timelineInject: config.timelineInject,
    timelineCrossRoom: config.timelineCrossRoom,
    timelineCap: config.timelineCap,
    testRoomPrefix: config.testRoomPrefix,
    twinModeRoomPrefix: config.twinModeRoomPrefix,
    secretaryGroupDefault: config.secretaryGroupDefault,
    secretaryDmDefault: config.secretaryDmDefault,
    roomRoles: config.roomRoles,
    taskClarifyBeforeStart: config.taskClarifyBeforeStart,
    taskClarifyTimeoutSecs: config.taskClarifyTimeoutSecs,
    taskConfirmBeforeDeliver: config.taskConfirmBeforeDeliver,
    taskConfirmTimeoutSecs: config.taskConfirmTimeoutSecs,
    taskConfirmTimeoutAction: config.taskConfirmTimeoutAction,
    taskConfirmExemptMatters: config.taskConfirmExemptMatters,
    soul: config.soul ?? DEFAULT_SOUL,
  }
}

/**
 * 注册 `dsh-matrix` settings namespace（live），返回 merge 后的 config
 * 与 watch 释放器。用户层为空时返回原 config。
 */
export function registerMatrixSettings(
  ctx: Context,
  config: Config,
  options?: { onTimelineOps?: (ops: TimelineOps) => void; onSecretaryOps?: (ops: SecretaryOps) => void; onConfigChange?: (merged: Config) => void },
): { merged: Config; dispose: () => void; getMerged: () => Config; updateTasksSnapshot: (snapshot: TasksSnapshot) => void; updateTimelineSnapshot: (snapshot: { entries: unknown[]; updatedAt: number }) => void; clearTimelineOps: () => void; clearSecretaryOps: () => void } {
  const onTimelineOps = options?.onTimelineOps
  const onSecretaryOps = options?.onSecretaryOps
  const onConfigChange = options?.onConfigChange
  let current = config
  const disposers: Array<() => void> = []
  let snapshotScope: { update(patch: object): Promise<void> } | undefined
  let snapshotTimer: NodeJS.Timeout | undefined
  let pendingSnapshot: TasksSnapshot | undefined
  let timelineTimer: NodeJS.Timeout | undefined
  let pendingTimeline: { entries: unknown[]; updatedAt: number } | undefined

  const settings = ctx.get('settings') as
    | {
        register(ns: string, schema: unknown, options?: { applies?: string; base?: unknown }): {
          get(): unknown
          watch(cb: (next: unknown) => void): () => void
          update(patch: object): Promise<void>
          replace(section: object): Promise<void>
        }
      }
    | undefined

  // 文件诊断：settings 服务是否可用、register 是否执行（不依赖 stdout）。
  fileLog(config.stateDir, `registerMatrixSettings enter: settingsService=${settings !== undefined} stateDir=${config.stateDir}`)

  if (settings !== undefined) {
    try {
      const scope = settings.register(MATRIX_NS, z.object({
        homeserverUrl: z.string().default(''),
        accessToken: z.string().role('secret').default(''),
        userId: z.string().default(''),
        owner: z.string().default(''),
        respondToAll: z.boolean().default(true),
        allowedUserIds: z.array(z.string()).default([]),
        allowAllUsers: z.boolean().default(false),
        provider: z.string().default(''),
        model: z.string().default(''),
        agentPreset: z.string().default('standard'),
        chunkMaxChars: z.number().default(4000),
        mergeTimeoutSecs: z.number().default(5),
        approvalTimeoutSecs: z.number().default(300),
        maxRetriesBeforeAbort: z.number().default(5),
        retryCircuitBreakerEnabled: z.boolean().default(true),
        taskQueueMax: z.number().default(20),
        matrixTools: z.boolean().default(true),
        notifyRoomEvents: z.boolean().default(false),
        proactiveSendRequiresApproval: z.boolean().default(true),
        preserveRichText: z.boolean().default(true),
        autoIntroduce: z.boolean().default(true),
        maxSelfIntroMentions: z.number().default(20),
        memberMemory: z.boolean().default(true),
        autoGreet: z.boolean().default(true),
        selfIntroTemplate: z.string().default('大家好，我是 {{userId}}，很高兴加入这个群。以后有什么需要帮忙的尽管找我，我会尽力配合大家的工作！'),
        timelineEnabled: z.boolean().default(true),
        timelineInject: z.boolean().default(true),
        timelineCrossRoom: z.boolean().default(false),
        timelineCap: z.number().default(500),
        testRoomPrefix: z.string().default('【测试】'),
        twinModeRoomPrefix: z.string().default(''),
        secretaryGroupDefault: z.boolean().default(true),
        secretaryDmDefault: z.boolean().default(false),
        roomRoles: z.dict(z.string()).default({}),
        taskClarifyBeforeStart: z.boolean().default(true),
        taskClarifyTimeoutSecs: z.number().default(120),
        taskConfirmBeforeDeliver: z.boolean().default(true),
        taskConfirmTimeoutSecs: z.number().default(600),
        taskConfirmTimeoutAction: z.union([z.const('hold'), z.const('deliver'), z.const('cancel')]).default('hold'),
        taskConfirmExemptMatters: z.array(z.string()).default([]),
        soul: z.object({
          enabled: z.boolean().default(true),
          persona: z.string().default(''),
          style: z.string().default('friendly'),
          catchphrase: z.string().default(''),
          habits: z.string().default(''),
          replyLength: z.string().default('short'),
        }).default(DEFAULT_SOUL),
        // 运行时只读镜像（非用户配置）：任务视图数据源。用 z.any 宽松校验
        // （任务形状由 Host 归一化，schema 只保证是个对象）。
        tasksSnapshot: z.any().default(emptyTasksSnapshot()),
        // 运行时只读镜像（非用户配置）：自我时间线数据源。
        timelineSnapshot: z.any().default({ entries: [], updatedAt: 0 }),
        // Client→Host 管理命令（非用户配置）：Host 处理后清零，防重启重放。
        timelineOps: z.any().default(emptyTimelineOps()),
        // Client→Host 秘书操作命令（非用户配置）：Host 处理后清零。
        secretaryOps: z.any().default(undefined),
      }), { applies: 'live', base: pickMatrixBase(config) })
      const applyUser = (user: unknown): void => {
        current = mergeMatrixConfig(config, (user ?? {}) as Record<string, unknown>)
        // 配置变化通知（供 index.ts 驱动 bridge 启停：token 缺失时保持插件存活，配置好后自动恢复）。
        if (onConfigChange !== undefined) onConfigChange(current)
        // 检测时间线管理命令（Client→Host）。
        const ops = (user as Record<string, unknown> | undefined)?.timelineOps as TimelineOps | undefined
        if (ops !== undefined && onTimelineOps !== undefined) {
          const active = ops.clearSeq !== 0 || (Array.isArray(ops.removeIds) && ops.removeIds.length > 0)
          if (active) onTimelineOps(ops)
        }
        // 检测秘书操作命令（Client→Host）。
        const sops = (user as Record<string, unknown> | undefined)?.secretaryOps as SecretaryOps | undefined
        if (sops !== undefined && sops.taskId !== undefined && onSecretaryOps !== undefined) {
          onSecretaryOps(sops)
        }
      }
      applyUser(scope.get())
      snapshotScope = scope
      const unsub = scope.watch((next) => applyUser(next))
      disposers.push(unsub)
      fileLog(config.stateDir, `settings register OK: ns=${MATRIX_NS} snapshotScope set`)
    } catch (error) {
      ctx.logger.warn('[dsh-matrix-agent] matrix settings unavailable: %s', error instanceof Error ? error.message : String(error))
      fileLog(config.stateDir, `settings register FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    fileLog(config.stateDir, 'settings service unavailable (ctx.get("settings") === undefined); snapshots will NOT be published')
  }

  /** 防抖写任务快照（运行时镜像，非用户配置）。 */
  const updateTasksSnapshot = (snapshot: TasksSnapshot): void => {
    // 归一化为 schema 兼容的纯 JSON（note/cwd/contextPrompt 可缺省），
    // 避免把含 readonly 对象/类实例的原始任务写进 settings（序列化丢失/污染）。
    const rooms: Record<string, unknown[]> = {}
    for (const [roomId, tasks] of Object.entries(snapshot.rooms)) {
      rooms[roomId] = tasks.map((t) => ({
        id: t.id,
        roomId: t.roomId,
        sender: t.sender,
        text: t.text,
        status: t.status,
        createdAt: t.createdAt,
        ...(t.role !== undefined ? { role: t.role } : {}),
        ...(t.note !== undefined ? { note: t.note } : {}),
        ...(t.cwd !== undefined ? { cwd: t.cwd } : {}),
        ...(t.deliverTo !== undefined ? { deliverTo: t.deliverTo } : {}),
        ...(t.result !== undefined ? { result: t.result } : {}),
        ...(t.clarifyReply !== undefined ? { clarifyReply: t.clarifyReply } : {}),
        ...(t.confirmReply !== undefined ? { confirmReply: t.confirmReply } : {}),
        ...(t.ownerDmRoomId !== undefined ? { ownerDmRoomId: t.ownerDmRoomId } : {}),
        ...(t.contextPrompt !== undefined ? { contextPrompt: t.contextPrompt } : {}),
      }))
    }
    const sessionRooms: Record<string, string> = {}
    for (const [sessionId, roomId] of Object.entries(snapshot.sessionRooms)) {
      sessionRooms[sessionId] = roomId
    }
    const payload: { rooms: Record<string, unknown[]>; sessionRooms: Record<string, string>; updatedAt: number } = {
      rooms,
      sessionRooms,
      updatedAt: snapshot.updatedAt,
    }
    pendingSnapshot = payload as TasksSnapshot
    clearTimeout(snapshotTimer)
    snapshotTimer = setTimeout(() => {
      const next = pendingSnapshot
      pendingSnapshot = undefined
      if (next === undefined || snapshotScope === undefined) {
        console.error('[dsh-matrix-agent] tasks snapshot skipped: next=%s snapshotScope=%s', next === undefined, snapshotScope === undefined)
        fileLog(config.stateDir, `tasks snapshot SKIPPED: next=${next !== undefined} snapshotScope=${snapshotScope !== undefined}`)
        return
      }
      snapshotScope.update({ tasksSnapshot: next }).then(() => {
        console.log('[dsh-matrix-agent] tasks snapshot published rooms=%d', Object.keys(next.rooms).length)
        fileLog(config.stateDir, `tasks snapshot published rooms=${Object.keys(next.rooms).length}`)
      }).catch((error: unknown) => {
        console.error('[dsh-matrix-agent] tasks snapshot write failed: %s', error instanceof Error ? error.message : String(error))
        ctx.logger.warn('[dsh-matrix-agent] tasks snapshot write failed: %s', error instanceof Error ? error.message : String(error))
        fileLog(config.stateDir, `tasks snapshot write FAILED: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, 300)
  }

  /** 防抖写时间线快照（运行时镜像，非用户配置）。 */
  const updateTimelineSnapshot = (snapshot: { entries: unknown[]; updatedAt: number }): void => {
    pendingTimeline = snapshot
    clearTimeout(timelineTimer)
    timelineTimer = setTimeout(() => {
      const next = pendingTimeline
      pendingTimeline = undefined
      if (next === undefined || snapshotScope === undefined) {
        fileLog(config.stateDir, `timeline snapshot SKIPPED: next=${next !== undefined} snapshotScope=${snapshotScope !== undefined}`)
        return
      }
      snapshotScope.update({ timelineSnapshot: next }).then(() => {
        fileLog(config.stateDir, `timeline snapshot published entries=${next.entries.length}`)
      }).catch((error: unknown) => {
        ctx.logger.warn('[dsh-matrix-agent] timeline snapshot write failed: %s', error instanceof Error ? error.message : String(error))
        fileLog(config.stateDir, `timeline snapshot write FAILED: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, 300)
  }

  /** 清零时间线管理命令（Host 处理后调用，防重启重放）。 */
  const clearTimelineOps = (): void => {
    if (snapshotScope === undefined) return
    snapshotScope.update({ timelineOps: emptyTimelineOps() }).catch(() => {})
  }

  /** 清零秘书操作命令（Host 处理后调用，防重启重放）。 */
  const clearSecretaryOps = (): void => {
    if (snapshotScope === undefined) return
    snapshotScope.update({ secretaryOps: undefined }).catch(() => {})
  }

  return {
    merged: current,
    dispose: () => {
      clearTimeout(snapshotTimer)
      clearTimeout(timelineTimer)
      for (const dispose of disposers.splice(0)) dispose()
    },
    getMerged: () => current,
    updateTasksSnapshot,
    updateTimelineSnapshot,
    clearTimelineOps,
    clearSecretaryOps,
  }
}
