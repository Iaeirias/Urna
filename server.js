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

let wantUser = '';
let retryTimer = null;

const SKIP = /^(toUser|to_user|anchor|host|receiver)$/i;
function deep(o, names, depth = 0, seen = new Set()) {
  if (!o || typeof o !== 'object' || depth > 6 || seen.has(o)) return undefined;
  seen.add(o);
  for (const n of names) {
    const v = o[n];
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'object') return v;
  }
  for (const k of Object.keys(o)) {
    if (SKIP.test(k)) continue;
    const r = deep(o[k], names, depth + 1, seen);
    if (r !== undefined) return r;
  }
  return undefined;
}
const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const ALIAS = { 'rosa': 'rose', 'rosa branca': 'white rose' };

const seenMsgs = new Set();
function onGift(data) {
  try {
    try { console.log('Presente bruto:', JSON.stringify(data, (k, v) => typeof v === 'bigint' ? v.toString() : v).slice(0, 1500)); } catch (e) {}
    // ignora o mesmo evento se o TikTok mandar repetido
    const mid = deep(data, ['msgId', 'msg_id']);
    if (mid !== undefined) {
      const m = String(mid);
      if (seenMsgs.has(m)) { console.log('Presente repetido ignorado'); return; }
      seenMsgs.add(m);
      if (seenMsgs.size > 500) seenMsgs.delete(seenMsgs.values().next().value);
    }
    const user = deep(data.user || data.sender || data, ['uniqueId', 'unique_id', 'nickname', 'nickName']) || 'alguem';
    const giftName = deep(data, ['giftName', 'gift_name', 'name']) || '';
    const giftId = deep(data, ['giftId', 'gift_id', 'id']) || giftName;
    const giftType = Number(deep(data, ['giftType', 'gift_type']));
    const repeatEnd = deep(data, ['repeatEnd', 'repeat_end']);
    const group = deep(data, ['groupId', 'group_id']) || '';
    const repeatCount = Number(deep(data, ['repeatCount', 'repeat_count', 'comboCount'])) || 1;
    const key = user + ':' + giftId + ':' + group;
    let n;
    if (!Number.isNaN(giftType) && giftType !== 1) {
      n = repeatCount; // presente que não acumula em sequência
    } else {
      // sequência: conta só o que ainda não foi contado (1 rosa = 1 ponto)
      const now = Date.now();
      const st = streaks[key];
      const prev = st && now - st.t < 15000 ? st.n : 0;
      n = repeatCount - prev;
      if (repeatEnd) delete streaks[key]; else streaks[key] = { n: repeatCount, t: now };
    }
    console.log('Presente:', giftName || ('ID ' + giftId), 'de', user, 'x', n);
    if (n <= 0) return;
    broadcast({ type: 'GIFT_SEEN', name: giftName || ('ID ' + giftId), user });
    const wanted = norm(giftName);
    const g = (config.gifts || []).find(x => {
      const nm = norm(x.name);
      return nm === wanted || nm === (ALIAS[wanted] || wanted);
    });
    if (!g) { console.log('Presente sem ligação na configuração:', giftName); return; }
    addVote(g.candidate, user, g.label || g.name, n * (Number(config.votesPerGift) || 1));
  } catch (e) { console.error('Erro no presente:', e); }
}

function scheduleRetry() {
  if (!wantUser) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (!wantUser || status === 'connected') return;
    console.log('Tentando reconectar em @' + wantUser);
    startConnection(wantUser).catch(e => console.log('Reconexão falhou:', e && e.message ? e.message : e));
  }, 20000);
}

async function startConnection(username) {
  wantUser = username;
  clearTimeout(retryTimer);
  if (conn) { const old = conn; conn = null; try { old.disconnect(); } catch (e) {} }
  let c;
  try {
    c = new Connection(username, { processInitialData: false });
    conn = c;
    c.on('gift', onGift);
    c.on('error', e => console.error('Erro do TikTok:', e && e.message ? e.message : e));
    c.on('disconnected', () => {
      if (conn !== c) return;
      status = 'disconnected'; broadcast({ type: 'STATUS', status });
      scheduleRetry();
    });
    const s = await c.connect();
    if (conn === c) { status = 'connected'; broadcast({ type: 'STATUS', status }); }
    return s;
  } catch (err) {
    console.error('Erro ao conectar:', err);
    if (!c || conn === c) { status = 'disconnected'; broadcast({ type: 'STATUS', status }); scheduleRetry(); }
    throw err;
  }
}

app.post('/api/connect', admin, async (req, res) => {
  const username = String(req.body.username || '').replace('@', '').trim().toLowerCase();
  if (!username) return res.status(400).json({ error: 'Informe o @usuário' });
  config.tiktokUsername = username; save();
  try {
    const s = await startConnection(username);
    res.json({ ok: true, roomId: s.roomId });
  } catch (err) {
    res.status(500).json({ error: 'Não conectou. A live precisa estar aberta. Vou tentar de novo sozinho. ' + (err && err.message ? err.message : err) });
  }
});

app.post('/api/disconnect', admin, (req, res) => {
  wantUser = ''; clearTimeout(retryTimer);
  if (conn) { const old = conn; conn = null; try { old.disconnect(); } catch (e) {} }
  status = 'disconnected';
  broadcast({ type: 'STATUS', status });
  res.json({ ok: true });
});

wss.on('connection', ws => ws.send(JSON.stringify(snapshot())));

process.on('uncaughtException', e => console.error('Erro inesperado:', e));
process.on('unhandledRejection', e => console.error('Promessa rejeitada:', e));

server.listen(PORT, '0.0.0.0', () => {
  console.log('Urna rodando na porta ' + PORT);
  const auto = String(process.env.TIKTOK_USERNAME || config.tiktokUsername || '').replace('@', '').trim().toLowerCase();
  if (auto) startConnection(auto).catch(e => console.log('Primeira conexão falhou, vou tentar de novo:', e && e.message ? e.message : e));
  const self = process.env.RENDER_EXTERNAL_URL;
  if (self) setInterval(() => { fetch(self + '/api/state').catch(() => {}); }, 10 * 60 * 1000);
});
