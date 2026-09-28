/**
 * 数字分身统一配置的 settings namespace：把可在设置页编辑的账号级字段合并为
 * 一个 `dsh-matrix` settings 用户层，构造 bridge 前 merge 进 config。
 *
 * 原则（与 README「整个 config 值替换，不深合并」对齐的扩展）：
 * - 用户层字段存在即覆盖 config 对应字段（优先级：settings 用户层 > yml config）；
 * - 连接类字段（homeserverUrl/accessToken/userId/digitalTwinMode）改动需重启生效，
 *   本模块只负责读 merge，不重建 channel；
 * - 可变字段（respondToAll/allowedUserIds/owner/provider/model/agentPreset/
 *   chunkMaxChars 等）可在运行时经 watch 更新 AccountBridge。
 * - 运行时只读镜像（非用户配置）：timelineSnapshot（自我时间线）/ ownerInbox
 *   （主人待批请示/汇报）/ taskBoard（各房间忙/待交付/请示中状态）由 Host 写入，
 *   供 DSH Web 的分身工作台读取。
 *
 * @module dsh-matrix-agent/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.js'
import { defaultReceptionKinds, DEFAULT_AUTOTUNE, DEFAULT_PARALLEL } from './config.js'

/** 文件诊断日志：与 bridge 的 diag 同写 stateDir/diagnostics.log（stateDir 已由 resolveStateDir 绝对化到 DSH_HOME）。 */
function fileLog(stateDir: string, message: string): void {
  const line = `${new Date().toISOString()} [dsh-matrix-agent:settings] ${message}\n`
  try {
    mkdirSync(stateDir, { recursive: true })
    appendFileSync(join(stateDir, 'diagnostics.log'), line, 'utf8')
  } catch { /* 忽略 */ }
}

/** settings namespace 名称（单入口单 ns：账号 + 社交统一存放）。 */
export const MATRIX_NS = 'dsh-matrix'

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

/**
 * 主人收件箱条目（运行时镜像，Host→Client）：分身发起的请示/汇报待主人决策。
 * id 复用 workRoomId（同一房间同一时刻只有一个 pending 请示/汇报）。
 */
export interface OwnerInboxItem {
  /** 唯一 id（= workRoomId，用于决策命令回指）。 */
  id: string
  /** 群聊房间 id。 */
  roomId: string
  /** 群聊房间名（含发起人/请求内容上下文）。 */
  roomName: string
  /** 请示 or 汇报 or 入群邀请审批。 */
  kind: 'clarify' | 'report' | 'invite'
  /** 请示/汇报正文。 */
  text: string
  /** 发起时间戳（ms）。 */
  createdAt: number
}

/** 主人收件箱快照。 */
export interface OwnerInboxSnapshot {
  items: OwnerInboxItem[]
  updatedAt: number
}

/** 空收件箱。 */
export function emptyOwnerInbox(): OwnerInboxSnapshot {
  return { items: [], updatedAt: 0 }
}

/**
 * 任务看板行（运行时镜像，Host→Client）：每房间一行的当前任务状态。
 * 供「分身工作台 → 任务」tab 展示主人管辖房间的实时忙闲/待交付/请示中状态。
 */
export interface TaskBoardRow {
  /** 群聊房间 id。 */
  roomId: string
  /** 对应 agent 会话 id（roomAgents 映射，供 UI 点击跳转会话）。 */
  sessionId?: string
  /** 房间名（bridge roomNameCache 提供，未命中时为 roomId 截断）。 */
  roomName: string
  /** 当前状态：busy（正在干活）/ awaiting-delivery（有实质结果待发群）/ clarifying（请示中）。 */
  state: 'busy' | 'awaiting-delivery' | 'clarifying'
  /** 正在做/待交付的任务摘要。 */
  label: string
  /** 该状态开始时间（ms）。 */
  since: number
  /** 已提醒次数（awaiting-delivery 时）。 */
  remindCount?: number
  /** 最近对外发消息时间（ms）。 */
  lastOutboundAt?: number
}

