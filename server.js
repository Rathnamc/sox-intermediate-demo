// SOX Intermediate practice app
// Express + WebSocket multiplayer backend, built to run on
// Azure App Service (Linux) with WebSockets enabled — same shape
// as the real project's App Service backend.

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Azure App Service injects PORT. Never hardcode 80/443.
const PORT = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname, 'public')));

// Health endpoint — Azure health checks and quick sanity tests
app.get('/health', (req, res) => {
  res.json({ status: 'ok', players: game.players.size, uptime: process.uptime() });
});

// ---- Minimal multiplayer game state (shared quiz/tap game) ----
const game = {
  players: new Map(), // ws -> { id, name, score }
  round: 1,
};

let nextId = 1;

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of game.players.keys()) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function scoreboard() {
  return [...game.players.values()]
    .sort((a, b) => b.score - a.score)
    .map(p => ({ name: p.name, score: p.score }));
}

wss.on('connection', (ws) => {
  const player = { id: nextId++, name: `Player ${nextId - 1}`, score: 0 };
  game.players.set(ws, player);

  ws.send(JSON.stringify({ type: 'welcome', you: player.name, round: game.round }));
  broadcast({ type: 'state', round: game.round, scoreboard: scoreboard() });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'setName' && typeof msg.name === 'string') {
      player.name = msg.name.slice(0, 24) || player.name;
    }
    if (msg.type === 'tap') {
      player.score += 1;
      if (player.score % 25 === 0) game.round += 1; // arbitrary round bump
    }
    broadcast({ type: 'state', round: game.round, scoreboard: scoreboard() });
  });

  ws.on('close', () => {
    game.players.delete(ws);
    broadcast({ type: 'state', round: game.round, scoreboard: scoreboard() });
  });
});

server.listen(PORT, () => {
  console.log(`SOX Intermediate demo listening on port ${PORT}`);
});
