import Schema from '@deepseek-ai/schemastery'

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

/** 数字分身灵魂配置：性格、说话风格、口头禅、工作习惯。可经设置界面/yml 配置。 */
export interface SoulConfig {
  /** 是否启用灵魂注入（false 时完全不影响 prompt）。默认 true。 */
  enabled: boolean
  /** 性格/人设描述（自由文本，注入 system prompt）。 */
  persona: string
  /** 说话风格：简洁/亲切/正式/幽默/毒舌。 */
  style: string
  /** 口头禅（一句话，可选）。 */
  catchphrase: string
  /** 工作习惯（自由文本，如"先确认需求再动手，做完主动同步结论"）。 */
  habits: string
  /** 回复长度偏好：short/normal/detailed。 */
  replyLength: string
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
   */
  agentPreset: string
  /** 出站单条消息的最大字符数（含分段前缀）。 */
  chunkMaxChars: number
  /** 裸文本消息的合并窗口（秒）；'..' 后缀继续、'!!' 后缀立即提交。 */
  mergeTimeoutSecs: number
  /** 审批请求推送到聊天后等待回复的秒数，超时按 unavailable 处理。 */
  approvalTimeoutSecs: number
  /** 桥接状态文件目录（房间↔会话映射、去重环、sync token、授权记录）。 */
  stateDir: string
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
  /** 单个房间 matrix 任务队列上限，超出后最早 pending 任务被自动拒绝。 */
  taskQueueMax: number
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

  // ========== 数字分身灵魂 ==========
  /** 灵魂配置（性格/风格/口头禅/习惯）。 */
  soul?: SoulConfig

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

  // ========== 自我时间线（跨房间记忆，仅元数据） ==========
  /** 是否记录自我时间线（分身出站动作元数据，不落盘原文）。默认 true。 */
  timelineEnabled: boolean
  /** 是否在 room agent system prompt 注入 `twin:memory` 恒定提示词段（告知可查自我记忆）。默认 true。 */
  timelineInject: boolean
  /** 跨房间共享门控：false 时仅允许按房间查询（隔离），true 允许无 roomId 全量摘要。默认 false。 */
  timelineCrossRoom: boolean
  /** 时间线内存保留条数上限。默认 500。 */
  timelineCap: number

  // ========== 秘书编排（角色化会话 + 开工请示 + 交付确认） ==========
  /** 房间 → 灵魂预设 id 的固定角色映射（如 { '!room:hs': 'dev' }）。默认空（百变员工）。 */
  roomRoles: Record<string, string>
  /** 开工前是否私下请示老板（矩阵 DM）。默认 true。 */
  taskClarifyBeforeStart: boolean
  /** 开工请示等待秒数；超时按原任务开始（不阻塞）。默认 120。 */
  taskClarifyTimeoutSecs: number
  /** 交付前是否私下确认老板。默认 true。 */
  taskConfirmBeforeDeliver: boolean
  /** 交付确认等待秒数。默认 600。 */
  taskConfirmTimeoutSecs: number
  /** 确认超时行为：hold(挂起待确认)/deliver(自动交付)/cancel(取消)。默认 'hold'。 */
  taskConfirmTimeoutAction: 'hold' | 'deliver' | 'cancel'
  /** 豁免交付确认的事分类（低风险任务跳过确认）。默认 []。 */
  taskConfirmExemptMatters: string[]
}

export const Config: Schema<Config> = Schema.object({
  homeserverUrl: Schema.string().required(),
  accessToken: Schema.string().default(''),
  userId: Schema.string().required(),
  allowedUserIds: Schema.array(Schema.string()).default([]),
  allowAllUsers: Schema.boolean().default(false),
  owner: Schema.string().default(''),
  respondToAll: Schema.boolean().default(true),
  provider: Schema.string().default('deepseek-official'),
  model: Schema.string().default('deepseek-v4-flash'),
  agentPreset: Schema.string().default('standard'),
  chunkMaxChars: Schema.number().default(4000),
  mergeTimeoutSecs: Schema.number().default(5),
  approvalTimeoutSecs: Schema.number().default(300),
  stateDir: Schema.string().default('.dsh-matrix'),
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
  taskQueueMax: Schema.number().default(20),
  matrixTools: Schema.boolean().default(true),
  notifyRoomEvents: Schema.boolean().default(false),
  proactiveSendRequiresApproval: Schema.boolean().default(true),
  preserveRichText: Schema.boolean().default(true),

  soul: Schema.object({
    enabled: Schema.boolean().default(true),
    persona: Schema.string().default('你是「百变员工」：会根据所在房间的名称、讨论氛围与收到的消息，自动选择最合适的人设与语气（比如在技术群里像靠谱的研发、在需求讨论里像产品经理、面对新同事像乐于帮助的前辈）。你不需要固定一种性格。'),
    style: Schema.string().default(''),
    catchphrase: Schema.string().default(''),
    habits: Schema.string().default('先理解当前对话的语境与对象，再选择合适的人设与语气；如果切换了人设，主动用一句话告知对方你现在以什么角色出现，并提示可以在「数字分身」设置页修改灵魂。'),
    replyLength: Schema.string().default('normal'),
  }).default({
    enabled: true,
    persona: '你是「百变员工」：会根据所在房间的名称、讨论氛围与收到的消息，自动选择最合适的人设与语气（比如在技术群里像靠谱的研发、在需求讨论里像产品经理、面对新同事像乐于帮助的前辈）。你不需要固定一种性格。',
    style: '',
    catchphrase: '',
    habits: '先理解当前对话的语境与对象，再选择合适的人设与语气；如果切换了人设，主动用一句话告知对方你现在以什么角色出现，并提示可以在「数字分身」设置页修改灵魂。',
    replyLength: 'normal',
  }),

  autoIntroduce: Schema.boolean().default(true),
  maxSelfIntroMentions: Schema.number().default(20),
  memberMemory: Schema.boolean().default(true),
  autoGreet: Schema.boolean().default(true),
  selfIntroTemplate: Schema.string().default('大家好，我是 {{userId}}，很高兴加入这个群。以后有什么需要帮忙的尽管找我，我会尽力配合大家的工作！'),

  timelineEnabled: Schema.boolean().default(true),
  timelineInject: Schema.boolean().default(true),
  timelineCrossRoom: Schema.boolean().default(false),
  timelineCap: Schema.number().default(500),

  roomRoles: Schema.dict(Schema.string()).default({}),
  taskClarifyBeforeStart: Schema.boolean().default(true),
  taskClarifyTimeoutSecs: Schema.number().default(120),
  taskConfirmBeforeDeliver: Schema.boolean().default(true),
  taskConfirmTimeoutSecs: Schema.number().default(600),
  taskConfirmTimeoutAction: Schema.union(['hold', 'deliver', 'cancel']).default('hold'),
  taskConfirmExemptMatters: Schema.array(Schema.string()).default([]),
})