/** 任务看板快照。 */
export interface TaskBoardSnapshot {
  rows: TaskBoardRow[]
  updatedAt: number
}

/** 空任务看板。 */
export function emptyTaskBoard(): TaskBoardSnapshot {
  return { rows: [], updatedAt: 0 }
}

/**
 * 岗位看板行（运行时镜像，Host→Client）：每房间一行的岗位状态。
 * 供「数字分身 → 岗位」设置页展示：每个群当前用的岗位、可切换的已安装岗位。
 */
export interface JobBoardRow {
  /** 群聊房间 id。 */
  roomId: string
  /** 房间名（bridge roomNameCache 提供，未命中时为 roomId 截断）。 */
  roomName: string
  /** 该房间当前生效的岗位 preset id（roomPresets 钉死值，或回退全局 agentPreset）。 */
  presetId: string
  /** 是否由 roomPresets 显式钉死（false=回退全局默认岗位）。 */
  pinned: boolean
  /** 对应 agent 会话 id（roomAgents 映射，供 UI 点击跳转会话）。 */
  sessionId?: string
  /** 该会话是否已产出内容（true=切换岗位需新建会话并同步历史）。 */
  hasProduced?: boolean
}

/**
 * 岗位看板快照（运行时镜像，Host→Client）。
 * 除房间列表外，还携带「已安装岗位清单」与「全局默认岗位」，供设置页一次性渲染。
 */
export interface JobBoardSnapshot {
  /** 全局默认岗位 id（config.agentPreset，未设回退 'standard'）。 */
  defaultPresetId: string
  /** 已安装岗位 id 清单（来自 agentPresets.list()，含 name 展示名）。 */
  installedPresets: Array<{ id: string; name: string; isDefault: boolean }>
  /** 各房间岗位行。 */
  rows: JobBoardRow[]
  updatedAt: number
}

/** 空岗位看板。 */
export function emptyJobBoard(): JobBoardSnapshot {
  return { defaultPresetId: 'standard', installedPresets: [], rows: [], updatedAt: 0 }
}

/** 岗位切换命令（Client→Host，Host 处理后清零，防重启重放）。 */
export interface JobSwitchOps {
  /** 非 0 即触发（用递增/时间戳唯一值）。 */
  seq: number
  /** 目标房间 id；空 = 修改全局默认岗位。 */
  roomId: string
  /** 目标岗位 preset id。 */
  presetId: string
}

/** 空岗位切换命令。 */
export function emptyJobSwitchOps(): JobSwitchOps {
  return { seq: 0, roomId: '', presetId: '' }
}

/** 主人决策命令（Client→Host，Host 处理后清零，防重启重放）。 */
export interface OwnerDecisionOps {
  /** 非 0 即触发（用递增/时间戳唯一值）。 */
  seq: number
  /** 目标收件箱条目 id（= workRoomId）。 */
  id: string
  /** 决策。 */
  decision: 'approve' | 'reject'
  /** 附加意见/指示（可选）。 */
  reply?: string
}

/** 空主人决策命令。 */
export function emptyOwnerDecisionOps(): OwnerDecisionOps {
  return { seq: 0, id: '', decision: 'approve' }
}

/**
 * 把 settings 用户层 merge 进 config（用户层字段存在即覆盖）。
 */
