/**
 * 通道层 barrel：通道抽象（Channel 接口 + 类型 + 状态契约）与 Matrix 通道实现。
 *
 * 原 @evlon/dsh-channel-core 与 @evlon/dsh-channel-matrix 已合并进本包
 * （dsh-matrix-agent），由本 barrel 统一导出，桥接层/工具层与外部只经本入口引用。
 *
 * @module dsh-matrix-agent/channel
 */

export * from './channel.js'
export * from './state.js'
export * from './types.js'
export { MatrixChannel } from './matrix.js'
