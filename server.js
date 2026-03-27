import express from 'express';
import cors from 'cors';
import { ExpressPeerServer } from 'peer';
import { createServer } from 'http';

const app = express();
app.use(cors());
app.use(express.static('.'));

const queue = [];

app.get('/match', (req, res) => {
  const nick = req.query.nick || 'Игрок';
  const myId = Math.random().toString(36).slice(2, 10);

  const opponent = queue.shift();
  if (opponent) {
    opponent.res.json({ roomId: myId, role: 'host', opponentNick: nick });
    clearTimeout(opponent.timer);
    return res.json({ roomId: myId, role: 'guest', opponentNick: opponent.nick });
  }

  const entry = { nick, res, id: myId };
  queue.push(entry);

  entry.timer = setTimeout(() => {
    const idx = queue.indexOf(entry);
    if (idx !== -1) queue.splice(idx, 1);
    res.status(408).json({ error: 'timeout' });
  }, 55000);
});

const server = createServer(app);
const peerServer = ExpressPeerServer(server, { path: '/' });
app.use('/peer', peerServer);

server.listen(process.env.PORT || 3000, () => console.log('ok'));