export function mergeMatrixConfig(base: Config, user: Record<string, unknown> | undefined): Config {
  if (user === undefined) return base
  const out: Config = { ...base }
  const record = out as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(user)) {
    // 只接受 Config 顶层已有的键；类型收窄交给调用侧。
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
  'workerReasoningEffort',
  'secretaryReasoningEffort',
  'chunkMaxChars',
  'mergeTimeoutSecs',
  'approvalTimeoutSecs',
  'maxRetriesBeforeAbort',
  'retryCircuitBreakerEnabled',
  'matrixTools',
  'notifyRoomEvents',
  'proactiveSendRequiresApproval',
  'preserveRichText',
  'autoIntroduce',
  'maxSelfIntroMentions',
  'memberMemory',
  'autoGreet',
  'selfIntroTemplate',
  'inviteApprovalEnabled',
  'inviteApprovalTimeoutSecs',
  'inviteApprovalTimeoutAction',
  'timelineEnabled',
  'timelineInject',
  'timelineCrossRoom',
  'timelineCap',
  'testRoomPrefix',
  'twinModeRoomPrefix',
  'secretaryGroupDefault',
  'secretaryDmDefault',
  'receptionAckNewTask',
  'receptionAckBusyQuestion',
  'receptionAckBusy',
  'receptionRejected',
  'receptionGiveUp',
  'receptionEnabled',
  'receptionPreset',
  'receptionProvider',
  'receptionModel',
  'receptionReasoningEffort',
  'receptionTimeoutSecs',
  'receptionMinLength',
  'receptionThrottleSecs',
  'receptionKinds',
  'roomModes',
  'roomPresets',
  'autoTune',
  'parallel',
  'taskClarifyTimeoutSecs',
  'taskConfirmTimeoutSecs',
  'secretaryDecisionTimeoutSecs',
])

/** 连接类字段名单：改动需重启才生效。 */
export const RESTART_KEYS = new Set([
  'homeserverUrl',
  'accessToken',
  'userId',
  'digitalTwinMode',
  'digitalTwins',
  'stateDir',
  'instanceKey',
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
    instanceKey: config.instanceKey,
    respondToAll: config.respondToAll,
    allowedUserIds: config.allowedUserIds,
    allowAllUsers: config.allowAllUsers,
    provider: config.provider,
    model: config.model,
    agentPreset: config.agentPreset,
    workerReasoningEffort: config.workerReasoningEffort,
    secretaryReasoningEffort: config.secretaryReasoningEffort,
    chunkMaxChars: config.chunkMaxChars,
    mergeTimeoutSecs: config.mergeTimeoutSecs,
    approvalTimeoutSecs: config.approvalTimeoutSecs,
    maxRetriesBeforeAbort: config.maxRetriesBeforeAbort,
    retryCircuitBreakerEnabled: config.retryCircuitBreakerEnabled,
    matrixTools: config.matrixTools,
    notifyRoomEvents: config.notifyRoomEvents,
    proactiveSendRequiresApproval: config.proactiveSendRequiresApproval,
    preserveRichText: config.preserveRichText,
    autoIntroduce: config.autoIntroduce,
    maxSelfIntroMentions: config.maxSelfIntroMentions,
    memberMemory: config.memberMemory,
    autoGreet: config.autoGreet,
    selfIntroTemplate: config.selfIntroTemplate,
    inviteApprovalEnabled: config.inviteApprovalEnabled,
    inviteApprovalTimeoutSecs: config.inviteApprovalTimeoutSecs,
    inviteApprovalTimeoutAction: config.inviteApprovalTimeoutAction,
    receptionAckNewTask: config.receptionAckNewTask,
    receptionAckBusyQuestion: config.receptionAckBusyQuestion,
    receptionAckBusy: config.receptionAckBusy,
    receptionRejected: config.receptionRejected,
    receptionGiveUp: config.receptionGiveUp,
    receptionEnabled: config.receptionEnabled,
    receptionPreset: config.receptionPreset,
    receptionProvider: config.receptionProvider,
    receptionModel: config.receptionModel,
    receptionReasoningEffort: config.receptionReasoningEffort,
    receptionTimeoutSecs: config.receptionTimeoutSecs,
    receptionMinLength: config.receptionMinLength,
    receptionThrottleSecs: config.receptionThrottleSecs,
    receptionKinds: config.receptionKinds,
    roomModes: config.roomModes ?? {},
    roomPresets: config.roomPresets ?? {},
    autoTune: config.autoTune ?? DEFAULT_AUTOTUNE,
    parallel: config.parallel ?? DEFAULT_PARALLEL,
    timelineEnabled: config.timelineEnabled,
    timelineInject: config.timelineInject,
    timelineCrossRoom: config.timelineCrossRoom,
    timelineCap: config.timelineCap,
    testRoomPrefix: config.testRoomPrefix,
    twinModeRoomPrefix: config.twinModeRoomPrefix,
    secretaryGroupDefault: config.secretaryGroupDefault,
    secretaryDmDefault: config.secretaryDmDefault,
    taskClarifyTimeoutSecs: config.taskClarifyTimeoutSecs,
    taskConfirmTimeoutSecs: config.taskConfirmTimeoutSecs,
    secretaryDecisionTimeoutSecs: config.secretaryDecisionTimeoutSecs,
  }
}

