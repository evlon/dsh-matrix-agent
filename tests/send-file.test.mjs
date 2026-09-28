import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_SEND_BYTES,
  extensionMime,
  isPathInside,
  mimeFor,
  msgtypeFor,
  sanitizeFileName,
  sniffImageMime,
} from '../lib/media-file.js'
import { createStateRoomResolver, sendFileToRoom } from '../lib/send-file.js'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])

/** 启动一个假 homeserver：记录全部请求，并按 options 注入失败分支。 */
async function withFakeHomeserver(options, run) {
  const calls = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) })
      const isUpload = (req.url ?? '').startsWith('/_matrix/media/v3/upload')
      if (options?.failUpload === true && isUpload) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end('{"errcode":"M_FORBIDDEN"}')
        return
      }
      if (options?.omitEventId === true && !isUpload) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(isUpload ? '{"content_uri":"mxc://fake/abc123"}' : '{"event_id":"$evt-1"}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    return await run(`http://127.0.0.1:${address.port}`, calls)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** 建临时工作目录，测试结束自动清理。 */
async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-send-file-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('sniffImageMime 按魔数识别常见图片', () => {
  assert.equal(sniffImageMime(PNG_BYTES), 'image/png')
  assert.equal(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffImageMime(new TextEncoder().encode('GIF89a......')), 'image/gif')
  assert.equal(sniffImageMime(new TextEncoder().encode('RIFF....WEBPVP8 ')), 'image/webp')
  assert.equal(sniffImageMime(new TextEncoder().encode('BM......')), 'image/bmp')
  assert.equal(sniffImageMime(new TextEncoder().encode('hello world')), undefined)
  assert.equal(sniffImageMime(new Uint8Array()), undefined)
})

test('mimeFor 优先魔数、其次扩展名、最后回退 octet-stream', () => {
  assert.equal(mimeFor('unknown', PNG_BYTES), 'image/png')
  assert.equal(mimeFor('mislabeled.txt', PNG_BYTES), 'image/png')
  assert.equal(mimeFor('report.docx', new TextEncoder().encode('x')), extensionMime('report.docx'))
  assert.equal(mimeFor('no-extension', new TextEncoder().encode('x')), 'application/octet-stream')
})

test('msgtypeFor 映射到 Matrix 媒体类型', () => {
  assert.equal(msgtypeFor('image/png'), 'm.image')
  assert.equal(msgtypeFor('audio/mpeg'), 'm.audio')
  assert.equal(msgtypeFor('video/mp4'), 'm.video')
  assert.equal(msgtypeFor('application/pdf'), 'm.file')
  assert.equal(msgtypeFor('application/octet-stream'), 'm.file')
})

test('sanitizeFileName 去掉路径分隔符与控制字符并保留扩展名', () => {
  assert.equal(sanitizeFileName('a/b\\c.txt'), 'a_b_c.txt')
  assert.equal(sanitizeFileName('截图\u0000\u001f.png'), '截图.png')
  assert.equal(sanitizeFileName('   '), 'file')
  assert.equal(sanitizeFileName(''), 'file')
  const long = sanitizeFileName(`${'x'.repeat(300)}.docx`)
  assert.ok(long.length <= 120)
  assert.ok(long.endsWith('.docx'))
})

test('isPathInside 只认同一路径或子路径', () => {
  assert.equal(isPathInside('/work', '/work'), true)
  assert.equal(isPathInside('/work', '/work/a/b.txt'), true)
  assert.equal(isPathInside('/work', '/worker/a'), false)
  assert.equal(isPathInside('/work', '/etc/passwd'), false)
})

test('sendFileToRoom 上传后发送 m.file 事件并返回 event_id', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'report.docx'), 'docx-bytes')
    await withFakeHomeserver(undefined, async (base, calls) => {
      const result = await sendFileToRoom({
        roomId: '!room:test',
        filePath: 'report.docx',
        root: dir,
        homeserverUrl: base,
        accessToken: 'test-token',
        caption: '月度报表',
      })
      assert.deepEqual(result, {
        roomId: '!room:test',
        eventId: '$evt-1',
        name: 'report.docx',
        size: 'docx-bytes'.length,
        mimetype: extensionMime('report.docx'),
        msgtype: 'm.file',
      })
      assert.equal(calls.length, 2)
      const upload = calls[0]
      assert.equal(upload.method, 'POST')
      assert.equal(upload.url, '/_matrix/media/v3/upload?filename=report.docx')
      assert.equal(upload.headers.authorization, 'Bearer test-token')
      assert.equal(upload.headers['content-type'], extensionMime('report.docx'))
      assert.equal(upload.body.length, 'docx-bytes'.length)
      const send = calls[1]
      assert.equal(send.method, 'PUT')
      assert.ok(send.url.startsWith('/_matrix/client/v3/rooms/!room%3Atest/send/m.room.message/'))
      assert.deepEqual(JSON.parse(send.body.toString()), {
        msgtype: 'm.file',
        body: '月度报表',
        filename: 'report.docx',
        url: 'mxc://fake/abc123',
        info: { mimetype: extensionMime('report.docx'), size: 'docx-bytes'.length },
      })
    })
  })
})

