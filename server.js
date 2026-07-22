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
            totalRounds: 5,
            isPlaying: false,
            selectedDifficulties: { easy: true, medium: true, hard: true, intimate: true, drinking: true, couples: false },
            includeWildcards: false,
            currentChallenge: null,
            difficulty: 'easy',
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
                gameMode: room.gameMode
            }
        });
    } catch (error) {
        console.error('Join room error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), activeRooms: rooms.size });
});

// Socket.io Events
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('joinRoom', (data) => {
        const { roomCode, playerName } = data;
        if (!roomCode || !playerName || !rooms.has(roomCode)) {
            socket.emit('error', 'Invalid room or player');
            return;
        }

        const room = rooms.get(roomCode);
        if (!room.players.find(p => p.name === playerName)) {
            room.players.push({ name: playerName, id: socket.id });
            room.scores[playerName] = 0;
        }

        socket.join(roomCode);
        playerSockets.set(socket.id, { roomCode, playerName });
        room.lastActivity = Date.now();

        io.to(roomCode).emit('playerJoined', {
            players: room.players.map(p => p.name),
            scores: room.scores,
            gameMode: room.gameMode
        });
    });

    socket.on('selectGameMode', (data) => {
        const { roomCode, gameMode } = data;
        if (!rooms.has(roomCode)) return;

        const room = rooms.get(roomCode);
        room.gameMode = gameMode;
        room.isPlaying = true;
        room.currentPlayerIndex = 0;
        room.round = 1;
        room.difficulty = 'easy';
        room.lastActivity = Date.now();

        io.to(roomCode).emit('gameModeSelected', {
            gameMode: gameMode,
            players: room.players.map(p => p.name),
            scores: room.scores
        });

        // Initialize game based on mode
        if (gameMode === 'truthordare') {
            getChallenge(roomCode);
        } else if (gameMode === 'higherlower') { // FIX: Corrected typo from 'higherrlower' to 'higherlower'
            generateCard(roomCode);
        } else if (gameMode === 'battleships') {
            io.to(roomCode).emit('initBattleships', { players: room.players.map(p => p.name) });
        } else if (gameMode === 'wordle') {
            io.to(roomCode).emit('initWordle', { players: room.players.map(p => p.name) });
        }
    });

    socket.on('getChallenge', (data) => {
        const { roomCode } = data;
        if (!rooms.has(roomCode)) return;
        getChallenge(roomCode);
    });

    // FIX: Added missing event listener to award points for Truth or Dare
    socket.on('completeChallenge', (data) => {
        const { roomCode, playerName, points } = data;
        if (!rooms.has(roomCode)) return;

        const room = rooms.get(roomCode);
        room.scores[playerName] = (room.scores[playerName] || 0) + (points || 25);
        room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
        
        io.to(roomCode).emit('scoreUpdated', { scores: room.scores });
    });

    socket.on('generateCard', (data) => {
        const { roomCode } = data;
        if (!rooms.has(roomCode)) return;
        generateCard(roomCode);
    });

    socket.on('guessCard', (data) => {
        const { roomCode, guess, playerName } = data;
        if (!rooms.has(roomCode)) return;

        const room = rooms.get(roomCode);
        const result = processCardGuess(room, guess, playerName);

        io.to(roomCode).emit('cardGuessResult', result);

        if (result.correct) {
            room.scores[playerName] = (room.scores[playerName] || 0) + 10;
        } else {
            room.scores[playerName] = Math.max(0, (room.scores[playerName] || 0) - 10);
        }

        io.to(roomCode).emit('scoreUpdated', { scores: room.scores });
        
        if (!result.correct) {
            room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
            generateCard(roomCode);
        }
    });

    socket.on('placeBattleships', (data) => {
        const { roomCode, playerName, ships } = data;
        if (!rooms.has(roomCode)) return;

        const room = rooms.get(roomCode);
        if (!room.battleshipState) room.battleshipState = {};
        room.battleshipState[playerName] = { ships, hits: [] };

        const allReady = room.players.every(p => room.battleshipState[p.name]);
        if (allReady) {
            room.currentPlayerIndex = 0;
            io.to(roomCode).emit('battleshipsStart', { 
                currentPlayer: room.players[0].name 
            });
        }
    });

    socket.on('fireShot', (data) => {
        const { roomCode, x, y, playerName, targetPlayer } = data;
        if (!rooms.has(roomCode)) return;

        const room = rooms.get(roomCode);
        const targetState = room.battleshipState[targetPlayer];
        const hit = checkBattleshipHit(targetState.ships, x, y);

        if (hit) {
            room.scores[playerName] = (room.scores[playerName] || 0) + 10;
            io.to(roomCode).emit('battleshipHit', { x, y, playerName, hit: true });
            
            if (targetState.hits.filter(h => h).length >= 17) {
                room.scores[playerName] += 100;
                io.to(roomCode).emit('battleshipsWon', { winner: playerName });
                room.gameMode = 'lobby';
            }
        } else {
            room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
            io.to(roomCode).emit('battleshipMiss', { x, y, nextPlayer: room.players[room.currentPlayerIndex].name });
        }

        io.to(roomCode).emit('scoreUpdated', { scores: room.scores });
    });

    socket.on('wordleGuess', (data) => {
        const { roomCode, guess, playerName } = data;
        if (!rooms.has(roomCode)) return;

        const room = rooms.get(roomCode);
        if (!room.wordleState) room.wordleState = {};
        if (!room.wordleState[playerName]) room.wordleState[playerName] = { word: '', guesses: 0, won: false };

        const feedback = processWordleGuess(guess, room.wordleState[playerName].word);
        room.wordleState[playerName].guesses++;

        io.to(roomCode).emit('wordleResult', {
            playerName,
            guess,
            feedback,
            guesses: room.wordleState[playerName].guesses,
            won: feedback.every(f => f === 'correct')
        });

        if (feedback.every(f => f === 'correct')) {
            room.scores[playerName] = (room.scores[playerName] || 0) + 50;
            io.to(roomCode).emit('scoreUpdated', { scores: room.scores });
        } else if (room.wordleState[playerName].guesses >= 10) {
            io.to(roomCode).emit('wordleGameOver', { playerName, word: room.wordleState[playerName].word });
        }
    });

    socket.on('setWordleWord', (data) => {
        const { roomCode, playerName, word } = data;
        if (!rooms.has(roomCode)) return;

        const room = rooms.get(roomCode);
        if (!room.wordleState) room.wordleState = {};

        const isValid = isValidWord(word.toUpperCase());
        if (!isValid) {
            socket.emit('error', 'Invalid word! Must be in dictionary.');
            return;
        }

        room.wordleState[playerName] = { 
            word: word.toUpperCase(), 
            guesses: 0, 
            won: false 
        };

        const allSet = room.players.every(p => room.wordleState[p.name]?.word);
        if (allSet) {
            io.to(roomCode).emit('wordleWordsSet', { 
                readyPlayers: room.players.map(p => p.name)
            });
        }
    });

    socket.on('returnToLobby', (data) => {
        const { roomCode } = data;
        if (!rooms.has(roomCode)) return;

        const room = rooms.get(roomCode);
        room.gameMode = 'lobby';
        room.isPlaying = false;
        room.currentPlayerIndex = 0;
        room.round = 1;

        io.to(roomCode).emit('returnedToLobby', { 
            players: room.players.map(p => p.name),
            scores: room.scores
        });
    });

    socket.on('leaveRoom', (data) => {
        const { roomCode, playerName } = data;
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
    });
});

