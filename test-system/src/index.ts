/**
 * 数字人测试系统入口：
 * 1. 读配置（.env）
 * 2. 启动 Web UI（SSE 实时展示 + 干预控制 + 场景控制）
 * 3. 初始化 orchestrator（多账号 Matrix 客户端 + AI 同事）
 * 4. AUTO_START=true（默认）自动启动「基本对话」场景；否则等用户在 Web 点「开始测试」
 *
 * 运行：cd test-system && npm run build && npm start
 */
import { loadConfig } from './config.js'
import { EventBus } from './events.js'
import { Orchestrator } from './orchestrator.js'
import { TestWebServer, type ScenarioRequest } from './web/server.js'
import { getScenario, listScenarios } from './scenarios/index.js'

async function main(): Promise<void> {
  const config = loadConfig()
  console.log('[test] 配置加载完成:')
  console.log(`  homeserver: ${config.homeserver}`)
  console.log(`  数字人: ${config.twinUserId}`)
  console.log(`  同事账号: ${config.colleagues.map((c) => c.displayName).join(', ')}`)
  console.log(`  LLM: ${config.llm.model} @ ${config.llm.baseUrl}`)
  console.log(`  每房轮次: ${config.roundsPerRoom} / 回复超时: ${config.replyTimeoutSecs}s`)
  console.log(`  场景: ${listScenarios().map((s) => s.id).join(', ')} / AUTO_START=${config.autoStart}`)

  const bus = new EventBus()
  const orchestrator = new Orchestrator({ config, bus })
  orchestrator.init()

  // 场景控制分发（Web POST /scenario）。
  const handleScenario = (req: ScenarioRequest): { ok: boolean; message?: string } => {
    const userIds = config.colleagues.map((c) => c.userId)
    switch (req.action) {
      case 'start': {
        const scenario = getScenario(req.scenarioId ?? 'basic-chat')
        if (scenario === undefined) return { ok: false, message: `未知场景: ${req.scenarioId}` }
        const defs = scenario.build(userIds)
        const r = orchestrator.startScenario(scenario.id, scenario.name, defs)
        return r
      }
      case 'restart': {
        if (orchestrator.activeScenario === undefined) {
          // 没跑过 → 等价 start（默认场景）。
          const scenario = getScenario(req.scenarioId ?? 'basic-chat')
          if (scenario === undefined) return { ok: false, message: `未知场景: ${req.scenarioId}` }
          const defs = scenario.build(userIds)
          return orchestrator.startScenario(scenario.id, scenario.name, defs)
        }
        const scenario = getScenario(orchestrator.activeScenario.id)
        if (scenario === undefined) return { ok: false, message: '当前场景已失效' }
        const defs = scenario.build(userIds)
        return orchestrator.startScenario(scenario.id, scenario.name, defs)
      }
      case 'stop':
        return orchestrator.stopScenario()
      case 'room-restart':
        if (req.roomId === undefined) return { ok: false, message: '缺少 roomId' }
        return orchestrator.restartRoom(req.roomId)
      default:
        return { ok: false, message: `未知动作: ${(req as { action?: string }).action}` }
    }
  }

  const web = new TestWebServer({
    host: config.web.host,
    port: config.web.port,
    bus,
    getRooms: () => orchestrator.roomsSnapshot,
    control: (cmd) => orchestrator.control(cmd),
    twinInjectionAvailable: orchestrator.twinInjectionAvailable,
    getActiveScenario: () => orchestrator.activeScenario,
    scenario: handleScenario,
  })
  await web.start()

  // AUTO_START：启动即跑默认场景（保持旧行为兼容）；否则等用户点开始。
  if (config.autoStart) {
    const scenario = getScenario('basic-chat')
    if (scenario !== undefined) {
      const defs = scenario.build(config.colleagues.map((c) => c.userId))
      const r = orchestrator.startScenario(scenario.id, scenario.name, defs)
      console.log(`[test] AUTO_START: ${r.message ?? '已启动'}`)
    }
  } else {
    console.log('[test] AUTO_START=false：在 Web 上选择场景并点「开始测试」')
  }
  console.log(`[test] Web UI: http://${config.web.host}:${config.web.port}`)
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
