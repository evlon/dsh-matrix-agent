/**
 * dsh-matrix-agent：把 Matrix 聊天桥接到 DeepSeek Harness agent 会话。
 *
 * 入站：白名单用户的文本消息经合并窗口后，通过 `agent.followup` 注入
 * 对应房间的 agent 会话（source.kind = 'plugin'，绝不直接执行 shell）；
 * 图片/文件/音视频自动下载为多模态附件，富文本/回复/编辑信息完整保留。
 * 出站：监听 `session/event`，把 `assistant/message` 文本分段并以
 * markdown 子集 HTML 发回房间；`turn/start` 显示 typing。
 * 审批：注册 `approval/request` answerer，把请求推送到房间，等白名单
 * 用户在聊天里回复「批准 / 拒绝」。
 * 多分身：每个分身一个独立账号 + harness 进程，真人 Owner 在聊天里审批。
 *
 * 通道层（matrix.ts）与桥接层（bridge.ts）分离，后续可按同样模式接
 * 其它 IM。export 形状：函数/命名空间插件（name/inject/apply/Config），
 * 无 default export（见官方 postmortem/0001）。
 *
 * 本包为 dsh-matrix 的独立演进（已断开与上游的远端关联）。
 *
 * @module dsh-matrix-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MatrixBridge } from './bridge.js'
import type { Config as MatrixConfig, DigitalTwinAccount } from './config.js'
import { registerSoul } from './soul.js'
import { registerMatrixSettings } from './settings.js'
import type { TimelineOps, SecretaryOps } from './settings.js'

export * from './auth-store.js'
export * from './bridge.js'
export * from './config.js'
export * from './format.js'
export * from './matrix.js'
export * from './member-store.js'
export * from './soul.js'
export * from './settings.js'
export * from './store.js'
export * from './timeline.js'
export * from './tools.js'

export const name = 'matrix-agent'
/**
 * 依赖：agents/tools（核心）+ settings（设置页 namespace 与快照镜像的 Host 提供者）。
 * 声明 settings 后 Cordis 会等它就绪再 apply，registerMatrixSettings 的
 * ctx.get('settings') 才能拿到服务（否则返回 undefined，namespace 不注册，
 * Client 侧 settingsScope 会 status=unavailable，任务/时间线读不到）。
 */
export const inject = ['agents', 'tools', 'settings']

