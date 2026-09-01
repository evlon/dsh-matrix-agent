/**
 * Matrix 专属工具向后兼容 shim：工具定义已拆到 @evlon/dsh-tools-channel。
 * 本文件保留旧导出面（applyMatrixTools/setToolLogger/MATRIX_TOOL_NAMES 等），
 * 从新包转发。后续 bridge.ts 直接 import 新包后，本文件可删除。
 *
 * @module dsh-matrix-agent/tools（兼容 shim）
 */

export {
  MATRIX_TOOL_NAMES,
  applyMatrixTools,
  setToolLogger,
} from '@evlon/dsh-tools-channel'
export type { MatrixToolDeps, MatrixToolName } from '@evlon/dsh-tools-channel'
