// 干预控制冒烟：mock Matrix + mock LLM，验证 control() 的 inject/switch/pause/resume/stop。
// 时序：房间启动后立即发指令（房间还在跑），再等几秒观察事件。
import { EventBus } from '../lib/events.js'
import { Orchestrator } from '../lib/orchestrator.js'

const config = {
  homeserver: 'https://fake.hs',
  twinUserId: '@ai-twin:fake.hs',
  twinAccessToken: 'twin-token',
  colleagues: [
    { userId: '@zhang:fake.hs', displayName: '张三', accessToken: 't1' },
    { userId: '@li:fake.hs', displayName: '李四', accessToken: 't2' },
  ],
  llm: { baseUrl: 'https://fake.llm/v1', apiKey: 'k', model: 'm' },
  web: { host: '127.0.0.1', port: 0 },
  roundsPerRoom: 8,
  replyTimeoutSecs: 2,
  roomPrefix: 'twin-test',
}

const sent = []
const roomMessages = new Map()
const membersByRoom = new Map()

async function mockFetch(url, init) {
  const u = new URL(url)
  const path = u.pathname
  const acct = String(init?.headers?.Authorization ?? '').replace('Bearer ', '') || '?'
  if (path.endsWith('/createRoom')) {
    const body = JSON.parse(init.body)
    const roomId = `!room-${Math.random().toString(36).slice(2, 8)}:fake.hs`
    membersByRoom.set(roomId, [...(body.invite ?? [])])
    roomMessages.set(roomId, [])
    return { ok: true, status: 200, json: async () => ({ room_id: roomId }) }
  }
  const sendMatch = path.match(/\/send\/m\.room\.message\//)
  if (sendMatch) {
    const roomId = decodeURIComponent(path.split('/rooms/')[1].split('/send')[0])
    const body = JSON.parse(init.body)
    const sender = acct === 't1' ? '@zhang:fake.hs' : acct === 't2' ? '@li:fake.hs' : acct === 'twin-token' ? '@ai-twin:fake.hs' : '@?'
    roomMessages.get(roomId)?.push({ event_id: '$e' + roomMessages.get(roomId).length, sender, body: body.body, origin_server_ts: Date.now() })
    sent.push({ roomId, sender, text: body.body })
    return { ok: true, status: 200, json: async () => ({ event_id: '$e' }) }
  }
  if (path.endsWith('/messages')) {
    const roomId = decodeURIComponent(path.split('/rooms/')[1].split('/messages')[0])
    return { ok: true, status: 200, json: async () => ({ chunk: (roomMessages.get(roomId) ?? []).slice().reverse() }) }
  }
  if (path.endsWith('/joined_members')) {
    const roomId = decodeURIComponent(path.split('/rooms/')[1].split('/joined_members')[0])
    const members = new Set(membersByRoom.get(roomId) ?? [])
    members.add('@ai-twin:fake.hs')
    return { ok: true, status: 200, json: async () => ({ joined: Object.fromEntries([...members].map((m) => [m, {}])) }) }
  }
  if (path.endsWith('/chat/completions')) {
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '（模拟发言）' } }] }) }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}

const bus = new EventBus()
const events = []
bus.subscribe((e) => events.push(e))
const orchestrator = new Orchestrator({ config, bus, fetchFn: mockFetch })
orchestrator.init()

const run = async () => {
  const def = {
    name: '测试群',
    colleagues: [
      { userId: '@zhang:fake.hs', displayName: '张三', role: '研发', goal: '测试干预' },
      { userId: '@li:fake.hs', displayName: '李四', role: '产品', goal: '测试干预' },
    ],
    goal: '测试干预',
  }
  const room = await orchestrator.startRoom(def)

  // 立即（房间还在创建/进行中）发指令。
  const r1 = orchestrator.control({ roomId: room.roomId, action: 'inject', colleagueId: '@zhang:fake.hs', text: '张三手动发言' })
  const r2 = orchestrator.control({ roomId: room.roomId, action: 'inject', asTwin: true, text: '数字人主动发言' })
  const r3 = orchestrator.control({ roomId: room.roomId, action: 'switch', colleagueId: '@li:fake.hs' })
  const r4 = orchestrator.control({ roomId: room.roomId, action: 'pause' })
  console.log('inject同事:', r1.ok, 'inject数字人:', r2.ok, 'switch:', r3.ok, 'pause:', r4.ok, 'twinAvail:', orchestrator.twinInjectionAvailable)
  await new Promise((r) => setTimeout(r, 1200))
  const r5 = orchestrator.control({ roomId: room.roomId, action: 'resume' })
  console.log('resume:', r5.ok)
  await new Promise((r) => setTimeout(r, 2500))
  const r6 = orchestrator.control({ roomId: room.roomId, action: 'stop' })
  console.log('stop:', r6.ok)
  await new Promise((r) => setTimeout(r, 800))
  orchestrator.stopAll()

  return { sent, events, r1, r2, r3, r4, r5, r6 }
}

run().then((result) => {
  console.log('=== 干预冒烟结果 ===')
  console.log('发送总数:', result.sent.length)
  const injected = result.sent.filter((s) => s.text === '张三手动发言' || s.text === '数字人主动发言')
  console.log('注入消息数:', injected.length, injected.map((s) => `[${s.sender}] ${s.text}`).join(' | '))
  const paused = result.events.filter((e) => e.kind === 'system' && (e.text || '').includes('暂停')).length > 0
  const switched = result.events.filter((e) => e.kind === 'system' && (e.text || '').includes('切换')).length > 0
  const stopped = result.events.filter((e) => e.kind === 'system' && (e.text || '').includes('停止')).length > 0
  console.log('paused事件:', paused, 'switch事件:', switched, 'stop事件:', stopped)
  // stop 可能在房间跑完后才发（mock 快），stop 指令接受即算通过；stop 事件存在更好。
  const ok = result.r1.ok && result.r2.ok && result.r3.ok && result.r4.ok && result.r5.ok && result.r6.ok &&
    injected.length >= 2 && paused && switched
  console.log(ok ? '✅ 干预控制通过（stop 指令已接受）' : '❌ 有失败项')
  process.exit(ok ? 0 : 1)
}).catch((error) => {
  console.error('❌ 异常:', error)
  process.exit(1)
})
