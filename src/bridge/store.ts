import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface RoomBinding {
  readonly sessionId: string
}

/** 人+事维度黑白名单规则。 */
export interface AllowDenyRule {
  /** 人：Matrix 用户 id（'*' 表示任意人）。 */
  readonly person: string
  /** 事：任务关键词/分类（'*' 表示任意事）。 */
  readonly matter: string
  readonly kind: 'allow' | 'deny'
  readonly addedAt: number
}

interface AllowDenyFile {
  version: 1
  rules: AllowDenyRule[]
}

interface StateFile {
  version: 1
  /** 会话命名空间（实例身份）：写入本文件的会话 id 所属的实例命名空间。
   *  切换 dsh 实例（DSH_HOME/instanceKey 变化）时用于作废旧房间绑定，
   *  避免跨实例 resume 到对方历史。旧文件无此字段（undefined）视为 legacy，保留绑定。 */
  sessionNamespace?: string
  roomSessions: Record<string, RoomBinding>
  processedEventIds: string[]
  syncToken?: string
  /** 房间已选定的工作目录（新房间授权后写入）。 */
  roomCwds?: Record<string, string>
  /** 房间会话代数：每次 /clear 或检测到损坏历史时 +1，用于生成全新确定性会话 id。 */
  roomSessionEpochs?: Record<string, number>
  /** 房间切换岗位时待同步的历史摘要（roomId → 摘要文本）。新建会话后注入并清除。 */
  roomJobSwitchSummaries?: Record<string, string>
}

/** 去重环最多保留的事件 id 数。Matrix 事件 id 全局唯一，重启后重放窗口有限。 */
const DEDUP_CAP = 2000
const SAVE_DEBOUNCE_MS = 300

/**
 * 桥接持久状态：房间↔会话映射、已处理事件去重环、Matrix sync token。
 * 原子写入（tmp + rename），写入去抖；`dispose()` 强制落盘。
 */
export class BridgeState {
  private data: StateFile = { version: 1, roomSessions: {}, processedEventIds: [] }
  private allowDeny: AllowDenyFile = { version: 1, rules: [] }
  private allowDenyPath: string | undefined
  private saveTimer: NodeJS.Timeout | undefined
  private saving: Promise<void> | undefined
  private allowDenySaving = false

  /** 当前实例的会话命名空间（由 load 传入；未提供则视为无命名空间）。 */
  private sessionNamespace: string | undefined

  constructor(private readonly filePath: string) {
    this.allowDenyPath = `${dirname(filePath)}/allow-deny.json`
  }

  /** 读取状态文件；`namespace` 为当前实例身份，用于作废跨实例的旧房间绑定。 */
  async load(namespace?: string): Promise<void> {
    this.sessionNamespace = namespace
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StateFile>
      if (parsed?.version === 1 && typeof parsed.roomSessions === 'object' && parsed.roomSessions !== null) {
        // 命名空间隔离：磁盘记录的 namespace 与当前不一致（例如同一个 stateDir 被
        // 另一个 dsh 实例写过后，本实例再次启动）时，作废房间↔会话绑定与会话代数，
        // 让本实例重新生成自己的确定性会话 id，绝不 resume 到别的实例的历史。
        const storedNs = typeof parsed.sessionNamespace === 'string' ? parsed.sessionNamespace : undefined
        const nsChanged = namespace !== undefined && storedNs !== undefined && storedNs !== namespace
        this.data = {
          version: 1,
          roomSessions: nsChanged ? {} : parsed.roomSessions as Record<string, RoomBinding>,
          processedEventIds: Array.isArray(parsed.processedEventIds) ? parsed.processedEventIds.slice(-DEDUP_CAP) : [],
          ...(typeof parsed.syncToken === 'string' ? { syncToken: parsed.syncToken } : {}),
          ...(typeof parsed.roomCwds === 'object' && parsed.roomCwds !== null && !nsChanged ? { roomCwds: parsed.roomCwds as Record<string, string> } : {}),
          ...(typeof parsed.roomSessionEpochs === 'object' && parsed.roomSessionEpochs !== null && !nsChanged ? { roomSessionEpochs: parsed.roomSessionEpochs as Record<string, number> } : {}),
          ...(typeof parsed.roomJobSwitchSummaries === 'object' && parsed.roomJobSwitchSummaries !== null && !nsChanged ? { roomJobSwitchSummaries: parsed.roomJobSwitchSummaries as Record<string, string> } : {}),
        }
      }
    } catch (error) {
      // 首次运行没有状态文件是正常情况；其它错误照常抛出。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // 无论文件是否存在、是否读成功，只要提供了命名空间就记录到 data，
    // 保证首次 saveNow 时它被序列化进磁盘（否则后续读回时 storedNs 为 undefined，作废失效）。
    if (namespace !== undefined) {
      this.data.sessionNamespace = namespace
    }
    await this.loadAllowDeny()
  }