/**
 * 注册 `dsh-matrix` settings namespace（live），返回 merge 后的 config
 * 与 watch 释放器。用户层为空时返回原 config。
 */
export function registerMatrixSettings(
  ctx: Context,
  config: Config,
  options?: { onTimelineOps?: (ops: TimelineOps) => void; onOwnerDecisionOps?: (ops: OwnerDecisionOps) => void; onJobSwitchOps?: (ops: JobSwitchOps) => void; onConfigChange?: (merged: Config) => void },
): { merged: Config; dispose: () => void; getMerged: () => Config; updateTimelineSnapshot: (snapshot: { entries: unknown[]; updatedAt: number }) => void; updateOwnerInbox: (snapshot: OwnerInboxSnapshot) => void; updateTaskBoard: (snapshot: TaskBoardSnapshot) => void; updateJobBoard: (snapshot: JobBoardSnapshot) => void; clearTimelineOps: () => void; clearOwnerDecisionOps: () => void; clearJobSwitchOps: () => void } {
  const onTimelineOps = options?.onTimelineOps
  const onOwnerDecisionOps = options?.onOwnerDecisionOps
  const onJobSwitchOps = options?.onJobSwitchOps
  const onConfigChange = options?.onConfigChange
  let current = config
  const disposers: Array<() => void> = []
  let snapshotScope: { update(patch: object): Promise<void> } | undefined
  let timelineTimer: NodeJS.Timeout | undefined
  let pendingTimeline: { entries: unknown[]; updatedAt: number } | undefined
  let ownerInboxTimer: NodeJS.Timeout | undefined
  let pendingOwnerInbox: OwnerInboxSnapshot | undefined
  let taskBoardTimer: NodeJS.Timeout | undefined
  let pendingTaskBoard: TaskBoardSnapshot | undefined
  let jobBoardTimer: NodeJS.Timeout | undefined
  let pendingJobBoard: JobBoardSnapshot | undefined

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
        instanceKey: z.string().default(''),
        respondToAll: z.boolean().default(true),
        allowedUserIds: z.array(z.string()).default([]),
        allowAllUsers: z.boolean().default(false),
        provider: z.string().default(''),
        model: z.string().default(''),
        agentPreset: z.string().default('standard'),
        workerReasoningEffort: z.string().default(''),
        secretaryReasoningEffort: z.string().default(''),
        chunkMaxChars: z.number().default(4000),
        mergeTimeoutSecs: z.number().default(5),
        approvalTimeoutSecs: z.number().default(300),
        maxRetriesBeforeAbort: z.number().default(5),
        retryCircuitBreakerEnabled: z.boolean().default(true),
        matrixTools: z.boolean().default(true),
        notifyRoomEvents: z.boolean().default(false),
        proactiveSendRequiresApproval: z.boolean().default(true),
        preserveRichText: z.boolean().default(true),
        autoIntroduce: z.boolean().default(true),
        maxSelfIntroMentions: z.number().default(20),
        memberMemory: z.boolean().default(true),
        autoGreet: z.boolean().default(true),
        selfIntroTemplate: z.string().default('大家好，我是 {{userId}}，很高兴加入这个群。以后有什么需要帮忙的尽管找我，我会尽力配合大家的工作！'),
        inviteApprovalEnabled: z.boolean().default(true),
        inviteApprovalTimeoutSecs: z.number().default(0),
        inviteApprovalTimeoutAction: z.union([z.const('pending'), z.const('reject')]).default('reject'),
        receptionAckNewTask: z.string().default('收到，我这就去整理{{taskHint}}，稍后把结果发你～'),
        receptionAckBusyQuestion: z.string().default('[前台接待] @{{lp}} 这条我记下了，手头正忙（处理任务中）{{taskDesc}}{{eta}}，处理完马上回你；有急需可以再把关键点说一遍～'),
        receptionAckBusy: z.string().default('[前台接待] @{{lp}} 收到，我手头正忙（处理任务中）{{taskDesc}}{{eta}}，稍后回你这条～'),
        receptionRejected: z.string().default('[前台接待] 主人暂时不同意开工，任务「{{summary}}」先搁置。'),
        receptionGiveUp: z.string().default('[前台接待] 我正在整理「{{summary}}」，结果稍后同步，请稍等～'),
        receptionEnabled: z.boolean().default(false),
        receptionPreset: z.string().default('reception'),
        receptionProvider: z.string().default(''),
        receptionModel: z.string().default(''),
        receptionReasoningEffort: z.string().default('off'),
        receptionTimeoutSecs: z.number().default(3),
        receptionMinLength: z.number().default(0),
        receptionThrottleSecs: z.number().default(0),
        receptionKinds: z.dict(z.object({
          label: z.string(),
          describe: z.string(),
          ack: z.boolean().default(true),
          ackText: z.string().default(''),
          busy: z.boolean().default(true),
          forward: z.boolean().default(true),
        })).default(defaultReceptionKinds()),
        // per-room 群工作模式显式覆盖（键=房间 id/群名，值=钉死模式；缺省 auto）。
        roomModes: z.dict(z.union([z.const('auto'), z.const('parallel'), z.const('cohesive')])).default({}),
        // per-room 岗位覆盖（键=房间 id/群名，值=岗位 preset id；缺省回退 agentPreset）。
        roomPresets: z.dict(z.string()).default({}),
        // auto 自适配阈值（阶段 3）：窗口/占比/票差/冷却；settings 热更即时生效。
        // 阈值可配 ≠ 倾向落配置——产出的倾向值仍只存内存（铁律：auto 只读、绝不写 roomModes）。
        autoTune: z.object({
          windowN: z.number().min(2).default(DEFAULT_AUTOTUNE.windowN),
          parallelRatio: z.number().min(0.01).max(1).default(DEFAULT_AUTOTUNE.parallelRatio),
          cohesiveRatio: z.number().min(0.01).max(1).default(DEFAULT_AUTOTUNE.cohesiveRatio),
          minDelta: z.number().min(0).default(DEFAULT_AUTOTUNE.minDelta),
          minGapMs: z.number().min(0).default(DEFAULT_AUTOTUNE.minGapMs),
        }).default(DEFAULT_AUTOTUNE),
        // A 路径并行批次窗口（总开关/批次窗/单批上限；无池参数——执行机制在 preset 的 delegation 组）。
        // settings 热更即时生效（MatrixBridge settings/updated 分发 parallel 键 → syncParallelFromSettings）。
        parallel: z.object({
          enabled: z.boolean().default(DEFAULT_PARALLEL.enabled),
          batchWindowSecs: z.number().min(2).max(60).default(DEFAULT_PARALLEL.batchWindowSecs),
          maxBatchItems: z.number().min(2).max(8).default(DEFAULT_PARALLEL.maxBatchItems),
        }).default(DEFAULT_PARALLEL),
        timelineEnabled: z.boolean().default(true),
        timelineInject: z.boolean().default(true),
        timelineCrossRoom: z.boolean().default(false),
        timelineCap: z.number().default(500),
        testRoomPrefix: z.string().default('【测试】'),
        twinModeRoomPrefix: z.string().default(''),
        secretaryGroupDefault: z.boolean().default(true),
        secretaryDmDefault: z.boolean().default(false),
        taskClarifyTimeoutSecs: z.number().default(120),
        taskConfirmTimeoutSecs: z.number().default(600),
        secretaryDecisionTimeoutSecs: z.number().default(180),
        // 运行时只读镜像（非用户配置）：自我时间线数据源。
        timelineSnapshot: z.any().default({ entries: [], updatedAt: 0 }),
        // 运行时只读镜像（非用户配置）：主人收件箱（待批请示/汇报）。
        ownerInbox: z.any().default(emptyOwnerInbox()),
        // 运行时只读镜像（非用户配置）：任务看板（各房间当前忙/待交付/请示中状态）。
        taskBoard: z.any().default(emptyTaskBoard()),
        // 运行时只读镜像（非用户配置）：岗位看板（已安装岗位/每房间岗位/默认岗位）。
        jobBoard: z.any().default(emptyJobBoard()),
        // Client→Host 管理命令（非用户配置）：Host 处理后清零，防重启重放。
        timelineOps: z.any().default(emptyTimelineOps()),
        // Client→Host 主人决策命令（非用户配置）：Host 处理后清零。
        ownerDecisionOps: z.any().default(emptyOwnerDecisionOps()),
        // Client→Host 岗位切换命令（非用户配置）：Host 处理后清零。
        jobSwitchOps: z.any().default(emptyJobSwitchOps()),
      }), { applies: 'live', base: pickMatrixBase(config) })
      const applyUser = (user: unknown, notify = true): void => {
        current = mergeMatrixConfig(config, (user ?? {}) as Record<string, unknown>)
        // 配置变化通知（供 index.ts 驱动 bridge 启停：token 缺失时保持插件存活，配置好后自动恢复）。
        // 首次同步 merge（register 内的 scope.get()）不通知：index.ts 拿到 merged 后会自行做
        // 初始启停判定；且此刻 index.ts 的 settingsHandle 仍处 TDZ（const 尚未赋值），
        // 提前通知会抛 "Cannot access 'settingsHandle' before initialization"，导致
        // snapshotScope 与 watch 注册被跳过、快照机制整体失效。后续 watch 变更才通知。
        if (notify && onConfigChange !== undefined) onConfigChange(current)
        // 检测时间线管理命令（Client→Host）。
        const ops = (user as Record<string, unknown> | undefined)?.timelineOps as TimelineOps | undefined
        if (ops !== undefined && onTimelineOps !== undefined) {
          const active = ops.clearSeq !== 0 || (Array.isArray(ops.removeIds) && ops.removeIds.length > 0)
          if (active) onTimelineOps(ops)
        }
        // 检测主人决策命令（Client→Host）。
        const dop = (user as Record<string, unknown> | undefined)?.ownerDecisionOps as OwnerDecisionOps | undefined
        if (dop !== undefined && dop.seq !== 0 && dop.id !== '' && onOwnerDecisionOps !== undefined) {
          onOwnerDecisionOps(dop)
        }
        // 检测岗位切换命令（Client→Host）。
        const jop = (user as Record<string, unknown> | undefined)?.jobSwitchOps as JobSwitchOps | undefined
        if (jop !== undefined && jop.seq !== 0 && jop.presetId !== '' && onJobSwitchOps !== undefined) {
          onJobSwitchOps(jop)
        }
      }
      applyUser(scope.get(), false)
      snapshotScope = scope
      const unsub = scope.watch((next) => applyUser(next, true))
      disposers.push(unsub)
      fileLog(config.stateDir, `settings register OK: ns=${MATRIX_NS} snapshotScope set`)
    } catch (error) {
      ctx.logger.warn('[dsh-matrix-agent] matrix settings unavailable: %s', error instanceof Error ? error.message : String(error))
      fileLog(config.stateDir, `settings register FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    fileLog(config.stateDir, 'settings service unavailable (ctx.get("settings") === undefined); snapshots will NOT be published')
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

  /** 清零主人决策命令（Host 处理后调用，防重启重放）。 */
  const clearOwnerDecisionOps = (): void => {
    if (snapshotScope === undefined) return
    snapshotScope.update({ ownerDecisionOps: emptyOwnerDecisionOps() }).catch(() => {})
  }

  /** 防抖写主人收件箱快照（运行时镜像，非用户配置）。 */
  const updateOwnerInbox = (snapshot: OwnerInboxSnapshot): void => {
    pendingOwnerInbox = snapshot
    clearTimeout(ownerInboxTimer)
    ownerInboxTimer = setTimeout(() => {
      const next = pendingOwnerInbox
      pendingOwnerInbox = undefined
      if (next === undefined || snapshotScope === undefined) {
        fileLog(config.stateDir, `ownerInbox SKIPPED: next=${next !== undefined} snapshotScope=${snapshotScope !== undefined}`)
        return
      }
      snapshotScope.update({ ownerInbox: next }).then(() => {
        fileLog(config.stateDir, `ownerInbox published items=${next.items.length}`)
      }).catch((error: unknown) => {
        ctx.logger.warn('[dsh-matrix-agent] ownerInbox write failed: %s', error instanceof Error ? error.message : String(error))
        fileLog(config.stateDir, `ownerInbox write FAILED: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, 300)
  }

  /** 防抖写任务看板快照（运行时镜像，非用户配置）。 */
  const updateTaskBoard = (snapshot: TaskBoardSnapshot): void => {
    pendingTaskBoard = snapshot
    clearTimeout(taskBoardTimer)
    taskBoardTimer = setTimeout(() => {
      const next = pendingTaskBoard
      pendingTaskBoard = undefined
      if (next === undefined || snapshotScope === undefined) {
        fileLog(config.stateDir, `taskBoard SKIPPED: next=${next !== undefined} snapshotScope=${snapshotScope !== undefined}`)
        return
      }
      snapshotScope.update({ taskBoard: next }).then(() => {
        fileLog(config.stateDir, `taskBoard published rows=${next.rows.length}`)
      }).catch((error: unknown) => {
        ctx.logger.warn('[dsh-matrix-agent] taskBoard write failed: %s', error instanceof Error ? error.message : String(error))
        fileLog(config.stateDir, `taskBoard write FAILED: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, 300)
  }

  /** 防抖写岗位看板快照（运行时镜像，非用户配置）。 */
  const updateJobBoard = (snapshot: JobBoardSnapshot): void => {
    pendingJobBoard = snapshot
    clearTimeout(jobBoardTimer)
    jobBoardTimer = setTimeout(() => {
      const next = pendingJobBoard
      pendingJobBoard = undefined
      if (next === undefined || snapshotScope === undefined) {
        fileLog(config.stateDir, `jobBoard SKIPPED: next=${next !== undefined} snapshotScope=${snapshotScope !== undefined}`)
        return
      }
      snapshotScope.update({ jobBoard: next }).then(() => {
        fileLog(config.stateDir, `jobBoard published presets=${next.installedPresets.length} rows=${next.rows.length}`)
      }).catch((error: unknown) => {
        ctx.logger.warn('[dsh-matrix-agent] jobBoard write failed: %s', error instanceof Error ? error.message : String(error))
        fileLog(config.stateDir, `jobBoard write FAILED: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, 300)
  }

  /** 清零岗位切换命令（Host 处理后调用，防重启重放）。 */
  const clearJobSwitchOps = (): void => {
    if (snapshotScope === undefined) return
    snapshotScope.update({ jobSwitchOps: emptyJobSwitchOps() }).catch(() => {})
  }

  return {
    merged: current,
    dispose: () => {
      clearTimeout(timelineTimer)
      clearTimeout(ownerInboxTimer)
      clearTimeout(taskBoardTimer)
      clearTimeout(jobBoardTimer)
      for (const dispose of disposers.splice(0)) dispose()
    },
    getMerged: () => current,
    updateTimelineSnapshot,
    updateOwnerInbox,
    updateTaskBoard,
    updateJobBoard,
    clearTimelineOps,
    clearOwnerDecisionOps,
    clearJobSwitchOps,
  }
}
