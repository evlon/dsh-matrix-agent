/**
 * @module @evlon/dsh-bridge
 *
 * dsh 数字员工桥接层：把任意 IM 通道（Channel 接口）桥接到 dsh agent 会话。
 * 通道实现（如 Matrix）与原子工具（matrix_*）分别由
 * @evlon/dsh-channel-matrix / @evlon/dsh-tools-channel 提供，本包只做编排：
 * - 多账号（主账号 + N 个数字分身），每个账号独立 sync 循环与状态；
 * - per-room agent 会话绑定、入站消息注入、出站投递、审批推送；
 * - Owner 授权记忆（L1 静默 / L2 房间确认 / L3 红线强制）；
 * - 秘书编排红线：请示→读数据→私发→等交付→发群。
 */

export * from './auth-store.js'
export * from './bridge.js'
export * from './config.js'
export * from './format.js'
export * from './invite-store.js'
export * from './member-store.js'
export * from './parallel.js'
export * from './room-mode.js'
export * from './settings.js'
export * from './store.js'
export * from './timeline.js'
export * from './workbench.js'
