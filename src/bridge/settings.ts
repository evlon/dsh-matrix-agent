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
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.js'
import { plainMatrixConfig } from './config.js'

/** 文件诊断日志：与 bridge 的 diag 同写 stateDir/diagnostics.log（stateDir 已由 resolveStateDir 绝对化到 DSH_HOME）。 */
function fileLog(stateDir: string, message: string): void {
  const line = `${new Date().toISOString()} [dsh-matrix-agent:settings] ${message}\n`
  try {
    mkdirSync(stateDir, { recursive: true })
    appendFileSync(join(stateDir, 'diagnostics.log'), line, 'utf8')
  } catch { /* 忽略 */ }
}

/**
 * settings namespace 名称 = cordis 组合里的 entry id（cordis.patch.yml 的 insert.id = 'matrix'）。
 * 0.1.7 的 SettingsForms.describe() 用 ns = entry.options.id，故必须是 'matrix'，不是 'dsh-matrix'。
 * client 端 configForms.get('matrix') 与此一致。
 */
export const MATRIX_NS = 'matrix'

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

/**
 * 注册矩阵插件的设置集成（0.1.7）：不再使用 settings.register（0.1.5 旧 API 已移除）。
 * 用户配置走 Config 的 .volatile() 字段（settings 页编辑 → loader/volatile-update 热更）。
 *
 * 运行时镜像（timelineSnapshot/ownerInbox/taskBoard/jobBoard，Host→Client）与
 * 命令通道（timelineOps/ownerDecisionOps/jobSwitchOps，Client→Host）在 0.1.7 里
 * 不能塞进 settings namespace（settings 只能写 volatile 字段），本阶段先降级为
 * 内存态（Host 内存持有，接口保留），后续走 Typert RPC（ctx.remote）重构。
 */
export function registerMatrixSettings(
  ctx: Context,
  config: Config,
  options?: { onTimelineOps?: (ops: TimelineOps) => void; onOwnerDecisionOps?: (ops: OwnerDecisionOps) => void; onJobSwitchOps?: (ops: JobSwitchOps) => void; onConfigChange?: (merged: Config) => void },
): { merged: Config; dispose: () => void; getMerged: () => Config; updateTimelineSnapshot: (snapshot: { entries: unknown[]; updatedAt: number }) => void; updateOwnerInbox: (snapshot: OwnerInboxSnapshot) => void; updateTaskBoard: (snapshot: TaskBoardSnapshot) => void; updateJobBoard: (snapshot: JobBoardSnapshot) => void; clearTimelineOps: () => void; clearOwnerDecisionOps: () => void; clearJobSwitchOps: () => void; getTimelineSnapshot: () => { entries: unknown[]; updatedAt: number }; getOwnerInboxSnapshot: () => OwnerInboxSnapshot; getTaskBoardSnapshot: () => TaskBoardSnapshot; getJobBoardSnapshot: () => JobBoardSnapshot } {
  const onConfigChange = options?.onConfigChange
  // config 是 rawConfig（volatile 字段为 Volatile 对象）；解包成普通 Config 作为当前合并值。
  let current: Config = plainMatrixConfig(config)
  const disposers: Array<() => void> = []

  fileLog(current.stateDir, `registerMatrixSettings enter (0.1.7 volatile): stateDir=${current.stateDir}`)

  // 0.1.7 用户配置热更：settings 页编辑 volatile 字段 → cordis-plugin-loader 更新 Volatile ref
  // → emit "loader/volatile-update"（paths）。config 对象引用稳定，重跑 plainMatrixConfig 得最新值。
  let volatileUnsub: (() => void) | undefined
  try {
    volatileUnsub = (ctx.on as (event: string, cb: (paths: unknown) => void) => () => void)('loader/volatile-update', (paths: unknown) => {
      const next = plainMatrixConfig(config)
      current = next
      fileLog(next.stateDir, `loader/volatile-update: paths=${Array.isArray(paths) ? paths.join(',') : String(paths)}`)
      if (onConfigChange !== undefined) onConfigChange(next)
    })
    disposers.push(volatileUnsub)
  } catch (error) {
    ctx.logger.warn('[dsh-matrix-agent] loader/volatile-update listener failed: %s', error instanceof Error ? error.message : String(error))
  }

  // —— 运行时镜像 / 命令通道：0.1.7 降级为内存态（接口保留，后续 Typert RPC 重构）——
  // 这些镜像原来靠 settings namespace 的 snapshotScope.update() 写回给 client 读；
  // 0.1.7 里 settings 只能写 volatile 字段（这些是运行时数据，非用户配置），故先不传输。
  // Host 内存缓存保留最近一次快照，接口签名不变，待 Typert RPC（ctx.remote）补齐后恢复传输。
  let timelineCache: { entries: unknown[]; updatedAt: number } | undefined
  let ownerInboxCache: OwnerInboxSnapshot | undefined
  let taskBoardCache: TaskBoardSnapshot | undefined
  let jobBoardCache: JobBoardSnapshot | undefined

  const updateTimelineSnapshot = (snapshot: { entries: unknown[]; updatedAt: number }): void => {
    timelineCache = snapshot
    fileLog(current.stateDir, `timeline snapshot cached (in-memory) entries=${snapshot.entries.length}`)
  }
  const updateOwnerInbox = (snapshot: OwnerInboxSnapshot): void => {
    ownerInboxCache = snapshot
    fileLog(current.stateDir, `ownerInbox cached (in-memory) items=${snapshot.items.length}`)
  }
  const updateTaskBoard = (snapshot: TaskBoardSnapshot): void => {
    taskBoardCache = snapshot
    fileLog(current.stateDir, `taskBoard cached (in-memory) rows=${snapshot.rows.length}`)
  }
  const updateJobBoard = (snapshot: JobBoardSnapshot): void => {
    jobBoardCache = snapshot
    fileLog(current.stateDir, `jobBoard cached (in-memory) presets=${snapshot.installedPresets.length} rows=${snapshot.rows.length}`)
  }
  // 命令通道清零：命令经 Typert RPC 直发（Client→Host），不再写 settings，故此处保持 no-op。
  const clearTimelineOps = (): void => {}
  const clearOwnerDecisionOps = (): void => {}
  const clearJobSwitchOps = (): void => {}

  // 镜像 getter：供 Typert workbench service 读取最新快照（避免两处 cache 不同步）。
  const getTimelineSnapshot = (): { entries: unknown[]; updatedAt: number } =>
    timelineCache ?? { entries: [], updatedAt: 0 }
  const getOwnerInboxSnapshot = (): OwnerInboxSnapshot =>
    ownerInboxCache ?? emptyOwnerInbox()
  const getTaskBoardSnapshot = (): TaskBoardSnapshot =>
    taskBoardCache ?? emptyTaskBoard()
  const getJobBoardSnapshot = (): JobBoardSnapshot =>
    jobBoardCache ?? emptyJobBoard()

  return {
    merged: current,
    dispose: () => {
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
    getTimelineSnapshot,
    getOwnerInboxSnapshot,
    getTaskBoardSnapshot,
    getJobBoardSnapshot,
  }
}
