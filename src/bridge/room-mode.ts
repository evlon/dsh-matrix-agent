/**
 * 群工作模式（roomModes）纯函数层：口播指令识别 / 判定输出解析 / 镜像归一 / 格式化 /
 * auto 自适配倾向投票（阶段 3）。
 * 全部为同步纯函数（零 I/O、零依赖），便于 node 直跑单元自查与阶段 2 复用：
 * - 前台（classifyIncoming / maybeConsumeModeDirective）识别口播指令 → 落内存 + settings roomModes；
 * - 识别原则「拿不准不落配置」（设计要点 2）：**强句式**（明确设置语气）才能无 LLM 兜底落配置；
 *   弱词汇只在 AI 接待层启用并给出同向语义确认时才落（关键词 + LLM 双保险）。
 *   避免把闲聊里「别拆太细 / 这是客服群吧」这类泛词误判成钉死指令。
 * - 阶段 3（auto 自适配）：shapeVote / leaningFromWindow / nextLeaning / leaningLabel 给
 *   auto 群产「最近 N 条消息的形态倾向」（parallel/cohesive/neutral）。倾向只存内存作软信号，
 *   绝不写 settings；「宁 neutral 不乱切」由占比阈值 + 票差 + 变更防抖三重保证。
 *
 * 模式语义（详见「数字员工系统_群工作模式设计_2026.md」）：
 * - auto：默认自适配（不阻断任何行为）；
 * - parallel：答疑/客服群，问题相互独立 → 阶段 2 拆任务并行；
 * - cohesive：协作群，多人共做一件事 → 单 worker 串行（现状行为）。
 */

import type { RoomMode } from './config.js'
import { isRoomMode } from './config.js'

/**
 * 口播模式指令识别分级：
 * - 强句式（strong）：明确「设置/指定本群模式」的句式 → 无 AI 时也可保守落配置；
 * - 弱词汇（weak）：仅含模式相关词但语气不明确 → 只作 AI 复核候选，AI 缺席不落。
 */

/** 求证/猜测收尾：指名某类群后带「吧/嘛/呀/啊/吗」→ 是对群性质的求证，不是钉死指令。 */
const GUESS_TONE_RE = /(客服|答疑|问答|咨询|支持|服务|项目|任务|工作|协同|协作|攻坚)群(吧|嘛|呀|啊|吗)/

/** 否定拒斥（仅作用于强句式命中后）：出现「不是/别用/不要用/关掉/取消」等 → 不是钉死指令。 */
const NEGATION_RE = /(不(是|要|用|设|开|让)|别用|不要用|关掉|取消|撤掉|停掉|别开)/

/** 疑问/未定语气：问号、句尾「吗」、或开头「要不要/能不能/是否…」→ 一律不落配置。 */
const QUESTION_TONE_RE = /[？?]|吗$|^(要不要|能不能|可不可以|是否|该不该|需不需要|怎么开|怎么设)/

/** 并行方向强句式：显式设置动词 + 并行/parallel，或「这是…客服/答疑…群」（收尾非求证语气）。 */
const PARALLEL_STRONG: RegExp[] = [
  /(把|将|给)?这(个|间)?群(的)?(设为|设置成|调成|改成|切到|切换|切为|用|开|开启|启用)(并行|parallel)(模式)?/i,
  /用并行模式/i,
  /(这(个|间)?群|本群|咱(们)?群|群里)(是|属于|算)(客服|答疑|问答|咨询|支持|服务)群/,
  /(这是|这个是|这是?个)(客服群|答疑群|问答群|咨询群|支持群|服务群)(的)?[。！!]?$/,
]

/** 并行方向弱词汇（仅 AI 复核用）。 */
const PARALLEL_WEAK: RegExp[] = [
  /客服群|答疑群|问答群|咨询群|支持群|服务群/,
  /互不相关|各自处理|一人一答|独立问题|分开处理|别抢答|不用抢答/,
  /问题(很|都)?独立/,
]

