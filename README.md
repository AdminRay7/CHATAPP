# 💬 ChatApp — Real-Time Chat with MongoDB

Full-stack WhatsApp-style chat app with authentication, real-time messaging, typing indicators, read receipts, online presence, and PWA install support. Persists data in MongoDB Atlas.

## ✨ Features
- 🔐 Register / Login (JWT + bcrypt)
- 💬 Real-time messaging (Socket.IO)
- ⌨️ Typing indicators
- ✓✓ Read receipts (sent / delivered / read)
- 🟢 Online presence
- 🗄️ MongoDB persistence
- 📱 Installable PWA
- 🔔 Desktop notifications

## 🚀 Local Development

```bash
git clone https://github.com/YOUR_USERNAME/chatapp.git
cd chatapp
npm install
cp .env.example .env
# edit .env with your MONGODB_URI and JWT_SECRET
npm run dev
```

Open http://localhost:3000, register two accounts in two browsers, and chat live.

## ☁️ Deploy to Render

1. Push to GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/chatapp.git
   git push -u origin main
   ```
2. Render → **New Web Service** → connect repo
   - Build: `npm install`
   - Start: `npm start`
   - Env vars:
     - `JWT_SECRET` = (any long random string)
     - `MONGODB_URI` = your Atlas connection string
3. In MongoDB Atlas → **Network Access** → allow `0.0.0.0/0` (or Render's IPs)

## 🐳 Docker (VPS)

```bash
docker-compose up -d --build
```

### Nginx reverse proxy

```nginx
server {
  listen 80;
  server_name chat.yourdomain.com;
  location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}
```

Then `sudo certbot --nginx -d chat.yourdomain.com` for HTTPS.

## 📱 Install as App
- **Chrome/Android:** Menu → "Install app"
- **iOS/Safari:** Share → "Add to Home Screen"
- **Desktop Chrome:** Install icon in the address bar

## ⚠️ Security
Never commit `.env`. Rotate your MongoDB password if it was ever exposed.