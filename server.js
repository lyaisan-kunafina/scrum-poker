const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Any /room/:id URL should also serve the SPA shell
app.get('/room/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * In-memory room storage.
 * rooms: Map<roomId, {
 *   hostSocketId: string | null,
 *   participants: Map<socketId, { name: string, vote: number | 'coffee' | null }>,
 *   revealed: boolean,
 *   createdAt: number
 * }>
 */
const rooms = new Map();

function generateRoomId() {
  return crypto.randomBytes(3).toString('hex'); // short 6-char code
}

function getPublicRoomState(room) {
  const participants = Array.from(room.participants.entries()).map(([id, p]) => {
    const entry = {
      id,
      name: p.name,
      hasVoted: p.vote !== null
    };
    if (room.revealed) {
      entry.vote = p.vote;
    }
    return entry;
  });

  return {
    revealed: room.revealed,
    participants,
    voteCount: participants.filter((p) => p.hasVoted).length,
    totalCount: participants.length
  };
}

function broadcastRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('room:update', getPublicRoomState(room));
}

function cleanupEmptyRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const hostGone = !room.hostSocketId || !io.sockets.sockets.get(room.hostSocketId);
  if (room.participants.size === 0 && hostGone) {
    rooms.delete(roomId);
  }
}

io.on('connection', (socket) => {
  // Host creates a new room
  socket.on('room:create', (callback) => {
    let roomId = generateRoomId();
    while (rooms.has(roomId)) roomId = generateRoomId();

    rooms.set(roomId, {
      hostSocketId: null,
      participants: new Map(),
      revealed: false,
      createdAt: Date.now()
    });

    callback({ roomId });
  });

  // Host attaches itself to an existing room as the moderator (does not vote)
  socket.on('room:host-join', ({ roomId }, callback) => {
    const room = rooms.get(roomId);
    if (!room) {
      callback({ error: 'Комната не найдена' });
      return;
    }
    room.hostSocketId = socket.id;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.isHost = true;

    callback({ success: true, state: getPublicRoomState(room) });
    broadcastRoom(roomId);
  });

  // Team member joins with a name
  socket.on('room:join', ({ roomId, name }, callback) => {
    const room = rooms.get(roomId);
    if (!room) {
      callback({ error: 'Комната не найдена' });
      return;
    }
    const cleanName = String(name || '').trim().slice(0, 40);
    if (!cleanName) {
      callback({ error: 'Введите имя' });
      return;
    }

    room.participants.set(socket.id, { name: cleanName, vote: null });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.isHost = false;

    callback({ success: true, state: getPublicRoomState(room) });
    broadcastRoom(roomId);
  });

  // Cast or change a vote
  socket.on('vote:cast', ({ value }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || socket.data.isHost) return;

    const participant = room.participants.get(socket.id);
    if (!participant) return;

    if (room.revealed) return; // cannot vote after reveal until cleared

    if (value === 'coffee') {
      participant.vote = 'coffee';
    } else {
      const num = parseInt(value, 10);
      if (Number.isNaN(num) || num < 1 || num > 50) return;
      participant.vote = num;
    }

    broadcastRoom(roomId);
  });

  // Host reveals all votes
  socket.on('room:reveal', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.hostSocketId !== socket.id) return;

    room.revealed = true;
    broadcastRoom(roomId);
  });

  // Host clears votes to start a new round
  socket.on('room:clear', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.hostSocketId !== socket.id) return;

    room.revealed = false;
    for (const p of room.participants.values()) {
      p.vote = null;
    }
    broadcastRoom(roomId);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (socket.data.isHost && room.hostSocketId === socket.id) {
      room.hostSocketId = null;
    } else {
      room.participants.delete(socket.id);
    }

    broadcastRoom(roomId);
    cleanupEmptyRoom(roomId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Scrum Poker server running at http://localhost:${PORT}`);
});
