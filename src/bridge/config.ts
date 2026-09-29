import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** 当前 dsh 实例的 home：显式 DSH_HOME，否则 ~/.dsh。 */
function resolveDshHome(): string {
  const base = process.env.DSH_HOME
  return base !== undefined && base.trim() !== '' ? base.trim() : join(homedir(), '.dsh')
}

/**
 * 把（可能是相对的）stateDir 解析为绝对路径，锚定到当前 dsh 实例的 DSH_HOME。
 * 相对路径不再相对 cwd 解析——否则多个 dsh 实例在同一 cwd 运行时（开发者/测试者/使用者
 * 共用同一工作目录，各自登录同一或不同分身账号）会写到同一个 state.json，互相覆盖
 * syncToken / 去重环 / 房间↔会话绑定。绝对路径原样返回（允许显式指定独立位置）。
 */
export function resolveStateDir(stateDir: string): string {
  const dir = (stateDir ?? '').trim()
  if (dir === '') return join(resolveDshHome(), '.dsh-matrix')
  if (isAbsolute(dir)) return dir
  return join(resolveDshHome(), dir)
}

/** 数字分身 Matrix 账号：一个真实员工名下的一个分身，独立 access token 与 agent 会话空间。 */
export interface DigitalTwinAccount {
  /** 分身的 Matrix 用户 id，如 '@ai-zhang-dev:im-ipm.ict.cmcc'。 */
  userId: string
  /** 直接内联的 access token（优先于 tokenEnv；生产建议用 tokenEnv）。 */
  accessToken: string
  /** 从环境变量读取 token 的变量名，如 DSH_MATRIX_AI_ZHANG_DEV_TOKEN。 */
  tokenEnv: string
  /** 工作责任负责人（主人）的 Matrix 用户 id。 */
  owner: string
  /** 角色标签（leader/pm/dev/qa/custom），仅作展示与路由提示。 */
  role: string
  /**
   * 是否响应房间里所有消息（即"是否只响应 @ 自己的消息"的反向开关）。
   * true：响应群里所有消息，无需 @（个人助手模式，主账号默认）。
   * false：只响应 @ 自己的消息，未 @ 一律静默（分身默认，避免抢答与浪费 token）。
   * 注意：无论此值如何，若消息 @提及 了其他已知账号，本账号仍会静默（不抢答别人的对话）。
   */
  respondToAll: boolean
  /** 覆盖顶层 provider/model；留空回退顶层值。 */
  provider: string
  model: string
}

/**
 * 群工作模式（per-room 显式覆盖，详见「数字员工系统_群工作模式设计」）：
 * - auto：默认。前台按群消息流自适配（本阶段只识别并落显式覆盖，auto 的自适应调度留阶段 2）；
 * - parallel：并行模式。答疑/客服群，每人问独立问题 → 提示 worker 用 subagent 工具并行拆解（A 路径）；
 * - cohesive：协同模式。协作群，多人共做一件事 → 单 worker 串行持共享上下文（现状行为）。
 * 显式钉死后不再自动切换（auto 才允许运行时变）。
 */
export type RoomMode = 'auto' | 'parallel' | 'cohesive'

/** 全部合法群工作模式值。 */
export const ROOM_MODES: readonly RoomMode[] = ['auto', 'parallel', 'cohesive']

/** 是否是合法群工作模式值。 */
export function isRoomMode(value: unknown): value is RoomMode {
  return value === 'auto' || value === 'parallel' || value === 'cohesive'
}

/**
 * auto 自适配阈值（阶段 3）：全部字段可配，缺省见 DEFAULT_AUTOTUNE。
 * - windowN：per-room 形态滚动窗口大小（最近 N 条人类消息）；
 * - parallelRatio/cohesiveRatio：窗口内对应倾向票占比达标线（0.6 = 60%）；
 * - minDelta：票数差 ≥ 该值才允许切换（宁不切不可乱切）；
 * - minGapMs：倾向变更冷却（距上次切换不足则不换，防形态震荡横跳）。
 */
export interface AutoTune {
  windowN: number
  parallelRatio: number
  cohesiveRatio: number
  minDelta: number
  minGapMs: number
}

/** auto 自适配阈值出厂默认（初值，待真实语料标定后固化）。 */
export const DEFAULT_AUTOTUNE: AutoTune = {
  windowN: 20,
  parallelRatio: 0.6,
  cohesiveRatio: 0.6,
  minDelta: 3,
  minGapMs: 600_000,
}

