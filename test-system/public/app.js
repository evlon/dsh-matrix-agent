// 前端：SSE 订阅事件流 + 渲染房间列表与对话流。
(() => {
  const roomListEl = document.getElementById('room-list')
  const chatHeaderEl = document.getElementById('chat-header')
  const chatStreamEl = document.getElementById('chat-stream')
  const connStatusEl = document.getElementById('conn-status')

  const rooms = new Map() // roomId -> { name, status, round, events: [] }
  let selectedRoomId = null

  function roomIdKey(event) {
    // 房间真实 id（创建后 roomId 会从占位换成真实 id，统一用事件里的 roomId）。
    return event.roomId
  }

  function ensureRoom(event) {
    if (!rooms.has(event.roomId)) {
      rooms.set(event.roomId, { name: event.roomName, status: 'creating', round: 0, events: [] })
    }
    const room = rooms.get(event.roomId)
    room.name = event.roomName
    room.events.push(event)
    return room
  }

  function renderRoomList() {
    const current = selectedRoomId
    if (rooms.size === 0) {
      roomListEl.innerHTML = '<p class="muted">等待场景启动…</p>'
      return
    }
    roomListEl.innerHTML = ''
    for (const [roomId, room] of rooms) {
      const card = document.createElement('div')
      card.className = 'room-card' + (roomId === current ? ' active' : '')
      const badgeClass = room.status === 'active' ? 'active' : room.status === 'done' ? 'done' : room.status === 'error' ? 'error' : 'creating'
      const badgeLabel = room.status === 'active' ? '进行中' : room.status === 'done' ? '完成' : room.status === 'error' ? '失败' : '创建中'
      card.innerHTML = `<div class="name">${esc(room.name)}</div>
        <div class="meta"><span class="badge ${badgeClass}">${badgeLabel}</span>
        <span>第 ${room.round || 0} 轮</span><span>${room.events.length} 条</span></div>`
      card.addEventListener('click', () => {
        selectedRoomId = roomId
        renderRoomList()
        renderChat()
      })
      roomListEl.appendChild(card)
    }
  }

  function renderChat() {
    if (selectedRoomId === null || !rooms.has(selectedRoomId)) {
      chatHeaderEl.innerHTML = '<h2>选择一个房间查看对话</h2>'
      chatStreamEl.innerHTML = ''
      return
    }
    const room = rooms.get(selectedRoomId)
    chatHeaderEl.innerHTML = `<h2>${esc(room.name)} ${room.status === 'active' ? '（进行中）' : room.status === 'done' ? '（完成）' : ''}</h2>`
    chatStreamEl.innerHTML = ''
    for (const event of room.events) {
      const el = document.createElement('div')
      if (event.kind === 'colleague' || event.kind === 'twin') {
        el.className = 'msg ' + event.kind
        const t = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false })
        el.innerHTML = `<span class="sender">${esc(event.from)}</span>${esc(event.text || '')}<span class="time">${t}</span>`
      } else if (event.kind === 'system') {
        el.className = 'msg system'
        el.textContent = `— ${event.text || ''} —`
      } else if (event.kind === 'assert') {
        const isErr = (event.status || '').includes('失败') || (event.status || '').includes('无响应') || (event.status || '').includes('error')
        el.className = 'msg assert' + (isErr ? ' err' : ' ok')
        el.textContent = '⚑ ' + (event.status || '')
      }
      chatStreamEl.appendChild(el)
    }
    chatStreamEl.scrollTop = chatStreamEl.scrollHeight
  }

  function handleEvent(event) {
    const room = ensureRoom(event)
    if (event.kind === 'system' && event.status) {
      if (event.status === 'creating') room.status = 'creating'
      else if (event.status === 'active') room.status = 'active'
      else if (event.status === 'done') room.status = 'done'
      else if (event.status === 'error') room.status = 'error'
    }
    if (typeof event.round === 'number') room.round = event.round
    renderRoomList()
    if (selectedRoomId === null) {
      selectedRoomId = event.roomId
    }
    renderChat()
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  }

  // 初始拉取状态。
  fetch('/state').then((res) => res.json()).then((data) => {
    for (const room of data.rooms || []) {
      rooms.set(room.roomId, { name: room.roomName, status: room.status, round: room.round, events: [] })
    }
    for (const event of data.events || []) {
      ensureRoom(event)
    }
    if (data.rooms && data.rooms.length > 0) selectedRoomId = data.rooms[0].roomId
    renderRoomList()
    renderChat()
  }).catch(() => {})

  // SSE 实时流。
  function connect() {
    const es = new EventSource('/events')
    es.onopen = () => {
      connStatusEl.textContent = '● 已连接'
      connStatusEl.className = 'conn-status on'
    }
    es.onmessage = (ev) => {
      try {
        handleEvent(JSON.parse(ev.data))
      } catch { /* 忽略坏事件 */ }
    }
    es.onerror = () => {
      connStatusEl.textContent = '○ 连接断开（重连中）'
      connStatusEl.className = 'conn-status off'
      es.close()
      setTimeout(connect, 2000)
    }
  }
  connect()
})()
