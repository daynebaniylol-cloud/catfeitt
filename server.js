import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const app = express();
app.use(cors());
app.use(express.static('.'));

// ── ТОП ИГРОКОВ (в памяти) ──
const leaderboard = [];
function updateLeaderboard(nick, elo) {
  const idx = leaderboard.findIndex(p => p.nick === nick);
  if (idx !== -1) leaderboard[idx].elo = elo;
  else leaderboard.push({ nick, elo });
  leaderboard.sort((a, b) => b.elo - a.elo);
  if (leaderboard.length > 100) leaderboard.length = 100;
}

app.get('/top', (req, res) => res.json(leaderboard));

// ── МАТЧМЕЙКИНГ (long-poll) ──
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

// ── ФИЗИКА ──
const RINK = { x: 68, y: 43, w: 664, h: 394 };
const BW = 800, BH = 480;
const GH = Math.round(RINK.h * 0.24);
const GY = RINK.y + RINK.h / 2 - GH / 2;
const PR = 36, PKTR = 18, SPMAX = 7, FRIC = 0.87;
const CENTER_X = BW / 2;
const TICK = 1000 / 60;

function resetState() {
  return {
    red:  { x: RINK.x + RINK.w * 0.22, y: BH / 2, vx: 0, vy: 0, r: PR },
    blue: { x: RINK.x + RINK.w * 0.78, y: BH / 2, vx: 0, vy: 0, r: PR },
    puck: { x: BW / 2, y: BH / 2, vx: (Math.random() - .5) * 2.5, vy: (Math.random() - .5) * 2.5, r: PKTR },
    sRed: 0, sBlue: 0,
  };
}

function clamp(pl) {
  const s = Math.hypot(pl.vx, pl.vy);
  if (s > SPMAX) { pl.vx = pl.vx / s * SPMAX; pl.vy = pl.vy / s * SPMAX; }
}

function movePlayer(pl, side, drag) {
  if (drag) {
    if (side === 'red') { pl.x = Math.max(RINK.x + pl.r, Math.min(CENTER_X - pl.r, pl.x)); }
    else                { pl.x = Math.max(CENTER_X + pl.r, Math.min(RINK.x + RINK.w - pl.r, pl.x)); }
    pl.y = Math.max(RINK.y + pl.r, Math.min(RINK.y + RINK.h - pl.r, pl.y));
    return;
  }
  pl.x += pl.vx; pl.y += pl.vy; pl.vx *= FRIC; pl.vy *= FRIC;
  if (pl.x - pl.r < RINK.x) { pl.x = RINK.x + pl.r; pl.vx *= -0.3; }
  if (pl.x + pl.r > RINK.x + RINK.w) { pl.x = RINK.x + RINK.w - pl.r; pl.vx *= -0.3; }
  if (pl.y - pl.r < RINK.y) { pl.y = RINK.y + pl.r; pl.vy *= -0.3; }
  if (pl.y + pl.r > RINK.y + RINK.h) { pl.y = RINK.y + RINK.h - pl.r; pl.vy *= -0.3; }
  if (side === 'red'  && pl.x + pl.r > CENTER_X) { pl.x = CENTER_X - pl.r; pl.vx = 0; }
  if (side === 'blue' && pl.x - pl.r < CENTER_X) { pl.x = CENTER_X + pl.r; pl.vx = 0; }
}

function collidePP(s) {
  const { red, blue } = s;
  const dx = blue.x - red.x, dy = blue.y - red.y, d = Math.hypot(dx, dy), mn = red.r + blue.r;
  if (d < mn && d > 0) {
    const nx = dx / d, ny = dy / d, ov = (mn - d) / 2;
    red.x -= nx * ov; red.y -= ny * ov; blue.x += nx * ov; blue.y += ny * ov;
    const rel = (red.vx - blue.vx) * nx + (red.vy - blue.vy) * ny;
    if (rel > 0) {
      red.vx -= rel * nx * 0.65; red.vy -= rel * ny * 0.65;
      blue.vx += rel * nx * 0.65; blue.vy += rel * ny * 0.65;
    }
  }
}

// returns 'red'|'blue'|null
function movePuck(s) {
  const { red, blue, puck } = s;
  let hit = false;
  for (const pl of [red, blue]) {
    const dx = puck.x - pl.x, dy = puck.y - pl.y, d = Math.hypot(dx, dy), mn = pl.r + puck.r;
    if (d < mn && d > 0) {
      const nx = dx / d, ny = dy / d;
      puck.x = pl.x + nx * mn; puck.y = pl.y + ny * mn;
      const imp = ((pl.vx - puck.vx) * nx + (pl.vy - puck.vy) * ny) * 2.6;
      if (imp > 0) { puck.vx += nx * imp; puck.vy += ny * imp; hit = true; }
      const ps = Math.hypot(puck.vx, puck.vy);
      if (ps < 3.5) { puck.vx = nx * 3.5; puck.vy = ny * 3.5; }
      if (ps > 18)  { puck.vx = puck.vx / ps * 18; puck.vy = puck.vy / ps * 18; }
    }
  }
  puck.x += puck.vx; puck.y += puck.vy; puck.vx *= 0.991; puck.vy *= 0.991;
  if (puck.y - puck.r < RINK.y) { puck.y = RINK.y + puck.r; puck.vy = Math.abs(puck.vy) * 0.82; }
  if (puck.y + puck.r > RINK.y + RINK.h) { puck.y = RINK.y + RINK.h - puck.r; puck.vy = -Math.abs(puck.vy) * 0.82; }
  if (puck.x - puck.r < RINK.x) {
    if (puck.y + puck.r > GY && puck.y - puck.r < GY + GH) return 'blue';
    puck.x = RINK.x + puck.r; puck.vx = Math.abs(puck.vx) * 0.82;
  }
  if (puck.x + puck.r > RINK.x + RINK.w) {
    if (puck.y + puck.r > GY && puck.y - puck.r < GY + GH) return 'red';
    puck.x = RINK.x + RINK.w - puck.r; puck.vx = -Math.abs(puck.vx) * 0.82;
  }
  return hit ? 'hit' : null;
}