/**
 * A 路径：并行「批次收集窗口」配置项（字段全部可配，缺省见 DEFAULT_PARALLEL）。
 * 语义详见 Config.parallel 的注释；归一并钳制见 normalizeParallel。
 * 注意：这里已无 poolSize——A 路径的执行机制（subagent 工具）由 worker 岗位 preset 的
 * delegation 组承载，桥接层只保留「什么时候该提示可并行」的批次窗口参数。
 */
export interface ParallelOpts {
  enabled: boolean
  batchWindowSecs: number
  maxBatchItems: number
}

/** 并行批次窗口出厂默认（批次窗 8s / 单批 ≤4；待真实联调后固化）。 */
export const DEFAULT_PARALLEL: ParallelOpts = {
  enabled: true,
  batchWindowSecs: 8,
  maxBatchItems: 4,
}

/**
 * 归一并校验 settings 用户层/yml 的 parallel 配置（外部写入可能带脏值/越界）：
 * 批次窗口钳到 [2,60] 秒；单批条数钳到 [2,8]（防批次提示过长撑爆上下文）。
 * 整个值缺失/非对象 → undefined（调用侧用 DEFAULT_PARALLEL）。
 */
export function normalizeParallel(raw: unknown): ParallelOpts | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v
      : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v)
        : undefined
  const enabled = typeof rec.enabled === 'boolean' ? rec.enabled : undefined
  const batchWindowSecs = num(rec.batchWindowSecs)
  const maxBatchItems = num(rec.maxBatchItems)
  if (enabled === undefined && batchWindowSecs === undefined && maxBatchItems === undefined) {
    return undefined
  }
  return {
    enabled: enabled ?? DEFAULT_PARALLEL.enabled,
    batchWindowSecs: batchWindowSecs !== undefined ? Math.min(60, Math.max(2, Math.floor(batchWindowSecs))) : DEFAULT_PARALLEL.batchWindowSecs,
    maxBatchItems: maxBatchItems !== undefined ? Math.min(8, Math.max(2, Math.floor(maxBatchItems))) : DEFAULT_PARALLEL.maxBatchItems,
  }
}

/** 取归一后的并行批次窗口配置（config.parallel 缺省/脏值自动回退出厂默认）。 */
export function parallelOf(config: { parallel?: ParallelOpts }): ParallelOpts {
  return normalizeParallel(config.parallel) ?? DEFAULT_PARALLEL
}

/**
 * 归一并校验 settings 用户层/yml 的 autoTune（外部写入可能带脏值/越界）：
 * 数字钳到正数（windowN 至少 2、minGapMs ≥ 0），比例钳到 (0,1]，非法字段回退默认；
 * 整个值缺失/非对象 → 返回 undefined（调用侧用 DEFAULT_AUTOTUNE）。
 */
export function normalizeAutoTune(raw: unknown): AutoTune | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v
      : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v)
        : undefined
  const ratio = (v: unknown): number | undefined => {
    const n = num(v)
    return n !== undefined ? Math.min(1, Math.max(0.01, n)) : undefined
  }
  const windowN = num(rec.windowN)
  const parallelRatio = ratio(rec.parallelRatio)
  const cohesiveRatio = ratio(rec.cohesiveRatio)
  const minDelta = num(rec.minDelta)
  const minGapMs = num(rec.minGapMs)
  if (windowN === undefined && parallelRatio === undefined && cohesiveRatio === undefined &&
      minDelta === undefined && minGapMs === undefined) return undefined
  return {
    windowN: windowN !== undefined ? Math.max(2, Math.floor(windowN)) : DEFAULT_AUTOTUNE.windowN,
    parallelRatio: parallelRatio ?? DEFAULT_AUTOTUNE.parallelRatio,
    cohesiveRatio: cohesiveRatio ?? DEFAULT_AUTOTUNE.cohesiveRatio,
    minDelta: minDelta !== undefined ? Math.max(0, Math.floor(minDelta)) : DEFAULT_AUTOTUNE.minDelta,
    minGapMs: minGapMs !== undefined ? Math.max(0, Math.floor(minGapMs)) : DEFAULT_AUTOTUNE.minGapMs,
  }
}

/** 取归一后的 auto 阈值（config.autoTune 缺省/脏值自动回退出厂默认）。 */
export function autoTuneOf(config: { autoTune?: AutoTune }): AutoTune {
  return normalizeAutoTune(config.autoTune) ?? DEFAULT_AUTOTUNE
}

