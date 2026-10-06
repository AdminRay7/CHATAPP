/* ============================================================
   STATE
============================================================ */
let socket = null;
let me = null;
let users = [];
let activeUserId = null;
let conversations = {};
let typingTimeout = null;

const $ = id => document.getElementById(id);

/* ============================================================
   AUTH
============================================================ */
async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function login() {
  const username = $('authUsername').value.trim();
  const password = $('authPassword').value;
  if (!username || !password) return showAuthError('Enter username and password');
  try {
    const data = await api('/api/login', { username, password });
    startApp(data);
  } catch (e) { showAuthError(e.message); }
}

async function register() {
  const username = $('authUsername').value.trim();
  const password = $('authPassword').value;
  if (!username || !password) return showAuthError('Enter username and password');
  if (password.length < 4) return showAuthError('Password too short (min 4)');
  try {
    const data = await api('/api/register', { username, password });
    startApp(data);
  } catch (e) { showAuthError(e.message); }
}

function showAuthError(msg) { $('authError').textContent = msg; }

function startApp({ token, user }) {
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
  me = user;
  $('authScreen').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('myAvatar').textContent = me.avatar;
  $('myAvatar').style.background = me.color;
  initSocket(token);
  loadUsers();
}

function logout() {
  localStorage.clear();
  if (socket) socket.disconnect();
  location.reload();
}

/* ============================================================
   SOCKET
============================================================ */
function initSocket(token) {
  socket = io({ auth: { token } });

  socket.on('connect', () => console.log('Connected'));
  socket.on('connect_error', (e) => {
    if (e.message.includes('token')) logout();
  });

  socket.on('presence', (onlineIds) => {
    users.forEach(u => u.online = onlineIds.includes(u.id));
    renderSidebar();
    if (activeUserId) {
      const u = users.find(x => x.id === activeUserId);
      if (u) $('headerStatus').textContent = u.online ? 'online' : 'offline';
    }
  });

  socket.on('message:receive', (msg) => {
    if (!conversations[msg.from]) conversations[msg.from] = [];
    conversations[msg.from].push(msg);
    if (activeUserId === msg.from) {
      renderMessages();
      socket.emit('message:read', { to: msg.from, ids: [msg.id] });
    } else {
      if (Notification.permission === 'granted') {
        new Notification(msg.fromName, { body: msg.text });
      }
    }
    renderSidebar();
  });

  socket.on('message:status', ({ id, status }) => {
    Object.values(conversations).forEach(list => {
      const m = list.find(x => x.id === id);
      if (m) m.status = status;
    });
    renderMessages();
  });

  socket.on('message:read', ({ by, ids }) => {
    (conversations[by] || []).forEach(m => {
      if (ids.includes(m.id)) m.status = 'read';
    });
    renderMessages();
  });

  socket.on('typing', ({ from, fromName, isTyping }) => {
    if (from === activeUserId) {
      const bar = $('typingBar');
      $('typingText').textContent = isTyping ? `${fromName} is typing` : '';
      bar.classList.toggle('active', isTyping);
      if (isTyping) scrollBottom();
    }
  });
}

/* ============================================================
   USERS
============================================================ */
async function loadUsers() {
  const res = await fetch('/api/users');
  users = (await res.json()).filter(u => u.id !== me.id);
  renderSidebar();
}

/* ============================================================
   SIDEBAR
============================================================ */
function renderSidebar() {
  const list = $('chatList');
  const filter = $('searchInput').value.toLowerCase();
  list.innerHTML = '';

  users
    .filter(u => u.username.toLowerCase().includes(filter))
    .forEach(u => {
      const msgs = conversations[u.id] || [];
      const last = msgs[msgs.length - 1];
      const preview = last
        ? (last.text.length > 32 ? last.text.slice(0, 32) + '…' : last.text)
        : 'Say hi 👋';
      const time = last ? formatTime(last.time) : '';

      const div = document.createElement('div');
      div.className = 'chat-item' + (activeUserId === u.id ? ' active' : '');
      div.innerHTML = `
        <div class="chat-avatar" style="background:${u.color}">
          ${u.avatar}
          ${u.online ? '<span class="online-dot"></span>' : ''}
        </div>
        <div class="chat-meta">
          <div class="chat-name">${u.username}</div>
          <div class="chat-preview">${escapeHtml(preview)}</div>
        </div>
        <div class="chat-time">${time}</div>
      `;
      div.onclick = () => openChat(u.id);
      list.appendChild(div);
    });
}