test('sendFileToRoom 对没有扩展名的图片按 m.image 发送', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'out'))
    await writeFile(join(dir, 'out', 'figure'), PNG_BYTES)
    await withFakeHomeserver(undefined, async (base, calls) => {
      const result = await sendFileToRoom({
        roomId: '!room:test',
        filePath: 'out/figure',
        root: dir,
        homeserverUrl: base,
        accessToken: 'test-token',
      })
      assert.equal(result.mimetype, 'image/png')
      assert.equal(result.msgtype, 'm.image')
      const sent = JSON.parse(calls[1].body.toString())
      assert.equal(sent.msgtype, 'm.image')
      assert.equal(sent.body, 'figure')
    })
  })
})

test('sendFileToRoom 上传被拒时抛错且不发送事件', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'a.txt'), 'x')
    await withFakeHomeserver({ failUpload: true }, async (base, calls) => {
      await assert.rejects(
        sendFileToRoom({
          roomId: '!room:test',
          filePath: 'a.txt',
          root: dir,
          homeserverUrl: base,
          accessToken: 'test-token',
        }),
        /上传附件失败：HTTP 403/,
      )
      assert.equal(calls.length, 1)
    })
  })
})

test('sendFileToRoom 缺少 event_id 视为未投递', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'a.txt'), 'x')
    await withFakeHomeserver({ omitEventId: true }, async (base) => {
      await assert.rejects(
        sendFileToRoom({
          roomId: '!room:test',
          filePath: 'a.txt',
          root: dir,
          homeserverUrl: base,
          accessToken: 'test-token',
        }),
        /未确认附件消息/,
      )
    })
  })
})

test('sendFileToRoom 拒绝工作目录之外的文件', async () => {
  await withTempDir(async (dir) => {
    await withFakeHomeserver(undefined, async (base) => {
      await assert.rejects(
        sendFileToRoom({
          roomId: '!room:test',
          filePath: '/etc/hosts',
          root: dir,
          homeserverUrl: base,
          accessToken: 'test-token',
        }),
        /只允许发送工作目录内的文件/,
      )
    })
  })
})

test('sendFileToRoom 拒绝符号链接逃逸工作目录', async () => {
  await withTempDir(async (dir) => {
    await symlink('/etc/hosts', join(dir, 'escape.txt'))
    await withFakeHomeserver(undefined, async (base) => {
      await assert.rejects(
        sendFileToRoom({
          roomId: '!room:test',
          filePath: 'escape.txt',
          root: dir,
          homeserverUrl: base,
          accessToken: 'test-token',
        }),
        /只允许发送工作目录内的文件/,
      )
    })
  })
})

test('sendFileToRoom 拒绝超过上限的文件', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'big.bin'), new Uint8Array(32))
    await withFakeHomeserver(undefined, async (base) => {
      await assert.rejects(
        sendFileToRoom({
          roomId: '!room:test',
          filePath: 'big.bin',
          root: dir,
          homeserverUrl: base,
          accessToken: 'test-token',
          maxBytes: 8,
        }),
        /超过发送上限/,
      )
    })
    assert.equal(MAX_SEND_BYTES, 64 * 1024 * 1024)
  })
})

test('createStateRoomResolver 从 state.json 反查会话绑定的房间', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({ version: 1, roomSessions: { '!room:test': { sessionId: 'sess-1' } } }),
    )
    await writeFile(
      join(dir, 'state-twin.json'),
      JSON.stringify({ version: 1, roomSessions: { '!twin:test': { sessionId: 'sess-2' } } }),
    )
    const resolve = createStateRoomResolver(dir)
    assert.equal(await resolve('sess-1'), '!room:test')
    assert.equal(await resolve('sess-2'), '!twin:test')
    assert.equal(await resolve('sess-unknown'), undefined)
    assert.equal(await createStateRoomResolver(join(dir, 'missing'))('sess-1'), undefined)
  })
})
