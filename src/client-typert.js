/**
 * 分身工作台 Typert Remote 描述符（手写，等价于 dsh-typert-generator 本会生成的
 * typert.remote-client.js 产物）。独立插件无法接入 typert 生成器（需 tsdown+双 face+
 * TS6+monorepo），故按官方 InvocationDescriptor 结构手写 src-json 描述符，供 client 侧
 * ctx.remote.$mount() 挂载，从而经 ctx.remote.matrixWorkbench.* 调用 Host 方法。
 *
 * 对应 Host 侧 src/bridge/workbench.ts 的 MatrixWorkbenchService（namespace=matrixWorkbench）。
 * 全部方法 src-json（纯 JSON 安全值，无二进制 codec），符合官方 source-mode 约定。
 *
 * @module dsh-matrix-agent/client-typert
 */

/** src-json codec（无 typeSymbol/create，纯 JSON 值原样透传）。 */
const SRC_JSON = { mode: 'src-json' }

/** 构造一个 json 参数描述符（source=json，src-json codec）。 */
function jsonParam(name, wire) {
  return { name, wire, source: 'json', codec: SRC_JSON }
}

/**
 * 构造一个 unary 方法描述符（direct invocation，src-json 结果）。
 * @param {string} method 方法名（= endpoint 的方法段）
 * @param {Array<{name:string, wire:string}>} params 参数列表（空 = 无参）
 */
function unaryMethod(method, params = []) {
  return {
    id: `dsh-matrix-agent#matrixWorkbench/${method}`,
    service: 'matrixWorkbench',
    namespace: 'matrixWorkbench',
    method,
    invocation: { kind: 'direct' },
    parameters: params.map((p) => jsonParam(p.name, p.wire)),
    result: SRC_JSON,
  }
}

/**
 * 分身工作台 Remote 贡献：4 个读镜像 + 3 个写命令，共 7 个 unary 方法。
 * package 字段用插件包名（dsh-matrix-agent），与 Host 侧服务名无关（Host 用 service key 匹配）。
 */
export const TYPERT_REMOTE = {
  package: 'dsh-matrix-agent',
  descriptors: [
    // —— 读镜像（Host→Client，无参）——
    unaryMethod('getTimeline'),
    unaryMethod('getOwnerInbox'),
    unaryMethod('getTaskBoard'),
    unaryMethod('getJobBoard'),
    // —— 写命令（Client→Host）——
    unaryMethod('handleTimelineOps', [
      { name: 'ops', wire: 'ops' },
    ]),
    unaryMethod('handleOwnerDecisionOps', [
      { name: 'ops', wire: 'ops' },
    ]),
    unaryMethod('handleJobSwitchOps', [
      { name: 'ops', wire: 'ops' },
    ]),
  ],
}

export default TYPERT_REMOTE
