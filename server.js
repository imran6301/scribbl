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
  "dinosaur","spaceship","octopus","balloon","camera","skateboard","trophy",
  "microscope","sailboat","chessboard","parachute","lollipop","trampoline",
  "suitcase","thermometer","accordion","firefly","raccoon","hammock","sombrero",
  "boomerang","escalator","pretzel","squid","flamingo","cactus","croissant",
  "hammock","quicksand","beekeeper","stalactite","trident","yeti","zeppelin",
  "abacus","bonsai","centaur","dumbbell","eclipse","ferris wheel","gondola",
  "hourglass","igloo","javelin","kite","labyrinth","magnet","nebula","origami",
  "pinwheel","quill","sundial","tapestry","ukulele","vortex","wombat","xylophone",
  "yoyo","zeppelin","amphitheater","blimp","chimney","dagger","easel","faucet",
  "gargoyle","hammock","icicle","joystick","keyhole","lasso","monocle","noodle",
  "overalls","plunger","quicksand","rocketship","seashell","toadstool","unicycle",
  "viking","walrus","xray","yoga","zipline","anvil","broccoli","clover","donut",
  "eclipse","fern","gloves","hammock","inbox","juggler","knitting","llama",
  "mushroom","narwhal","otter","peacock","queen","radish","sphinx","toucan",
  "universe","vampire","waffle","xenon","yak","zombie","alligator","banjo",
  "catfish","dartboard","eggplant","fossil","gorilla","hummingbird","iron",
  "jaguar","koala","lobster","mammoth","nightowl","obelisk","platypus","quartz",
  "reindeer","salamander","tarantula","umbrella","vulture","wolverine","xerox",
  "yellowstone","zorro","anchor","breadstick","cockpit","dungeon","elevator",
  "frisbee","glider","hippo","inkwell","jukebox","kazoo","lemon","mango",
  "nunchucks","ostrich","panda","raccoon","stethoscope","tuba","ursa","velvet",
  "watermelon","xylophone","yarn","zucchini"
];

function pickWords(usedWords, n = 3) {
  const available = WORD_LIST.filter(w => !usedWords.has(w));
  const pool = available.length >= n ? available : WORD_LIST;
  const copy = [...pool].sort(() => Math.random() - 0.5);
  return copy.slice(0, n);
}

const rooms = new Map();