/** 接待分类标签定义：AI 判定输出 kind id → bridge 查表执行的一行策略。 */
export interface ReceptionKindDef {
  /** 显示名（设置界面/GUI）。 */
  label: string
  /** 语义描述（注入接待 persona，供 AI 判定参考：什么消息归此类）。 */
  describe: string
  /** 命中是否立刻发礼貌 ack。 */
  ack: boolean
  /** ack 话术模板（占位符 {{lp}}/{{taskHint}}/{{taskDesc}}/{{eta}} 运行时替换；空=用默认模板或散键回退）。 */
  ackText: string
  /** 是否把该房间 worker 置忙（true=视为任务在执行）。 */
  busy: boolean
  /** 是否照常转交 worker（false=接待层消化，不打扰 worker——仅用于明确收尾/不相关消息）。 */
  forward: boolean
}

/** dsh-matrix 插件配置。所有字段都可在 cordis.patch.yml 的行 config 中覆盖。 */
export interface Config {
  /** Matrix homeserver 的 client-server API base URL。 */
  homeserverUrl: string
  /** 主账号 access token；为空时回退到环境变量 DSH_MATRIX_TOKEN。 */
  accessToken: string
  /** 主账号 Matrix 用户 id（数字分身自己；真实人账号不在 harness 登录）。 */
  userId: string
  /** 允许与 bot 对话的 Matrix 用户 id 白名单；为空且 allowAllUsers=false 时拒绝所有人。 */
  allowedUserIds: string[]
  /** 允许任意用户（仅开发用）。 */
  allowAllUsers: boolean
  /** 工作责任负责人（真实人账号，仅在 Matrix 客户端登录）：设置后本账号审批仅其可应答。 */
  owner: string
  /** 是否响应房间里所有消息（false=只响应 @ 自己的消息）；默认 true（主账号个人助手模式）。 */
  respondToAll: boolean
  /** 默认 LLM provider 路由（分身未指定时使用）。 */
  provider: string
  /** 默认模型 id（分身未指定时使用）。 */
  model: string
  /**
   * room agent 挂载的 agent preset（决定其工具集与角色提示）。
   * 缺省 standard 提供完整工具（bash/pwsh/fs/…）；留空则 agent 无任何工具。
   * ⚠️ 无头（服务器无人值守）环境别用 standard：它挂载 ask_user_question / plan-mode
   * 「问人」工具，问题会推给 web answerer 而主人不在电脑旁。数字分身应配岗位 preset
   * （如 pm/dev/qa），其问人走 matrix_request_owner_decision（DM 私聊主人，有超时兜底）。
   */
  agentPreset: string
  /**
   * 数字人（worker/room agent）请求的思考级别（reasoningEffort）。
   * ''=不干预（默认，沿用模型默认思考，codebuddy 默认 high）| off | low | high | max。
   * 设 off 可关闭思考（秒回提速）；复杂任务可能降质，建议实测后定档。
   * 作用于 dsh-bridge 创建的所有 worker 会话（agentSetup 内按角色注入 agent/request）。
   */
  workerReasoningEffort: string
  /**
   * 秘书会话请求的思考级别。语义同上；秘书负责决策/上呈，默认 ''（保持模型默认 high），
   * 仅当明确要秘书提速才显式配置。作用于 secretary preset 会话。
   */
  secretaryReasoningEffort: string
  /** 出站单条消息的最大字符数（含分段前缀）。 */
  chunkMaxChars: number
  /** 裸文本消息的合并窗口（秒）；'..' 后缀继续、'!!' 后缀立即提交。 */
  mergeTimeoutSecs: number
  /** 审批请求推送到聊天后等待回复的秒数，超时按 unavailable 处理。 */
  approvalTimeoutSecs: number
  /** 桥接状态文件目录（房间↔会话映射、去重环、sync token、授权记录）。 */
  stateDir: string
  /**
   * 实例命名空间（会话隔离）：同一分身账号在多个 dsh 实例（不同端口/profile/DSH_HOME）运行时，
   * 若会话 id 只由 userId+roomId 派生，会互相 resume 到对方历史。此值参与确定性会话 id 生成，
   * 使不同 dsh 实例的 room agent 会话彼此隔离。显式非空时直接用其哈希；留空回退到
   * process.env.DSH_HOME 的哈希（DSH_HOME 是每个实例的稳定身份锚，端口号可能漂移/随机）。
   * DSH_HOME 也不存在时为空（保持旧的无命名空间 id，向后兼容）。改动需重启生效。
   */
  instanceKey: string
  /**
   * 重试熔断阈值：同一房间 turn 内 LLM 受限自动重试达到该次数时，插件主动
   * agent.cancel() 终止当前 turn 以止损（harness 的 always 模式无上限重试会持续烧 token）。
   * 设为 0 或配合 retryCircuitBreakerEnabled=false 可关闭熔断。默认 5（给模型恢复机会）。
   */
  maxRetriesBeforeAbort: number
  /** 是否启用重试熔断兜底（默认 true）。关闭后仅保留诊断日志，不做主动 cancel。 */
  retryCircuitBreakerEnabled: boolean

