/**
 * A 路径：并行能力纯函数层（subagent 提示层）。
 * 全部为同步纯函数（零 I/O、零依赖、不感知任何并行"引擎"服务），便于 node 直跑单元自查：
 * - 批次判定：并行房「待派批」窗口内 ≥2 条独立 @任务 → 结构化「并行任务批次」提示交 worker 拆；
 * - 批次结构注入：worker 侧批次提示 + 内部可拆提示（MVP 口播/枚举触发）；
 * - 执行方式：**机制在 preset+skill**（worker 岗位 preset 挂 delegation 组 = subagent 工具；
 *   SKILL 交代何时拆/怎么收/怎么交付）。本层只产出"什么时候该提示可并行"的输入预处理。
 *
 * 铁律（与阶段 1/3 一致）：
 * - 本层只产出「提示/结构」等纯数据，绝不主动调用任何执行 API（执行交给 worker 模型）；
 * - 「宁可串行不可拆错」：批次/内部可拆均为**提示**，拆不拆由 worker 模型判断；
 * - 交付红线不因并行放宽：子代理无房间绑定不能发群（同秘书会话机制），结果经 report 回 worker，
 *   群内交付单点收敛在 worker（owner 批准后才发群）。
 */

/** 并行群待派批的单条独立任务（保留 sender/text 各自独立，勿拼成一段文本）。 */
export interface ParallelTaskItem {
  /** 消息序号（1 起，窗口内递增；提示里作「N) @sender：…」编号）。 */
  seq: number
  /** 发送者 userId（提示里显示 @localpart）。 */
  sender: string
  /** 独立任务原文（已剥离 @提及 前缀后的文本）。 */
  text: string
}

/** 任务在等待窗口内是否已超时（窗口 ms > 0 且超过）。 */
export function isWindowExpired(enteredAtMs: number, nowMs: number, windowMs: number): boolean {
  return windowMs > 0 && nowMs - enteredAtMs >= windowMs
}

/** 是否应触发「并行批次」结构提示：≥2 条独立任务（提示不吞消息，拆不拆由 worker 判）。 */
export function shouldBatch(tasks: readonly ParallelTaskItem[], minItems = 2): boolean {
  return tasks.length >= minItems
}

/** 组装「并行任务批次」结构化提示（设计 A 路径 §三.A/B；源 kind='user' 右对齐气泡）。
 *  措辞指向 subagent 工具（delegation 组，release 内置）：worker 用 subagent/subagent_fork
 *  为每个独立任务各派一个后台子代理，子代理用 report 回报、worker 用 list_agents 观察。 */
export function buildBatchPrompt(tasks: readonly ParallelTaskItem[]): string {
  const lines = tasks.map((t) => {
    const lp = t.sender.includes(':') ? t.sender.split(':')[0] : t.sender
    const who = lp === '' ? '(未知名)' : `@${lp}`
    return `${t.seq}) ${who}：${t.text}`
  })
  return [
    '[并行任务批次] 本群当前为并行模式。这批有 ' + tasks.length + ' 个相互独立的请求（已按发送者/主题分条）：',
    ...lines,
    '',
    '请判断：若它们确实相互独立（不共享中间状态、互不引用），用 subagent 工具（subagent / subagent_fork，' +
      '每个子代理 prompt 自包含：任务全文 + 产出格式 + "结果用 report 回报"）为每个独立任务各派一个后台子代理并行处理；' +
      '用 list_agents 观察子代理状态，全部收齐后把各结果**分条**用 matrix_send_room_message 在群里逐条交付。' +
      '若存在相互依赖或需要共享上下文，则按顺序串行处理。宁可串行，不可拆错。',
  ].join('\n')
}

/** 单条任务是否呈「内部可拆」形态（含明确列表/枚举结构：请分别/逐个/1.2.3./A/B/C）。 */
export function isInternallySplittable(text: string): boolean {
  return /(分别|逐个|逐条|一一|每个|每一项|各[^的]{0,4}(分析|评审|检查|处理|看一下|整理)|1[\.、．\uFF0E]|2[\.、．\uFF0E]|3[\.、．\uFF0E])/u.test(text)
    || /(?:^|\n)\s*(?:[-*]|\d+[\.\)、．])\s+/u.test(text)
}

/** 单条内部可拆任务的结构化提示（弱触发：模型不认可就退回现状）。措辞指向 subagent 工具。 */
export function buildSplittableHint(text: string): string {
  return [
    '[并行提示] 本条任务包含明显的并列/枚举结构，各部分看起来相互独立：',
    text.slice(0, 400),
    '',
    '若各部分确实相互独立且无需共享中间状态，可考虑用 subagent 工具各派一个子代理并行执行（prompt 自包含、' +
      '结果用 report 回报），再汇总逐项回复；若各部分有依赖，则保持串行。宁可串行，不可拆错。',
  ].join('\n')
}
