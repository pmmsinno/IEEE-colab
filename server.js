const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 10000,
  pingTimeout: 5000,
});

app.use(express.static(path.join(__dirname, "public")));

// ─── Game State ──────────────────────────────────────────────
const game = {
  phase: "lobby", // lobby | countdown | playing | roundEnd | gameOver
  light: "red", // red | green
  players: new Map(), // socketId -> player object
  round: 0,
  lightTimer: null,
  graceTimer: null,
  countdownTimer: null,
  greenDuration: { min: 1500, max: 5000 },
  redDuration: { min: 2000, max: 4000 },
  gracePeriodMs: 350, // ms after red light before checking
  progressToWin: 100, // progress points to finish
  progressRate: 2.5, // progress per 100ms while holding during green
  eliminationPending: false,
};

function createPlayer(id, name) {
  return {
    id,
    name: name.substring(0, 15),
    progress: 0,
    alive: true,
    holding: false,
    eliminated: false,
    finishedAt: null,
  };
}

function getPlayersArray() {
  return Array.from(game.players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    progress: p.progress,
    alive: p.alive,
    holding: p.holding,
    finishedAt: p.finishedAt,
  }));
}

function getAlivePlayers() {
  return Array.from(game.players.values()).filter((p) => p.alive);
}

function broadcastGameState() {
  io.to("tv").emit("gameState", {
    phase: game.phase,
    light: game.light,
    players: getPlayersArray(),
    round: game.round,
  });
}

function broadcastToPhones() {
  game.players.forEach((player) => {
    io.to(player.id).emit("playerState", {
      phase: game.phase,
      light: game.light,
      progress: player.progress,
      alive: player.alive,
      holding: player.holding,
    });
  });
}

function broadcastAll() {
  broadcastGameState();
  broadcastToPhones();
}

// ─── Progress accumulation interval ─────────────────────────
let progressInterval = null;

function startProgressTracking() {
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = setInterval(() => {
    if (game.phase !== "playing" || game.light !== "green") return;

    let someoneFinished = false;
    game.players.forEach((player) => {
      if (player.alive && player.holding && !player.finishedAt) {
        player.progress = Math.min(
          game.progressToWin,
          player.progress + game.progressRate
        );
        if (player.progress >= game.progressToWin) {
          player.finishedAt = Date.now();
          someoneFinished = true;
        }
      }
    });

    broadcastAll();

    if (someoneFinished) {
      checkForWinner();
    }
  }, 100);
}

function stopProgressTracking() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
}

// ─── Light Switching Logic ───────────────────────────────────
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function switchToGreen() {
  if (game.phase !== "playing") return;
  game.light = "green";
  game.eliminationPending = false;
  broadcastAll();

  const duration = randomBetween(
    game.greenDuration.min,
    game.greenDuration.max
  );
  game.lightTimer = setTimeout(() => {
    switchToRed();
  }, duration);
}

function switchToRed() {
  if (game.phase !== "playing") return;
  game.light = "red";
  game.eliminationPending = true;
  broadcastAll();

  // Grace period before checking who's still holding
  game.graceTimer = setTimeout(() => {
    eliminateHolders();
  }, game.gracePeriodMs);
}

function eliminateHolders() {
  if (game.phase !== "playing" || game.light !== "red") return;

  const eliminated = [];
  game.players.forEach((player) => {
    if (player.alive && player.holding) {
      player.alive = false;
      player.eliminated = true;
      eliminated.push({ id: player.id, name: player.name });
    }
  });

  if (eliminated.length > 0) {
    io.to("tv").emit("eliminations", eliminated);
    eliminated.forEach((e) => {
      io.to(e.id).emit("eliminated");
    });
  }

  broadcastAll();

  // Check if game should end
  const alive = getAlivePlayers();
  if (alive.length === 0) {
    endGame(null);
    return;
  }
  if (alive.length === 1) {
    endGame(alive[0]);
    return;
  }

  // Schedule next green light
  const duration = randomBetween(game.redDuration.min, game.redDuration.max);
  game.lightTimer = setTimeout(() => {
    switchToGreen();
  }, duration);
}

function checkForWinner() {
  const finishers = Array.from(game.players.values()).filter(
    (p) => p.finishedAt
  );
  if (finishers.length > 0) {
    finishers.sort((a, b) => a.finishedAt - b.finishedAt);
    endGame(finishers[0]);
  }
}

