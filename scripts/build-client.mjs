/**
 * 构建 client 半：用 esbuild 把 src/client-main.js 打包为自包含 bundle，
 * 输出到 lib/client.js，包装成 dsh web 要求的 `__ModuleLoader__.load` 格式。
 *
 * dsh 的 client-modules 加载器要求每个 client 半以
 * `window.__ModuleLoader__.load({ id, factory })` 注册：factory(require) 返回
 * module.exports，其中必须导出 `apply`（插件入口）与 `inject`（依赖服务声明）。
 *
 * 打包策略：
 * - esbuild bundle 成 CJS（`format: 'cjs'`，`platform: 'browser'`）；
 * - `react` 外部化（`external: ['react']`）：它是 dsh 模块系统的 shell seed，
 *   由 factory(require) 注入，内联会与 shell 的 React 实例冲突（hooks 失效）；
 * - banner/footer 把 esbuild 的 CJS 输出包进 factory 闭包：闭包内的 `require`
 *   参数遮蔽全局 require，使 esbuild 生成的 `require("react")` 走 dsh 注入；
 *   `var module = { exports: {} }; var exports = module.exports;` 让 esbuild 的
 *   `exports.apply = ...` 写到 module.exports，最后 `return module.exports`。
 *
 * 构建后执行 `node --check` 语法自检：bundle 一旦语法错误，dsh web 会报
 * "loaded without registering" 并拒绝加载插件（等于整页插件区崩掉）。
 * 语法错误必须在 build 阶段就暴露，而不是等用户重启后才在浏览器里炸。
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'src', 'client-main.js')
const dest = join(root, 'lib', 'client.js')

// 从 package.json 读取版本号，构建时注入为 __PLUGIN_VERSION__ 常量，
// 供设置页等 UI 展示（浏览器端无 fs，无法运行时读 package.json）。
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const pluginVersion = typeof pkg.version === 'string' ? pkg.version : 'dev'

const BANNER = `window.__ModuleLoader__.load({
  id: "dsh-matrix-agent",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`
const FOOTER = `    return module.exports;
  }
});
`

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  external: ['react'],
  define: {
    __PLUGIN_VERSION__: JSON.stringify(pluginVersion),
  },
  write: false,
  minify: false,
  sourcemap: false,
  logLevel: 'error',
})

if (result.outputFiles.length === 0) {
  throw new Error('[build-client] esbuild produced no output')
}
const body = result.outputFiles[0].text

mkdirSync(dirname(dest), { recursive: true })
writeFileSync(dest, BANNER + body + FOOTER, 'utf8')
console.log(`[build-client] ${dest} (${body.length} bytes code)`)

// 语法自检：失败即抛错终止构建。
execFileSync(process.execPath, ['--check', dest], { stdio: 'inherit' })
console.log('[build-client] syntax OK')