  // ========== 数字分身支持 ==========
  /** 启用数字分身模式：@提及路由、Owner 授权记忆、红线强制确认。 */
  digitalTwinMode: boolean
  /** 额外的数字分身账号列表（主账号之外，每个分身一个独立 Matrix 账号）。 */
  digitalTwins: DigitalTwinAccount[]
  /** 授权记录文件名（相对 stateDir）。 */
  authStoreFile: string
  /** 红线工具列表：即使有长期授权也必须每次房间确认。 */
  redlineTools: string[]

  // ========== Matrix 任务队列 ==========
  /** 新房间工作目录引导的候选目录列表；首项作为缺省。 */
  cwdCandidates: string[]
  /** 是否为 agent 注册 Matrix 工具（获取群联系人、最近消息等）。
   * true：注册 matrix_get_room_members 等 4 个工具，模型可按需调用获取信息。
   * false：不注册工具，回退到旧行为（将群聊历史等信息组合到消息中）。
   * 默认 true。
   */
  matrixTools: boolean
  /** 是否把入群/离群/资料变更等房间事件注入 agent 会话（供 agent 主动打招呼等）。
   * true：成员变化/资料变更时向对应房间 agent 注入「系统事件」消息（经 authorized 门控 + eventId 去重）。
   * false：忽略这些事件，仅更新缓存（默认，避免大群 join/leave 刷屏与 token 浪费）。
   */
  notifyRoomEvents: boolean
  /** 主动消息工具（matrix_send_dm/send_room_message/mention_member）首用是否需 Owner 批准。
   * true：首用经 approval/request 批准后记忆授权；false：直接允许发送（谨慎）。
   * 默认 true（安全优先）。
   */
  proactiveSendRequiresApproval: boolean
  /** 是否保留富文本（formatted_body）/回复上下文/编辑语义，结构化注入 agent 会话。
   * true：注入富文本结构注记 + 被回复消息引用 + 编辑标记，类人理解信息不丢失。
   * false：回退纯文本旧行为（token 更省、行为更保守）。默认 true。
   */
  preserveRichText: boolean

  // ========== 社交记忆 ==========
  /** 自己入群后是否主动 @ 成员做自我介绍。默认 true。 */
  autoIntroduce: boolean
  /** 自我介绍 @ 人数上限（超出截断并附「等 N 人」）。默认 20。 */
  maxSelfIntroMentions: number
  /** 是否记住成员资料（加入/资料变更 upsert）。默认 true。 */
  memberMemory: boolean
  /** 新成员（含其他数字人）入群时是否提示 agent 主动打招呼了解。默认 true。 */
  autoGreet: boolean
  /** 自我介绍模板；占位符 {{userId}}/{{role}}/{{owner}} 可替换。 */
  selfIntroTemplate: string

  // ========== 入群邀请审批 ==========
  /** 是否启用入群邀请审批（默认 true，安全优先）。
   * true：收到邀请不自动进群——邀请人已在批准名单则直接进群；否则落盘待决并请示主人。
   * false：回退旧行为（收到邀请无条件自动进群）——仅用于可信测试环境。
   */
  inviteApprovalEnabled: boolean
  /** 待决邀请的请示超时秒数。0 = 一直保持待决（等主人有空再答）。
   * >0：超时后按 inviteApprovalTimeoutAction 处置。注意邀请已持久化，超时不会丢邀请。
   */
  inviteApprovalTimeoutSecs: number
  /** 请示超时后的处置：'pending' 保持待决 / 'reject' 自动拒绝（安全默认）。 */
  inviteApprovalTimeoutAction: 'pending' | 'reject'

  // ========== 自我时间线（跨房间记忆，仅元数据） ==========
  /** 是否记录自我时间线（分身出站动作元数据，不落盘原文）。默认 true。 */
  timelineEnabled: boolean
  /** 是否在 room agent system prompt 注入 `twin:memory` 恒定提示词段（告知可查自我记忆）。默认 true。 */
  timelineInject: boolean
  /** 跨房间共享门控：false 时仅允许按房间查询（隔离），true 允许无 roomId 全量摘要。默认 false。 */
  timelineCrossRoom: boolean
  /** 时间线内存保留条数上限。默认 500。 */
  timelineCap: number

