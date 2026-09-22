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
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * 平台二进制是独立包 `@esbuild/<os>-<arch>`，其根目录直接放 `esbuild(.exe)`
 * （无 bin 字段）。pnpm 把它实体化到 `node_modules/.pnpm/@esbuild+<os>-<arch>@<ver>/...`，
 * npm/yarn 则放到 `node_modules/@esbuild/<os>-<arch>/`。故用文件系统扫描而非
 * require.resolve（后者在 pnpm 严格布局下解析不到顶层不可见平台包）。
 */
function resolveEsbuildBinary() {
  const binName = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'
  const arch = { x64: 'x64', arm64: 'arm64', ia32: 'ia32' }[process.arch] || process.arch
  const wantedPkg = `@esbuild/${process.platform}-${arch}`

  // 候选根目录：pnpm 的 .pnpm 实体目录 与 顶层 node_modules/@esbuild
  const roots = []
  const pnpmDir = join(root, 'node_modules', '.pnpm')
  if (existsSync(pnpmDir)) {
    let entries = []
    try {
      entries = readdirSync(pnpmDir)
    } catch { /* ignore */ }
    for (const e of entries) {
      // 形如 @esbuild+win32-x64@0.28.2 → 实体目录 .../node_modules/@esbuild/win32-x64
      if (!e.startsWith('@esbuild+')) continue
      const inner = join(pnpmDir, e, 'node_modules', '@esbuild')
      if (!existsSync(inner)) continue
      let subs = []
      try {
        subs = readdirSync(inner)
      } catch { /* ignore */ }
      for (const s of subs) {
        // 精确匹配当前平台包（排除其他 os/arch 的平台包）
        if (s === `${process.platform}-${arch}`) roots.push(join(inner, s))
      }
    }
  }
  // 顶层 node_modules/@esbuild/<os>-<arch>（npm/yarn 布局）
  const topLevel = join(root, 'node_modules', '@esbuild')
  if (existsSync(topLevel)) {
    let subs = []
    try { subs = readdirSync(topLevel) } catch { /* ignore */ }
    for (const s of subs) {
      if (s === `${process.platform}-${arch}`) roots.push(join(topLevel, s))
    }
  }

  const seen = new Set()
  for (const r of roots) {
    const bin = join(r, binName)
    const key = bin.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const st = statSync(bin)
      if (st.isFile()) return bin
    } catch { /* 不存在，继续 */ }
  }

  throw new Error(
    `[build-client] esbuild 原生二进制未找到（期望 ${wantedPkg}）。请先 \`pnpm install\` 确保平台包已安装。`
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
