require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { User, Message, Verification } = require('./models');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const MONGODB_URI = process.env.MONGODB_URI;
const SMS_MODE = process.env.SMS_MODE || 'console';

let twilioClient = null;
if (SMS_MODE === 'twilio') {
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI missing');
  process.exit(1);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   DATABASE
============================================================ */
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

/* ============================================================
   HELPERS
============================================================ */
const COLORS = ['#b0d9c0', '#f5c6a5', '#a5c9f5', '#f5a5c9', '#f5e3a5', '#c9a5f5'];
const convId = (a, b) => [String(a), String(b)].sort().join('::');
const onlineUsers = {}; // socketId -> userId

function publicUser(u, viewerId) {
  const isSelf = String(u._id) === String(viewerId);
  return {
    id: String(u._id),
    phone: isSelf ? u.phone : undefined,
    username: u.username,
    about: u.about,
    avatar: u.avatar,
    color: u.color,
    online: !!u.online,
    lastSeen: u.lastSeen
  };
}

// Normalize phone: strip spaces/dashes, ensure starts with +
function normalizePhone(raw) {
  if (!raw) return '';
  let p = String(raw).replace(/[\s\-()]/g, '');
  if (!p.startsWith('+')) p = '+' + p;
  return p;
}

async function sendSms(phone, code) {
  const message = `Your ChatApp verification code is: ${code}. It expires in 10 minutes.`;
  if (SMS_MODE === 'twilio' && twilioClient) {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone
    });
    console.log(`📱 SMS sent to ${phone}`);
  } else {
    console.log('\n═══════════════════════════════════════════');
    console.log(`📱 DEV SMS to ${phone}`);
    console.log(`   CODE: ${code}`);
    console.log('═══════════════════════════════════════════\n');
  }
}

/* ============================================================
   PHONE VERIFICATION — STEP 1: send code
============================================================ */
app.post('/api/auth/send-code', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone || phone.length < 8) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    // Rate limit: one code per 30 seconds per phone
    const recent = await Verification.findOne({
      phone,
      createdAt: { $gt: new Date(Date.now() - 30000) }
    });
    if (recent) {
      return res.status(429).json({ error: 'Please wait 30s before requesting a new code' });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await Verification.deleteMany({ phone }); // clear old codes
    await Verification.create({ phone, code });

    await sendSms(phone, code);

    res.json({
      ok: true,
      // Only expose code in dev console mode for testing convenience
      devCode: SMS_MODE === 'console' ? code : undefined
    });
  } catch (e) {
    console.error('send-code', e);
    res.status(500).json({ error: 'Failed to send code' });
  }
});

/* ============================================================
   PHONE VERIFICATION — STEP 2: verify code + register or login
============================================================ */
app.post('/api/auth/verify', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || '').trim();
    const username = (req.body.username || '').trim();

    if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });

    const record = await Verification.findOne({ phone }).sort({ createdAt: -1 });
    if (!record) return res.status(400).json({ error: 'Code expired or not requested' });

    if (record.attempts >= 5) {
      await Verification.deleteOne({ _id: record._id });
      return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
    }

    if (record.code !== code) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json({ error: 'Incorrect code' });
    }

    // Code correct — find or create user
    let user = await User.findOne({ phone });
    const isNew = !user;

    if (isNew) {
      if (!username || username.length < 2) {
        return res.status(400).json({ error: 'Username required (min 2 chars)' });
      }
      const taken = await User.findOne({ username });
      if (taken) return res.status(409).json({ error: 'Username already taken' });

      user = await User.create({
        phone,
        username,
        avatar: username.charAt(0).toUpperCase(),
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        about: 'Hey there! I am using ChatApp.'
      });
    }

    await Verification.deleteMany({ phone });

    const token = jwt.sign({ id: String(user._id) }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: publicUser(user, user._id), isNew });
  } catch (e) {
    console.error('verify', e);
    res.status(500).json({ error: 'Verification failed' });
  }
});

/* ============================================================
   PROFILE
============================================================ */
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    req.userId = String(d.id);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.get('/api/me', auth, async (req, res) => {
  const u = await User.findById(req.userId);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(u, req.userId));
});

app.patch('/api/me', auth, async (req, res) => {
  const { username, about } = req.body;
  const u = await User.findById(req.userId);
  if (!u) return res.status(404).json({ error: 'User not found' });

  if (username && username !== u.username) {
    const taken = await User.findOne({ username, _id: { $ne: u._id } });
    if (taken) return res.status(409).json({ error: 'Username already taken' });
    u.username = username;
    u.avatar = username.charAt(0).toUpperCase();
  }
  if (typeof about === 'string') u.about = about.slice(0, 139);
  await u.save();
  res.json(publicUser(u, req.userId));
});

/* ============================================================
   USERS
============================================================ */
app.get('/api/users', async (req, res) => {
  const list = await User.find({}, 'username about avatar color online lastSeen').lean();
  const onlineIds = Object.values(onlineUsers);
  res.json(list.map(u => ({
    id: String(u._id),
    username: u.username,
    about: u.about,
    avatar: u.avatar,
    color: u.color,
    online: onlineIds.includes(String(u._id)),
    lastSeen: u.lastSeen
  })));
});

