/**
 * 测试系统配置：从环境变量 / .env 读取。
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** 一个同事测试账号。 */
export interface ColleagueAccount {
  userId: string
  displayName: string
  accessToken: string
}

/** 完整配置。 */
export interface TestConfig {
  homeserver: string
  twinUserId: string
  /** 数字人账号 access token（数字人身份注入用；缺省禁用该功能）。 */
  twinAccessToken?: string
  colleagues: ColleagueAccount[]
  llm: { baseUrl: string; apiKey: string; model: string }
  web: { host: string; port: number }
  roundsPerRoom: number
  replyTimeoutSecs: number
  roomPrefix: string
}

function loadDotEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), 'test-system', '.env')]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
      out[key] = value
    }
    break
  }
  return out
}

const env: Record<string, string | undefined> = { ...process.env, ...loadDotEnv() }

function required(key: string): string {
  const v = env[key]
  if (v === undefined || v === '') throw new Error(`缺少配置 ${key}（见 .env.example）`)
  return v
}

function parseColleagues(raw: string): ColleagueAccount[] {
  return raw.split(',').map((part, i) => {
    const trimmed = part.trim()
    if (trimmed === '') throw new Error('COLLEAGUE_TOKENS 有空项')
    const cols = trimmed.split(':')
    // userId:accessToken —— userId 形如 @zhangsan:server，token 无冒号（syt_ 开头）时用 splitn
    const sep = trimmed.lastIndexOf(':')
    if (sep <= 0) throw new Error(`COLLEAGUE_TOKENS 项格式错误: ${trimmed}`)
    const userId = trimmed.slice(0, sep)
    const accessToken = trimmed.slice(sep + 1)
    const lp = userId.startsWith('@') && userId.includes(':') ? userId.slice(1, userId.indexOf(':')) : userId
    return { userId, displayName: lp, accessToken }
  })
}

export function loadConfig(): TestConfig {
  return {
    homeserver: required('HOMESERVER').replace(/\/+$/, ''),
    twinUserId: required('TWIN_USER_ID'),
    twinAccessToken: env['TWIN_ACCESS_TOKEN'] ?? undefined,
    colleagues: parseColleagues(required('COLLEAGUE_TOKENS')),
    llm: {
      baseUrl: required('LLM_BASE_URL').replace(/\/+$/, ''),
      apiKey: required('LLM_API_KEY'),
      model: required('LLM_MODEL'),
    },
    web: {
      host: env['WEB_HOST'] ?? '127.0.0.1',
      port: Number(env['WEB_PORT'] ?? '3088'),
    },
    roundsPerRoom: Number(env['ROUNDS_PER_ROOM'] ?? '6'),
    replyTimeoutSecs: Number(env['REPLY_TIMEOUT_SECS'] ?? '90'),
    roomPrefix: env['ROOM_PREFIX'] ?? 'twin-test',
  }
}
