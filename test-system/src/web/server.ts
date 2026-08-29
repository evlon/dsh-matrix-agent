/**
 * Web UI 服务：http server + SSE 实时推送测试事件。
 * GET /          静态页（对话流 + 房间列表）
 * GET /events    SSE 事件流
 * GET /state     房间状态快照
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EventBus } from '../events.js'
import type { RoomState } from '../events.js'

export interface WebServerOptions {
  host: string
  port: number
  bus: EventBus
  getRooms: () => RoomState[]
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
          res.end(JSON.stringify({ rooms: this.options.getRooms(), events: bus.recent(300) }))
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