/** 协同方向强句式：显式设置动词 + 协同/协作，或「这是…项目/协同…群」，或「别拆任务/活」。 */
const COHESIVE_STRONG: RegExp[] = [
  /(把|将|给)?这(个|间)?群(的)?(设为|设置成|调成|改成|切到|切换|切为|用|开|开启|启用)(协同|协作|cohesive)(模式)?/i,
  /(这(个|间)?群|本群|咱(们)?群|群里)(是|属于|算)(项目|任务|工作|协同|协作|攻坚)群/,
  /(这是|这个是|这是?个)(项目群|任务群|工作群|协同群|协作群|攻坚群)(的)?[。！!]?$/,
  /(别|不要|别把|不要把|不能把)(任务|活|工作)(拆|分开|拆开|拆散)/,
  /(任务|活|工作)(别|不要)(拆|拆开|拆散)/,
]

/** 协同方向弱词汇（仅 AI 复核用）。 */
const COHESIVE_WEAK: RegExp[] = [
  /协同|协作|cohesive/i,
  /项目群|任务群|工作群|攻坚群/,
  /统一推进|连贯|保持上下文|共享上下文|一起做|共同做|整体做|串行|按顺序|按流程|专人跟|不要抢/,
]

/** 打断词：口气明显是否定/不涉及模式设置时，绝不落配置。 */
const BREAKER_RE = /(不要设|不用设|别设|别管|不用管|不要管|没让你|不需要你|别理|别帮我|别给我们)/

/**
 * 消息是否「几乎纯模式指令」（无实质任务内容）：无任务类动词（整理/写/查/做…）且不长。
 * 用于早检：强句式纯指令 → 直接落配置并吞掉，不转发 worker（避免被当任务执行）。
 * 指令+任务混排（"开并行，顺便帮我整理X"）→ false，走完整分类后由双保险裁决。
 */
export function isProbablyPureDirective(text: string, maxLen = 80): boolean {
  if (text.length > maxLen) return false
  // 实质任务动词：出现即认为消息夹带任务（如"用并行模式整理会议纪要"），不能整条吞。
  // 注意不含"帮我/请帮"——模式设置句常带（"帮我把这个群设为并行"），它们不是任务。
  return !/(整理|汇总|编写|写一|写个|写份|写篇|分析|查一|查下|查查|调研|做一|做个|搞一|弄一|出个|制定|排期|评估|统计|转成|整理成|归纳|起草|生成|生成一|生成个|列个|列一|看看|看一下)/.test(text)
}

/** 模式指令识别结果。 */
export interface ModeDirective {
  mode: RoomMode
  /** true=强句式（可无 AI 兜底落配置）；false=仅弱词汇（需 AI 同向确认）。 */
  strong: boolean
}

/**
 * 口播指令关键词预判：返回命中侧（强句式命中即认定；否则两侧弱词汇同时命中才算候选，
 * 供 AI 复核用）。两侧冲突或都不中 → undefined（不算指令，拿不准不落配置）。
 */
export function keywordModeHint(text: string): ModeDirective | undefined {
  // 疑问/求证语气前置拒斥：问号/句尾吗/要不要/…群吧 → 一律不算指令（宁漏不误钉）。
  if (QUESTION_TONE_RE.test(text) || GUESS_TONE_RE.test(text)) return undefined
  const negated = NEGATION_RE.test(text)
  const hitStrongP = PARALLEL_STRONG.some((re) => re.test(text))
  const hitStrongC = COHESIVE_STRONG.some((re) => re.test(text))
  // 强句式带否定（"不是并行模式/别用并行"）→ 不是钉死指令；也不回退弱词（语义已乱）。
  if (negated) {
    if (hitStrongP || hitStrongC) return undefined
  } else {
    if (hitStrongP && !hitStrongC) return { mode: 'parallel', strong: true }
    if (hitStrongC && !hitStrongP) return { mode: 'cohesive', strong: true }
    if (hitStrongP && hitStrongC) return undefined // 双侧强句式冲突 → 拿不准
  }
  const hitWeakP = PARALLEL_WEAK.some((re) => re.test(text))
  const hitWeakC = COHESIVE_WEAK.some((re) => re.test(text))
  if (hitWeakP && !hitWeakC) return { mode: 'parallel', strong: false }
  if (hitWeakC && !hitWeakP) return { mode: 'cohesive', strong: false }
  return undefined
}

/**
 * 解析前台 AI 判定输出中的「模式指令段」（reception 单次推理顺带输出）。
 * 判定契约要求 LLM 输出附加字段 mode，取值：
 * - 不输出 / "no"：本条不是模式指令；
 * - "parallel" / "cohesive"：显式钉死该群模式的指令；
 * - "unsure"：疑似但拿不准（不落配置）。
 * 容错：围栏/多余文本剥离后按行找 "mode" 键；解析失败/非法值一律 undefined。
 */
