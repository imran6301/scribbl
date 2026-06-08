const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, "public", "index.html");
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
  });
});

// ── Game state ───────────────────────────────────────────────────
const DEFAULT_ROUND_TIME = 80;
const DEFAULT_ROUNDS_TOTAL = 3;

const WORD_LIST = [
  "apple","banana","guitar","mountain","rainbow","elephant","castle","bicycle",
  "dolphin","volcano","pizza","umbrella","butterfly","dragon","lighthouse",
  "cactus","penguin","tornado","treasure","telescope","submarine","giraffe",
  "compass","jellyfish","snowflake","sandwich","porcupine","waterfall","robot",
  "astronaut","pyramid","caterpillar","mermaid","carousel","pancake","igloo",
  "lantern","hedgehog","teapot","windmill","parrot","crab","badminton","cloud",
  "detective","scorpion","avocado","diamond","kangaroo","firework","wizard",
  "dinosaur","spaceship","octopus","tornado","volcano","balloon","camera",
  "skateboard","trophy","microscope","sailboat","chessboard","lighthouse",
  "parachute","lollipop","trampoline","suitcase","thermometer","accordion"
];

function pick(arr, n = 3) {
  const copy = [...arr].sort(() => Math.random() - 0.5);
  return copy.slice(0, n);
}

const rooms = new Map();

function makeRoom() {
  return {
    players: [],
    drawingIdx: 0,
    round: 0,
    word: null,
    phase: "lobby",
    timer: null,
    timerLeft: 0,
    strokes: [],
    wordChoices: [],
    guessedIds: new Set(),
    // Configurable settings
    roundTime: DEFAULT_ROUND_TIME,
    roundsTotal: DEFAULT_ROUNDS_TOTAL,
    host: null, // id of room creator
  };
}