// Game Logic Functions
function getChallenge(roomCode) {
    if (!rooms.has(roomCode)) return;
    
    const room = rooms.get(roomCode);
    const difficulties = ['easy', 'medium', 'hard', 'intimate', 'drinking', 'couples'];
    const difficulty = difficulties[Math.min(room.round - 1, difficulties.length - 1)];
    
    const isTruth = Math.random() > 0.5;
    const categoryList = isTruth 
        ? (challengeDB.truth?.[difficulty] || challengeDB.truth?.easy || [])
        : (challengeDB.dare?.[difficulty] || challengeDB.dare?.easy || []);

    const challenge = categoryList[Math.floor(Math.random() * categoryList.length)] || 
        { text: "Default", emoji: "🎭" };

    room.currentChallenge = { ...challenge, type: isTruth ? 'Truth' : 'Dare', difficulty };
    room.currentAnsweringPlayerName = room.players[room.currentPlayerIndex].name;

    io.to(roomCode).emit('challengeGenerated', {
        challenge: room.currentChallenge,
        currentPlayer: room.currentAnsweringPlayerName,
        round: room.round,
        difficulty: difficulty
    });
}

function generateCard(roomCode) {
    if (!rooms.has(roomCode)) return;

    const suits = ['♠', '♥', '♦', '♣'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const suit = suits[Math.floor(Math.random() * 4)];
    const rank = ranks[Math.floor(Math.random() * 13)];
    const value = ['2', '3', '4', '5', '6', '7', '8', '9', '10'].includes(rank) 
        ? parseInt(rank) 
        : rank === 'J' ? 11 : rank === 'Q' ? 12 : rank === 'K' ? 13 : 14;

    const room = rooms.get(roomCode);
    room.currentCard = { rank, suit, value };
    room.currentPlayerIndex = (room.currentPlayerIndex) % room.players.length;

    io.to(roomCode).emit('cardGenerated', {
        card: `${rank}${suit}`,
        currentPlayer: room.players[room.currentPlayerIndex].name
    });
}

function processCardGuess(room, guess, playerName) {
    const nextRanks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const suits = ['♠', '♥', '♦', '♣'];
    const nextSuit = suits[Math.floor(Math.random() * 4)];
    const nextRank = nextRanks[Math.floor(Math.random() * 13)];
    const nextValue = ['2', '3', '4', '5', '6', '7', '8', '9', '10'].includes(nextRank)
        ? parseInt(nextRank)
        : nextRank === 'J' ? 11 : nextRank === 'Q' ? 12 : nextRank === 'K' ? 13 : 14;

    const correct = (guess === 'higher' && nextValue > room.currentCard.value) ||
                   (guess === 'lower' && nextValue < room.currentCard.value);

    room.currentCard = { rank: nextRank, suit: nextSuit, value: nextValue };

    return {
        correct,
        card: `${nextRank}${nextSuit}`,
        playerName
    };
}

function checkBattleshipHit(ships, x, y) {
    for (let ship of ships) {
        if (ship.horizontal) {
            if (ship.y === y && x >= ship.x && x < ship.x + ship.length) return true;
        } else {
            if (ship.x === x && y >= ship.y && y < ship.y + ship.length) return true;
        }
    }
    return false;
}

function processWordleGuess(guess, word) {
    const feedback = [];
    guess = guess.toUpperCase();

    for (let i = 0; i < guess.length; i++) {
        if (guess[i] === word[i]) {
            feedback.push('correct');
        } else if (word.includes(guess[i])) {
            feedback.push('present');
        } else {
            feedback.push('absent');
        }
    }

    return feedback;
}

function isValidWord(word) {
    return wordList.includes(word);
}

setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
        if (now - room.lastActivity > 60 * 60 * 1000) {
            rooms.delete(code);
        }
    }
}, 10 * 60 * 1000);

app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📍 Word list: ${wordList.length} words loaded`);
});