app.get('/api/users/by-phone/:phone', auth, async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const u = await User.findOne({ phone });
  if (!u) return res.status(404).json({ error: 'No user with that number' });
  res.json({
    id: String(u._id),
    username: u.username,
    about: u.about,
    avatar: u.avatar,
    color: u.color
  });
});

/* ============================================================
   MESSAGES
============================================================ */
app.get('/api/messages/:conversationId', async (req, res) => {
  const msgs = await Message.find({ conversationId: req.params.conversationId })
    .sort({ time: 1 })
    .lean();
  res.json(msgs.map(m => ({
    id: String(m._id),
    from: String(m.from),
    fromName: m.fromName,
    to: String(m.to),
    text: m.deleted ? '' : m.text,
    deleted: m.deleted,
    status: m.status,
    time: m.time
  })));
});

/* ============================================================
   HEALTH + SPA
============================================================ */
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ============================================================
   SOCKET.IO
============================================================ */
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('No token'));
  try {
    const d = jwt.verify(token, JWT_SECRET);
    socket.userId = String(d.id);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', async (socket) => {
  const user = await User.findById(socket.userId);
  if (!user) return socket.disconnect();

  socket.username = user.username;
  socket.join(socket.userId); // personal room

  onlineUsers[socket.id] = socket.userId;
  user.online = true;
  user.lastSeen = new Date();
  await user.save();
  io.emit('presence', Object.values(onlineUsers));
  console.log(`✅ ${user.username} connected`);

  /* ---- SEND MESSAGE ---- */
  socket.on('message:send', async ({ to, text }, callback) => {
    try {
      if (!text || !to) return;
      const cid = convId(socket.userId, to);

      const msg = await Message.create({
        conversationId: cid,
        from: socket.userId,
        fromName: socket.username,
        to,
        text,
        status: 'sent',
        time: new Date()
      });

      const payload = {
        id: String(msg._id),
        from: socket.userId,
        fromName: socket.username,
        to: String(to),
        text: msg.text,
        deleted: false,
        status: msg.status,
        time: msg.time
      };

      // Deliver if recipient online
      const recipientSocket = Object.keys(onlineUsers).find(sid => onlineUsers[sid] === String(to));
      if (recipientSocket) {
        io.to(recipientSocket).emit('message:receive', payload);
        msg.status = 'delivered';
        await msg.save();
        socket.emit('message:status', { id: String(msg._id), status: 'delivered' });
      }

      if (callback) callback({ ok: true, msg: { ...payload, status: msg.status } });
    } catch (e) {
      console.error('message:send', e);
    }
  });

  /* ---- TYPING ---- */
  socket.on('typing', ({ to, isTyping }) => {
    const recipientSocket = Object.keys(onlineUsers).find(sid => onlineUsers[sid] === String(to));
    if (recipientSocket) {
      io.to(recipientSocket).emit('typing', {
        from: socket.userId,
        fromName: socket.username,
        isTyping
      });
    }
  });

  /* ---- READ RECEIPTS ---- */
  socket.on('message:read', async ({ to, ids }) => {
    try {
      if (!ids || !ids.length) return;
      await Message.updateMany(
        { _id: { $in: ids }, from: socket.userId, to },
        { $set: { status: 'read' } }
      );
      const senderSocket = Object.keys(onlineUsers).find(sid => onlineUsers[sid] === String(to));
      if (senderSocket) {
        io.to(senderSocket).emit('message:read', { by: socket.userId, ids });
      }
    } catch (e) {
      console.error('message:read', e);
    }
  });

  /* ---- DELETE MESSAGE ---- */
  socket.on('message:delete', async ({ id, to }) => {
    try {
      const msg = await Message.findById(id);
      if (!msg) return;
      if (String(msg.from) !== socket.userId) return;
      msg.deleted = true;
      msg.text = '';
      await msg.save();

      // Notify both parties
      const otherSocket = Object.keys(onlineUsers).find(sid => onlineUsers[sid] === String(to));
      const payload = { id: String(msg._id) };
      socket.emit('message:deleted', payload);
      if (otherSocket) io.to(otherSocket).emit('message:deleted', payload);
    } catch (e) {
      console.error('message:delete', e);
    }
  });

  /* ---- DISCONNECT ---- */
  socket.on('disconnect', async () => {
    delete onlineUsers[socket.id];
    const u = await User.findById(socket.userId);
    if (u) { u.online = false; u.lastSeen = new Date(); await u.save(); }
    io.emit('presence', Object.values(onlineUsers));
    console.log(`❌ ${socket.username} disconnected`);
  });
});

/* ============================================================
   START
============================================================ */
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
  console.log(`   SMS_MODE = ${SMS_MODE}${SMS_MODE === 'console' ? ' (codes printed to console)' : ''}`);
});