function endGame(winner) {
  game.phase = "gameOver";
  clearTimeout(game.lightTimer);
  clearTimeout(game.graceTimer);
  stopProgressTracking();
  game.light = "red";

  io.to("tv").emit("gameOver", {
    winner: winner ? { id: winner.id, name: winner.name } : null,
    players: getPlayersArray(),
  });

  broadcastToPhones();
}

function startGame() {
  if (game.players.size < 1) return; // need at least 1 player

  game.phase = "countdown";
  game.round++;
  game.light = "red";
  broadcastAll();

  let count = 3;
  io.to("tv").emit("countdown", count);
  game.players.forEach((p) => io.to(p.id).emit("countdown", count));

  game.countdownTimer = setInterval(() => {
    count--;
    if (count > 0) {
      io.to("tv").emit("countdown", count);
      game.players.forEach((p) => io.to(p.id).emit("countdown", count));
    } else {
      clearInterval(game.countdownTimer);
      game.phase = "playing";
      startProgressTracking();
      switchToGreen();
    }
  }, 1000);
}

function resetGame() {
  game.phase = "lobby";
  game.light = "red";
  game.round = 0;
  clearTimeout(game.lightTimer);
  clearTimeout(game.graceTimer);
  clearInterval(game.countdownTimer);
  stopProgressTracking();

  game.players.forEach((player) => {
    player.progress = 0;
    player.alive = true;
    player.holding = false;
    player.eliminated = false;
    player.finishedAt = null;
  });

  broadcastAll();
}

// ─── QR Code endpoint ────────────────────────────────────────
app.get("/qr", async (req, res) => {
  try {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const url = `${protocol}://${host}/phone.html`;
    const qr = await QRCode.toDataURL(url, {
      width: 400,
      margin: 2,
      color: { dark: "#1a1a2e", light: "#ffffff" },
    });
    res.json({ qr, url });
  } catch (err) {
    res.status(500).json({ error: "QR generation failed" });
  }
});

// ─── Socket.io Connections ───────────────────────────────────
io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  // TV joins
  socket.on("joinTV", () => {
    socket.join("tv");
    broadcastGameState();
  });

  // Player joins
  socket.on("joinGame", (name) => {
    if (game.phase !== "lobby") {
      socket.emit("joinError", "Game already in progress. Wait for next round!");
      return;
    }
    if (!name || name.trim().length === 0) {
      socket.emit("joinError", "Please enter a name!");
      return;
    }
    const player = createPlayer(socket.id, name.trim());
    game.players.set(socket.id, player);

    socket.emit("joined", { id: player.id, name: player.name });
    io.to("tv").emit("playerJoined", { id: player.id, name: player.name });
    broadcastGameState();
    console.log(`Player joined: ${player.name} (${socket.id})`);
  });

  // Player touch/hold events
  socket.on("holdStart", () => {
    const player = game.players.get(socket.id);
    if (!player || !player.alive || game.phase !== "playing") return;
    player.holding = true;

    // If they start holding during red (after grace period), eliminate immediately
    if (game.light === "red" && !game.eliminationPending) {
      player.alive = false;
      player.eliminated = true;
      io.to("tv").emit("eliminations", [
        { id: player.id, name: player.name },
      ]);
      socket.emit("eliminated");
      broadcastAll();
    }
  });

  socket.on("holdEnd", () => {
    const player = game.players.get(socket.id);
    if (!player) return;
    player.holding = false;
  });

  // TV controls
  socket.on("startGame", () => {
    if (game.phase === "lobby" || game.phase === "gameOver") {
      // Reset player states for new game
      game.players.forEach((player) => {
        player.progress = 0;
        player.alive = true;
        player.holding = false;
        player.eliminated = false;
        player.finishedAt = null;
      });
      startGame();
    }
  });

  socket.on("resetGame", () => {
    resetGame();
  });

  socket.on("kickPlayer", (playerId) => {
    game.players.delete(playerId);
    io.to(playerId).emit("kicked");
    broadcastGameState();
  });

  // Disconnect
  socket.on("disconnect", () => {
    const player = game.players.get(socket.id);
    if (player) {
      console.log(`Player disconnected: ${player.name}`);
      if (game.phase === "lobby") {
        game.players.delete(socket.id);
      } else {
        player.alive = false;
        player.holding = false;
      }
      broadcastAll();
    }
  });
});

// ─── Start Server ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🔴🟢 Red Light Green Light server running on port ${PORT}`);
  console.log(`   TV view:    http://localhost:${PORT}/tv.html`);
  console.log(`   Player view: http://localhost:${PORT}/phone.html`);
});
