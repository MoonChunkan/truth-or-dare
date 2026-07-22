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
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingInterval: 25000,
    pingTimeout: 60000
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
const createRoomLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });

app.use(limiter);

// Load data
let challengeDB = {};
let wordList = [];

try {
    challengeDB = JSON.parse(fs.readFileSync(path.join(__dirname, 'challengeDB.json'), 'utf8'));
} catch (err) {
    console.error('Failed to load challengeDB.json:', err.message);
    challengeDB = { truth: {}, dare: {}, wildcards: [] };
}

try {
    wordList = JSON.parse(fs.readFileSync(path.join(__dirname, 'wordlist.json'), 'utf8')).words || [];
} catch (err) {
    console.error('Failed to load wordlist.json:', err.message);
    wordList = [];
}

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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/rooms/create', createRoomLimiter, (req, res) => {
    try {
        const playerName = sanitizeName(req.body.playerName || 'Host');
        let roomCode = generateRoomCode();
        while (rooms.has(roomCode)) roomCode = generateRoomCode();

        rooms.set(roomCode, {
            code: roomCode,
            players: [{ name: playerName, id: Math.random().toString(36) }],
            scores: { [playerName]: 0 },
            gameMode: 'menu',
            currentPlayerIndex: 0,
            currentAnsweringPlayerName: playerName,
            round: 1,
            isPlaying: false,
            // Advanced ToD Settings
            todSettings: {
                categories: ['easy', 'medium', 'hard'],
                totalRounds: 5
            },
            todVotes: { passes: 0, fails: 0, votedPlayers: [] },
            tiedPlayers: [],
            isTieBreaker: false,
            currentChallenge: null,
            createdAt: Date.now(),
            lastActivity: Date.now()
        });

        res.json({ success: true, roomCode: roomCode });
    } catch (error) {
        console.error('Create room error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/rooms/join', (req, res) => {
    try {
        const roomCode = String(req.body.roomCode || '').toUpperCase().trim();
        const playerName = sanitizeName(req.body.playerName || 'Player');

        if (!roomCode || roomCode.length !== 6 || !rooms.has(roomCode)) {
            return res.status(404).json({ success: false, error: 'Room not found' });
        }

        const room = rooms.get(roomCode);
        if (!room.players.find(p => p.name === playerName)) {
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
                gameMode: room.gameMode,
                todSettings: room.todSettings
            }
        });
    } catch (error) {
        console.error('Join room error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Socket.io Events
io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        const { roomCode, playerName } = data;
        if (!roomCode || !playerName || !rooms.has(roomCode)) return;

        const room = rooms.get(roomCode);
        socket.join(roomCode);
        playerSockets.set(socket.id, { roomCode, playerName });
        room.lastActivity = Date.now();

        io.to(roomCode).emit('playerJoined', {
            players: room.players.map(p => p.name),
            scores: room.scores,
            gameMode: room.gameMode,
            todSettings: room.todSettings
        });
    });

    socket.on('updateTodSettings', (data) => {
        const { roomCode, categories, totalRounds } = data;
        if (!rooms.has(roomCode)) return;
        const room = rooms.get(roomCode);
        room.todSettings.categories = categories;
        room.todSettings.totalRounds = totalRounds;
        io.to(roomCode).emit('todSettingsUpdated', room.todSettings);
    });

    socket.on('selectGameMode', (data) => {
        const { roomCode, gameMode } = data;
        if (!rooms.has(roomCode)) return;

        const room = rooms.get(roomCode);
        room.gameMode = gameMode;
        room.isPlaying = true;
        room.currentPlayerIndex = 0;
        room.round = 1;
        room.isTieBreaker = false;
        room.tiedPlayers = [];
        
        // Reset scores
        room.players.forEach(p => room.scores[p.name] = 0);
        room.lastActivity = Date.now();

        io.to(roomCode).emit('gameModeSelected', {
            gameMode: gameMode,
            players: room.players.map(p => p.name),
            scores: room.scores
        });

        if (gameMode === 'truthordare') {
            getChallenge(roomCode);
        } else if (gameMode === 'higherlower') {
            generateCard(roomCode);
        }
    });

    socket.on('judgeChallenge', (data) => {
        const { roomCode, playerName, passed } = data;
        if (!rooms.has(roomCode)) return;

        const room = rooms.get(roomCode);
        
        if (playerName === room.currentAnsweringPlayerName || room.todVotes.votedPlayers.includes(playerName)) return;

        room.todVotes.votedPlayers.push(playerName);
        if (passed) room.todVotes.passes++;
        else room.todVotes.fails++;

        const requiredVotes = Math.max(1, room.players.length - 1); // 1 if solo play

        if (room.todVotes.votedPlayers.length >= requiredVotes) {
            const taskPassed = room.todVotes.passes >= room.todVotes.fails;
            
            if (taskPassed) {
                room.scores[room.currentAnsweringPlayerName] = (room.scores[room.currentAnsweringPlayerName] || 0) + 25;
            }

            io.to(roomCode).emit('challengeJudged', {
                passed: taskPassed,
                scores: room.scores,
                passes: room.todVotes.passes,
                fails: room.todVotes.fails
            });

            setTimeout(() => advanceTodTurn(roomCode), 4000); // Wait 4s to show results, then move on
        } else {
            io.to(roomCode).emit('voteRegistered', { 
                votesCast: room.todVotes.votedPlayers.length,
                votesNeeded: requiredVotes 
            });
        }
    });

    // ... (Higher/Lower & Battleships logic remains unchanged from previous version)

    socket.on('disconnect', () => {
        const info = playerSockets.get(socket.id);
        if (info) playerSockets.delete(socket.id);
    });
});

