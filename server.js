// SOX Intermediate — live multiplayer trivia
// Express + WebSocket. Host creates a room (shown on a projector),
// players join from phones with a 4-letter code, answer timed
// multiple-choice questions, and get scored on speed + correctness.
//
// Runs on Azure App Service (Linux) with WebSockets enabled.

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8080; // Azure assigns PORT

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) =>
  res.json({ status: 'ok', rooms: rooms.size, uptime: process.uptime() }));

// ---------------------------------------------------------------
// Question bank
// ---------------------------------------------------------------
const QUESTIONS = [
  { q: 'Which cloud provider offers a service called "App Service"?',
    options: ['AWS', 'Azure', 'Google Cloud', 'Oracle Cloud'], answer: 1 },
  { q: 'What does a WebSocket give you that plain HTTP does not?',
    options: ['Encryption', 'A persistent two-way connection', 'Faster DNS', 'Free storage'], answer: 1 },
  { q: 'In Git, which command uploads your commits to a remote?',
    options: ['git pull', 'git stash', 'git push', 'git clone'], answer: 2 },
  { q: 'What planet is known as the Red Planet?',
    options: ['Venus', 'Jupiter', 'Mars', 'Mercury'], answer: 2 },
  { q: 'Which of these is a NoSQL database?',
    options: ['PostgreSQL', 'MongoDB', 'MySQL', 'SQLite'], answer: 1 },
  { q: 'How many bits are in a byte?',
    options: ['4', '8', '16', '32'], answer: 1 },
  { q: 'What language runs natively in a web browser?',
    options: ['Python', 'JavaScript', 'Ruby', 'Go'], answer: 1 },
  { q: 'Which company created the React library?',
    options: ['Google', 'Microsoft', 'Meta', 'Amazon'], answer: 2 },
  { q: 'What does "HTTP" stand for?',
    options: ['HyperText Transfer Protocol', 'High Transfer Text Path', 'Host Transfer Table Protocol', 'Hyperterminal Text Program'], answer: 0 },
  { q: 'The Great Barrier Reef is off the coast of which country?',
    options: ['Brazil', 'Australia', 'Thailand', 'Mexico'], answer: 1 },
  { q: 'Which port does HTTPS use by default?',
    options: ['80', '22', '443', '8080'], answer: 2 },
  { q: 'What year did the first iPhone launch?',
    options: ['2005', '2007', '2009', '2010'], answer: 1 },
];

const QUESTION_MS = 20000;   // time to answer
const MAX_POINTS = 1000;     // per question (500 base + 500 speed)

// ---------------------------------------------------------------
// Room state
// ---------------------------------------------------------------
const rooms = new Map(); // code -> room
const socketRoom = new Map(); // ws -> code

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  send(room.host, obj);
  for (const p of room.players.values()) send(p.ws, obj);
}

function lobbyPayload(room) {
  return { type: 'lobby', code: room.code,
    players: [...room.players.values()].map(p => p.name) };
}

function scoreboard(room) {
  return [...room.players.values()]
    .sort((a, b) => b.score - a.score)
    .map(p => ({ name: p.name, score: p.score }));
}

function startQuestion(room) {
  const item = QUESTIONS[room.index];
  room.state = 'question';
  room.questionStart = Date.now();
  for (const p of room.players.values()) { p.answered = false; p.gained = 0; p.lastChoice = -1; }

  broadcast(room, {
    type: 'question',
    index: room.index,
    total: room.questions.length,
    q: item.q,
    options: item.options,
    duration: QUESTION_MS,
  });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => revealAnswer(room), QUESTION_MS);
}

function revealAnswer(room) {
  clearTimeout(room.timer);
  if (room.state !== 'question') return;
  room.state = 'reveal';
  const item = QUESTIONS[room.index];

  for (const p of room.players.values()) {
    send(p.ws, {
      type: 'reveal',
      correctIndex: item.answer,
      correct: p.lastChoice === item.answer,
      gained: p.gained || 0,
      score: p.score,
      scoreboard: scoreboard(room),
      last: room.index === room.questions.length - 1,
    });
  }
  send(room.host, {
    type: 'reveal',
    isHost: true,
    correctIndex: item.answer,
    scoreboard: scoreboard(room),
    last: room.index === room.questions.length - 1,
  });
}

function nextQuestion(room) {
  if (room.index < room.questions.length - 1) {
    room.index++;
    startQuestion(room);
  } else {
    room.state = 'ended';
    broadcast(room, { type: 'ended', scoreboard: scoreboard(room) });
  }
}

function maybeAllAnswered(room) {
  if (room.state !== 'question') return;
  const total = room.players.size;
  const answered = [...room.players.values()].filter(p => p.answered).length;
  send(room.host, { type: 'tally', answered, total });
  if (total > 0 && answered === total) revealAnswer(room);
}

// ---------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'host') {
      const code = makeCode();
      const room = {
        code, host: ws, players: new Map(),
        state: 'lobby', index: 0,
        questions: QUESTIONS, timer: null,
      };
      rooms.set(code, room);
      socketRoom.set(ws, code);
      send(ws, { type: 'hosted', code });
      send(ws, lobbyPayload(room));
      return;
    }

    if (msg.type === 'join') {
      const code = (msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', msg: 'No room with that code.' });
      if (room.state !== 'lobby') return send(ws, { type: 'error', msg: 'That game already started.' });
      const name = (msg.name || '').trim().slice(0, 20) || 'Player';
      const id = Math.random().toString(36).slice(2, 8);
      room.players.set(id, { id, ws, name, score: 0, answered: false, lastChoice: -1, gained: 0 });
      ws._playerId = id;
      socketRoom.set(ws, code);
      send(ws, { type: 'joined', code, name });
      broadcast(room, lobbyPayload(room));
      return;
    }

    const code = socketRoom.get(ws);
    const room = code && rooms.get(code);
    if (!room) return;

    if (msg.type === 'start' && ws === room.host) {
      if (room.players.size === 0) return send(ws, { type: 'error', msg: 'Wait for at least one player.' });
      room.index = 0;
      startQuestion(room);
      return;
    }

    if (msg.type === 'answer' && ws._playerId) {
      const p = room.players.get(ws._playerId);
      if (!p || room.state !== 'question' || p.answered) return;
      const item = QUESTIONS[room.index];
      p.answered = true;
      p.lastChoice = msg.choice;
      if (msg.choice === item.answer) {
        const elapsed = Date.now() - room.questionStart;
        const speed = Math.max(0, 1 - elapsed / QUESTION_MS);
        p.gained = Math.round(MAX_POINTS * (0.5 + 0.5 * speed));
        p.score += p.gained;
      } else {
        p.gained = 0;
      }
      send(ws, { type: 'locked' });
      maybeAllAnswered(room);
      return;
    }

    if (msg.type === 'next' && ws === room.host) {
      if (room.state === 'reveal') nextQuestion(room);
      return;
    }
  });

  ws.on('close', () => {
    const code = socketRoom.get(ws);
    socketRoom.delete(ws);
    const room = code && rooms.get(code);
    if (!room) return;

    if (ws === room.host) {
      broadcast(room, { type: 'error', msg: 'Host disconnected. Game over.' });
      clearTimeout(room.timer);
      rooms.delete(code);
      return;
    }
    if (ws._playerId) {
      room.players.delete(ws._playerId);
      if (room.state === 'lobby') broadcast(room, lobbyPayload(room));
      else maybeAllAnswered(room);
    }
  });
});

server.listen(PORT, () => console.log(`Trivia server on ${PORT}`));
