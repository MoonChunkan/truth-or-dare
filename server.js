const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingInterval: 25000,
    pingTimeout: 60000
});

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests'
});

const createRoomLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: 'Too many rooms created'
});

app.use(limiter);

// ===== ROOM STORAGE =====
const rooms = new Map();
const playerSockets = new Map(); // Track which player is in which room

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function sanitizeName(name) {
    return String(name).trim().replace(/[^a-zA-Z0-9 -]/g, '').substring(0, 20);
}

// ===== ROUTES =====

// Serve index.html for root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create Room
app.post('/api/rooms/create', createRoomLimiter, (req, res) => {
    try {
        const playerName = sanitizeName(req.body.playerName || 'Player');
        let roomCode = generateRoomCode();
        
        while (rooms.has(roomCode)) {
            roomCode = generateRoomCode();
        }

        rooms.set(roomCode, {
            code: roomCode,
            players: [{ name: playerName, id: Math.random().toString(36) }],
            scores: { [playerName]: 0 },
            currentPlayerIndex: 0,
            round: 1,
            isPlaying: false,
            selectedDifficulties: { easy: true, medium: true, hard: true, intimate: true },
            createdAt: Date.now(),
            lastActivity: Date.now()
        });

        res.json({
            success: true,
            roomCode: roomCode,
            message: 'Room created'
        });
    } catch (error) {
        console.error('Create room error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Join Room
app.post('/api/rooms/join', (req, res) => {
    try {
        const roomCode = String(req.body.roomCode || '').toUpperCase().trim();
        const playerName = sanitizeName(req.body.playerName || 'Player');

        if (!roomCode || roomCode.length !== 6) {
            return res.status(400).json({ success: false, error: 'Invalid room code' });
        }

        if (!rooms.has(roomCode)) {
            return res.status(404).json({ success: false, error: 'Room not found' });
        }

        const room = rooms.get(roomCode);
        
        // Check if player already exists
        const existingPlayer = room.players.find(p => p.name === playerName);
        if (!existingPlayer) {
            room.players.push({ name: playerName, id: Math.random().toString(36) });
            room.scores[playerName] = 0;
        }
        
        room.lastActivity = Date.now();

        res.json({
            success: true,
            roomCode: roomCode,
            room: {
                code: roomCode,
                players: room.players.map(p => p.name),
                scores: room.scores,
                currentPlayerIndex: room.currentPlayerIndex,
                round: room.round,
                isPlaying: room.isPlaying,
                selectedDifficulties: room.selectedDifficulties
            }
        });
    } catch (error) {
        console.error('Join room error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get Room Info
app.get('/api/rooms/:code', (req, res) => {
    try {
        const roomCode = String(req.params.code || '').toUpperCase().trim();

        if (!rooms.has(roomCode)) {
            return res.status(404).json({ success: false, error: 'Room not found' });
        }

        const room = rooms.get(roomCode);
        room.lastActivity = Date.now();

        res.json({
            success: true,
            room: {
                code: roomCode,
                players: room.players.map(p => p.name),
                scores: room.scores,
                currentPlayerIndex: room.currentPlayerIndex,
                round: room.round,
                isPlaying: room.isPlaying,
                selectedDifficulties: room.selectedDifficulties
            }
        });
    } catch (error) {
        console.error('Get room error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health Check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeRooms: rooms.size
    });
});

// ===== SOCKET.IO EVENTS =====

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('joinRoom', (data) => {
        const { roomCode, playerName } = data;
        
        if (!roomCode || !playerName) {
            socket.emit('error', 'Invalid room or player name');
            return;
        }

        if (!rooms.has(roomCode)) {
            socket.emit('error', 'Room not found');
            return;
        }

        const room = rooms.get(roomCode);
        
        // Add player if not already there
        const existingPlayer = room.players.find(p => p.name === playerName);
        if (!existingPlayer) {
            room.players.push({ name: playerName, id: socket.id });
            room.scores[playerName] = 0;
        }

        socket.join(roomCode);
        playerSockets.set(socket.id, { roomCode, playerName });
        room.lastActivity = Date.now();

        // Notify everyone in room
        io.to(roomCode).emit('playerJoined', {
            players: room.players.map(p => p.name),
            scores: room.scores,
            currentPlayerIndex: room.currentPlayerIndex,
            round: room.round
        });

        console.log(`${playerName} joined room ${roomCode}`);
    });

    socket.on('updateDifficulties', (data) => {
        const { roomCode, selectedDifficulties } = data;
        
        if (rooms.has(roomCode)) {
            rooms.get(roomCode).selectedDifficulties = selectedDifficulties;
            io.to(roomCode).emit('difficultiesUpdated', selectedDifficulties);
        }
    });

    socket.on('startGame', (data) => {
        const { roomCode } = data;
        
        if (!rooms.has(roomCode)) return;
        
        const room = rooms.get(roomCode);
        room.isPlaying = true;
        room.currentPlayerIndex = 0;
        room.round = 1;
        room.lastActivity = Date.now();

        io.to(roomCode).emit('gameStarted', {
            players: room.players.map(p => p.name),
            currentPlayerIndex: room.currentPlayerIndex,
            round: room.round,
            selectedDifficulties: room.selectedDifficulties
        });

        console.log(`Game started in room ${roomCode}`);
    });

    socket.on('completeChallenge', (data) => {
        const { roomCode, playerName, points } = data;
        
        if (!rooms.has(roomCode)) return;
        
        const room = rooms.get(roomCode);
        room.scores[playerName] = (room.scores[playerName] || 0) + points;
        room.lastActivity = Date.now();

        io.to(roomCode).emit('scoreUpdated', {
            scores: room.scores
        });

        // Move to next player
        nextPlayerInRoom(roomCode);
    });

    socket.on('skipChallenge', (data) => {
        const { roomCode } = data;
        
        if (!rooms.has(roomCode)) return;
        
        const room = rooms.get(roomCode);
        room.lastActivity = Date.now();

        // Move to next player
        nextPlayerInRoom(roomCode);
    });

    socket.on('leaveRoom', (data) => {
        const { roomCode, playerName } = data;
        
        if (rooms.has(roomCode)) {
            const room = rooms.get(roomCode);
            room.players = room.players.filter(p => p.name !== playerName);
            delete room.scores[playerName];
            
            if (room.players.length === 0) {
                rooms.delete(roomCode);
                console.log(`Room ${roomCode} deleted (empty)`);
            } else {
                room.lastActivity = Date.now();
                io.to(roomCode).emit('playerLeft', {
                    players: room.players.map(p => p.name),
                    scores: room.scores
                });
            }
        }
        
        playerSockets.delete(socket.id);
        socket.leave(roomCode);
    });

    socket.on('disconnect', () => {
        const info = playerSockets.get(socket.id);
        if (info) {
            const { roomCode, playerName } = info;
            
            if (rooms.has(roomCode)) {
                const room = rooms.get(roomCode);
                room.players = room.players.filter(p => p.name !== playerName);
                delete room.scores[playerName];
                
                if (room.players.length === 0) {
                    rooms.delete(roomCode);
                } else {
                    io.to(roomCode).emit('playerLeft', {
                        players: room.players.map(p => p.name),
                        scores: room.scores
                    });
                }
            }
            
            playerSockets.delete(socket.id);
        }
        console.log('User disconnected:', socket.id);
    });
});

function nextPlayerInRoom(roomCode) {
    if (!rooms.has(roomCode)) return;
    
    const room = rooms.get(roomCode);
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
    
    if (room.currentPlayerIndex === 0) {
        room.round++;
    }

    io.to(roomCode).emit('nextPlayer', {
        currentPlayerIndex: room.currentPlayerIndex,
        round: room.round,
        currentPlayer: room.players[room.currentPlayerIndex].name
    });
}

// ===== CLEANUP =====
setInterval(() => {
    const now = Date.now();
    const inactivityTimeout = 60 * 60 * 1000; // 1 hour

    for (const [code, room] of rooms) {
        if (now - room.lastActivity > inactivityTimeout) {
            rooms.delete(code);
            console.log(`Cleaned up inactive room: ${code}`);
        }
    }
}, 10 * 60 * 1000);

// ===== ERROR HANDLING =====
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
});

app.use((req, res) => {
    if (!req.path.startsWith('/api/')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        res.status(404).json({ success: false, error: 'Not found' });
    }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 Open: http://localhost:${PORT}`);
    console.log(`🎮 Serving from: ${path.join(__dirname, 'public')}`);
});