  // ========== 前台接待层话术模板（规则化 ack，用户可改） ==========
  /**
   * 前台接待层 5 类规则化话术模板（默认值=原硬编码文案，占位符 {{lp}}/{{taskHint}}/
   * {{taskDesc}}/{{eta}}/{{summary}} 运行时替换，含 [] 前缀原样保留）。留空=该场景不自动 ack。
   * - receptionAckNewTask：新任务收到（房间不忙、@ 派活）
   * - receptionAckBusyQuestion：忙时被问问题
   * - receptionAckBusy：忙时普通消息
   * - receptionRejected：主人拒绝开工
   * - receptionGiveUp：跟进超次代发占位
   */
  receptionAckNewTask: string
  receptionAckBusyQuestion: string
  receptionAckBusy: string
  receptionRejected: string
  receptionGiveUp: string

  // ========== AI 接待层（Reception as an Agent） ==========
  /** 是否启用 AI 接待判定（入站消息先经接待 agent 语义分类）。false=回退纯正则接待。默认 false（渐进开启）。 */
  receptionEnabled: boolean
  /** 接待会话挂载的 agent preset id（默认 reception，可换）。 */
  receptionPreset: string
  /** 接待会话独立 provider（空=沿用 worker 档 provider）。 */
  receptionProvider: string
  /** 接待会话独立模型（空=沿用 worker 档 model；建议填轻量快模型）。 */
  receptionModel: string
  /** 接待判定的思考级别（恒 off：接待必须快，不需要思考）。 */
  receptionReasoningEffort: string
  /** 接待判定单轮等待超时（秒）。超时回退正则接待。默认 3。 */
  receptionTimeoutSecs: number
  /**
   * 接待分类标签表（AI 判定输出 kind id → bridge 查表执行）。
   * 每类含：label（显示名）/describe（语义描述，注入 persona 供 AI 判定参考）/
   * ack（命中是否发礼貌 ack）/ackText（话术模板，空=不自定义）/busy（是否置忙）/forward（是否转 worker）。
   * 内置 5 类默认；用户可增删改（新增 kind 后 persona 自动带上其 describe）。
   */
  receptionKinds: Record<string, ReceptionKindDef>
  /** AI 接待判定最小消息长度阈值：短于此的纯问候/表情不判（避免琐碎消息烧 token）。默认 0=全判。 */
  receptionMinLength: number
  /** 接待判定节流（秒）：同一房间两次判定之间的最小间隔，间隔内直接复用上次判定结果。默认 0=不节流。 */
  receptionThrottleSecs: number

  // ========== 群工作模式（per-room 显式覆盖，默认 auto 自适配） ==========
  /** 该房间钉死的工作模式；undefined/缺省 = auto（前台按消息流自适配，不阻断任何行为）。 */
  roomModes: Record<string, RoomMode>

  // ========== per-room 岗位覆盖（键=roomId/群名，值=岗位 preset id） ==========
  /**
   * 该房间钉死的岗位 preset；缺省回退 config.agentPreset（全局默认岗位）。
   * 与 roomModes 同构：键可为 roomId 或群名，值必须是已安装岗位的 preset id。
   * 用于「每个会话/群单独调整岗位」——数字分身被拉进不同群时，按群指派不同岗位。
   */
  roomPresets: Record<string, string>

  // ========== auto 自适配阈值（阶段 3：auto 群按最近消息形态产软倾向，不落配置） ==========
  /**
   * 前台形态滚动器的阈值参数（设计「阶段 3 auto 自适配」§三）：窗口大小 / 两侧投票占比 /
   * 最小票差 / 倾向变更冷却。settings 用户层可热更（LIVE_APPLY_KEYS），缺省/脏值经
   * normalizeAutoTune 归一钳制后生效。缺省 undefined 时用 DEFAULT_AUTOTUNE。
   */
  autoTune?: AutoTune

  // ========== A 路径：并行「批次收集窗口」（提示层，执行机制在 preset+skill） ==========
  /**
   * 并行批次窗口参数（A 路径：bridge 只保留"什么时候该提示可并行"的输入预处理；
   * 怎么拆/怎么收/怎么交付由 worker 岗位 preset 的 delegation 组 + SKILL 承载）。
   * - enabled：总开关（默认 true；false=不触发并行批次/内部可拆提示，行为退化为现状）；
   * - batchWindowSecs：并行房「待派批」收集窗口（默认 8s）：窗口内多条独立 @任务
   *   被收集成结构化「并行任务批次」提示交给 worker（≥2 才批；不足走现状）；
   * - maxBatchItems：单批最多条目数（默认 4；防批次提示过长撑爆上下文）。
   */
  parallel?: ParallelOpts

