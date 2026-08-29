/**
 * AI 同事：用独立 LLM（OpenAI 兼容 API）扮演测试群里的同事。
 * 输入：角色 persona + 房间上下文（最近消息） + 测试目标 → 输出下一条发言。
 * 与 dsh 解耦（独立 key）。
 */

export interface ColleaguePersona {
  userId: string
  displayName: string
  /** 角色描述（如"研发部张三，直接，爱追问细节"）。 */
  role: string
  /** 本轮测试目标（如"测试数字人能否理解任务需求"）。 */
  goal: string
}

export interface AiColleagueOptions {
  baseUrl: string
  apiKey: string
  model: string
  /** 被测数字人账号（发言需要 @ 它，确保响应）。 */
  twinUserId?: string
  /** 测试接缝。 */
  fetchFn?: typeof fetch
}

/** 一次发言生成结果。 */
export interface ColleagueTurn {
  /** 发言文本；若为 null 表示本轮不发言（结束/待命）。 */
  text: string | null
  /** 结束本轮对话的标志（同事认为测试目标已达成）。 */
  done: boolean
}

export class AiColleague {
  private readonly options: AiColleagueOptions

  constructor(options: AiColleagueOptions) {
    this.options = options
  }

  /**
   * 让同事基于房间上下文生成下一条发言。
   * @param persona 同事角色
   * @param history 房间最近消息（按时间正序），每项 { sender, text }
   * @param round 当前轮次（1 起）
   */
  async nextMessage(persona: ColleaguePersona, history: Array<{ sender: string; text: string }>, round: number): Promise<ColleagueTurn> {
    const twin = this.options.twinUserId ?? ''
    const twinNote = twin !== ''
      ? `- 群里有一个数字人「${twin}」（分账号），你要找它说话/派活/提问。**每次发言开头用 @${twin} 明确找它**（除非你在回复其他同事），这样它才会响应。`
      : ''
    const system = [
      `你正在参与数字人行为测试。你扮演「${persona.displayName}」（${persona.role}）。`,
      `你的测试目标：${persona.goal}`,
      '规则：',
      '- 像真实同事一样在群里说话：自然、简短（一般 1-3 句），可以提问、给任务、闲聊、追问细节。',
      twinNote,
      '- 不要暴露你是测试机器人；不要提"测试""模拟"等词。',
      '- 观察群里其他人的回复，自然地继续对话；数字人回复后可以追问或确认。',
      '- 如果测试目标已达成（比如你问的问题得到了满意回答、任务被理解），回复 DONE 表示本轮结束。',
      '- 只输出你的发言内容本身，不要输出任何解释或前缀。',
    ].join('\n')
    const historyText = history.length === 0
      ? '（群里还没有消息，这是开场）'
      : history.map((h) => `${h.sender}: ${h.text}`).join('\n')
    const user = `第 ${round} 轮。当前房间最近消息：\n${historyText}\n\n请输出你（${persona.displayName}）的下一句发言：`

    const reply = await this.chat(system, user)
    const trimmed = reply.trim()
    if (/^(DONE|结束|好了|就这样|没问题了)/i.test(trimmed) || trimmed === '') {
      return { text: null, done: true }
    }
    return { text: trimmed, done: false }
  }

  /** 单轮 chat 调用（OpenAI 兼容）。失败重试 2 次。 */
  private async chat(system: string, user: string): Promise<string> {
    const fetchFn = this.options.fetchFn ?? fetch
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchFn(`${this.options.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify({
            model: this.options.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            max_tokens: 300,
            temperature: 0.9,
          }),
        })
        if (!res.ok) {
          let detail = ''
          try {
            const j = await res.json() as { error?: { message?: string } }
            detail = j.error?.message ?? ''
          } catch { /* 非 JSON */ }
          throw new Error(`LLM ${res.status}: ${detail}`)
        }
        const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
        const content = data.choices?.[0]?.message?.content
        if (content === undefined || content === '') throw new Error('LLM 返回空内容')
        return content
      } catch (error) {
        lastError = error
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
      }
    }
    throw lastError instanceof Error ? lastError : new Error('LLM 调用失败')
  }
}
