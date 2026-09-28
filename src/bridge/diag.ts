import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 诊断日志：写入 stateDir/diagnostics.log（stateDir 由 DSH_HOME 派生，
 * 见 dsh-matrix-agent 的 settings 注册处），便于事后由 AI/人工直接读取文件排查，
 * 不必依赖 dsh web 运行终端。按行追加，进程级单例。
 *
 * 注意：不再写 ~/.dsh/dsh-matrix-diag.log —— 那个路径无视 DSH_HOME 隔离，
 * 会把隔离 home（如 3090 的 .dsh-matrix-dev）的诊断污染进 ~/.dsh，且不易定位。
 */
export class DiagLogger {
  private file: string | undefined
  private readonly mem: string[] = []
  private readonly maxMem = 500

  constructor(private readonly name: string, stateDir?: string) {
    this.attachFile(stateDir)
  }

  /** 后补挂载文件（单例可能先于拿到 stateDir 的调用方创建）。 */
  attachFile(stateDir?: string): void {
    if (this.file || !stateDir) return
    try {
      mkdirSync(stateDir, { recursive: true })
      this.file = join(stateDir, 'diagnostics.log')
    } catch {
      this.file = undefined
    }
  }

  log(line: string): void {
    const ts = new Date().toISOString()
    const full = `${ts} ${line}`
    // 内存环缓冲，供 tests / 调试查看最近 N 条
    this.mem.push(full)
    if (this.mem.length > this.maxMem) this.mem.shift()
    if (this.file) {
      try {
        appendFileSync(this.file, full + '\n')
      } catch {
        /* 写文件失败不影响主流程 */
      }
    }
  }

  /** 取最近若干条内存日志（不读文件）。 */
  recent(n = 50): string[] {
    return this.mem.slice(-n)
  }
}

let shared: DiagLogger | undefined

export function getDiag(name: string, stateDir?: string): DiagLogger {
  if (!shared) shared = new DiagLogger(name, stateDir)
  else shared.attachFile(stateDir)
  return shared
}
