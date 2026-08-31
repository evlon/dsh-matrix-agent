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
      rooms.set(event.roomId, { name: event.roomName, status: 'creating', paused: false, round: 0, activeColleague: '', members: [], events: [], asserts: [], passed: undefined })
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

  function sendScenario(req) {
    fetch('/scenario', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }).then((res) => res.json()).then((r) => {
      setCtlMsg(r.ok ? '✔ ' + (r.message || '已执行') : '✘ ' + (r.message || '失败'), r.ok)
    }).catch(() => setCtlMsg('✘ 网络错误', false))
  }

  function setCtlMsg(text, ok, persist) {
    ctlMsgEl.textContent = text
    ctlMsgEl.className = 'ctl-msg ' + (ok ? 'ok' : 'err')
    if (!persist) setTimeout(() => { ctlMsgEl.textContent = '' }, 3000)
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
      let assertBadge = ''
      if (room.status === 'done' && room.asserts && room.asserts.length > 0) {
        const failCount = room.asserts.filter((a) => !a.passed).length
        assertBadge = failCount === 0
          ? ' <span class="badge ok">✔ 断言全过</span>'
          : ` <span class="badge fail">✘ 断言 ${failCount}/${room.asserts.length}</span>`
      }
      card.innerHTML = `<div class="name">${esc(room.name)}</div>
        <div class="meta"><span class="badge ${badgeClass}">${badgeLabel}</span>
        <span>第 ${room.round || 0} 轮</span><span>${room.events.length} 条</span>${colleague}${assertBadge}</div>`
      if (room.status === 'done' && room.asserts && room.asserts.length > 0) {
        const detail = document.createElement('div')
        detail.className = 'assert-detail'
        detail.innerHTML = room.asserts.map((a) =>
          `<div class="assert-row ${a.passed ? 'ok' : 'fail'}">${a.passed ? '✔' : '✘'} ${esc(a.label)}${a.detail ? ' <span class="muted">(' + esc(a.detail) + ')</span>' : ''}</div>`).join('')
        card.appendChild(detail)
      }
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
      } else if (event.kind === 'assert-result') {
        const isOk = (event.status || '').startsWith('通过') || (event.status || '').includes('通过）')
        el.className = 'msg assert' + (isOk ? ' ok' : ' err')
        el.textContent = '🧪 ' + (event.status || '')
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
    const finished = room.status === 'done' || room.status === 'error'
    // 房间已结束：除「重跑本房间」外禁用其余控制。
    const buttons = controlBarEl.querySelectorAll('button')
    const selects = controlBarEl.querySelectorAll('select')
    const input = document.getElementById('inj-text')
    for (const b of buttons) {
      const act = b.dataset.act
      b.disabled = finished && act !== 'room-restart'
    }
    for (const s of selects) s.disabled = finished
    if (input) input.disabled = finished
    if (finished) {
      setCtlMsg('⚠ 房间已结束：可「🔄 重跑本房间」，或在顶部「重新开始」整个场景', false, true)
    }
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
    if (event.roomId === 'scenario') {
      // 全局场景事件：不当作房间，仅在控制条提示区显示。
      setCtlMsg('ℹ ' + (event.text || ''), true)
      return
    }
    if (event.kind === 'owner-inbox') {
      handleOwnerEvent(event)
      return
    }
    // 忽略占位房间事件（创建前的 room-xxx 占位 id；真实房间由 /state 提供）。
    if (String(event.roomId).startsWith('room-')) return
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

  // ---- 主人区域 ----
  const ownerInboxEl = document.getElementById('owner-inbox')
  const ownerModeEl = document.getElementById('owner-mode-select')
  const ownerItems = [] // { roomId, text, kind, reply? }

  function renderOwnerInbox() {
    if (ownerItems.length === 0) {
      ownerInboxEl.innerHTML = '<p class="muted">暂无请示…</p>'
      return
    }
    ownerInboxEl.innerHTML = ''
    for (const item of ownerItems) {
      const card = document.createElement('div')
      card.className = 'owner-item'
      const t = new Date(item.ts).toLocaleTimeString('zh-CN', { hour12: false })
      const kindLabel = item.kind === 'clarify' ? '🤔 请示' : item.kind === 'confirm' ? '🔐 待确认' : '📊 汇报'
      // 主人回复回显：有 reply 就显示「主人回复：xxx」，否则显示「待答复」。
      const replyLine = item.reply
        ? `<div class="owner-reply">👔 主人回复：<b>${esc(item.reply)}</b></div>`
        : '<div class="owner-reply pending">👔 待答复…</div>'
      const body = `<div class="owner-item-head">${kindLabel}<span class="time">${t}</span></div><pre class="owner-item-text">${esc(item.text)}</pre>${replyLine}`
      card.innerHTML = body
      if (ownerModeEl.value === 'manual') {
        const replyBar = document.createElement('div')
        replyBar.className = 'owner-reply-bar'
        const input = document.createElement('input')
        input.className = 'ctl-input'
        input.placeholder = item.kind === 'clarify' ? '批准 / 指定目录 / 补充要求' : '交付 / 修改意见'
        const btn = document.createElement('button')
        btn.className = 'ctl-btn primary'
        btn.textContent = '答复'
        btn.addEventListener('click', () => {
          const text = input.value.trim()
          if (!text) return
          fetch('/owner', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'reply', roomId: item.roomId, text }),
          }).then((res) => res.json()).then((r) => {
            if (r.ok) { item.reply = text; input.disabled = true; btn.disabled = true }
          }).catch(() => {})
        })
        replyBar.appendChild(input)
        replyBar.appendChild(btn)
        card.appendChild(replyBar)
      }
      ownerInboxEl.appendChild(card)
    }
  }

  function handleOwnerEvent(event) {
    ownerItems.push({ roomId: event.roomId, text: event.text || '', kind: event.ownerItem?.kind || 'clarify', ts: event.ts, reply: event.ownerItem?.reply })
    if (ownerItems.length > 50) ownerItems.shift()
    renderOwnerInbox()
  }

  ownerModeEl.addEventListener('change', () => {
    fetch('/owner', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: ownerModeEl.value === 'auto' ? 'auto' : 'manual' }),
    }).catch(() => {})
    renderOwnerInbox()
  })


  // 初始拉取状态。
  fetch('/state').then((res) => res.json()).then((data) => {
    twinInjectionAvailable = !!data.twinInjectionAvailable
    renderScenarioInfo(data.activeScenario)
    for (const room of data.rooms || []) {
      rooms.set(room.roomId, { name: room.roomName, status: room.status, paused: !!room.paused, round: room.round, activeColleague: room.activeColleague || '', members: room.members || [], events: [], asserts: room.asserts || [], passed: room.passed })
    }
    for (const event of data.events || []) {
      if (event.roomId === 'scenario') continue
      if (String(event.roomId).startsWith('room-')) continue
      ensureRoom(event)
    }
    if (data.rooms && data.rooms.length > 0) selectedRoomId = data.rooms[0].roomId
    for (const item of data.ownerInbox || []) {
      ownerItems.push({ roomId: item.roomId, text: item.text, kind: item.kind, ts: Date.now() })
    }
    renderOwnerInbox()
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

  // 场景控制。
  const scenarioSelectEl = document.getElementById('scenario-select')
  const btnStart = document.getElementById('btn-scenario-start')
  const btnRestart = document.getElementById('btn-scenario-restart')
  const btnStop = document.getElementById('btn-scenario-stop')
  const scenarioInfoEl = document.getElementById('scenario-info')

  btnStart.addEventListener('click', () => {
    sendScenario({ action: 'start', scenarioId: scenarioSelectEl.value })
  })
  btnRestart.addEventListener('click', () => {
    sendScenario({ action: 'restart', scenarioId: scenarioSelectEl.value })
  })
  btnStop.addEventListener('click', () => {
    sendScenario({ action: 'stop' })
  })

  // 场景下拉填充（当前只有 basic-chat，后续场景库扩展后这里同步）。
  function fillScenarios() {
    const known = [
      { id: 'basic-chat', name: '基本对话（研发群+产品群）' },
    ]
    scenarioSelectEl.innerHTML = ''
    for (const s of known) {
      const opt = document.createElement('option')
      opt.value = s.id
      opt.textContent = s.name
      scenarioSelectEl.appendChild(opt)
    }
  }
  fillScenarios()

  // /state 返回 activeScenario 时显示。
  function renderScenarioInfo(active) {
    if (active) {
      scenarioInfoEl.textContent = `场景「${active.name}」· 第 ${active.run} 轮`
      scenarioInfoEl.className = 'scenario-info'
    } else {
      scenarioInfoEl.textContent = '未运行'
      scenarioInfoEl.className = 'scenario-info idle'
    }
  }

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
    } else if (act === 'room-restart') {
      sendScenario({ action: 'room-restart', roomId: selectedRoomId })
    } else {
      sendControl(act)
    }
  })

  // 布局分隔条：拖拽调整房间栏宽度。
  const splitterEl = document.getElementById('layout-splitter')
  const roomsPanelEl = document.querySelector('.rooms-panel')
  const MIN_W = 180
  const MAX_W = window.innerWidth * 0.55
  let dragging = false

  splitterEl.addEventListener('mousedown', (e) => {
    e.preventDefault()
    dragging = true
    splitterEl.classList.add('dragging')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  })

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const rect = document.querySelector('.layout').getBoundingClientRect()
    const pct = Math.max(MIN_W, Math.min(MAX_W, e.clientX - rect.left))
    roomsPanelEl.style.width = pct + 'px'
  })

  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    splitterEl.classList.remove('dragging')
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  })
})()