export function parseModeFromOutput(text: string): RoomMode | undefined {
  if (text === undefined || text === '') return undefined
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  // 只认首层 JSON 对象里的 mode（容忍 reason 等其它字段与顺序变化）。
  const m = cleaned.match(/"mode"\s*:\s*"?([a-zA-Z]+)"?/)
  if (m === null || m === undefined) return undefined
  const value = (m[1] ?? '').toLowerCase()
  if (value === 'no' || value === 'unsure' || value === 'none') return undefined
  if (isRoomMode(value)) return value
  return undefined
}

/**
 * 是否应落配置（双保险裁决）：
 * - 强句式命中：LLM 缺席（未启用/失败）也可落；LLM 同向/未反对则落，反向则弃（以语义为准）；
 * - 仅弱词汇命中：必须 LLM 同向确认才落（LLM 缺席/反向一律不落）。
 * 命中带打断词 → 一律不落。
 */
export function shouldApplyModeDirective(hint: ModeDirective | undefined, llm: RoomMode | undefined, text: string): boolean {
  if (hint === undefined) return false
  if (BREAKER_RE.test(text)) return false
  if (hint.strong) {
    return llm === undefined || llm === hint.mode
  }
  return llm === hint.mode
}

/** 模式 → 中文显示名。 */
export function roomModeLabel(mode: RoomMode | undefined): string {
  switch (mode) {
    case 'parallel': return '并行'
    case 'cohesive': return '协同'
    default: return '自动'
  }
}

/**
 * 归一并校验 settings 用户层/yml 的 roomModes 镜像（外部写入/旧 schema 可能带脏值）：
 * 键必须非空字符串、值必须合法模式，其余剔除。返回全新的 Record。
 */
export function normalizeRoomModes(raw: unknown): Record<string, RoomMode> {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, RoomMode> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === '') continue
    if (isRoomMode(value)) out[key] = value
  }
  return out
}

/**
 * 归一并校验 settings 用户层/yml 的 roomPresets 镜像：键必须非空字符串、值必须非空
 * 岗位 preset id 字符串，其余剔除。返回全新的 Record。
 */
export function normalizeRoomPresets(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === '') continue
    if (typeof value === 'string' && value.trim() !== '') out[key] = value
  }
  return out
}

/**
 * 把某账号（分身）的 roomModes 子表并入总表（后者为设置页可写的「房间 id/群名 → 模式」总表）。
 * 各账号只增量合并自己改过的键，绝不整表覆盖（避免多账号并发写互相吞）。
 */
export function mergeAccountRoomModes(total: Record<string, RoomMode>, account: Record<string, RoomMode>): Record<string, RoomMode> {
  const out: Record<string, RoomMode> = { ...total }
  for (const [key, mode] of Object.entries(account)) {
    if (isRoomMode(mode)) out[key] = mode
  }
  return out
}

/**
 * 群内确认话术（口播指令落配置后向群里播报）。
 * {{roomLabel}} 为当前群名（无则「本群」）；说明已生效并给改回出口。
 */
export function modeConfirmText(mode: RoomMode, roomLabel: string): string {
  const label = roomModeLabel(mode)
  const how = label === '并行'
    ? '群内相互独立的提问我会分别并行处理，互不干扰'
    : '群内围绕同一件事我会串行推进、保持上下文连贯'
  const where = roomLabel !== '' && roomLabel !== '本群' ? `「${roomLabel}」` : '本群'
  return `已将此群（${where}）设为${label}模式：${how}。如需改回自动或换模式，随时告诉我即可。`
}

// ════════════════════ 阶段 3：auto 自适配（群形态倾向投票）════════════════════
// 设计「阶段 3 auto 自适配」§六.2：全部为同步纯函数（零 I/O、零依赖），node 直测。
// 语义：给「最近 N 条人类消息」逐条打倾向票（parallel / cohesive / 中性不投票），
// 窗口汇总出 per-room 软倾向（Leaning）。倾向只作注入行软信号、绝不写 settings；
// 「宁 neutral 不乱切」由投票占比阈值 + 票差 + 变更防抖共同保证。
// 倾向票是运行时软判断：重启即清、不落盘（auto 群重启后重新积累即可）。