  // ========== 测试环境识别 ==========
  /** 房间名前缀匹配即视为测试房间（如「【测试】」）。匹配时给数字人注入测试声明：
   * 「当前是测试环境，请勿真实执行任务/修改文件/向真实用户发送消息」。默认「【测试】」，空=关闭。 */
  testRoomPrefix: string
  /** 测试房间是否允许真实执行（读文件/分析/产出结果）。true=测试群可配合执行验证任务（仅提示别影响真实数据/用户）；
   * false=仍禁止执行（旧行为：仅配合测试对话）。默认 true。 */
  testEnvAllowExecute: boolean
  /** 房间名前缀匹配即启用秘书编排（任务入队/开工请示/交付确认），即使 digitalTwinMode=false。
   * 用于「只给测试房间开秘书编排」（测试房间名带此前缀）。默认 ''，空=不启用。 */
  twinModeRoomPrefix: string
  /** 群聊默认启用秘书编排：Matrix 群聊消息（非私聊）默认进任务队列待 owner 审核/请示/确认，
   * 无需 digitalTwinMode 或 twinModeRoomPrefix。私聊保持直接回复。默认 true。
   * 显式配置 digitalTwinMode=true 或 twinModeRoomPrefix 匹配时始终优先。 */
  secretaryGroupDefault: boolean
  /** 私聊默认启用秘书编排：设为 true 时，数字分身的私聊消息也进任务队列待 owner 审核。
   * 默认 false（私聊保持直接对话）。仅对数字分身账号（非主账号）生效。 */
  secretaryDmDefault: boolean

  // ========== 秘书编排（请示等待：首次等待后转「挂起待答」，不判死） ==========
  /** 开工请示（matrix_request_owner_decision）首次阻塞等待主人答复的秒数；
   *  超时后转「挂起待答」（返回 pending，请示保留），主人晚答复会唤醒秘书继续。默认 120。 */
  taskClarifyTimeoutSecs: number
  /** 交付汇报（matrix_report_owner）首次阻塞等待主人答复的秒数；
   *  超时后转「挂起待答」（返回 pending，汇报保留），主人晚答复会唤醒秘书继续。默认 600。 */
  taskConfirmTimeoutSecs: number
  /** worker 请示/汇报后首次阻塞等待「秘书回传决策」的秒数；
   *  超时后转「挂起待答」（返回 pending，请示保留），秘书晚回传（replyWorker）会唤醒 worker 继续。
   *  需覆盖秘书 LLM 思考时间（秘书可能要再上呈主人，故比主人决策略长）。默认 180。 */
  secretaryDecisionTimeoutSecs: number
}

