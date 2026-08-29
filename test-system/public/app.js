// 前端：SSE 订阅事件流 + 渲染房间列表与对话流 + 干预控制。
(() => {
  const roomListEl = document.getElementById('room-list')
  const chatHeaderEl = document.getElementById('chat-header')
  const chatStreamEl = document.getElementById('chat-stream')
  const connStatusEl = document.getElementById('conn-status')
  const controlBarEl = document.getElementById('control-bar')
  const ctlMsgEl = document.getElementById('ctl-msg')
  const ctlColleagueEl = document.getElementById('ctl-colleague')
  const injIdentityEl = document.getElementById('inj-identity')
  const injTextEl = document.getElementById('inj-text')

  const rooms = new Map() // roomId -> { name, status, paused, round, activeColleague, members, events: [] }
  let selectedRoomId = null
  let twinInjectionAvailable = false

  function ensureRoom(event) {
    if (!rooms.has(event.roomId)) {
      rooms.set(event.roomId, { name: event.roomName, status: 'creating', paused: false, round: 0, activeColleague: '', members: [], events: [] })
    }
    const room = rooms.get(event.roomId)
    room.name = event.roomName
    room.events.push(event)
    return room
  }

  function sendControl(action, extra) {
    if (!selectedRoomId) return
    const cmd = Object.assign({ roomId: selectedRoomId, action }, extra || {})
    fetch('/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    }).then((res) => res.json()).then((r) => {
      setCtlMsg(r.ok ? '✔ 已发送' : '✘ ' + (r.message || '失败'), r.ok)
    }).catch(() => setCtlMsg('✘ 网络错误', false))
  }

  function sendGlobal(action) {
    fetch('/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: 'all', action: action + '-all' }),
    }).then((res) => res.json()).then((r) => {
      setCtlMsg(r.ok ? '✔ 已发送' : '✘ ' + (r.message || '失败'), r.ok)
    }).catch(() => setCtlMsg('✘ 网络错误', false))
  }

  function setCtlMsg(text, ok) {
    ctlMsgEl.textContent = text
    ctlMsgEl.className = 'ctl-msg ' + (ok ? 'ok' : 'err')
    setTimeout(() => { ctlMsgEl.textContent = '' }, 3000)
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
      const badgeClass = room.status === 'active' ? (room.paused ? 'paused' : 'active') : room.status === 'done' ? 'done' : room.status === 'error' ? 'error' : 'creating'
      const badgeLabel = room.status === 'active' ? (room.paused ? '⏸ 已暂停' : '进行中') : room.status === 'done' ? '完成' : room.status === 'error' ? '失败' : '创建中'
      const colleague = room.activeColleague ? ' · ' + room.activeColleague + '发言' : ''
      card.innerHTML = `<div class="name">${esc(room.name)}</div>
        <div class="meta"><span class="badge ${badgeClass}">${badgeLabel}</span>
        <span>第 ${room.round || 0} 轮</span><span>${room.events.length} 条</span>${colleague}</div>`
      card.addEventListener('click', () => {
        selectedRoomId = roomId
        renderRoomList()
        renderChat()
        renderControlBar()
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
    chatHeaderEl.innerHTML = `<h2>${esc(room.name)} ${room.status === 'active' ? (room.paused ? '（⏸ 已暂停）' : '（进行中）') : room.status === 'done' ? '（完成）' : ''}</h2>`
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

  function renderControlBar() {
    if (selectedRoomId === null || !rooms.has(selectedRoomId)) {
      controlBarEl.style.display = 'none'
      return
    }
    const room = rooms.get(selectedRoomId)
    controlBarEl.style.display = 'block'
    // 换同事下拉：房间成员里去掉数字人。
    const colleagues = (room.members || []).filter((m) => !m.startsWith('@ai-'))
    ctlColleagueEl.innerHTML = ''
    for (const c of colleagues) {
      const opt = document.createElement('option')
      opt.value = c
      opt.textContent = c
      ctlColleagueEl.appendChild(opt)
    }
    // 注入身份下拉：同事 + （若可用）数字人。
    injIdentityEl.innerHTML = ''
    for (const c of colleagues) {
      const opt = document.createElement('option')
      opt.value = 'col:' + c
      opt.textContent = c
      injIdentityEl.appendChild(opt)
    }
    if (twinInjectionAvailable) {
      const opt = document.createElement('option')
      opt.value = 'twin'
      opt.textContent = '（数字人）'
      injIdentityEl.appendChild(opt)
    }
  }

  function handleEvent(event) {
    const room = ensureRoom(event)
    if (event.kind === 'system' && event.status) {
      if (event.status === 'creating') room.status = 'creating'
      else if (event.status === 'active') room.status = 'active'
      else if (event.status === 'paused') room.status = 'active'
      else if (event.status === 'done') room.status = 'done'
      else if (event.status === 'error') room.status = 'error'
    }
    if (typeof event.round === 'number') room.round = event.round
    if (event.from && event.from !== '系统' && event.from !== '') room.activeColleague = event.from
    renderRoomList()
    if (selectedRoomId === null) {
      selectedRoomId = event.roomId
    }
    renderChat()
    renderControlBar()
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  }

  // 初始拉取状态。
  fetch('/state').then((res) => res.json()).then((data) => {
    twinInjectionAvailable = !!data.twinInjectionAvailable
    for (const room of data.rooms || []) {
      rooms.set(room.roomId, { name: room.roomName, status: room.status, paused: !!room.paused, round: room.round, activeColleague: room.activeColleague || '', members: room.members || [], events: [] })
    }
    for (const event of data.events || []) {
      ensureRoom(event)
    }
    if (data.rooms && data.rooms.length > 0) selectedRoomId = data.rooms[0].roomId
    renderRoomList()
    renderChat()
    renderControlBar()
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

  // 控制按钮事件。
  document.getElementById('btn-pause-all').addEventListener('click', () => sendGlobal('pause'))
  document.getElementById('btn-resume-all').addEventListener('click', () => sendGlobal('resume'))
  document.getElementById('btn-stop-all').addEventListener('click', () => sendGlobal('stop'))

  controlBarEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]')
    if (!btn) return
    const act = btn.dataset.act
    if (act === 'switch') {
      const colleagueId = ctlColleagueEl.value
      if (colleagueId) sendControl('switch', { colleagueId })
    } else if (act === 'inject') {
      const identity = injIdentityEl.value
      const text = injTextEl.value.trim()
      if (!text) { setCtlMsg('✘ 请输入消息内容', false); return }
      if (identity === 'twin') {
        sendControl('inject', { asTwin: true, text })
      } else if (identity.startsWith('col:')) {
        sendControl('inject', { colleagueId: identity.slice(4), text })
      }
      injTextEl.value = ''
    } else {
      sendControl(act)
    }
  })
})()
