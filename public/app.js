/* ============================================================
   STATE
============================================================ */
let socket = null;
let me = null;
let users = [];
let activeUserId = null;
let conversations = {};
let typingTimeout = null;
let pendingPhone = null;
let pendingIsNewUser = false;

const $ = id => document.getElementById(id);

/* ============================================================
   API HELPERS
============================================================ */
async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function authGet(path) {
  const res = await fetch(path, {
    headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function authPatch(path, body) {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + localStorage.getItem('token')
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ============================================================
   AUTH — STEP 1: send code
============================================================ */
async function sendCode() {
  const phone = $('phoneInput').value.trim();
  if (!phone || phone.length < 8) {
    $('authError1').textContent = 'Enter a valid phone number (e.g. +254712345678)';
    return;
  }
  const btn = $('sendCodeBtn');
  btn.disabled = true;
  btn.textContent = 'Sending...';
  $('authError1').textContent = '';

  try {
    const data = await post('/api/auth/send-code', { phone });
    pendingPhone = phone;
    $('phoneDisplay').textContent = phone;
    $('step1').classList.add('hidden');
    $('step2').classList.remove('hidden');

    // In dev/console mode, show the code on screen
    if (data.devCode) {
      $('devCodeHint').classList.remove('hidden');
      $('devCodeHint').innerHTML =
        `🧪 Dev mode: your code is <code>${data.devCode}</code><br>(In production, this arrives by SMS.)`;
    }
    $('codeInput').focus();
  } catch (e) {
    $('authError1').textContent = e.message;
    btn.disabled = false;
    btn.textContent = 'Continue';
  }
}

/* ============================================================
   AUTH — STEP 2: verify code
============================================================ */
async function verifyCode() {
  const code = $('codeInput').value.trim();
  const username = $('usernameInput').value.trim();

  if (!code || code.length !== 6) {
    $('authError2').textContent = 'Enter the 6-digit code';
    return;
  }

  const btn = $('verifyBtn');
  btn.disabled = true;
  btn.textContent = 'Verifying...';
  $('authError2').textContent = '';

  try {
    const body = { phone: pendingPhone, code };
    if (username) body.username = username;
    const data = await post('/api/auth/verify', body);
    startApp(data);
  } catch (e) {
    const msg = e.message || '';
    // If username is required, show field and retry
    if (msg.toLowerCase().includes('username')) {
      $('newUserFields').classList.remove('hidden');
      pendingIsNewUser = true;
      $('usernameInput').focus();
      $('authError2').textContent = 'Please choose a username above';
    } else {
      $('authError2').textContent = msg;
    }
    btn.disabled = false;
    btn.textContent = 'Verify';
  }
}

function backToPhone() {
  $('step2').classList.add('hidden');
  $('step1').classList.remove('hidden');
  $('sendCodeBtn').disabled = false;
  $('sendCodeBtn').textContent = 'Continue';
  $('codeInput').value = '';
  $('authError1').textContent = '';
  $('authError2').textContent = '';
  $('devCodeHint').classList.add('hidden');
  pendingPhone = null;
}

function startApp({ token, user }) {
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
  me = user;
  $('authScreen').classList.add('hidden');
  $('app').classList.remove('hidden');
  updateAvatar();
  initSocket(token);
  loadUsers();
}

function updateAvatar() {
  $('myAvatar').textContent = me.avatar;
  $('myAvatar').style.background = me.color;
}

function logout() {
  if (!confirm('Log out of ChatApp?')) return;
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
    renderModalUsers();
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
      showToast(`💬 New message from ${msg.fromName}`);
    }
    renderSidebar();
  });

  socket.on('message:status', ({ id, status }) => {
    Object.values(conversations).forEach(list => {
      const m = list.find(x => x.id === id);
      if (m) m.status = status;
    });
    if (activeUserId) renderMessages();
  });

  socket.on('message:read', ({ by, ids }) => {
    (conversations[by] || []).forEach(m => {
      if (ids.includes(m.id)) m.status = 'read';
    });
    if (activeUserId) renderMessages();
  });

  socket.on('message:deleted', ({ id }) => {
    Object.values(conversations).forEach(list => {
      const m = list.find(x => x.id === id);
      if (m) { m.deleted = true; m.text = ''; }
    });
    if (activeUserId) renderMessages();
    renderSidebar();
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
  renderModalUsers();
}

/* ============================================================
   SIDEBAR
============================================================ */
function renderSidebar() {
  const list = $('chatList');
  const filter = $('searchInput').value.toLowerCase();
  list.innerHTML = '';

  const recent = users.filter(u =>
    (conversations[u.id] && conversations[u.id].length > 0) || u.id === activeUserId
  );

  if (recent.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <p>No chats yet</p>
        <small>Tap ➕ to start a new conversation</small>
      </div>`;
    return;
  }

  recent
    .filter(u => u.username.toLowerCase().includes(filter))
    .forEach(u => {
      const msgs = conversations[u.id] || [];
      const last = msgs[msgs.length - 1];
      const preview = last
        ? (last.deleted ? '🚫 This message was deleted' : last.text)
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
          <div class="chat-name">${escapeHtml(u.username)}</div>
          <div class="chat-preview">${escapeHtml(preview.length > 32 ? preview.slice(0,32)+'…' : preview)}</div>
        </div>
        <div class="chat-time">${time}</div>
      `;
      div.onclick = () => openChat(u.id);
      list.appendChild(div);
    });
}

/* ============================================================
   NEW CHAT MODAL
============================================================ */
function openModal() {
  $('newChatModal').classList.remove('hidden');
  $('modalSearchInput').value = '';
  $('findPhoneResult').innerHTML = '';
  $('findPhoneInput').value = '';
  renderModalUsers();
  setTimeout(() => $('modalSearchInput').focus(), 50);
}
function closeModal() { $('newChatModal').classList.add('hidden'); }

function renderModalUsers() {
  const list = $('modalUserList');
  if (!list) return;
  const filter = ($('modalSearchInput')?.value || '').toLowerCase();
  list.innerHTML = '';

  const filtered = users.filter(u => u.username.toLowerCase().includes(filter));
  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state"><p>No other users yet</p><small>Share your invite link</small></div>`;
    return;
  }

  filtered.forEach(u => {
    const div = document.createElement('div');
    div.className = 'modal-user';
    div.innerHTML = `
      <div class="chat-avatar" style="background:${u.color}">
        ${u.avatar}
        ${u.online ? '<span class="online-dot"></span>' : ''}
      </div>
      <div class="u-info">
        <div class="u-name">${escapeHtml(u.username)}</div>
        <div class="u-status">${u.online ? 'online' : 'offline'}</div>
      </div>
    `;
    div.onclick = () => { closeModal(); openChat(u.id); };
    list.appendChild(div);
  });
}

async function findUserByPhone() {
  const phone = $('findPhoneInput').value.trim();
  const box = $('findPhoneResult');
  if (!phone) return;
  box.innerHTML = `<p style="color:#667781;font-size:13px;">Searching...</p>`;
  try {
    const u = await authGet('/api/users/by-phone/' + encodeURIComponent(phone));
    if (u.id === me.id) {
      box.innerHTML = `<p style="color:#e67e22;font-size:13.5px;">That's your own number 🙂</p>`;
      return;
    }
    box.innerHTML = `
      <div class="modal-user" style="border-radius:8px;border:1px solid #e0e0e0;" id="foundUser">
        <div class="chat-avatar" style="background:${u.color}">${u.avatar}</div>
        <div class="u-info">
          <div class="u-name">${escapeHtml(u.username)}</div>
          <div class="u-status">${escapeHtml(u.about || '')}</div>
        </div>
      </div>`;
    $('foundUser').onclick = () => { closeModal(); openChat(u.id); };
    // Ensure the user is in local `users`
    if (!users.find(x => x.id === u.id)) {
      users.push({ ...u, online: false });
      renderSidebar();
    }
  } catch (e) {
    box.innerHTML = `<p style="color:#e74c3c;font-size:13.5px;">${escapeHtml(e.message)}</p>`;
  }
}

/* ============================================================
   CHAT
============================================================ */
async function openChat(userId) {
  activeUserId = userId;
  const u = users.find(x => x.id === userId);
  if (!u) return;

  $('headerName').textContent = u.username;
  $('headerStatus').textContent = u.online ? 'online' : (u.lastSeen ? `last seen ${formatTime(u.lastSeen)}` : 'offline');
  const av = $('headerAvatar');
  av.textContent = u.avatar;
  av.style.background = u.color;

  $('messageInput').disabled = false;
  $('sendBtn').disabled = false;

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
    .filter(m => m.from === userId && m.status !== 'read' && !m.deleted)
    .map(m => m.id);
  if (unread.length) {
    socket.emit('message:read', { to: userId, ids: unread });
  }
  scrollBottom();
}

function closeChat() {
  $('main').classList.remove('open');
  activeUserId = null;
  $('messageInput').disabled = true;
  $('sendBtn').disabled = true;
  renderSidebar();
}

function renderMessages() {
  const box = $('messages');
  box.innerHTML = '';
  const msgs = conversations[activeUserId] || [];

  if (msgs.length === 0) {
    box.innerHTML = `
      <div class="empty-chat">
        <div class="empty-chat-icon">👋</div>
        <p>Say hi to start the conversation</p>
      </div>`;
    return;
  }

  msgs.forEach(m => {
    const mine = m.from === me.id;
    const div = document.createElement('div');
    div.className = 'msg ' + (mine ? 'out' : 'in') + (m.deleted ? ' deleted' : '');

    const text = m.deleted
      ? `<i>🚫 This message was deleted</i>`
      : escapeHtml(m.text);

    const tick = mine && !m.deleted
      ? `<span class="tick ${m.status === 'read' ? 'read' : ''}">${m.status === 'read' ? '✓✓' : (m.status === 'delivered' ? '✓✓' : '✓')}</span>`
      : '';
    const delBtn = mine && !m.deleted
      ? `<button class="del-btn" title="Delete">🗑</button>`
      : '';

    div.innerHTML = `${delBtn}${text}<div class="time">${formatTime(m.time)} ${tick}</div>`;

    if (delBtn) {
      div.querySelector('.del-btn').onclick = (e) => {
        e.stopPropagation();
        if (!confirm('Delete this message for everyone?')) return;
        socket.emit('message:delete', { id: m.id, to: activeUserId });
      };
    }

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
   PROFILE
============================================================ */
async function openProfile() {
  try {
    const fresh = await authGet('/api/me');
    me = fresh;
    $('profileAvatar').textContent = me.avatar;
    $('profileAvatar').style.background = me.color;
    $('profilePhone').textContent = me.phone || '';
    $('profileUsername').value = me.username || '';
    $('profileAbout').value = me.about || '';
    $('profileModal').classList.remove('hidden');
  } catch (e) {
    showToast('Could not load profile');
  }
}
function closeProfile() { $('profileModal').classList.add('hidden'); }

async function saveProfile() {
  const username = $('profileUsername').value.trim();
  const about = $('profileAbout').value.trim();
  if (!username || username.length < 2) {
    showToast('Username must be at least 2 characters');
    return;
  }
  try {
    const updated = await authPatch('/api/me', { username, about });
    me = updated;
    localStorage.setItem('user', JSON.stringify(me));
    updateAvatar();
    closeProfile();
    showToast('✅ Profile saved');
    // Refresh other users' lists too
    users.forEach(u => {
      if (u.id === me.id) Object.assign(u, me);
    });
  } catch (e) {
    showToast('❌ ' + e.message);
  }
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
  if (m) m.scrollTop = m.scrollHeight;
}

let toastTimer;
function showToast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

/* ============================================================
   EVENT BINDINGS
============================================================ */
$('sendCodeBtn').onclick = sendCode;
$('verifyBtn').onclick = verifyCode;
$('backBtn1').onclick = backToPhone;
$('phoneInput').addEventListener('keydown', e => e.key === 'Enter' && sendCode());
$('codeInput').addEventListener('keydown', e => e.key === 'Enter' && verifyCode());
$('usernameInput').addEventListener('keydown', e => e.key === 'Enter' && verifyCode());

$('newChatBtn').onclick = openModal;
$('closeModalBtn').onclick = closeModal;
$('modalSearchInput').addEventListener('input', renderModalUsers);
$('findPhoneBtn').onclick = findUserByPhone;
$('findPhoneInput').addEventListener('keydown', e => e.key === 'Enter' && findUserByPhone());

$('profileBtn').onclick = openProfile;
$('closeProfileBtn').onclick = closeProfile;
$('saveProfileBtn').onclick = saveProfile;
$('logoutBtn').onclick = logout;

$('sendBtn').onclick = sendMessage;
$('messageInput').addEventListener('keydown', e => e.key === 'Enter' && sendMessage());
$('messageInput').addEventListener('input', onTyping);
$('searchInput').addEventListener('input', renderSidebar);
$('backBtn').onclick = closeChat;

$('inviteBtn').onclick = () => {
  const url = window.location.origin;
  navigator.clipboard.writeText(url).then(() => showToast('🔗 Invite link copied!'))
    .catch(() => prompt('Copy this link:', url));
};

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-body').forEach(b => b.classList.add('hidden'));
    tab.classList.add('active');
    $('tab' + tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1)).classList.remove('hidden');
  };
});

// Close modals on backdrop click
$('newChatModal').addEventListener('click', e => { if (e.target.id === 'newChatModal') closeModal(); });
$('profileModal').addEventListener('click', e => { if (e.target.id === 'profileModal') closeProfile(); });

/* ============================================================
   AUTO-LOGIN + PWA
============================================================ */
(async function autoLogin() {
  const token = localStorage.getItem('token');
  if (token) {
    try {
      const user = await authGet('/api/me');
      me = user;
      localStorage.setItem('user', JSON.stringify(user));
      $('authScreen').classList.add('hidden');
      $('app').classList.remove('hidden');
      updateAvatar();
      initSocket(token);
      loadUsers();
    } catch {
      localStorage.clear();
    }
  }
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();