  private async loadAllowDeny(): Promise<void> {
    if (!this.allowDenyPath) return
    try {
      const raw = await readFile(this.allowDenyPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AllowDenyFile>
      if (parsed?.version === 1 && Array.isArray(parsed.rules)) {
        this.allowDeny = { version: 1, rules: parsed.rules }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  roomSession(roomId: string): string | undefined {
    return this.data.roomSessions[roomId]?.sessionId
  }

  /** 所有已绑定会话的房间 id 列表（供岗位看板等聚合视图枚举）。 */
  roomIds(): string[] {
    return Object.keys(this.data.roomSessions)
  }

  setRoomSession(roomId: string, sessionId: string): void {
    this.data.roomSessions[roomId] = { sessionId }
    this.scheduleSave()
  }

  deleteRoom(roomId: string): void {
    if (roomId in this.data.roomSessions) {
      delete this.data.roomSessions[roomId]
      this.scheduleSave()
    }
    if (this.data.roomCwds) delete this.data.roomCwds[roomId]
    this.scheduleSave()
  }

  // ---- 房间会话代数（用于 /clear 与损坏历史重建） ----

  /** 当前房间的会话代数；无记录时返回 0（兼容旧的无后缀确定性 id）。 */
  sessionEpoch(roomId: string): number {
    return this.data.roomSessionEpochs?.[roomId] ?? 0
  }

  /** 代数 +1：下次 createRoomAgent 会生成新的确定性会话 id（旧 session 不再 resume）。 */
  bumpSessionEpoch(roomId: string): number {
    if (!this.data.roomSessionEpochs) this.data.roomSessionEpochs = {}
    const next = (this.data.roomSessionEpochs[roomId] ?? 0) + 1
    this.data.roomSessionEpochs[roomId] = next
    this.scheduleSave()
    return next
  }

  // ---- 房间切换岗位待同步历史摘要 ----

  /** 读取房间待同步的历史摘要；无则 undefined。 */
  roomJobSwitchSummary(roomId: string): string | undefined {
    return this.data.roomJobSwitchSummaries?.[roomId]
  }

  /** 写入房间待同步历史摘要（切换岗位时记录旧会话要点，新建会话后注入）。 */
  setRoomJobSwitchSummary(roomId: string, summary: string): void {
    if (!this.data.roomJobSwitchSummaries) this.data.roomJobSwitchSummaries = {}
    this.data.roomJobSwitchSummaries[roomId] = summary
    this.scheduleSave()
  }

  /** 清除房间待同步历史摘要（注入完成后调用）。 */
  clearRoomJobSwitchSummary(roomId: string): void {
    if (this.data.roomJobSwitchSummaries) {
      delete this.data.roomJobSwitchSummaries[roomId]
      this.scheduleSave()
    }
  }

  // ---- 房间工作目录绑定 ----

  roomCwd(roomId: string): string | undefined {
    return this.data.roomCwds?.[roomId]
  }

  setRoomCwd(roomId: string, cwd: string): void {
    if (!this.data.roomCwds) this.data.roomCwds = {}
    this.data.roomCwds[roomId] = cwd
    this.scheduleSave()
  }

  // ---- 人+事黑白名单 ----

  listRules(): AllowDenyRule[] {
    return this.allowDeny.rules
  }

  addRule(rule: AllowDenyRule): void {
    this.allowDeny.rules = this.allowDeny.rules.filter(
      (r) => !(r.person === rule.person && r.matter === rule.matter),
    )
    this.allowDeny.rules.push(rule)
    void this.scheduleAllowDenySave()
  }

  private async scheduleAllowDenySave(): Promise<void> {
    if (!this.allowDenyPath || this.allowDenySaving) return
    this.allowDenySaving = true
    try {
      await mkdir(dirname(this.allowDenyPath), { recursive: true })
      const tmp = `${this.allowDenyPath}.tmp`
      await writeFile(tmp, JSON.stringify(this.allowDeny, null, 2), 'utf8')
      await rename(tmp, this.allowDenyPath)
    } catch (error) {
      // 写入失败仅记录，不阻断主流程。
      console.warn(`[matrix] failed to save allow/deny: ${String(error)}`)
    } finally {
      this.allowDenySaving = false
    }
  }

  sessionRoom(sessionId: string): string | undefined {
    for (const [roomId, binding] of Object.entries(this.data.roomSessions)) {
      if (binding.sessionId === sessionId) return roomId
    }
    return undefined
  }

  hasSeen(eventId: string): boolean {
    return this.data.processedEventIds.includes(eventId)
  }

  markSeen(eventId: string): void {
    if (this.hasSeen(eventId)) return
    this.data.processedEventIds.push(eventId)
    if (this.data.processedEventIds.length > DEDUP_CAP) {
      this.data.processedEventIds.splice(0, this.data.processedEventIds.length - DEDUP_CAP)
    }
    this.scheduleSave()
  }

  get syncToken(): string | undefined {
    return this.data.syncToken
  }

  set syncToken(token: string | undefined) {
    if (token === this.data.syncToken) return
    this.data.syncToken = token
    this.scheduleSave()
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      // 写文件失败（如 Windows EPERM 文件锁竞争）绝不能让 unhandled rejection
      // 导致整个 dsh 进程 fatal：静默降级，下一次 scheduleSave 会重试。
      void this.saveNow().catch(() => {})
    }, SAVE_DEBOUNCE_MS)
  }

  async saveNow(): Promise<void> {
    clearTimeout(this.saveTimer)
    if (this.saving !== undefined) {
      await this.saving
      return
    }
    this.saving = (async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      await rename(tmp, this.filePath)
    })().finally(() => {
      this.saving = undefined
    })
    await this.saving
  }

  async dispose(): Promise<void> {
    clearTimeout(this.saveTimer)
    if (this.saving !== undefined) await this.saving.catch(() => {})
    await this.saveNow().catch(() => {})
  }
}
