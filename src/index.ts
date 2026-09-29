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
import { createRequire } from 'node:module'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MatrixBridge } from './bridge/index.js'
import type { Config as MatrixConfig, DigitalTwinAccount } from './bridge/index.js'
import { plainMatrixConfig, resolveStateDir } from './bridge/index.js'
import { registerMatrixSettings } from './bridge/index.js'
import { MatrixWorkbenchService } from './bridge/index.js'
import type { TimelineOps, OwnerDecisionOps, JobSwitchOps } from './bridge/index.js'

// 桥接层/支撑类型面：原 @evlon/dsh-bridge 已合并进本包，从这里转发。
export * from './bridge/index.js'
// 通道层（Channel 接口 + MatrixChannel 实现）与矩阵工具：原
// @evlon/dsh-channel-core / dsh-channel-matrix / dsh-tools-channel 已合并进本包。
export * from './channel/index.js'
export * from './tools-channel/index.js'

// ESM 下用 createRequire 解析自身与 dsh 核心的 package.json 版本（运行时读取，
// 不依赖构建期注入；浏览器端 client 半无法用 fs，才走构建期 define 注入）。
const require = createRequire(import.meta.url)

/** 读取某包的运行时版本号（读 package.json 的 version 字段，解析失败返回 undefined）。 */
function readPkgVersion(pkgName: string): string | undefined {
  try {
    const pkg = require(`${pkgName}/package.json`) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/** 提取错误信息（Error 或其它抛出的值）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 文件诊断日志：与 settings.ts 的 fileLog 同写 stateDir/diagnostics.log。 */
function fileLog(stateDir: string, message: string): void {
  const line = `${new Date().toISOString()} [dsh-matrix-agent] ${message}\n`
  try {
    mkdirSync(stateDir, { recursive: true })
    appendFileSync(join(stateDir, 'diagnostics.log'), line, 'utf8')
  } catch { /* 忽略 */ }
}

export const name = 'matrix-agent'
/**
 * 依赖：agents/tools（核心）+ settings（0.1.7 设置页：SettingsForms.describe() 自动投影
 * Config 的 .volatile() 字段为表单，ns = entry id = 'matrix'，无需显式 configure）。
 * 声明 settings 后 Cordis 会等它就绪再 apply，保证 Config volatile 字段被 settings 系统收录。
 */
export const inject = ['agents', 'tools', 'settings']

export function apply(ctx: Context, config: MatrixConfig): void {
  // 0.1.7：标 .volatile() 的字段在 config 里是 Volatile 对象。保留原始引用（热更时重新解包），
  // 同时解包一份普通快照供 bridge/settings 使用。
  const rawConfig = config
  config = plainMatrixConfig(rawConfig)
  // 插件初始化：打印自身版本 + 当前依赖的 dsh 核心（@deepseek-ai/dsh-agent）版本，
  // 便于在日志里核对插件适配的 dsh 版本线（本包 peer 要求 ^0.1.7-rc.1）。
  const selfVersion = readPkgVersion('dsh-matrix-agent') ?? 'unknown'
  const dshAgentVersion = readPkgVersion('@deepseek-ai/dsh-agent') ?? 'unknown'
  ctx.logger.info('[dsh-matrix-agent] plugin version=%s, dsh-agent version=%s', selfVersion, dshAgentVersion)

  // stateDir 绝对化：相对路径锚定到 DSH_HOME（而非 cwd），使不同 dsh 实例
  // （开发者/测试者/使用者各自 DSH_HOME）在相同工作目录下运行也互不覆盖 state.json。
  config.stateDir = resolveStateDir(config.stateDir)
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
  // 设置层：0.1.7 用 Config.volatile + loader/volatile-update 热更（无 settings namespace）。
  // 运行时镜像/命令通道经 Typert RPC（MatrixWorkbenchService）暴露给 Client。
  let bridgeRef: MatrixBridge | undefined
  let bridgeDisposer: (() => void) | undefined
  const settingsHandle = registerMatrixSettings(ctx, rawConfig, {
    onConfigChange: (merged: MatrixConfig) => {
      const tok = merged.accessToken === '' ? process.env.DSH_MATRIX_TOKEN : merged.accessToken
      const ready = tok !== undefined && tok !== '' && merged.homeserverUrl !== '' && merged.userId !== ''
      if (ready && bridgeRef === undefined) {
        ctx.logger.info('[dsh-matrix-agent] config complete, starting Matrix bridge')
        startBridge(merged, tok as string)
      } else if (!ready && bridgeRef !== undefined) {
        ctx.logger.warn('[dsh-matrix-agent] config became incomplete, stopping Matrix bridge (设置页可继续配置)')
        stopBridge()
      } else if (ready && bridgeRef !== undefined) {
        // 配置完整且 bridge 已存在：volatile 字段热更（respondToAll/allowAllUsers 等运行时读取生效）。
        bridgeRef.applyConfigUpdate(merged)
      }
    },
  })
  const mergedConfig: MatrixConfig = settingsHandle.getMerged()

  // 分身工作台 Typert Remote Service：把运行时镜像/命令通道暴露给 Client（ctx.remote）。
  // Service 构造即注册（TypertRemoteService → Service 构造调 ctx.reflect.provide），
  // Gateway source-mode 经 @Remote 标记 + typertRemote binding 自动发现端点。
  // Client 侧 $mount 描述符后经 ctx.remote.matrixWorkbench.* 调用。
  let workbenchRef: MatrixWorkbenchService | undefined
  ctx.effect(() => {
    try {
      workbenchRef = new MatrixWorkbenchService(ctx, {
        getTimeline: () => settingsHandle.getTimelineSnapshot(),
        getOwnerInbox: () => settingsHandle.getOwnerInboxSnapshot(),
        getTaskBoard: () => settingsHandle.getTaskBoardSnapshot(),
        getJobBoard: () => settingsHandle.getJobBoardSnapshot(),
      })
      ctx.logger.info('[dsh-matrix-agent] workbench Typert service registered: namespace=matrixWorkbench')
      fileLog(config.stateDir, 'workbench Typert service registered: namespace=matrixWorkbench (7 methods)')
    } catch (error) {
      ctx.logger.error('[dsh-matrix-agent] workbench Typert service register failed: %s', messageOf(error))
      fileLog(config.stateDir, `workbench Typert service register FAILED: ${messageOf(error)}`)
    }
    // 命令分发回调在 bridge 创建后注入；这里若 bridge 已存在则立即接上。
    const wire = (): void => {
      workbenchRef?.wireHandlers({
        onTimelineOps: (ops) => bridgeRef?.handleTimelineOps(ops),
        onOwnerDecisionOps: (ops) => bridgeRef?.handleOwnerDecisionOps(ops),
        onJobSwitchOps: (ops) => bridgeRef?.handleJobSwitchOps(ops),
      })
    }
    wire()
    return () => {
      workbenchRef = undefined
    }
  }, 'matrix-agent.workbench')

  function startBridge(cfg: MatrixConfig, tok: string): void {
    // 幂等守卫：初次 applyUser 的 onConfigChange 与 apply 末尾的 initToken 检查
    // 都可能触发本函数，避免重复创建 bridge（两个实例会互相干扰 sync）。
    if (bridgeRef !== undefined) return
    const twins: DigitalTwinAccount[] = cfg.digitalTwinMode ? (cfg.digitalTwins ?? []) : []
    const bridge = new MatrixBridge(ctx, {
      ...cfg,
      accessToken: tok,
      digitalTwins: twins,
      updateTimelineSnapshot: settingsHandle.updateTimelineSnapshot,
      updateOwnerInbox: settingsHandle.updateOwnerInbox,
      updateTaskBoard: settingsHandle.updateTaskBoard,
      updateJobBoard: settingsHandle.updateJobBoard,
      onTimelineOpsHandled: settingsHandle.clearTimelineOps,
      onOwnerDecisionOpsHandled: settingsHandle.clearOwnerDecisionOps,
      onJobSwitchOpsHandled: settingsHandle.clearJobSwitchOps,
    })
    bridgeRef = bridge
    bridgeDisposer = ctx.effect(() => {
      void bridge.start().then(() => {
        // bridge 就绪后立即发布一次岗位看板（已安装岗位 + 各房间岗位），供设置页首屏渲染。
        void bridge.publishJobBoardSnapshot()
      })
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
      settingsHandle.dispose()
    }
  }, 'matrix-agent.teardown')
}