/* ============================================================
   CHAT
============================================================ */
async function openChat(userId) {
  activeUserId = userId;
  const u = users.find(x => x.id === userId);

  $('headerName').textContent = u.username;
  $('headerStatus').textContent = u.online ? 'online' : 'offline';
  const av = $('headerAvatar');
  av.textContent = u.avatar;
  av.style.background = u.color;

  if (!conversations[userId]) {
    const cid = [me.id, userId].sort().join('::');
    const res = await fetch(`/api/messages/${cid}`);
    conversations[userId] = await res.json();
  }

  renderMessages();
  renderSidebar();
  $('main').classList.add('open');
  $('messageInput').focus();

  const unread = (conversations[userId] || [])
    .filter(m => m.from === userId && m.status !== 'read')
    .map(m => m.id);
  if (unread.length) {
    socket.emit('message:read', { to: userId, ids: unread });
  }
  scrollBottom();
}

function closeChat() {
  $('main').classList.remove('open');
  activeUserId = null;
  renderSidebar();
}

function renderMessages() {
  const box = $('messages');
  box.innerHTML = '';
  (conversations[activeUserId] || []).forEach(m => {
    const mine = m.from === me.id;
    const div = document.createElement('div');
    div.className = 'msg ' + (mine ? 'out' : 'in');
    const tick = mine
      ? `<span class="tick ${m.status === 'read' ? 'read' : ''}">${m.status === 'read' ? '✓✓' : '✓'}</span>`
      : '';
    div.innerHTML = `${escapeHtml(m.text)}<div class="time">${formatTime(m.time)} ${tick}</div>`;
    box.appendChild(div);
  });
  scrollBottom();
}

/* ============================================================
   SEND / TYPING
============================================================ */
function sendMessage() {
  const input = $('messageInput');
  const text = input.value.trim();
  if (!text || !activeUserId) return;

  socket.emit('message:send', { to: activeUserId, text }, ({ msg }) => {
    if (!conversations[activeUserId]) conversations[activeUserId] = [];
    conversations[activeUserId].push({ ...msg, from: me.id });
    renderMessages();
    renderSidebar();
  });
  input.value = '';
  socket.emit('typing', { to: activeUserId, isTyping: false });
}

function onTyping() {
  if (!activeUserId) return;
  socket.emit('typing', { to: activeUserId, isTyping: true });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    socket.emit('typing', { to: activeUserId, isTyping: false });
  }, 1200);
}

/* ============================================================
   UTIL
============================================================ */
function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function scrollBottom() {
  const m = $('messages');
  m.scrollTop = m.scrollHeight;
}

/* ============================================================
   EVENTS
============================================================ */
$('loginBtn').onclick = login;
$('registerBtn').onclick = register;
$('authPassword').addEventListener('keydown', e => e.key === 'Enter' && login());
$('logoutBtn').onclick = logout;
$('sendBtn').onclick = sendMessage;
$('messageInput').addEventListener('keydown', e => e.key === 'Enter' && sendMessage());
$('messageInput').addEventListener('input', onTyping);
$('searchInput').addEventListener('input', renderSidebar);
$('backBtn').onclick = closeChat;

/* ============================================================
   AUTO-LOGIN + PWA
============================================================ */
(function autoLogin() {
  const token = localStorage.getItem('token');
  const user = localStorage.getItem('user');
  if (token && user) {
    me = JSON.parse(user);
    $('authScreen').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('myAvatar').textContent = me.avatar;
    $('myAvatar').style.background = me.color;
    initSocket(token);
    loadUsers();
  }
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();