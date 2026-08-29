// 断言引擎冒烟：mock Matrix + mock LLM，验证房间 done 后断言求值 + 结果事件。
import { EventBus } from '../lib/events.js'
import { Orchestrator } from '../lib/orchestrator.js'

const config = {
  homeserver: 'https://fake.hs',
  twinUserId: '@ai-twin:fake.hs',
  colleagues: [
    { userId: '@zhang:fake.hs', displayName: '张三', accessToken: 't1' },
    { userId: '@li:fake.hs', displayName: '李四', accessToken: 't2' },
  ],
  llm: { baseUrl: 'https://fake.llm/v1', apiKey: 'k', model: 'm' },
  web: { host: '127.0.0.1', port: 0 },
  roundsPerRoom: 2,
  replyTimeoutSecs: 1,
  roomPrefix: 'p',
}

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
    // 延迟注入数字人回复（模拟真实异步，让 waitForTwinReply 能发现新增）。
    setTimeout(() => {
      roomMessages.get(roomId)?.push({ event_id: '$t' + roomMessages.get(roomId).length, sender: '@ai-twin:fake.hs', body: '（数字人回复）收到', origin_server_ts: Date.now() })
    }, 300)
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

const def = {
  name: '测试群',
  colleagues: [{ userId: '@zhang:fake.hs', displayName: '张三', role: '研发', goal: 'g' }],
  goal: 'g',
  asserts: [
    { id: 'reply', label: '数字人回复了', kind: 'twin-replied' },
    { id: 'count', label: '消息≥4', kind: 'message-count', target: 4 },
  ],
}

const run = async () => {
  const room = orchestrator.startRoom(def)
  await new Promise((r) => setTimeout(r, 5000))
  orchestrator.stopAll()
  return { room, events }
}

run().then(({ room, events }) => {
  console.log('=== 断言引擎冒烟 ===')
  console.log('status:', room.state.status)
  console.log('asserts:', JSON.stringify(room.state.asserts, null, 1))
  console.log('passed:', room.state.passed)
  const assertResults = events.filter((e) => e.kind === 'assert-result')
  console.log('assert-result 事件数:', assertResults.length)
  const ok = room.state.status === 'done' && room.state.asserts?.length === 2 &&
    room.state.asserts[0].passed === true && room.state.asserts[1].passed === true &&
    room.state.passed === true && assertResults.length >= 2
  console.log(ok ? '✅ 断言引擎通过' : '❌ 断言引擎失败')
  process.exit(ok ? 0 : 1)
}).catch((error) => {
  console.error('❌ 异常:', error)
  process.exit(1)
})