export type Leaning = 'parallel' | 'cohesive' | 'neutral'

/** 单条形态采样：与入站人类消息同构的轻量三元组（bridge 滚动器喂给它）。 */
export interface ShapeSample {
  sender: string
  text: string
  ts: number
}

/** 短独立问的最大长度（设计 §三.2：长度 < 60 视为短问，> 60 不算答疑节奏）。 */
const SHORT_QUESTION_MAX = 60

/**
 * 中性（不投票）文本：纯确认/致谢/纯表情等短收尾，不含可判别的工作形态。
 * 命中即 shapeVote 返回 undefined（中性票不计数，也不稀释占比——分母只算有效票）。
 * 识别为「收尾短语」：以确认/致谢核心词开头，其后只允许标点 + 礼貌尾词
 * （辛苦了/谢谢/感谢…）或语气词（呢呀吧嘛啊）——夹带实质内容（动词/宾语）不算中性。
 */
const ACK_LEAD_RE = /^(收(到|了)|收到收到|收到没问题|好(的|吧|呢|呀)?|嗯+|哦+|噢+|ok|OK|👌|👍|辛苦(了)?|谢谢|谢啦|多谢|感谢|没问题|可以|行(的|吧|呢|呀)?|了解|清楚(了)?|是(的)?|对(的)?|哈哈+|呵呵+|嗯嗯|好的呢|晓得|明白)[，,、。.．!！?？:：;；…\s~～]*/i
const POLITE_TAIL_RE = /^(辛苦了?|谢谢|多谢|感谢|好的|嗯+|👌|👍)$/i
const PARTICLE_TAIL_RE = /^[呢呀吧嘛啊的]+$/

