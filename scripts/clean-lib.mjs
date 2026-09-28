/**
 * 清理 lib 目录（跨平台），确保 tsc 重新编译时不会有旧 src 模块的孤儿产物残留。
 * 合并后 src 含 index + client + bridge/ + channel/ + tools-channel/（原 @evlon/dsh-bridge
 * 与 dsh-channel-* 三包已并入本包）；不清 lib 会残留旧 .js/.d.ts 并被误 import。
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
