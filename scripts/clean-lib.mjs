/**
 * 清理 lib 目录（跨平台），确保 tsc 重新编译时不会有旧 src 模块的孤儿产物残留。
 * 拆包后 src 只剩 index/matrix/tools + client，旧模块（bridge/config/format/...）
 * 已迁到 @evlon/dsh-bridge；不清 lib 会残留旧 .js/.d.ts 并被误 import。
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const libDir = join(root, 'lib')

mkdirSync(libDir, { recursive: true })
for (const name of readdirSync(libDir)) {
  if (name.endsWith('.js') || name.endsWith('.d.ts') || name.endsWith('.js.map') || name.endsWith('.tsbuildinfo')) {
    rmSync(join(libDir, name), { force: true })
  }
}
console.log('[clean-lib] lib cleared')
