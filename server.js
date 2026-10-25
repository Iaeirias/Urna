const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const TT = require('tiktok-live-connector');
const Connection = TT.TikTokLiveConnection || TT.WebcastPushConnection;
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const CFG = path.join(__dirname, 'config.json');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.json());
const BLOCK = ['/server.js', '/package.json', '/package-lock.json', '/config.json', '/README.md'];
app.use((req, res, next) => BLOCK.includes(req.path) ? res.status(404).end() : next());
app.get('/rose.png', (req, res, next) => {
  const f = ['rose.png', 'rose.png.webp'].map(n => path.join(__dirname, n)).find(p => fs.existsSync(p));
  f ? res.sendFile(f) : next();
});
app.use(express.static(__dirname, { index: false, dotfiles: 'ignore' }));

let config = JSON.parse(fs.readFileSync(CFG, 'utf8'));
let votes = [0, 0];
let recent = [];
let conn = null;
let status = 'disconnected';
const streaks = {};

const save = () => { try { fs.writeFileSync(CFG, JSON.stringify(config, null, 2)); } catch (e) {} };
const broadcast = d => wss.clients.forEach(c => c.readyState === 1 && c.send(JSON.stringify(d)));
const snapshot = () => ({ type: 'STATE', config: { ...config, tiktokUsername: undefined }, votes, recent, status });

const admin = (req, res, next) => {
  if (!ADMIN_KEY || req.get('x-admin-key') === ADMIN_KEY) return next();
  res.status(401).json({ error: 'Senha incorreta' });
};

function addVote(candidate, user, gift, count) {
  votes[candidate] += count;
  recent.unshift({ candidate, user, gift, count });
  recent = recent.slice(0, 6);
  broadcast({ type: 'VOTE', candidate, user, gift, count, votes, recent });
}

app.get('/api/state', (req, res) => res.json(snapshot()));
app.get('/api/config', admin, (req, res) => res.json(config));
app.post('/api/config', admin, (req, res) => {
  config = req.body; save();
  broadcast(snapshot());
  res.json({ ok: true });
});
app.post('/api/vote', admin, (req, res) => {
  const c = Number(req.body.candidate);
  if (c !== 0 && c !== 1) return res.status(400).json({ error: 'candidato inválido' });
  addVote(c, 'teste', 'Teste', Number(req.body.count) || 1);
  res.json({ ok: true });
});
app.post('/api/reset', admin, (req, res) => {
  votes = [0, 0]; recent = [];
  broadcast(snapshot());
  res.json({ ok: true });
});

app.post('/api/connect', admin, async (req, res) => {
  const username = String(req.body.username || '').replace('@', '').trim();
  if (!username) return res.status(400).json({ error: 'Informe o @usuário' });
  config.tiktokUsername = username; save();
  if (conn) { try { conn.disconnect(); } catch (e) {} }
  conn = new Connection(username, { processInitialData: false });

  conn.on('gift', data => {
    try {
      const user = data.uniqueId || (data.user && data.user.uniqueId) || 'alguem';
      const gd = data.giftDetails || {};
      const giftName = data.giftName || gd.giftName || '';
      const giftId = data.giftId || gd.id || giftName;
      const giftType = data.giftType !== undefined ? data.giftType : gd.giftType;
      const key = user + ':' + giftId;
      let n = 1;
      if (giftType === 1) {
        const total = Number(data.repeatCount) || 1;
        n = total - (streaks[key] || 0);
        if (data.repeatEnd) delete streaks[key]; else streaks[key] = total;
      } else {
        n = Number(data.repeatCount) || 1;
      }
      console.log('Presente:', giftName, 'de', user, 'x', n);
      if (n <= 0) return;
      broadcast({ type: 'GIFT_SEEN', name: giftName, user });
      const g = (config.gifts || []).find(x => x.name.toLowerCase() === String(giftName).toLowerCase());
      if (!g) return;
      addVote(g.candidate, user, g.label || g.name, n * (Number(config.votesPerGift) || 1));
    } catch (e) { console.error('Erro no presente:', e); }
  });
  conn.on('disconnected', () => { status = 'disconnected'; broadcast({ type: 'STATUS', status }); });

  try {
    const s = await conn.connect();
    status = 'connected';
    broadcast({ type: 'STATUS', status });
    res.json({ ok: true, roomId: s.roomId });
  } catch (err) {
    status = 'disconnected';
    console.error('Erro ao conectar:', err);
    res.status(500).json({ error: 'Não conectou. A live precisa estar aberta. ' + (err && err.message ? err.message : err) });
  }
});

app.post('/api/disconnect', admin, (req, res) => {
  if (conn) { try { conn.disconnect(); } catch (e) {} conn = null; }
  status = 'disconnected';
  broadcast({ type: 'STATUS', status });
  res.json({ ok: true });
});

wss.on('connection', ws => ws.send(JSON.stringify(snapshot())));

server.listen(PORT, '0.0.0.0', () => console.log('Urna rodando na porta ' + PORT));
