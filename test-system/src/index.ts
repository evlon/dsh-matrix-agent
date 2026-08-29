/**
 * 数字人测试系统入口：
 * 1. 读配置（.env）
 * 2. 启动 Web UI（SSE 实时展示）
 * 3. 初始化 orchestrator（多账号 Matrix 客户端 + AI 同事）
 * 4. 启动 MVP 场景（基本对话：研发群 + 产品群）
 *
 * 运行：cd test-system && npm run build && npm start
 */
import { loadConfig } from './config.js'
import { EventBus } from './events.js'
import { Orchestrator } from './orchestrator.js'
import { TestWebServer } from './web/server.js'
import { buildBasicChatScenario } from './scenarios/basic-chat.js'

async function main(): Promise<void> {
  const config = loadConfig()
  console.log('[test] 配置加载完成:')
  console.log(`  homeserver: ${config.homeserver}`)
  console.log(`  数字人: ${config.twinUserId}`)
  console.log(`  同事账号: ${config.colleagues.map((c) => c.displayName).join(', ')}`)
  console.log(`  LLM: ${config.llm.model} @ ${config.llm.baseUrl}`)
  console.log(`  每房轮次: ${config.roundsPerRoom} / 回复超时: ${config.replyTimeoutSecs}s`)

  const bus = new EventBus()
  const orchestrator = new Orchestrator({ config, bus })
  orchestrator.init()

  const web = new TestWebServer({
    host: config.web.host,
    port: config.web.port,
    bus,
    getRooms: () => orchestrator.roomsSnapshot,
  })
  await web.start()

  // 构建 MVP 场景（研发群 + 产品群）。
  const rooms = buildBasicChatScenario(config.colleagues.map((c) => c.userId))
  console.log(`[test] 启动场景: ${rooms.length} 个房间`)

  const running = await Promise.all(rooms.map((def) => orchestrator.startRoom(def)))
  console.log(`[test] 已启动 ${running.length} 个测试房间，Web UI: http://${config.web.host}:${config.web.port}`)
  console.log('[test] 按 Ctrl+C 停止')

  // 优雅停止。
  const shutdown = (): void => {
    console.log('\n[test] 停止中…')
    orchestrator.stopAll()
    void web.stop().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('[test] 启动失败:', error instanceof Error ? error.message : error)
  process.exit(1)
})