function makeRoom() {
  return {
    players: [],
    drawingIdx: 0,
    round: 1,
    word: null,
    phase: "lobby",
    timer: null,
    timerLeft: 0,
    strokes: [],
    wordChoices: [],
    guessedIds: new Set(),
    usedWords: new Set(),
    roundTime: DEFAULT_ROUND_TIME,
    roundsTotal: DEFAULT_ROUNDS_TOTAL,
    host: null,
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

function getHostName(room) {
  return room.players.find(p => p.id === room.host)?.name || null;
}

function startChoosing(room) {
  room.phase = "choosing";
  room.strokes = [];
  room.guessedIds = new Set();
  const drawer = room.players[room.drawingIdx];
  room.wordChoices = pickWords(room.usedWords);

  broadcast(room, { type: "phase", phase: "choosingWait", drawer: drawer.name }, drawer.id);
  send(drawer.ws, { type: "phase", phase: "choosing", drawer: drawer.name });
  send(drawer.ws, { type: "chooseWord", words: room.wordChoices });

  room.timer = setTimeout(() => {
    if (room.phase === "choosing") chooseWord(room, room.wordChoices[0]);
  }, 15000);
}

function chooseWord(room, word) {
  clearTimer(room);
  room.word = word;
  room.usedWords.add(word);
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
  broadcast(room, { type: "roundEnd", word: room.word, scores, allGuessed, round: room.round, roundsTotal: room.roundsTotal });
  setTimeout(() => nextTurn(room), 4000);
}

function nextTurn(room) {
  const total = room.players.length;
  room.drawingIdx++;
  if (room.drawingIdx >= total) { room.drawingIdx = 0; room.round++; }
  if (room.round > room.roundsTotal) {
    endGame(room);
  } else {
    broadcast(room, { type: "roundInfo", round: room.round, roundsTotal: room.roundsTotal });
    startChoosing(room);
  }
}

function endGame(room) {
  room.phase = "gameEnd";
  const scores = room.players.map(p => ({ name: p.name, score: p.score })).sort((a, b) => b.score - a.score);
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
    player.score += 100 + timeBonus;
    room.players[room.drawingIdx].score += 25;
    room.guessedIds.add(player.id);
    broadcast(room, { type: "correctGuess", name: player.name, score: player.score, drawerScore: room.players[room.drawingIdx].score });
    const guessers = room.players.filter(p => p.id !== room.players[room.drawingIdx].id);
    if (room.guessedIds.size >= guessers.length) endRound(room, true);
  } else {
    broadcast(room, { type: "chat", name: player.name, text, isGuess: true });
  }
}

function handleFill(room, player, data) {
  if (room.phase !== "drawing") return;
  if (player.id !== room.players[room.drawingIdx].id) return;
  room.strokes.push({ fill: true, x: data.x, y: data.y, c: data.c });
  broadcast(room, { type: "fill", data }, player.id);
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

      const isNewRoom = !rooms.has(roomId);
      if (!rooms.has(roomId)) rooms.set(roomId, makeRoom());
      const room = rooms.get(roomId);

      if (room.phase !== "lobby" && room.phase !== "gameEnd") {
        send(ws, { type: "error", text: "Game already in progress." }); return;
      }

      if (room.players.length === 0) room.host = playerId;
      const player = { ws, id: playerId, name, score: 0 };
      room.players.push(player);

      // Tell the joiner their own confirmation + full current player list
      send(ws, {
        type: "joined",
        id: playerId,
        name,
        roomId,
        players: room.players.map(p => p.name),
        isHost: room.host === playerId,
        isNewRoom,
        settings: { roundTime: room.roundTime, roundsTotal: room.roundsTotal },
        // FIX: include host name so client can render crown correctly
        host: getHostName(room),
      });

      // FIX: broadcast playerJoined to all OTHER players with updated list + host name
      broadcast(room, {
        type: "playerJoined",
        name,
        players: room.players.map(p => p.name),
        host: getHostName(room),
      }, playerId);
      return;
    }

    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;

    switch (msg.type) {
      case "updateSettings":
        if (room.host !== playerId) return;
        if (room.phase !== "lobby" && room.phase !== "gameEnd") return;
        if (msg.roundTime) room.roundTime = Math.max(20, Math.min(180, parseInt(msg.roundTime) || DEFAULT_ROUND_TIME));
        if (msg.roundsTotal) room.roundsTotal = Math.max(1, Math.min(10, parseInt(msg.roundsTotal) || DEFAULT_ROUNDS_TOTAL));
        broadcast(room, { type: "settingsUpdated", roundTime: room.roundTime, roundsTotal: room.roundsTotal });
        break;

      case "startGame":
        if (room.host !== playerId) { send(ws, { type: "error", text: "Only the host can start the game." }); return; }
        if (room.players.length < 2) { send(ws, { type: "error", text: "Need at least 2 players." }); return; }
        if (room.phase !== "lobby" && room.phase !== "gameEnd") return;
        room.round = 1; room.drawingIdx = 0; room.usedWords = new Set();
        room.players.forEach(p => p.score = 0);
        broadcast(room, { type: "gameStarting", players: room.players.map(p => p.name), roundsTotal: room.roundsTotal, roundTime: room.roundTime });
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

      case "fill":
        handleFill(room, player, msg.data);
        break;

      case "clearCanvas":
        if (player.id !== room.players[room.drawingIdx].id) return;
        room.strokes = [];
        broadcast(room, { type: "clearCanvas" }, playerId);
        break;

      case "undoCanvas":
        if (player.id !== room.players[room.drawingIdx].id) return;
        const lastDown = room.strokes.lastIndexOf(null);
        if (lastDown === -1) room.strokes = [];
        else room.strokes = room.strokes.slice(0, lastDown);
        broadcast(room, { type: "redrawStrokes", strokes: room.strokes }, playerId);
        break;

      case "mouseDown":
        if (player.id !== room.players[room.drawingIdx].id) return;
        if (room.phase !== "drawing") return;
        room.strokes.push(null);
        // FIX: relay mouseDown to guessers so their strokeHistory groups stay in sync
        broadcast(room, { type: "mouseDown" }, playerId);
        break;

      case "guess":
        handleGuess(room, player, msg.text);
        break;

      case "chat":
        broadcast(room, { type: "chat", name: player.name, text: msg.text });
        break;

      case "drawerChat":
        broadcast(room, { type: "chat", name: player.name, text: msg.text, isDrawer: true });
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

    if (room.host === playerId && room.players.length > 0) {
      room.host = room.players[0].id;
      send(room.players[0].ws, { type: "youAreHost" });
    }

    broadcast(room, {
      type: "playerLeft",
      name,
      players: room.players.map(p => p.name),
      host: getHostName(room),
    });

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