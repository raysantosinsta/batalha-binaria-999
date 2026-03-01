import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  const PORT = 3000;

  // Game states stored by room ID
  const rooms = new Map<string, any>();
  const timers = new Map<string, NodeJS.Timeout>();
  const roomSlots = new Map<string, Map<number, string>>(); // roomId -> (playerId -> socketId)
  const roomPrivateData = new Map<string, Map<number, any>>(); // roomId -> (playerId -> privateData)
  const roomAvailableNumbers = new Map<string, number[]>(); // roomId -> available numbers for Cooperative mode

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-room", (roomId: string) => {
      socket.join(roomId);
      console.log(`User ${socket.id} joined room ${roomId}`);
      
      if (rooms.has(roomId)) {
        socket.emit("game-state", rooms.get(roomId));
      }
      
      // Send current slot assignments
      const slots = roomSlots.get(roomId) || new Map();
      socket.emit("slot-assignments", Array.from(slots.entries()));
    });

    socket.on("claim-slot", ({ roomId, playerId }: { roomId: string; playerId: number }) => {
      if (!roomSlots.has(roomId)) roomSlots.set(roomId, new Map());
      const slots = roomSlots.get(roomId)!;
      
      // Check if slot is taken
      if (slots.has(playerId) && slots.get(playerId) !== socket.id) {
        socket.emit("error", "Slot already taken");
        return;
      }
      
      // Remove socket from other slots in this room
      for (const [id, sid] of slots.entries()) {
        if (sid === socket.id) slots.delete(id);
      }
      
      slots.set(playerId, socket.id);
      io.to(roomId).emit("slot-assignments", Array.from(slots.entries()));
      
      // If game is already running and has private data for this player, send it
      if (roomPrivateData.has(roomId)) {
        const privateData = roomPrivateData.get(roomId)!.get(playerId);
        if (privateData) {
          socket.emit("private-data", privateData);
        }
      }
    });

    socket.on("start-game", ({ roomId, mode, numPlayers, bits }: { roomId: string; mode: number; numPlayers: number; bits: number }) => {
      const maxVal = Math.pow(2, bits) - 1;
      const privateDataMap = new Map<number, any>();
      const players = [];

      for (let i = 1; i <= numPlayers; i++) {
        if (mode === 1) { // Competitive
          const targetDecimal = Math.floor(Math.random() * maxVal) + 1;
          const targetBinary = targetDecimal.toString(2).padStart(bits, '0');
          privateDataMap.set(i, { targetDecimal, targetBinary });
        }
        players.push({ id: i, name: `Jogador ${i}`, score: 0 });
      }

      if (mode === 1) {
        roomPrivateData.set(roomId, privateDataMap);
      } else {
        roomPrivateData.delete(roomId); // Clear any old data for cooperative
        roomAvailableNumbers.delete(roomId); // Clear any old pool
      }

      const initialState = {
        mode,
        status: "playing",
        board: Array(bits).fill(null).map(() => ({ value: null, ownerId: null })),
        currentPlayerIndex: 0,
        drawnBit: null,
        players,
        winner: null,
        lastDraw: null,
        winClaimTimerActive: false,
        winClaimTimeLeft: 0
      };

      rooms.set(roomId, initialState);
      io.to(roomId).emit("game-state", initialState);

      // Send private data to each socket assigned to a slot (only for competitive)
      if (mode === 1) {
        const slots = roomSlots.get(roomId);
        if (slots) {
          for (const [playerId, socketId] of slots.entries()) {
            const data = privateDataMap.get(playerId);
            if (data) {
              io.to(socketId).emit("private-data", data);
            }
          }
        }
      }
    });

    socket.on("draw-decimal-card", ({ roomId, playerId }: { roomId: string; playerId: number }) => {
      const state = rooms.get(roomId);
      if (!state || state.mode !== 2) return;

      const bits = state.board.length;
      const boardBinary = state.board.map((c: any) => c.value ?? 0).join('');
      const boardDecimal = parseInt(boardBinary, 2);

      let pool = roomAvailableNumbers.get(roomId);
      if (!pool) {
        // Initialize pool from 0 to boardDecimal
        pool = [];
        for (let i = 0; i <= boardDecimal; i++) {
          pool.push(i);
        }
      }

      if (pool.length === 0) return;

      const randomIndex = Math.floor(Math.random() * pool.length);
      const targetDecimal = pool[randomIndex];
      pool.splice(randomIndex, 1);
      roomAvailableNumbers.set(roomId, pool);

      const targetBinary = targetDecimal.toString(2).padStart(bits, '0');
      const isWin = targetDecimal === boardDecimal;

      // Store as private data for this player
      if (!roomPrivateData.has(roomId)) roomPrivateData.set(roomId, new Map());
      roomPrivateData.get(roomId)!.set(playerId, { targetDecimal, targetBinary });

      let nextState;
      if (isWin) {
        nextState = {
          ...state,
          status: "finished",
          winner: state.players[state.currentPlayerIndex],
          targetDecimalMode2: targetDecimal,
          lastDraw: { playerId, value: targetDecimal, match: true },
          winClaimTimerActive: false,
          winClaimTimeLeft: 0
        };
      } else {
        // No match, advance turn
        nextState = {
          ...state,
          currentPlayerIndex: (state.currentPlayerIndex + 1) % state.players.length,
          drawnBit: null,
          lastDraw: { playerId, value: targetDecimal, match: false },
          winClaimTimerActive: false,
          winClaimTimeLeft: 0
        };
      }

      rooms.set(roomId, nextState);
      io.to(roomId).emit("game-state", nextState);

      // Send the card only to the player who drew it
      socket.emit("private-data", { targetDecimal, targetBinary });
    });

    socket.on("update-game-state", ({ roomId, state }: { roomId: string; state: any }) => {
      rooms.set(roomId, state);
      
      // If game is reset to SETUP, clear slots and private data
      if (state.status === 'setup') {
        roomSlots.delete(roomId);
        roomPrivateData.delete(roomId);
        roomAvailableNumbers.delete(roomId);
        io.to(roomId).emit("slot-assignments", []);
      }

      // Handle timer logic on server
      if (state.winClaimTimerActive && !timers.has(roomId)) {
        const timer = setInterval(() => {
          const currentState = rooms.get(roomId);
          if (!currentState || !currentState.winClaimTimerActive) {
            clearInterval(timer);
            timers.delete(roomId);
            return;
          }

          if (currentState.winClaimTimeLeft <= 0.1) {
            clearInterval(timer);
            timers.delete(roomId);
            
            // Advance turn automatically
            const nextState = {
              ...currentState,
              winClaimTimerActive: false,
              winClaimTimeLeft: 0,
              currentPlayerIndex: (currentState.currentPlayerIndex + 1) % currentState.players.length,
              drawnBit: null
            };
            rooms.set(roomId, nextState);
            io.to(roomId).emit("game-state", nextState);
          } else {
            const nextState = {
              ...currentState,
              winClaimTimeLeft: currentState.winClaimTimeLeft - 0.1
            };
            rooms.set(roomId, nextState);
          }
        }, 100);
        timers.set(roomId, timer);
      } else if (!state.winClaimTimerActive && timers.has(roomId)) {
        clearInterval(timers.get(roomId));
        timers.delete(roomId);
      }

      socket.to(roomId).emit("game-state", state);
    });

    socket.on("skip-turn", ({ roomId }: { roomId: string }) => {
      const state = rooms.get(roomId);
      if (!state) return;

      const nextState = {
        ...state,
        winClaimTimerActive: false,
        winClaimTimeLeft: 0,
        currentPlayerIndex: (state.currentPlayerIndex + 1) % state.players.length,
        drawnBit: null
      };
      rooms.set(roomId, nextState);
      io.to(roomId).emit("game-state", nextState);
      
      if (timers.has(roomId)) {
        clearInterval(timers.get(roomId));
        timers.delete(roomId);
      }
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      // Clean up slots
      for (const [roomId, slots] of roomSlots.entries()) {
        for (const [playerId, socketId] of slots.entries()) {
          if (socketId === socket.id) {
            slots.delete(playerId);
            io.to(roomId).emit("slot-assignments", Array.from(slots.entries()));
          }
        }
      }
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
