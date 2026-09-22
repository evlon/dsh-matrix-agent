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
 *
 * ⚠️ 为什么用 esbuild 原生 CLI 而非 JS API：
 *   esbuild 的 JS API（`build()` / `transform()`）会 spawn 一个持久化服务进程
 *   （stdio:'pipe'），在受限沙箱（禁止捕获子进程输出的 spawn）下会 EPERM。
 *   原生二进制 `@esbuild/<platform>/esbuild.exe` 是独立 CLI，用
 *   `execFileSync(..., { stdio: 'inherit' })` 调用不 spawn 服务进程，本地与 CI
 *   都能跑。因此本脚本通过 `resolveEsbuildBinary()` 定位原生二进制并走 CLI。
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'src', 'client-main.js')
const dest = join(root, 'lib', 'client.js')
const tmpOut = join(root, 'lib', 'client.bundle.tmp.js')

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

/**
 * 定位 esbuild 原生二进制（跨平台、跨包管理器健壮）。
 *
 * 完全沿用 esbuild 官方 install.js 的定位逻辑（node-platform.ts）：
 *   - Windows: `@esbuild/<os>-<arch>/esbuild.exe`（平台包根目录）
 *   - Unix:    `@esbuild/<os>-<arch>/bin/esbuild`（平台包 bin 子目录）
 * 用 `require.resolve(pkg/subpath)` 解析（能正确穿透 pnpm 的 .pnpm 软链与
 * npm/yarn 的顶层 node_modules），比手扫目录树更可靠。
 *
 * 兜底：esbuild 安装失败时会自行下载二进制到
 * `<esbuild-lib>/downloaded-<pkg>-<basename>`（install.js 的 downloadedBinPath），
 * 这里同样尝试，确保 `--no-optional` 场景也能构建。
 */
function resolveEsbuildBinary() {
  const { arch, platform } = process
  const knownWindows = {
    'win32 arm64': '@esbuild/win32-arm64',
    'win32 ia32': '@esbuild/win32-ia32',
    'win32 x64': '@esbuild/win32-x64',
  }
  const knownUnix = {
    'linux x64': '@esbuild/linux-x64',
    'linux arm64': '@esbuild/linux-arm64',
    'darwin x64': '@esbuild/darwin-x64',
    'darwin arm64': '@esbuild/darwin-arm64',
    'freebsd x64': '@esbuild/freebsd-x64',
    'freebsd arm64': '@esbuild/freebsd-arm64',
    'openbsd x64': '@esbuild/openbsd-x64',
    'openbsd arm64': '@esbuild/openbsd-arm64',
    'sunos x64': '@esbuild/sunos-x64',
    'android arm64': '@esbuild/android-arm64',
  }
  const key = `${platform} ${arch}`
  let pkg, subpath
  if (knownWindows[key]) {
    pkg = knownWindows[key]
    subpath = 'esbuild.exe'
  } else if (knownUnix[key]) {
    pkg = knownUnix[key]
    subpath = 'bin/esbuild'
  } else {
    throw new Error(`[build-client] 不支持的平台: ${key}`)
  }

  // ① 官方主路径：从 esbuild 主包目录出发 resolve 平台包
  //    （pnpm 把 @esbuild/<platform> 软链在 esbuild 主包同级的 @esbuild/ 下，
  //    顶层 node_modules 不可见，故必须带 paths 起点）
  try {
    const esbuildMain = require.resolve('esbuild')
    const esbuildPkgDir = dirname(dirname(esbuildMain))
    return require.resolve(`${pkg}/${subpath}`, { paths: [esbuildPkgDir] })
  } catch { /* 继续兜底 */ }

  // ② 兜底：顶层可直接解析（npm/yarn 布局）
  try {
    return require.resolve(`${pkg}/${subpath}`)
  } catch { /* 继续兜底 */ }

  // ③ 兜底：esbuild 自行下载到 lib/downloaded-<pkg>-<basename>
  try {
    const esbuildLibDir = dirname(require.resolve('esbuild/package.json'))
    const downloaded = join(esbuildLibDir, `downloaded-${pkg.replace('/', '-')}-${subpath.split('/').pop()}`)
    if (readFileSync(downloaded).length > 0) return downloaded
  } catch { /* 继续 */ }

  throw new Error(
    `[build-client] esbuild 原生二进制未找到（期望 ${pkg}/${subpath}）。请先 \`pnpm install\` 确保平台包已安装。`
  )
}

const esbuildBin = resolveEsbuildBinary()
console.log(`[build-client] esbuild binary: ${esbuildBin}`)

// 用原生 CLI 打 bundle，输出到临时文件；BANNER/FOOTER 由 Node 拼装，
// 避免 CLI --banner/--footer 多行字符串在 Windows 下的引号转义坑。
execFileSync(
  esbuildBin,
  [
    entry,
    '--bundle',
    '--format=cjs',
    '--platform=browser',
    '--target=es2020',
    '--external:react',
    `--define:__PLUGIN_VERSION__=${JSON.stringify(pluginVersion)}`,
    '--log-level=error',
    `--outfile=${tmpOut}`,
  ],
  { stdio: 'inherit', cwd: root }
)

const body = readFileSync(tmpOut, 'utf8')
rmSync(tmpOut, { force: true })

mkdirSync(dirname(dest), { recursive: true })
writeFileSync(dest, BANNER + body + FOOTER, 'utf8')
console.log(`[build-client] ${dest} (${body.length} bytes code)`)

// 语法自检：失败即抛错终止构建。
execFileSync(process.execPath, ['--check', dest], { stdio: 'inherit' })
console.log('[build-client] syntax OK')