/** 纯表情/无实质内容（去掉符号后 < 2 个内容字符）也判中性。 */
function isShapeNeutral(text: string): boolean {
  const stripped = text.trim()
  if (stripped === '') return true
  const content = stripped
    .replace(/[\s\u3000\u3001\uFF0C\u3002\uFF01\uFF1F\uFF1A\uFF1B\u300A\u300B\u201C\u201D\u2018\u2019\uFF08\uFF09\-—…、；：？！.,;:!?()"'[\]{}<>~`@]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
  if (content.length < 2) return true
  // 收尾短语：确认/致谢核心 + 仅礼貌尾词或语气词 → 中性。
  const lead = ACK_LEAD_RE.exec(stripped)
  if (lead === null) return false
  const rest = stripped.slice(lead[0].length)
  if (rest === '') return true
  const restClean = rest.replace(/[，,、。.．!！?？:：;；…\s~～]/g, '').trim()
  if (restClean === '') return true
  return POLITE_TAIL_RE.test(restClean) || PARTICLE_TAIL_RE.test(restClean)
}

/**
 * 短独立问的疑问词（复用 applyLegacyReceptionRules 的 QUESTION 词表语义 + 句尾问号）。
 * 只认「句尾问号/吗/呢/么」或「以疑问词开头」——避免把正文中嵌疑问词的
 * 长陈述句（如"帮我查一下哪个接口能连"）误当短问。整体再叠加长度 < 60 门槛。
 */
const SHORT_QUESTION_RE = /[?？]|吗$|呢$|么$|^(怎么|如何|为什么|啥|谁|哪个|哪些|多少|何时|能不能|可不可以|要不要|是否|有没有|是不是|能否|可否)/

/**
 * 上下文引用/接续词（S3）：出现即视为「围绕同一件事/共享上下文推进」→ cohesive 票。
 * 覆盖两类：明确接续（接着/继续/按上次说的…）与话题补充（补充/还有/另外…）。
 * 「明确长指令带上下文引用」可跨 sender 判定（设计 §三.2 cohesive 第三项）；
 * 短文本仅在同 sender 连续时借 marker 判定（见 shapeVote 规则 4）。
 */
const CONTEXT_REF_RE = /(接着|继续|按(上次|刚才|之前|前面)|刚才|上次|之前)(说|讲|提到|的|那个|这个|一下)?|补充|还有|另外|再说|再补|再聊|延续|回到(刚才|上次|之前)|继续(上次|刚才|之前)/

/**
 * 同主题重叠判定（S3 轻量）：双方去除 @前缀/标点/表情/问答套话后抽取连续双字（bigram），
 * 存在任一共享双字即视为主题重叠。足够轻（窗口 ≤ N 条 × 短文本），供前台每条消息 O(窗口) 算。
 * 关键：先剥掉句尾问答模板（怎么办/怎么查/什么流程…）——否则两个**不相关**的短问
 * （"社保断缴怎么办" vs "离职证明怎么办"）会因共享"怎么办"双字被误判为主题重叠 → cohesive，
 * 恰好违背设计风险 4（同人连发多个不相关短问应偏 parallel）。真连续补充重叠的是内容词。
 */
const QA_TEMPLATE_TAIL_RE = /(怎么|如何|怎样|咋|啥|什么|哪些|哪个|多少|何时|多久|为什么|能不能|可不可以|要不要|是否|有没有|是不是|能否|可否|好吗|行吗|在吗)([\u4e00-\u9fff]{0,4})?$/
const TRAILING_PARTICLE_RE = /[的了吗呢么啊吧]+$/

/** 抽主题双字前的清洗：标点已在调用处剥掉，这里只剥句尾问答模板与语气词。 */
function topicBigrams(s: string): Set<string> {
  let content = s
    .replace(/@\S+/g, '')
    .replace(/[\s\u3000\u3001\uFF0C\u3002\uFF01\uFF1F\uFF1A\uFF1B\u300A\u300B\u201C\u201D\u2018\u2019\uFF08\uFF09\-—…、；：？！.,;:!?()"'[\]{}<>~`]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
  content = content.replace(QA_TEMPLATE_TAIL_RE, '').replace(TRAILING_PARTICLE_RE, '')
  const set = new Set<string>()
  for (let i = 0; i + 1 < content.length; i++) set.add(content.slice(i, i + 2))
  return set
}

function topicOverlap(a: string, b: string): boolean {
  const ga = topicBigrams(a)
  const gb = topicBigrams(b)
  if (ga.size === 0 || gb.size === 0) return false
  for (const g of ga) if (gb.has(g)) return true
  return false
}

/**
 * 单条消息 → 单票（设计 §六.2）：复用 PARALLEL_WEAK/COHESIVE_WEAK + 问句/长度/
 * 同人连续补充/话题重叠规则。prev = 窗口内「上一条产生票的消息」（中性票不更新 prev，
 * 使同人补充不被无关的确认打断连续性）。返回 'parallel' | 'cohesive' | undefined（中性）。
 *
 * 规则顺序（宁 neutral，逐级收敛）：
 * 1. 中性（纯确认/表情/过短）→ 不投票；
 * 2. 弱词汇单侧命中（复用阶段 1 词表）→ 该侧投票；双侧同时命中 → 交结构规则；
 * 3. 明确上下文引用且够长（“接着刚才的/按上次说的/补充…”，可跨 sender）→ cohesive；
 * 4. 同一 sender 连续（对上一条有效票）且带接续词或主题重叠 → cohesive（补充/追问同一件事）；
 * 5. 短独立问（长度 < 60 + 疑问语气）→ parallel（答疑节奏）；
 * 6. 其余一律不投票（不把“不同人发言”简单归纳为 parallel）。
 */
export function shapeVote(text: string, prev: ShapeSample | undefined, sender: string): 'parallel' | 'cohesive' | undefined {
  const t = (text ?? '').trim()
  if (t === '') return undefined
  if (isShapeNeutral(t)) return undefined
  // 弱词汇（阶段 1 词汇表；单侧命中即投该侧票）。
  const hitP = PARALLEL_WEAK.some((re) => re.test(t))
  const hitC = COHESIVE_WEAK.some((re) => re.test(t))
  if (hitP && !hitC) return 'parallel'
  if (hitC && !hitP) return 'cohesive'
  // 明确上下文引用 + 够长（“接着刚才的 / 按上次说的 / 我补充…”，不要求 sender 连续）。
  if (t.length >= 8 && CONTEXT_REF_RE.test(t)) return 'cohesive'
  // 同一 sender 连续且带接续词/主题重叠（“补充/追问同一件事”）。
  if (prev !== undefined && sender !== '' && sender === prev.sender &&
      (CONTEXT_REF_RE.test(t) || topicOverlap(t, prev.text))) return 'cohesive'
  // 短独立问 → 答疑节奏（并行）。
  if (t.length < SHORT_QUESTION_MAX && SHORT_QUESTION_RE.test(t)) return 'parallel'
  return undefined
}

/** leaningFromWindow 的可调参数（缺省 = 设计 §三.2 初值：N=20 / 60% / Δ≥3）。 */
export interface LeaningWindowOpts {
  n?: number
  parallelRatio?: number
  cohesiveRatio?: number
  minDelta?: number
}

/**
 * 窗口滚动 → 倾向版本裁决（设计 §六.2；不带时间，时间防抖交给调用侧 nextLeaning）：
 * 对窗口内每条消息打票（prev 取窗口内上一条有效票，实现“连续”语义），统计后：
 * - parallel 票占比 ≥ parallelRatio 且 p−c ≥ minDelta → 'parallel'；
 * - cohesive 票占比 ≥ cohesiveRatio 且 c−p ≥ minDelta → 'cohesive'；
 * - 否则 'neutral'（占比不过半 / 票差不足 → 宁 neutral 不乱切）。
 * 中性票不参与分母（占比只算有效票）——设计「中性票不计数」。
 */
export function leaningFromWindow(samples: ShapeSample[], opts?: LeaningWindowOpts): Leaning {
  const n = Math.max(2, Math.floor(opts?.n ?? 20))
  const parallelRatio = opts?.parallelRatio ?? 0.6
  const cohesiveRatio = opts?.cohesiveRatio ?? 0.6
  const minDelta = Math.max(0, Math.floor(opts?.minDelta ?? 3))
  const recent = samples.length > n ? samples.slice(samples.length - n) : samples
  let pVotes = 0
  let cVotes = 0
  let prev: ShapeSample | undefined
  for (const s of recent) {
    const vote = shapeVote(s.text, prev, s.sender)
    if (vote === 'parallel') {
      pVotes += 1
      prev = s
    } else if (vote === 'cohesive') {
      cVotes += 1
      prev = s
    }
    // 中性票：不计数、不更新 prev（不打断他人/自己的接续语义）。
  }
  const total = pVotes + cVotes
  if (total === 0) return 'neutral'
  if (pVotes / total >= parallelRatio && pVotes - cVotes >= minDelta) return 'parallel'
  if (cVotes / total >= cohesiveRatio && cVotes - pVotes >= minDelta) return 'cohesive'
  return 'neutral'
}

/**
 * 防抖/冷却裁决（设计 §六.2）：窗口 verdict（proposed）与当前倾向（prev）之间的
 * 变更裁决——双重防抖防形态震荡横跳：
 * - proposed = neutral：直接返回 neutral（降回“不声明”是防震荡出口，无需冷却）；
 * - proposed 与 prev 同向：保持；
 * - 反向切换（parallel↔cohesive）：需距上次变更 ≥ minGapMs **且** 窗口整体翻新
 *   （windowFresh = 自上轮变更以来已滚动 ≥ 整窗新消息）才允许，否则保持 prev；
 * - 首声明（prev = neutral → parallel/cohesive）：只要求冷却（窗口才刚积累出多数票，
 *   不强制整窗翻新，否则新建窗口永远无法发声）。
 */
export function nextLeaning(
  prev: Leaning,
  prevAt: number,
  now: number,
  windowFresh: boolean,
  proposed: Leaning,
  minGapMs: number,
): Leaning {
  const gap = Math.max(0, minGapMs ?? 0)
  if (proposed === 'neutral') return 'neutral'
  if (proposed === prev) return prev
  // 反向切换：窗口未整体翻新 → 证据不足，保持现状（宁不切）。
  if (prev !== 'neutral' && !windowFresh) return prev
  // 冷却：距上次变更不足 minGapMs → 保持现状。
  if (prev !== 'neutral' && now - prevAt < gap) return prev
  return proposed
}

/**
 * 倾向注入行（软声明，设计 §4.1 措辞）：parallel/cohesive 各给一行低噪提示；
 * neutral → ''（不注入，走现状）。
 */
export function leaningLabel(lean: Leaning): string {
  switch (lean) {
    case 'parallel': return '（本群近况判断：多人独立提问为主，本批可按并行处理）'
    case 'cohesive': return '（本群近况判断：围绕同一件事持续推进，本批保持连贯上下文）'
    default: return ''
  }
}