// ── КОМНАТЫ ──
const rooms = {};

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of [room.hostWs, room.guestWs]) {
    if (ws && ws.readyState === 1) ws.send(msg);
  }
}

function startRoom(room) {
  room.state = resetState();
  room.scoreLimit = 5;
  room.running = true;
  room.hostDrag = false;
  room.guestDrag = false;

  room.interval = setInterval(() => {
    if (!room.running) return;
    const s = room.state;

    // применяем ввод от клиентов
    if (room.hostInput) {
      s.red.x = room.hostInput.x; s.red.y = room.hostInput.y;
      s.red.vx = room.hostInput.vx; s.red.vy = room.hostInput.vy;
    }
    if (room.guestInput) {
      s.blue.x = room.guestInput.x; s.blue.y = room.guestInput.y;
      s.blue.vx = room.guestInput.vx; s.blue.vy = room.guestInput.vy;
    }

    clamp(s.red); clamp(s.blue);
    movePlayer(s.red, 'red', room.hostDrag);
    movePlayer(s.blue, 'blue', room.guestDrag);
    collidePP(s);
    const ev = movePuck(s);

    if (ev === 'hit') broadcast(room, { t: 'hit' });

    if (ev === 'red' || ev === 'blue') {
      if (ev === 'red') s.sRed++;
      else s.sBlue++;

      const ended = s.sRed >= room.scoreLimit || s.sBlue >= room.scoreLimit;
      broadcast(room, { t: 'goal', who: ev, sRed: s.sRed, sBlue: s.sBlue, ended });

      if (ended) {
        room.running = false;
        clearInterval(room.interval);
        const rw = s.sRed >= room.scoreLimit;
        const dRed = rw ? Math.floor(15 + Math.random() * 10) : -Math.floor(15 + Math.random() * 10);
        broadcast(room, { t: 'end', winner: rw ? 'red' : 'blue', deltaRed: dRed, deltaBlue: -dRed });
        // обновляем лидерборд
        if (room.hostNick)  updateLeaderboard(room.hostNick,  Math.max(100, (room.hostElo  || 1640) + dRed));
        if (room.guestNick) updateLeaderboard(room.guestNick, Math.max(100, (room.guestElo || 1640) - dRed));
        return;
      }
      // сброс позиций
      Object.assign(s.red,  { x: RINK.x + RINK.w * 0.22, y: BH / 2, vx: 0, vy: 0 });
      Object.assign(s.blue, { x: RINK.x + RINK.w * 0.78, y: BH / 2, vx: 0, vy: 0 });
      Object.assign(s.puck, { x: BW / 2, y: BH / 2, vx: (Math.random() - .5) * 2.5, vy: (Math.random() - .5) * 2.5 });
    }

    // шлём состояние обоим
    broadcast(room, {
      t: 'state',
      rx: s.red.x, ry: s.red.y, rvx: s.red.vx, rvy: s.red.vy,
      bx: s.blue.x, by: s.blue.y, bvx: s.blue.vx, bvy: s.blue.vy,
      px: s.puck.x, py: s.puck.y, pvx: s.puck.vx, pvy: s.puck.vy,
    });
  }, TICK);
}

// ── WebSocket ──
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.on('message', raw => {
    let d;
    try { d = JSON.parse(raw); } catch { return; }

    if (d.t === 'join') {
      const room = rooms[d.roomId];
      if (!room) return;
      if (d.role === 'host') {
        room.hostWs = ws; room.hostNick = d.nick; room.hostElo = d.elo;
        ws._roomId = d.roomId; ws._role = 'host';
      } else {
        room.guestWs = ws; room.guestNick = d.nick; room.guestElo = d.elo;
        ws._roomId = d.roomId; ws._role = 'guest';
        // оба подключились — старт
        startRoom(room);
        broadcast(room, { t: 'start' });
      }
    }

    if (d.t === 'input') {
      const room = rooms[ws._roomId];
      if (!room) return;
      if (ws._role === 'host')  { room.hostInput = d;  room.hostDrag  = d.drag; }
      if (ws._role === 'guest') { room.guestInput = d; room.guestDrag = d.drag; }
    }
  });

  ws.on('close', () => {
    const room = rooms[ws._roomId];
    if (!room) return;
    room.running = false;
    clearInterval(room.interval);
    const other = ws._role === 'host' ? room.guestWs : room.hostWs;
    send(other, { t: 'bye' });
    delete rooms[ws._roomId];
  });
});

// создаём комнату при матче
const _origMatch = app._router;
app.get('/room', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).end();
  rooms[id] = { hostWs: null, guestWs: null, state: null, running: false, interval: null };
  res.json({ ok: true });
});

server.listen(process.env.PORT || 3000, () => console.log('ok'));