// 注：标 `.volatile()` 的字段可在设置页热编辑（0.1.7 SettingsForms.describe() 只投影 volatile 字段）。
// 0.1.7 关键约定（已实测验证）：volatile 字段【可】写进 cordis.patch.yml 作为「部署初始值」，
// 只要 profile 层用「不带 insert 的 - id: matrix」（覆盖语义）而非 - insert:（会 compose 出两个
// entry，导致 configEditor.edit 写盘被拒「overridden by home patch」）。
// 故字段划分：仅「连接/身份」参数（homeserverUrl/accessToken/userId/owner/instanceKey/provider）
// 保持非 volatile（写死 patch，改需重启）；「运行时行为开关」（respondToAll/allowAllUsers 等）
// 标 volatile，可热编辑 + 保留 patch 初始值。
export const Config = Schema.object({
  homeserverUrl: Schema.string().required(),
  accessToken: Schema.string().default(''),
  userId: Schema.string().required(),
  allowedUserIds: Schema.array(Schema.string()).default([]).volatile(),
  allowAllUsers: Schema.boolean().default(false).volatile(),
  owner: Schema.string().default(''),
  respondToAll: Schema.boolean().default(true).volatile(),
  provider: Schema.string().default('deepseek-official'),
  model: Schema.string().default('deepseek-v4-flash').volatile(),
  agentPreset: Schema.string().default('standard').volatile(),
  workerReasoningEffort: Schema.string().default('').volatile(),
  secretaryReasoningEffort: Schema.string().default('').volatile(),
  chunkMaxChars: Schema.number().default(4000).volatile(),
  mergeTimeoutSecs: Schema.number().default(5),
  approvalTimeoutSecs: Schema.number().default(300),
  stateDir: Schema.string().default('.dsh-matrix'),
  instanceKey: Schema.string().default(''),
  maxRetriesBeforeAbort: Schema.number().default(5),
  retryCircuitBreakerEnabled: Schema.boolean().default(true),

  digitalTwinMode: Schema.boolean().default(false),
  digitalTwins: Schema.array(Schema.object({
    userId: Schema.string().required(),
    accessToken: Schema.string().default(''),
    tokenEnv: Schema.string().default(''),
    owner: Schema.string().default(''),
    role: Schema.string().default(''),
    respondToAll: Schema.boolean().default(false),
    provider: Schema.string().default(''),
    model: Schema.string().default(''),
  })).default([]),
  authStoreFile: Schema.string().default('auth-store.json'),
  redlineTools: Schema.array(Schema.string()).default(['bash', 'pwsh', 'write', 'edit']),

  cwdCandidates: Schema.array(Schema.string()).default([process.cwd()]),
  matrixTools: Schema.boolean().default(true),
  notifyRoomEvents: Schema.boolean().default(false),
  proactiveSendRequiresApproval: Schema.boolean().default(true).volatile(),
  preserveRichText: Schema.boolean().default(true).volatile(),

  autoIntroduce: Schema.boolean().default(true).volatile(),
  maxSelfIntroMentions: Schema.number().default(20).volatile(),
  memberMemory: Schema.boolean().default(true).volatile(),
  autoGreet: Schema.boolean().default(true).volatile(),
  selfIntroTemplate: Schema.string().default('大家好，我是 {{userId}}，很高兴加入这个群。以后有什么需要帮忙的尽管找我，我会尽力配合大家的工作！').volatile(),
  inviteApprovalEnabled: Schema.boolean().default(true),
  inviteApprovalTimeoutSecs: Schema.number().default(0),
  inviteApprovalTimeoutAction: Schema.union([Schema.const('pending'), Schema.const('reject')]).default('reject'),

  receptionAckNewTask: Schema.string().default('收到，我这就去整理{{taskHint}}，稍后把结果发你～').volatile(),
  receptionAckBusyQuestion: Schema.string().default('[前台接待] @{{lp}} 这条我记下了，手头正忙（处理任务中）{{taskDesc}}{{eta}}，处理完马上回你；有急需可以再把关键点说一遍～').volatile(),
  receptionAckBusy: Schema.string().default('[前台接待] @{{lp}} 收到，我手头正忙（处理任务中）{{taskDesc}}{{eta}}，稍后回你这条～').volatile(),
  receptionRejected: Schema.string().default('[前台接待] 主人暂时不同意开工，任务「{{summary}}」先搁置。').volatile(),
  receptionGiveUp: Schema.string().default('[前台接待] 我正在整理「{{summary}}」，结果稍后同步，请稍等～').volatile(),

  receptionEnabled: Schema.boolean().default(false).volatile(),
  receptionPreset: Schema.string().default('reception').volatile(),
  receptionProvider: Schema.string().default('').volatile(),
  receptionModel: Schema.string().default('').volatile(),
  receptionReasoningEffort: Schema.string().default('off').volatile(),
  receptionTimeoutSecs: Schema.number().default(3).volatile(),
  receptionMinLength: Schema.number().default(0).volatile(),
  receptionThrottleSecs: Schema.number().default(0).volatile(),
  receptionKinds: Schema.dict(Schema.object({
    label: Schema.string().required(),
    describe: Schema.string().required(),
    ack: Schema.boolean().default(true),
    ackText: Schema.string().default(''),
    busy: Schema.boolean().default(true),
    forward: Schema.boolean().default(true),
  })).default(defaultReceptionKinds()).volatile(),

  // per-room 群工作模式显式覆盖：键=房间 id（Matrix roomId 或群名），值=钉死模式；
  // 缺省/未收录 = auto。设置页可手动钉死，口播指令由前台识别后写入（默认空）。
  roomModes: Schema.dict(Schema.union([Schema.const('auto'), Schema.const('parallel'), Schema.const('cohesive')])).default({}),

  // per-room 岗位覆盖：键=roomId/群名，值=岗位 preset id（kebab-case）。缺省回退 agentPreset。
  roomPresets: Schema.dict(Schema.string()).default({}),

  // auto 自适配阈值（阶段 3）：窗口/占比/最小票差/冷却全可配；缺省 undefined = 出厂默认。
  // 注意：阈值本身可配可热更，但「产出的倾向值」绝不写 settings（只存内存，重启即清）。
  autoTune: Schema.object({
    windowN: Schema.number().min(2).default(DEFAULT_AUTOTUNE.windowN),
    parallelRatio: Schema.number().min(0.01).max(1).default(DEFAULT_AUTOTUNE.parallelRatio),
    cohesiveRatio: Schema.number().min(0.01).max(1).default(DEFAULT_AUTOTUNE.cohesiveRatio),
    minDelta: Schema.number().min(0).default(DEFAULT_AUTOTUNE.minDelta),
    minGapMs: Schema.number().min(0).default(DEFAULT_AUTOTUNE.minGapMs),
  }).default(DEFAULT_AUTOTUNE),

  // A 路径并行批次窗口（总开关/批次窗/单批上限；无池参数——执行机制在 preset 的 delegation 组）。
  parallel: Schema.object({
    enabled: Schema.boolean().default(DEFAULT_PARALLEL.enabled),
    batchWindowSecs: Schema.number().min(2).max(60).default(DEFAULT_PARALLEL.batchWindowSecs),
    maxBatchItems: Schema.number().min(2).max(8).default(DEFAULT_PARALLEL.maxBatchItems),
  }).default(DEFAULT_PARALLEL),

  timelineEnabled: Schema.boolean().default(true),
  timelineInject: Schema.boolean().default(true),
  timelineCrossRoom: Schema.boolean().default(false),
  timelineCap: Schema.number().default(500),

  testRoomPrefix: Schema.string().default('【测试】').volatile(),
  testEnvAllowExecute: Schema.boolean().default(true),
  twinModeRoomPrefix: Schema.string().default(''),
  secretaryGroupDefault: Schema.boolean().default(true).volatile(),
  secretaryDmDefault: Schema.boolean().default(false).volatile(),

  taskClarifyTimeoutSecs: Schema.number().default(120).volatile(),
  taskConfirmTimeoutSecs: Schema.number().default(600).volatile(),
  secretaryDecisionTimeoutSecs: Schema.number().default(180).volatile(),
}) as unknown as Schema<Config>

