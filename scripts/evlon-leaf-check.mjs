#!/usr/bin/env node
/**
 * @evlon/dsh-* 内部叶子包覆盖校验：防止「叶子包已发布新版，但顶层包的 semver 范围
 * 不覆盖 → 同事默认 install 装到旧版」的漂移。
 *
 * 背景：工作区内部互引链只有一条（dsh-matrix-agent → dsh-bridge → channel-matrix /
 * tools-channel → channel-core）。叶子 @evlon/dsh-channel-core 被两条路径引用，一旦
 * 跨 minor/major 发 breaking 版（如 0.2.0），上层 `^0.1.x` 不再覆盖，顶层默认安装
 * 仍是 0.1.x 旧版，而叶子作者以为「发版即生效」。
 *
 * 本脚本做**只读判定**：对本包（顶层 dsh-matrix-agent）声明依赖的每一个
 * `@evlon/dsh-*` 包，查 npm registry 上已发布的 dist-tags.latest，断言其仍被本包
 * 声明的 semver 范围覆盖。不覆盖 → 输出 JSON 并 exit 2（CI 据此失败），逼作者先
 * bump 顶层范围，而不是「悄悄发了个叶子包、同事装到旧版」。
 *
 * 只盯 `@evlon/dsh-*` 前缀（内部家族）；`@deepseek-ai/dsh-*` 轴由 dsh-sync-check.mjs
 * 负责，`@deepseek-ai/cordis` / schemastery 各自独立发版，不在本脚本范围。
 *
 * 输出（stdout，单行 JSON）：
 *   {"verdict":"OK","checked":[...]}                              全部覆盖
 *   {"verdict":"DRIFT","drifted":[{"name","latest","declared"}]}  有叶子未覆盖
 *
 * 用法：
 *   node scripts/evlon-leaf-check.mjs [--no-npm] [--pkg <path>]
 *     --no-npm  离线模式（不查 npm，仅供语法自检；此时所有覆盖判定跳过，verdict=OK）
 *     --pkg     指定 package.json 路径，缺省读 ./package.json
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const require = createRequire(import.meta.url)
let semver
try {
  semver = require('semver')
} catch {
  throw new Error('evlon-leaf-check: 需要 semver。请确认 node 能 require 到 semver。')
}

const EVLON_RE = /^@evlon\/dsh-[a-z0-9-]+$/

function parseArgs(argv) {
  const out = { noNpm: false, pkg: './package.json' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-npm') out.noNpm = true
    else if (a === '--pkg') out.pkg = argv[++i]
  }
  return out
}

function collectEvlonDeps(pkg) {
  const map = {}
  for (const sec of ['dependencies', 'peerDependencies', 'devDependencies']) {
    const s = pkg[sec]
    if (s && typeof s === 'object') {
      for (const [k, v] of Object.entries(s)) {
        if (EVLON_RE.test(k)) map[k] = v
      }
    }
  }
  return map
}

function npmLatest(name) {
  try {
    const out = execSync(`npm view "${name}" dist-tags.latest`, { encoding: 'utf8' }).trim()
    return out
  } catch (e) {
    return null
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const pkg = JSON.parse(readFileSync(opts.pkg, 'utf8'))

  const deps = collectEvlonDeps(pkg)
  const names = Object.keys(deps)
  if (names.length === 0) {
    console.log(JSON.stringify({ verdict: 'OK', checked: [], note: 'no @evlon/dsh-* deps' }))
    return
  }

  if (opts.noNpm) {
    console.log(JSON.stringify({ verdict: 'OK', checked: names.map((n) => ({ name: n, declared: deps[n], latest: 'skipped(offline)' })) }))
    return
  }

  const drifted = []
  const checked = []
  for (const name of names) {
    const declared = deps[name]
    const latest = npmLatest(name)
    if (latest == null) {
      // npm 查询失败（网络抖动等）不误判为漂移，记为 unchecked；CI 仍应放行。
      checked.push({ name, declared, latest: null, note: 'npm query failed, skipped' })
      continue
    }
    checked.push({ name, declared, latest })
    // 关键：最新版是否仍被声明范围覆盖？不覆盖 = 漂移。
    if (!semver.satisfies(latest, declared)) {
      drifted.push({ name, latest, declared })
    }
  }

  if (drifted.length > 0) {
    console.log(JSON.stringify({ verdict: 'DRIFT', drifted, checked }))
    process.exit(2)
  }
  console.log(JSON.stringify({ verdict: 'OK', drifted: [], checked }))
}

main()