export function apply(ctx: Context, config: MatrixConfig): void {
  // 关键连接参数校验：缺失时不 throw（保持插件存活，设置页可用），仅禁用 Matrix 桥；
  // 用户在浏览器设置好参数后（settings live 更新）自动恢复连接。
  const missing: string[] = []
  if (config.homeserverUrl === undefined || config.homeserverUrl === '') missing.push('homeserverUrl')
  if (config.userId === undefined || config.userId === '') missing.push('userId')
  const token = config.accessToken === '' ? process.env.DSH_MATRIX_TOKEN : config.accessToken
  if (token === undefined || token === '') missing.push('accessToken / DSH_MATRIX_TOKEN')
  if (missing.length > 0) {
    ctx.logger.warn('[dsh-matrix-agent] incomplete config, Matrix bridge disabled: missing %s (插件保持运行，请在设置页配置后自动恢复)', missing.join(', '))
  } else if (config.allowedUserIds.length === 0 && !config.allowAllUsers) {
    ctx.logger.warn('[dsh-matrix-agent] no allowlist configured: all inbound messages will be rejected (fail closed)')
  }
  // 设置层 merge：settings 用户层覆盖 yml config（若 settings 服务可用）。
  // onTimelineOps 经引用转发：bridge 创建后把管理命令分发到账号，再清零命令字段。
  let bridgeRef: MatrixBridge | undefined
  let bridgeDisposer: (() => void) | undefined
  const settingsHandle = registerMatrixSettings(ctx, config, {
    onTimelineOps: (ops: TimelineOps) => {
      bridgeRef?.handleTimelineOps(ops)
    },
    onSecretaryOps: (ops: SecretaryOps) => {
      bridgeRef?.handleSecretaryOps(ops)
    },
    // 配置 live 变化（含 token 从缺到有）：驱动 bridge 动态启停，无需重启。
    onConfigChange: (merged: MatrixConfig) => {
      const tok = merged.accessToken === '' ? process.env.DSH_MATRIX_TOKEN : merged.accessToken
      const ready = tok !== undefined && tok !== '' && merged.homeserverUrl !== '' && merged.userId !== ''
      if (ready && bridgeRef === undefined) {
        ctx.logger.info('[dsh-matrix-agent] config complete, starting Matrix bridge')
        startBridge(merged, tok as string)
      } else if (!ready && bridgeRef !== undefined) {
        ctx.logger.warn('[dsh-matrix-agent] config became incomplete, stopping Matrix bridge (设置页可继续配置)')
        stopBridge()
      }
    },
  })
  const mergedConfig: MatrixConfig = settingsHandle.getMerged()
  // 灵魂子系统（行为统计 + 工具；配置从 merged config 读取，live 更新）。
  const soulHandle = registerSoul(ctx, () => mergedConfig.soul ?? {
    enabled: true,
    persona: '你是「百变员工」：会根据所在房间的名称、讨论氛围与收到的消息，自动选择最合适的人设与语气（比如在技术群里像靠谱的研发、在需求讨论里像产品经理、面对新同事像乐于帮助的前辈）。你不需要固定一种性格。',
    style: '',
    catchphrase: '',
    habits: '先理解当前对话的语境与对象，再选择合适的人设与语气；如果切换了人设，主动用一句话告知对方你现在以什么角色出现，并提示可以在「数字分身」设置页修改灵魂。',
    replyLength: 'normal',
  })
  // 诊断：dump 灵魂配置（确认 twin_soul_status / system prompt 灵魂段有内容）。
  try {
    const soul = mergedConfig.soul
    appendFileSync(
      join(homedir(), '.dsh', 'dsh-matrix-diag.log'),
      `${new Date().toISOString()} [dsh-matrix-agent:soul] enabled=${soul?.enabled} personaLen=${(soul?.persona ?? '').length} style=${soul?.style} replyLength=${soul?.replyLength} habitsLen=${(soul?.habits ?? '').length}\n`,
      'utf8',
    )
  } catch { /* 忽略 */ }

  function startBridge(cfg: MatrixConfig, tok: string): void {
    const twins: DigitalTwinAccount[] = cfg.digitalTwinMode ? (cfg.digitalTwins ?? []) : []
    const bridge = new MatrixBridge(ctx, {
      ...cfg,
      accessToken: tok,
      digitalTwins: twins,
      soulHandle,
      updateTasksSnapshot: settingsHandle.updateTasksSnapshot,
      updateTimelineSnapshot: settingsHandle.updateTimelineSnapshot,
      onTimelineOpsHandled: settingsHandle.clearTimelineOps,
      onSecretaryOpsHandled: settingsHandle.clearSecretaryOps,
    })
    bridgeRef = bridge
    bridgeDisposer = ctx.effect(() => {
      void bridge.start()
      return () => {
        void bridge.stop()
      }
    }, 'matrix-agent.serve')
  }

  function stopBridge(): void {
    if (bridgeDisposer !== undefined) {
      bridgeDisposer()
      bridgeDisposer = undefined
    }
    bridgeRef = undefined
  }

  // 初次启动：配置完整则直接起桥；否则保持插件存活（设置页可配置）。
  const initToken = mergedConfig.accessToken === '' ? process.env.DSH_MATRIX_TOKEN : mergedConfig.accessToken
  if (initToken !== undefined && initToken !== '' && mergedConfig.homeserverUrl !== '' && mergedConfig.userId !== '') {
    startBridge(mergedConfig, initToken)
  } else {
    ctx.logger.warn('[dsh-matrix-agent] Matrix bridge not started: 配置不完整（缺 token/连接参数），插件保持运行，请在「数字分身」设置页配置后自动恢复。')
  }

  ctx.effect(() => {
    return () => {
      stopBridge()
      soulHandle.dispose()
      settingsHandle.dispose()
    }
  }, 'matrix-agent.teardown')
}
