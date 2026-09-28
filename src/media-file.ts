/**
 * 附件发送的纯函数集：MIME 判定、Matrix 消息类型映射、文件名清洗与路径约束。
 *
 * 单独成文件且不 import 任何依赖，便于单测直接覆盖；工具本体在 send-file.ts。
 *
 * @module dsh-matrix-agent/media-file
 */

/** 单次发送的附件大小上限（字节）：与常见 Matrix homeserver 默认的 64 MiB 对齐。 */
export const MAX_SEND_BYTES = 64 * 1024 * 1024

/** Matrix 附件消息类型（图片/音频/视频/其它文件）。 */
export type MediaMsgType = 'm.image' | 'm.audio' | 'm.video' | 'm.file'

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false
  }
  return true
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/**
 * 按魔数判定常见图片类型；无法判定时返回 undefined。
 * 图片优先看内容而不是扩展名：模型生成的图片常常没有扩展名或写错扩展名。
 */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) return 'image/gif'
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'image/webp'
  if (startsWithBytes(bytes, [0x42, 0x4d])) return 'image/bmp'
  return undefined
}

/** 扩展名 → MIME 的保守映射（只覆盖常见交付物；未命中回退 octet-stream）。 */
const EXTENSION_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

/** 取文件扩展名对应的 MIME（不区分大小写）。 */
export function extensionMime(name: string): string | undefined {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  return EXTENSION_MIME[name.slice(dot).toLowerCase()]
}

/**
 * 判定附件 MIME：图片魔数 > 扩展名 > application/octet-stream。
 * @param name - 文件名（用于扩展名回退）
 * @param bytes - 文件内容（用于图片魔数判定）
 */
export function mimeFor(name: string, bytes: Uint8Array): string {
  return sniffImageMime(bytes) ?? extensionMime(name) ?? 'application/octet-stream'
}

/** MIME → Matrix msgtype：图片/音频/视频各有专用类型，其余走 m.file。 */
export function msgtypeFor(mime: string): MediaMsgType {
  if (mime.startsWith('image/')) return 'm.image'
  if (mime.startsWith('audio/')) return 'm.audio'
  if (mime.startsWith('video/')) return 'm.video'
  return 'm.file'
}

/** 去掉控制字符、路径分隔符与前后空白；超长时保留扩展名截断。 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    // biome/eslint 无关：显式按码点过滤控制字符（含 \u0000-\u001f 与 \u007f）
    .split('')
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
    .replace(/[/\\]/g, '_')
    .trim()
  if (cleaned === '') return 'file'
  const MAX = 120
  if (cleaned.length <= MAX) return cleaned
  const dot = cleaned.lastIndexOf('.')
  if (dot <= 0 || cleaned.length - dot > 16) return cleaned.slice(0, MAX)
  return `${cleaned.slice(0, MAX - (cleaned.length - dot))}${cleaned.slice(dot)}`
}

/** target 是否等于 root 或位于 root 之内（两者都必须是已解析的绝对路径）。 */
export function isPathInside(root: string, target: string): boolean {
  if (target === root) return true
  const prefix = root.endsWith('/') ? root : `${root}/`
  return target.startsWith(prefix)
}