/**
 * 解包 apply 收到的 config：标 `.volatile()` 的字段在运行时是 cosmokit 的 `Volatile<T>`
 * 对象（schemastery Schema.resolve 对 meta.volatile 节点 createVolatile 包装），需 `.get()`
 * 解包成普通值。与官方 dsh-llm-deepseek 的 plainOptions 同构。
 * 热更新（loader/volatile-update）后 config 对象引用稳定、Volatile ref 被原地更新，
 * 重跑本函数即得最新值。
 * 用 duck-typing 判断 Volatile（有 get 方法的对象），避免显式依赖 @deepseek-ai/cosmokit。
 */
function unwrapVolatile(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    // 仅当对象除 get 外无其他自身属性时才视为 Volatile 包装（避免误伤带 get 方法的业务对象）。
    const keys = Object.keys(value as object)
    if (keys.length <= 2 && keys.includes('get')) return (value as { get(): unknown }).get()
  }
  return value
}

export function plainMatrixConfig(raw: unknown): Config {
  const src = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(src)) {
    out[key] = unwrapVolatile(src[key])
  }
  return out as unknown as Config
}

/** 内置 5 类接待分类标签的默认定义（用户可在 settings receptionKinds 里增删改）。 */
export function defaultReceptionKinds(): Record<string, ReceptionKindDef> {
  return {
    'new-task': {
      label: '新任务',
      describe: '同事明确要求数字员工动手执行的任务：整理/汇总/编写/分析/排期/读取文件等，通常有可交付成果，特征是命令式或请求式、指向未来的产出。',
      ack: true,
      ackText: '',
      busy: true,
      forward: true,
    },
    'busy-question': {
      label: '忙时追问',
      describe: 'worker 正在处理任务（房间忙）时，同事发来的追问/澄清/问题，期望 worker 处理完当前任务后回答。注意：即便不带问号，只要明显是针对进行中任务的追问就归此类。',
      ack: true,
      ackText: '',
      busy: false,
      forward: true,
    },
    'busy-plain': {
      label: '忙时普通消息',
      describe: 'worker 忙时同事发来的非问题类消息：补充信息/同步/简单说明/转发材料，需要礼貌回应但不打断当前工作。',
      ack: true,
      ackText: '',
      busy: false,
      forward: true,
    },
    'closing-ack': {
      label: '收尾确认',
      describe: '同事对已交付结果的验收/确认/致谢/收尾（如「收到，清单没问题，辛苦了」「行，先这样，不打扰了」）。表示话题已闭合，不是新任务、不需要 worker 再动手。',
      ack: false,
      ackText: '',
      busy: false,
      forward: false,
    },
    chat: {
      label: '闲聊问答',
      describe: '普通对话/闲聊/答疑，无需动手执行，worker 直接回复即可。接待层不抢答。',
      ack: false,
      ackText: '',
      busy: false,
      forward: true,
    },
  }
}
