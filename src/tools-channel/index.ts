/**
 * 面向 Channel 接口的原子工具 barrel：matrix_* 工具（成员/消息/房间/用户/媒体/
 * 时间线/发送/工作目录/请示/汇报/工作区文件）。
 *
 * 原 @evlon/dsh-tools-channel 已合并进本包（dsh-matrix-agent），由本 barrel 导出。
 *
 * @module dsh-matrix-agent/tools-channel
 */

export {
  MATRIX_TOOL_NAMES,
  applyMatrixTools,
  setToolLogger,
} from './tools.js'
export type { MatrixToolDeps, MatrixToolName, OwnerDecisionResult } from './tools.js'
