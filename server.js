require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { User, Message } = require('./models');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI missing in environment');
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
const onlineUsers = {}; // socketId -> userId (string)

function publicUser(u) {
  return {
    id: String(u._id),
    username: u.username,
    avatar: u.avatar,
    color: u.color
  };
}

/* ============================================================
   AUTH
============================================================ */
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const existing = await User.findOne({ username });
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const user = await User.create({
      username,
      password: await bcrypt.hash(password, 10),
      avatar: username.charAt(0).toUpperCase(),
      color: COLORS[Math.floor(Math.random() * COLORS.length)]
    });

    const token = jwt.sign({ id: String(user._id), username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: String(user._id), username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ============================================================
   USERS
============================================================ */
app.get('/api/users', async (req, res) => {
  const list = await User.find({}, 'username avatar color').lean();
  const onlineIds = Object.values(onlineUsers);
  res.json(list.map(u => ({
    id: String(u._id),
    username: u.username,
    avatar: u.avatar,
    color: u.color,
    online: onlineIds.includes(String(u._id))
  })));
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
    text: m.text,
    status: m.status,
    time: m.time
  })));
});

/* ============================================================
   HEALTH + SPA FALLBACK
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
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = String(decoded.id);
    socket.username = decoded.username;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log(`✅ ${socket.username} connected (${socket.id})`);
  onlineUsers[socket.id] = socket.userId;
  io.emit('presence', Object.values(onlineUsers));

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
        status: msg.status,
        time: msg.time
      };

      // Deliver to recipient if online
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

  socket.on('disconnect', () => {
    delete onlineUsers[socket.id];
    io.emit('presence', Object.values(onlineUsers));
    console.log(`❌ ${socket.username} disconnected`);
  });
});

/* ============================================================
   START
============================================================ */
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});