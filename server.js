import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const app = express();
app.use(cors());
app.use(express.static('.'));

// ← логирование IP
app.use((req, res, next) => {
  console.log(`IP: ${req.headers['x-forwarded-for'] || req.ip} | ${req.method} ${req.url}`);
  next();
});

// ── ТОП ──
const leaderboard = [];
function updateLeaderboard(nick, elo) {
  const idx = leaderboard.findIndex(p => p.nick === nick);
  if (idx !== -1) leaderboard[idx].elo = elo;
  else leaderboard.push({ nick, elo });
  leaderboard.sort((a, b) => b.elo - a.elo);
  if (leaderboard.length > 100) leaderboard.length = 100;
}
app.get('/top', (req, res) => res.json(leaderboard));

// ── МАТЧМЕЙКИНГ ──
const queue = [];
app.get('/match', (req, res) => {
  const nick = req.query.nick || 'Игрок';
  const elo  = parseInt(req.query.elo) || 1640;
  const myId = Math.random().toString(36).slice(2, 10);
  const opponent = queue.shift();
  if (opponent) {
    clearTimeout(opponent.timer);
    opponent.res.json({ roomId: myId, role: 'host', opponentNick: nick });
    return res.json({ roomId: myId, role: 'guest', opponentNick: opponent.nick });
  }
  const entry = { nick, elo, res, id: myId };
  queue.push(entry);
  entry.timer = setTimeout(() => {
    const idx = queue.indexOf(entry);
    if (idx !== -1) queue.splice(idx, 1);
    res.status(408).json({ error: 'timeout' });
  }, 55000);
});

// ── КОМНАТЫ ──
const rooms = {};
app.get('/room', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).end();
  rooms[id] = { hostWs: null, guestWs: null, hostNick:'', guestNick:'', hostElo:1640, guestElo:1640, sRed:0, sBlue:0, scoreLimit:5 };
  res.json({ ok: true });
});

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  if (room.hostWs  && room.hostWs.readyState  === 1) room.hostWs.send(msg);
  if (room.guestWs && room.guestWs.readyState === 1) room.guestWs.send(msg);
}

// ── WebSocket ──
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }

    if (d.t === 'join') {
      const room = rooms[d.roomId];
      if (!room) return;
      ws._roomId = d.roomId;
      ws._role = d.role;
      if (d.role === 'host') {
        room.hostWs = ws; room.hostNick = d.nick; room.hostElo = d.elo || 1640;
      } else {
        room.guestWs = ws; room.guestNick = d.nick; room.guestElo = d.elo || 1640;
        broadcast(room, { t: 'start' });
      }
    }

    if (d.t === 'pos') {
      const room = rooms[ws._roomId];
      if (!room) return;
      const target = ws._role === 'host' ? room.guestWs : room.hostWs;
      send(target, { t: 'pos', x: d.x, y: d.y, vx: d.vx, vy: d.vy });
    }

    if (d.t === 'goal') {
      const room = rooms[ws._roomId];
      if (!room || ws._role !== 'host') return;
      if (d.who === 'red') room.sRed++; else room.sBlue++;
      const ended = room.sRed >= room.scoreLimit || room.sBlue >= room.scoreLimit;
      broadcast(room, { t: 'goal', who: d.who, sRed: room.sRed, sBlue: room.sBlue });
      if (ended) {
        const rw = room.sRed >= room.scoreLimit;
        const dRed = rw ? Math.floor(15 + Math.random()*10) : -Math.floor(15 + Math.random()*10);
        broadcast(room, { t: 'end', winner: rw?'red':'blue', deltaRed: dRed, deltaBlue: -dRed });
        updateLeaderboard(room.hostNick,  Math.max(100, room.hostElo  + dRed));
        updateLeaderboard(room.guestNick, Math.max(100, room.guestElo - dRed));
        delete rooms[ws._roomId];
      }
    }
  });

  ws.on('close', () => {
    const room = rooms[ws._roomId];
    if (!room) return;
    const other = ws._role === 'host' ? room.guestWs : room.hostWs;
    send(other, { t: 'bye' });
    delete rooms[ws._roomId];
  });
});

server.listen(process.env.PORT || 3000, () => console.log('ok'));
