/**
 * Web UI 服务：http server + SSE 实时推送测试事件。
 * GET /          静态页（对话流 + 房间列表）
 * GET /events    SSE 事件流
 * GET /state     房间状态快照
 * POST /control  干预指令（pause/resume/stop/inject/switch/skip-wait + 全局）
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EventBus } from '../events.js'
import type { RoomState } from '../events.js'
import type { ControlCmd } from '../orchestrator.js'

export interface WebServerOptions {
  host: string
  port: number
  bus: EventBus
  getRooms: () => RoomState[]
  /** 干预指令回调（orchestrator.control）。 */
  control?: (cmd: ControlCmd) => { ok: boolean; message?: string }
  /** 数字人身份注入是否可用（供 UI 提示）。 */
  twinInjectionAvailable?: boolean
  /** 当前场景信息。 */
  getActiveScenario?: () => { id: string; name: string; run: number } | undefined
  /** 场景控制（start/stop/restart/room-restart）。 */
  scenario?: (req: ScenarioRequest) => { ok: boolean; message?: string }
  /** 主人区域：切换 AI/真人驱动。 */
  setOwnerAutoApprove?: (v: boolean) => void
  /** 主人区域：读取收件箱。 */
  getOwnerInbox?: () => Array<{ roomId: string; text: string; kind: string }>
  /** 主人区域：真人对某条请示答复。 */
  ownerReply?: (roomId: string, replyText: string) => Promise<void>
}

/** 场景控制请求。 */
export interface ScenarioRequest {
  action: 'start' | 'stop' | 'restart' | 'room-restart'
  scenarioId?: string
  scenarioName?: string
  roomId?: string
}

export class TestWebServer {
  private readonly options: WebServerOptions
  private server: ReturnType<typeof createServer> | undefined

  constructor(options: WebServerOptions) {
    this.options = options
  }

  start(): Promise<void> {
    return new Promise((resolveStart, rejectStart) => {
      const { host, port, bus } = this.options
      // public 目录在项目根 test-system/public（源码与产物都指向它）。
      const publicDir = resolve(import.meta.dirname, '..', '..', 'public')

      const serveStatic = (path: string, res: ServerResponse, contentType: string): void => {
        try {
          const body = readFileSync(resolve(publicDir, path))
          res.writeHead(200, { 'Content-Type': contentType })
          res.end(body)
        } catch {
          res.writeHead(404)
          res.end('Not Found')
        }
      }

      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
        const path = url.pathname

        if (path === '/') {
          serveStatic('index.html', res, 'text/html; charset=utf-8')
          return
        }
        if (path === '/app.js') {
          serveStatic('app.js', res, 'application/javascript; charset=utf-8')
          return
        }
        if (path === '/style.css') {
          serveStatic('style.css', res, 'text/css; charset=utf-8')
          return
        }
        if (path === '/events') {
          // SSE。
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
          res.write('retry: 2000\n\n')
          const unsub = bus.subscribe((event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`)
          })
          req.on('close', () => {
            unsub()
            res.end()
          })
          return
        }
        if (path === '/state') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({
            rooms: this.options.getRooms(),
            events: bus.recent(300),
            twinInjectionAvailable: this.options.twinInjectionAvailable ?? false,
            activeScenario: this.options.getActiveScenario?.() ?? undefined,
            ownerInbox: this.options.getOwnerInbox?.() ?? [],
          }))
          return
        }
        if (path === '/scenario' && req.method === 'POST') {
          // 场景控制（start/stop/restart/room-restart）。
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
          req.on('end', () => {
            try {
              const req2 = JSON.parse(body) as ScenarioRequest
              if (this.options.scenario === undefined) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, message: '场景控制未启用' }))
                return
              }
              const result = this.options.scenario(req2)
              res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(result))
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, message: '无效的场景指令 JSON' }))
            }
          })
          return
        }
        if (path === '/control' && req.method === 'POST') {
          // 干预指令。
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
          req.on('end', () => {
            try {
              const cmd = JSON.parse(body) as ControlCmd
              if (this.options.control === undefined) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, message: '控制接口未启用' }))
                return
              }
              const result = this.options.control(cmd)
              res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(result))
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, message: '无效的指令 JSON' }))
            }
          })
          return
        }
        if (path === '/owner' && req.method === 'POST') {
          // 主人区域控制：{ action: 'auto'|'manual' } 切换驱动；{ action: 'reply', roomId, text } 答复。
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
          req.on('end', () => {
            try {
              const req2 = JSON.parse(body) as { action: string; roomId?: string; text?: string }
              if (req2.action === 'auto') {
                this.options.setOwnerAutoApprove?.(true)
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: true, mode: 'auto' }))
                return
              }
              if (req2.action === 'manual') {
                this.options.setOwnerAutoApprove?.(false)
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: true, mode: 'manual' }))
                return
              }
              if (req2.action === 'reply') {
                if (req2.roomId === undefined || req2.text === undefined) {
                  res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
                  res.end(JSON.stringify({ ok: false, message: '缺少 roomId/text' }))
                  return
                }
                void this.options.ownerReply?.(req2.roomId, req2.text)
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: true }))
                return
              }
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, message: `未知 action: ${req2.action}` }))
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, message: '无效 JSON' }))
            }
          })
          return
        }
        res.writeHead(404)
        res.end('Not Found')
      })

      this.server.listen(port, host, () => {
        console.log(`[test-web] UI: http://${host}:${port}`)
        resolveStart()
      })
      this.server.on('error', (error) => {
        console.error('[test-web] 启动失败:', error)
        rejectStart(error)
      })
    })
  }

  async stop(): Promise<void> {
    if (this.server === undefined) return
    await new Promise<void>((resolveStop) => this.server?.close(() => resolveStop()))
    this.server = undefined
  }
}