function broadcast(room, msg, excludeId = null) {
  const json = JSON.stringify(msg);
  room.players.forEach(p => {
    if (p.id !== excludeId && p.ws.readyState === 1) p.ws.send(json);
  });
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function maskWord(word) { return word.replace(/[a-zA-Z]/g, "_"); }

function clearTimer(room) {
  if (room.timer) { clearInterval(room.timer); clearTimeout(room.timer); room.timer = null; }
}

function startChoosing(room) {
  room.phase = "choosing";
  room.strokes = [];
  room.guessedIds = new Set();
  const drawer = room.players[room.drawingIdx];
  room.wordChoices = pick(WORD_LIST);

  // Send chooseWord ONLY to drawer
  send(drawer.ws, { type: "chooseWord", words: room.wordChoices });

  // Broadcast to everyone (including drawer) for phase display
  broadcast(room, { type: "phase", phase: "choosingWait", drawer: drawer.name });
  // Tell drawer their specific phase (overwrites the above for them)
  send(drawer.ws, { type: "phase", phase: "choosing", drawer: drawer.name });

  // Auto-pick after 12s if drawer doesn't respond
  room.timer = setTimeout(() => {
    if (room.phase === "choosing") chooseWord(room, room.wordChoices[0]);
  }, 12000);
}

function chooseWord(room, word) {
  clearTimer(room);
  room.word = word;
  room.phase = "drawing";
  const drawer = room.players[room.drawingIdx];

  send(drawer.ws, { type: "drawStart", word, role: "drawer", timeLeft: room.roundTime });
  broadcast(room, {
    type: "drawStart",
    masked: maskWord(word),
    hint: `${word.length} letters`,
    role: "guesser",
    drawer: drawer.name,
    timeLeft: room.roundTime,
  }, drawer.id);

  room.timerLeft = room.roundTime;
  room.timer = setInterval(() => {
    room.timerLeft--;
    broadcast(room, { type: "tick", t: room.timerLeft });
    if (room.timerLeft <= 0) endRound(room, false);
  }, 1000);
}

function endRound(room, allGuessed) {
  clearTimer(room);
  room.phase = "roundEnd";
  const scores = room.players.map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
  broadcast(room, { type: "roundEnd", word: room.word, scores, allGuessed });
  setTimeout(() => nextTurn(room), 4000);
}

function nextTurn(room) {
  const total = room.players.length;
  room.drawingIdx = (room.drawingIdx + 1) % total;
  if (room.drawingIdx === 0) room.round++;
  if (room.round >= room.roundsTotal) {
    endGame(room);
  } else {
    startChoosing(room);
  }
}

function endGame(room) {
  room.phase = "gameEnd";
  const scores = room.players
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
  broadcast(room, { type: "gameEnd", scores });
}

function handleGuess(room, player, text) {
  if (room.phase !== "drawing") return;
  if (player.id === room.players[room.drawingIdx].id) return;
  if (room.guessedIds.has(player.id)) return;

  const guess = text.trim().toLowerCase();
  const correct = room.word && guess === room.word.toLowerCase();

  if (correct) {
    const timeBonus = Math.floor(room.timerLeft * 0.5);
    const pts = 100 + timeBonus;
    player.score += pts;
    room.players[room.drawingIdx].score += 25;
    room.guessedIds.add(player.id);

    broadcast(room, {
      type: "correctGuess",
      name: player.name,
      score: player.score,
      drawerScore: room.players[room.drawingIdx].score,
    });

    const guessers = room.players.filter(p => p.id !== room.players[room.drawingIdx].id);
    if (room.guessedIds.size >= guessers.length) endRound(room, true);
  } else {
    broadcast(room, { type: "chat", name: player.name, text, isGuess: true });
  }
}

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  let roomId = null, playerId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "join") {
      roomId = msg.room || "default";
      playerId = Date.now() + Math.random().toString(36).slice(2);
      const name = (msg.name || "Player").slice(0, 16);

      if (!rooms.has(roomId)) rooms.set(roomId, makeRoom());
      const room = rooms.get(roomId);

      if (room.phase !== "lobby" && room.phase !== "gameEnd") {
        send(ws, { type: "error", text: "Game already in progress." }); return;
      }

      // First player is host
      if (room.players.length === 0) room.host = playerId;

      const player = { ws, id: playerId, name, score: 0 };
      room.players.push(player);

      send(ws, {
        type: "joined",
        id: playerId,
        name,
        roomId,
        players: room.players.map(p => p.name),
        isHost: room.host === playerId,
        settings: { roundTime: room.roundTime, roundsTotal: room.roundsTotal },
      });
      broadcast(room, { type: "playerJoined", name, players: room.players.map(p => p.name) }, playerId);
      return;
    }

    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;

    switch (msg.type) {
      case "updateSettings":
        // Only host can change settings
        if (room.host !== playerId) return;
        if (room.phase !== "lobby" && room.phase !== "gameEnd") return;
        if (msg.roundTime) room.roundTime = Math.max(20, Math.min(180, parseInt(msg.roundTime) || DEFAULT_ROUND_TIME));
        if (msg.roundsTotal) room.roundsTotal = Math.max(1, Math.min(10, parseInt(msg.roundsTotal) || DEFAULT_ROUNDS_TOTAL));
        broadcast(room, {
          type: "settingsUpdated",
          roundTime: room.roundTime,
          roundsTotal: room.roundsTotal,
        });
        break;

      case "startGame":
        if (room.players.length < 2) { send(ws, { type: "error", text: "Need at least 2 players." }); return; }
        if (room.phase !== "lobby" && room.phase !== "gameEnd") return;
        room.round = 0;
        room.drawingIdx = 0;
        room.players.forEach(p => p.score = 0);
        broadcast(room, {
          type: "gameStarting",
          players: room.players.map(p => p.name),
          roundsTotal: room.roundsTotal,
          roundTime: room.roundTime,
        });
        setTimeout(() => startChoosing(room), 1500);
        break;

      case "wordChosen":
        if (room.phase !== "choosing") return;
        if (player.id !== room.players[room.drawingIdx].id) return;
        if (!room.wordChoices.includes(msg.word)) return;
        clearTimeout(room.timer);
        chooseWord(room, msg.word);
        break;

      case "draw":
        if (room.phase !== "drawing") return;
        if (player.id !== room.players[room.drawingIdx].id) return;
        room.strokes.push(msg.data);
        broadcast(room, { type: "draw", data: msg.data }, playerId);
        break;

      case "clearCanvas":
        if (player.id !== room.players[room.drawingIdx].id) return;
        room.strokes = [];
        broadcast(room, { type: "clearCanvas" }, playerId);
        break;

      case "undoCanvas":
        if (player.id !== room.players[room.drawingIdx].id) return;
        // Pop last stroke group (strokes since last mousedown)
        const lastDown = room.strokes.lastIndexOf(null);
        if (lastDown === -1) room.strokes = [];
        else room.strokes = room.strokes.slice(0, lastDown);
        // Broadcast full redraw
        broadcast(room, { type: "redrawStrokes", strokes: room.strokes }, playerId);
        break;

      case "mouseDown":
        if (player.id !== room.players[room.drawingIdx].id) return;
        if (room.phase !== "drawing") return;
        room.strokes.push(null); // null = stroke group separator
        break;

      case "guess":
        handleGuess(room, player, msg.text);
        break;

      case "chat":
        broadcast(room, { type: "chat", name: player.name, text: msg.text });
        break;

      case "requestStrokes":
        send(ws, { type: "strokes", strokes: room.strokes });
        break;
    }
  });

  ws.on("close", () => {
    const room = rooms.get(roomId);
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx === -1) return;
    const name = room.players[idx].name;
    room.players.splice(idx, 1);

    // Transfer host if host left
    if (room.host === playerId && room.players.length > 0) {
      room.host = room.players[0].id;
      send(room.players[0].ws, { type: "youAreHost" });
    }

    broadcast(room, { type: "playerLeft", name, players: room.players.map(p => p.name) });

    if (room.players.length === 0) {
      clearTimer(room);
      rooms.delete(roomId);
    } else if (room.phase === "drawing" && idx === room.drawingIdx) {
      clearTimer(room);
      endRound(room, false);
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`🎨 Scribbl server running → http://localhost:${PORT}`));