function getChallenge(roomCode) {
    if (!rooms.has(roomCode)) return;
    
    const room = rooms.get(roomCode);
    const isTruth = Math.random() > 0.5;
    
    // Pick random category from host settings
    const activeCategories = room.todSettings.categories.length > 0 ? room.todSettings.categories : ['easy'];
    const selectedCategory = activeCategories[Math.floor(Math.random() * activeCategories.length)];
    
    // Safely pull from DB, fallback to easy if category missing
    const dbSection = isTruth ? challengeDB.truth : challengeDB.dare;
    let categoryList = dbSection[selectedCategory] || dbSection['easy'] || [{ text: "Tell us a secret", emoji: "🤫" }];

    const challenge = categoryList[Math.floor(Math.random() * categoryList.length)];
    
    // Determine whose turn it is
    let targetPlayers = room.isTieBreaker ? room.tiedPlayers : room.players;
    
    // Failsafe if someone disconnected during a tiebreaker
    if (room.isTieBreaker && targetPlayers.length === 0) targetPlayers = room.players;

    room.currentAnsweringPlayerName = targetPlayers[room.currentPlayerIndex].name;
    room.currentChallenge = { ...challenge, type: isTruth ? 'Truth' : 'Dare', category: selectedCategory };
    room.todVotes = { passes: 0, fails: 0, votedPlayers: [] };

    io.to(roomCode).emit('challengeGenerated', {
        challenge: room.currentChallenge,
        currentPlayer: room.currentAnsweringPlayerName,
        round: room.round,
        totalRounds: room.todSettings.totalRounds,
        isTieBreaker: room.isTieBreaker
    });
}

function advanceTodTurn(roomCode) {
    if (!rooms.has(roomCode)) return;
    const room = rooms.get(roomCode);

    let targetPlayers = room.isTieBreaker ? room.tiedPlayers : room.players;
    
    room.currentPlayerIndex++;

    // Check if we reached the end of the round
    if (room.currentPlayerIndex >= targetPlayers.length) {
        room.currentPlayerIndex = 0;
        
        if (!room.isTieBreaker) {
            room.round++;
        }

        // Check if game is over
        if (!room.isTieBreaker && room.round > room.todSettings.totalRounds) {
            evaluateTodWinner(room);
            return;
        } else if (room.isTieBreaker) {
            // End of a tie-breaker round, re-evaluate
            evaluateTodWinner(room);
            return;
        }
    }

    getChallenge(roomCode);
}

function evaluateTodWinner(room) {
    let targetPlayers = room.isTieBreaker ? room.tiedPlayers : room.players;
    let maxScore = -1;
    
    // Find the highest score among eligible players
    targetPlayers.forEach(p => {
        if (room.scores[p.name] > maxScore) maxScore = room.scores[p.name];
    });

    const winners = targetPlayers.filter(p => room.scores[p.name] === maxScore);

    if (winners.length === 1 || winners.length === targetPlayers.length && room.isTieBreaker) {
        // We have a definitive winner (or everyone is perfectly tied after sudden death and we just end it)
        room.gameMode = 'lobby';
        io.to(room.code).emit('todGameOver', {
            winners: winners.map(w => w.name),
            scores: room.scores
        });
    } else {
        // We have a tie
        room.isTieBreaker = true;
        room.tiedPlayers = winners;
        room.currentPlayerIndex = 0;
        
        io.to(room.code).emit('todTieBreaker', {
            tiedPlayers: winners.map(w => w.name)
        });
        
        // Start tie breaker round
        setTimeout(() => getChallenge(room.code), 3000);
    }
}

// ... (Other helper functions remain unchanged)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});