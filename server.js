const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs');

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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// Load challenges
let challengeDB = null;
try {
    const dbPath = path.join(__dirname, 'challengeDB.json');
    challengeDB = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
} catch (err) {
    console.error('Failed to load challengeDB.json:', err.message);
    challengeDB = {
        truth: { easy: [], medium: [], hard: [], intimate: [], drinking: [] },
        dare: { easy: [], medium: [], hard: [], intimate: [], drinking: [] },
        wildcards: []
    };
}

// Room Storage
const rooms = new Map();
const playerSockets = new Map();

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

// Routes

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/rooms/create', createRoomLimiter, (req, res) => {
    try {
        const playerName = sanitizeName(req.body.playerName || 'Host');
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
            totalRounds: 5,
            isPlaying: false,
            selectedDifficulties: { easy: true, medium: true, hard: true, intimate: true, drinking: true },
            includeWildcards: false,
            currentChallenge: null,
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
                totalRounds: room.totalRounds,
                isPlaying: room.isPlaying,
                selectedDifficulties: room.selectedDifficulties,
                includeWildcards: room.includeWildcards,
                currentChallenge: room.currentChallenge
            }
        });
    } catch (error) {
        console.error('Join room error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

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
                totalRounds: room.totalRounds,
                isPlaying: room.isPlaying,
                selectedDifficulties: room.selectedDifficulties,
                includeWildcards: room.includeWildcards,
                currentChallenge: room.currentChallenge
            }
        });
    } catch (error) {
        console.error('Get room error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeRooms: rooms.size
    });
});

// Socket.io

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
        
        const existingPlayer = room.players.find(p => p.name === playerName);
        if (!existingPlayer) {
            room.players.push({ name: playerName, id: socket.id });
            room.scores[playerName] = 0;
        }

        socket.join(roomCode);
        playerSockets.set(socket.id, { roomCode, playerName });
        room.lastActivity = Date.now();

        io.to(roomCode).emit('playerJoined', {
            players: room.players.map(p => p.name),
            scores: room.scores,
            currentPlayerIndex: room.currentPlayerIndex,
            round: room.round,
            totalRounds: room.totalRounds
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

    socket.on('setRounds', (data) => {
        const { roomCode, totalRounds } = data;
        
        if (rooms.has(roomCode)) {
            rooms.get(roomCode).totalRounds = totalRounds;
            io.to(roomCode).emit('roundsUpdated', { totalRounds });
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
            totalRounds: room.totalRounds,
            selectedDifficulties: room.selectedDifficulties
        });

        console.log(`Game started in room ${roomCode}`);
    });

    socket.on('getChallenge', (data) => {
        const { roomCode } = data;
        
        if (!rooms.has(roomCode)) return;
        
        const room = rooms.get(roomCode);
        const challenge = generateChallenge(room.selectedDifficulties, room.includeWildcards);
        room.currentChallenge = challenge;
        room.lastActivity = Date.now();

        io.to(roomCode).emit('challengeGenerated', {
            challenge: challenge,
            currentPlayer: room.players[room.currentPlayerIndex].name,
            currentPlayerIndex: room.currentPlayerIndex,
            round: room.round,
            totalRounds: room.totalRounds
        });
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

        nextPlayerInRoom(roomCode);
    });

    socket.on('skipChallenge', (data) => {
        const { roomCode } = data;
        
        if (!rooms.has(roomCode)) return;
        
        const room = rooms.get(roomCode);
        room.lastActivity = Date.now();

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

    if (room.round > room.totalRounds) {
        io.to(roomCode).emit('gameEnded', {
            scores: room.scores,
            players: room.players.map(p => p.name)
        });
    } else {
        io.to(roomCode).emit('nextPlayer', {
            currentPlayerIndex: room.currentPlayerIndex,
            round: room.round,
            totalRounds: room.totalRounds,
            currentPlayer: room.players[room.currentPlayerIndex].name
        });
    }
}

function generateChallenge(selectedDifficulties, includeWildcards) {
    // 10% chance of wildcard if enabled
    if (includeWildcards && Math.random() < 0.1 && challengeDB.wildcards && challengeDB.wildcards.length > 0) {
        const wildcard = challengeDB.wildcards[Math.floor(Math.random() * challengeDB.wildcards.length)];
        return {
            ...wildcard,
            isWildcard: true
        };
    }

    const difficulties = Object.keys(selectedDifficulties)
        .filter(d => selectedDifficulties[d] && d !== 'wildcards');
    
    if (difficulties.length === 0) {
        difficulties.push('easy');
    }

    const randomDifficulty = difficulties[Math.floor(Math.random() * difficulties.length)];
    const isTruth = Math.random() > 0.5;
    
    const categoryList = isTruth 
        ? (challengeDB.truth?.[randomDifficulty] || []) 
        : (challengeDB.dare?.[randomDifficulty] || []);
    
    if (!categoryList || categoryList.length === 0) {
        return { 
            text: "Default challenge", 
            emoji: "🎭", 
            type: isTruth ? "Truth" : "Dare", 
            difficulty: randomDifficulty 
        };
    }
    
    const challenge = categoryList[Math.floor(Math.random() * categoryList.length)];

    return {
        ...challenge,
        type: isTruth ? 'Truth' : 'Dare',
        difficulty: randomDifficulty
    };
}

// Cleanup
setInterval(() => {
    const now = Date.now();
    const inactivityTimeout = 60 * 60 * 1000;

    for (const [code, room] of rooms) {
        if (now - room.lastActivity > inactivityTimeout) {
            rooms.delete(code);
            console.log(`Cleaned up inactive room: ${code}`);
        }
    }
}, 10 * 60 * 1000);

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 Open: http://localhost:${PORT}`);
    console.log(`🎮 Serving from: ${path.join(__dirname, 'public')}`);
    console.log(`📦 Challenges loaded: ${Object.keys(challengeDB.truth?.easy || []).length} easy, ${Object.keys(challengeDB.dare?.hard || []).length} hard+`);
});
