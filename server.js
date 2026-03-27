import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());

const queue = [];

app.get('/match', async (req, res) => {
  const nick = req.query.nick || 'Игрок';
  const myId = Math.random().toString(36).slice(2, 10);

  const opponent = queue.shift();
  if (opponent) {
    opponent.res.json({ roomId: myId, role: 'host', opponentNick: nick });
    clearTimeout(opponent.timer);
    return res.json({ roomId: myId, role: 'guest', opponentNick: opponent.nick });
  }

  let resolve;
  const entry = { nick, res, id: myId };
  queue.push(entry);

  entry.timer = setTimeout(() => {
    const idx = queue.indexOf(entry);
    if (idx !== -1) queue.splice(idx, 1);
    res.status(408).json({ error: 'timeout' });
  }, 55000);
});

app.listen(process.env.PORT || 3000, () => console.log('ok'));
