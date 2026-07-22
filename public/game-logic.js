// ============ STATE ============
let gameState = {
    roomCode: null,
    playerName: null,
    players: [],
    scores: {},
    gameMode: null,
    isHost: false,
    holScore: 0,
    round: 1,
    totalRounds: 5
};

let socket = null;
let quickJoinCode = null;

// ============ SOCKET ============
function initSocket() {
    if (socket) return;
    
    const serverUrl = window.location.origin;
    socket = io(serverUrl, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 10
    });

    socket.on('connect', () => {
        updateStatus('Connected', false);
    });

    socket.on('disconnect', () => {
        updateStatus('Disconnected', true);
    });

    socket.on('playerJoined', (data) => {
        gameState.players = data.players;
        gameState.scores = data.scores || {};
        updatePlayersList();
        
        if (gameState.isHost) {
            const hostPanel = document.getElementById('hostSettingsPanel');
            if (hostPanel) hostPanel.style.display = 'block';
        }
    });

    socket.on('todSettingsUpdated', (settings) => {
        document.getElementById('totalRounds').textContent = settings.totalRounds;
        document.getElementById('settingRounds').value = settings.totalRounds;
    });

    socket.on('gameModeSelected', (data) => {
        gameState.gameMode = data.gameMode;
        gameState.round = 1;
        gameState.holScore = 0;
        
        document.getElementById('winnerNames').style.display = 'none';
        startGameMode(data.gameMode);
    });

    socket.on('challengeGenerated', (data) => {
        document.getElementById('voteResults').style.display = 'none';
        document.getElementById('todEmoji').textContent = data.challenge.emoji || '🎭';
        document.getElementById('todText').textContent = data.challenge.text;
        document.getElementById('todType').textContent = data.challenge.type || 'Truth';
        document.getElementById('roundNum').textContent = data.round;
        document.getElementById('totalRounds').textContent = data.totalRounds || 5;
        gameState.round = data.round;
        
        if (data.isTieBreaker) {
            document.getElementById('todRoundInfo').innerHTML = `<span style="color: #FF3B30; font-weight: bold;">🚨 TIE BREAKER 🚨</span>`;
        } else {
            document.getElementById('todRoundInfo').innerHTML = `Round <span id="roundNum">${data.round}</span> of <span id="totalRounds">${data.totalRounds}</span>`;
        }

        if (data.currentPlayer === gameState.playerName) {
            document.getElementById('todHeader').textContent = "YOUR TURN!";
            document.getElementById('todHeader').style.color = "#34C759";
            document.getElementById('activePlayerPanel').style.display = 'block';
            document.getElementById('activePlayerPanel').innerHTML = `<p style="font-style: italic; opacity: 0.9; color: white;">The group is deciding your fate...</p>`;
            document.getElementById('juryPanel').style.display = 'none';
        } else {
            document.getElementById('todHeader').textContent = `${data.currentPlayer.toUpperCase()}'s TURN!`;
            document.getElementById('todHeader').style.color = "#f1c40f";
            document.getElementById('activePlayerPanel').style.display = 'none';
            document.getElementById('juryPanel').style.display = 'block';
        }
    });

    socket.on('voteRegistered', (data) => {
        const activePanel = document.getElementById('activePlayerPanel');
        if (activePanel.style.display === 'block') {
            activePanel.innerHTML = `<p style="font-style: italic; opacity: 0.9; color: white;">Waiting for judges... (${data.votesCast}/${data.votesNeeded})</p>`;
        }
    });

    socket.on('challengeJudged', (data) => {
        document.getElementById('juryPanel').style.display = 'none';
        document.getElementById('activePlayerPanel').style.display = 'none';
        const resultsEl = document.getElementById('voteResults');
        resultsEl.style.display = 'block';
        
        if (data.passed) {
            resultsEl.innerHTML = `✅ PASSED!<br><span style="font-size:14px; font-weight:normal;">(${data.passes} Yes / ${data.fails} No)</span>`;
            resultsEl.style.color = "#34C759";
        } else {
            resultsEl.innerHTML = `❌ FAILED!<br><span style="font-size:14px; font-weight:normal;">(${data.fails} No / ${data.passes} Yes)</span>`;
            resultsEl.style.color = "#FF3B30";
        }

        gameState.scores = data.scores;
        updateLeaderboard();
    });

    socket.on('todTieBreaker', (data) => {
        alert(`It's a tie! Sudden death for: ${data.tiedPlayers.join(', ')}`);
    });

    socket.on('todGameOver', (data) => {
        const winnerNames = document.getElementById('winnerNames');
        winnerNames.textContent = data.winners.join(' & ') + ' WINS!';
        winnerNames.style.display = 'block';
        
        gameState.scores = data.scores;
        updateLeaderboard();
        showScreen('scoresScreen');
    });

    socket.on('cardGenerated', (data) => {
        document.getElementById('cardDisplay').textContent = data.card;
        document.getElementById('cardResult').textContent = '';
    });

    socket.on('cardGuessResult', (data) => {
        const result = data.correct ? '✅ Correct! +10' : '❌ Wrong! -10';
        document.getElementById('cardResult').textContent = result;
        gameState.holScore = data.score || gameState.holScore;
        document.getElementById('holYourScore').textContent = gameState.holScore;
    });

    socket.on('scoreUpdated', (data) => {
        gameState.scores = data.scores;
        updateLeaderboard();
    });

    socket.on('error', (msg) => {
        console.error('Error:', msg);
    });
}

function updateStatus(text, isOffline) {
    document.getElementById('statusText').textContent = text;
    const bar = document.getElementById('statusBar');
    if (isOffline) {
        bar.style.background = '#FF3B30';
    } else {
        bar.style.background = '#34C759';
    }
}

// ============ NAVIGATION ============
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

function goToHome() {
    if (gameState.roomCode && socket) {
        socket.emit('leaveRoom', { roomCode: gameState.roomCode, playerName: gameState.playerName });
    }
    gameState = { roomCode: null, playerName: null, players: [], scores: {}, gameMode: null, isHost: false, holScore: 0, round: 1, totalRounds: 5 };
    showScreen('homeScreen');
}

function goToLobby() { showScreen('lobbyScreen'); }
function proceedToGameSelector() { showScreen('selectorScreen'); }
function returnToGameSelector() { showScreen('selectorScreen'); }

// ============ QUICK JOIN ============
function quickJoinFlow() {
    const code = document.getElementById('quickJoinCode').value.toUpperCase().trim();
    if (!code || code.length !== 6) {
        alert('Enter 6-character code');
        return;
    }
    quickJoinCode = code;
    document.getElementById('quickJoinModal').classList.add('active');
    document.getElementById('quickJoinName').focus();
}

function closeQuickJoinModal() {
    document.getElementById('quickJoinModal').classList.remove('active');
}

function quickJoinRoom() {
    const name = document.getElementById('quickJoinName').value.trim();
    if (!name) {
        alert('Enter your name');
        return;
    }

    fetch('/api/rooms/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomCode: quickJoinCode, playerName: name })
    })
    .then(r => r.json())
    .then(d => {
        if (d.success) {
            gameState.roomCode = quickJoinCode;
            gameState.playerName = name;
            gameState.isHost = false;
            gameState.players = d.room.players || [];
            gameState.scores = Object.fromEntries((d.room.players || []).map(p => [p, 0]));
            
            document.getElementById('displayCode').textContent = quickJoinCode;
            closeQuickJoinModal();
            document.getElementById('quickJoinCode').value = '';
            
            initSocket();
            socket.emit('joinRoom', { roomCode: quickJoinCode, playerName: name });
            showScreen('lobbyScreen');
            updatePlayersList();
        } else {
            alert('Failed: ' + d.error);
        }
    });
}

// ============ CREATE ROOM ============
function showCreateRoom() {
    document.getElementById('createModal').classList.add('active');
    document.getElementById('hostName').focus();
}

function closeCreateModal() {
    document.getElementById('createModal').classList.remove('active');
}

function createRoom() {
    const name = document.getElementById('hostName').value.trim();
    if (!name) {
        alert('Enter your name');
        return;
    }

    fetch('/api/rooms/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerName: name })
    })
    .then(r => r.json())
    .then(d => {
        if (d.success) {
            gameState.roomCode = d.roomCode;
            gameState.playerName = name;
            gameState.isHost = true;
            gameState.players = [name];
            gameState.scores[name] = 0;
            
            document.getElementById('displayCode').textContent = gameState.roomCode;
            closeCreateModal();
            document.getElementById('hostName').value = '';
            
            initSocket();
            socket.emit('joinRoom', { roomCode: d.roomCode, playerName: name });
            showScreen('lobbyScreen');
            updatePlayersList();
        }
    });
}

function updatePlayersList() {
    const list = document.getElementById('playersList');
    list.innerHTML = gameState.players.map(p => `<div class="player-item">✅ ${p}</div>`).join('');
}

// ============ GAMES ============
function emitSettings() {
    if (!gameState.isHost) return;
    const rounds = document.getElementById('settingRounds').value;
    const categories = Array.from(document.querySelectorAll('#categoryToggles input:checked')).map(cb => cb.value);
    socket.emit('updateTodSettings', { 
        roomCode: gameState.roomCode, 
        categories: categories, 
        totalRounds: parseInt(rounds) 
    });
}

function startGame(mode) {
    if (!socket || !gameState.roomCode) return;
    socket.emit('selectGameMode', { roomCode: gameState.roomCode, gameMode: mode });
}

function startGameMode(mode) {
    if (mode === 'truthordare') {
        showScreen('todScreen');
    } else if (mode === 'higherlower') {
        gameState.holScore = 0;
        document.getElementById('holYourScore').textContent = '0';
        socket.emit('generateCard', { roomCode: gameState.roomCode });
        showScreen('holScreen');
    } else if (mode === 'battleships') {
        initBattleships();
        showScreen('battleshipScreen');
    } else if (mode === 'wordle') {
        showScreen('wordleScreen');
    }
}

// ============ TRUTH OR DARE ============
function castVote(passed) {
    document.getElementById('juryPanel').style.display = 'none';
    document.getElementById('activePlayerPanel').style.display = 'block';
    document.getElementById('activePlayerPanel').innerHTML = `<p style="font-style: italic; opacity: 0.9; color: white;">Vote registered. Waiting for others...</p>`;
    socket.emit('judgeChallenge', { 
        roomCode: gameState.roomCode, 
        playerName: gameState.playerName, 
        passed: passed 
    });
}

// ============ HIGHER OR LOWER ============
function guessCard(guess) {
    if (socket && gameState.roomCode) {
        socket.emit('guessCard', {
            roomCode: gameState.roomCode,
            guess: guess,
            playerName: gameState.playerName
        });
    }
}

// ============ BATTLESHIPS ============
let battleState = {
    ships: [
        { name: 'Carrier', size: 5, horizontal: true, placed: false },
        { name: 'Battleship', size: 4, horizontal: true, placed: false },
        { name: 'Cruiser', size: 3, horizontal: true, placed: false },
        { name: 'Destroyer', size: 3, horizontal: true, placed: false },
        { name: 'Submarine', size: 2, horizontal: true, placed: false }
    ],
    grid: Array(100).fill(0)
}

function initBattleships() { generateGrid(); updateShipPalette(); }

function generateGrid() {
    const grid = document.getElementById('battleshipGrid');
    grid.innerHTML = '';
    for (let i = 0; i < 100; i++) {
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        cell.id = `cell-${i}`;
        cell.onclick = () => placeShip(i);
        grid.appendChild(cell);
    }
}

function updateShipPalette() {
    const list = document.getElementById('shipsList');
    list.innerHTML = battleState.ships.map((ship, idx) => `
        <div class="ship-item">
            <div>
                <div class="ship-name">${ship.name}</div>
                <div class="ship-size">${ship.size} cells</div>
            </div>
            <button class="orientation-btn ${ship.horizontal ? 'active' : ''}" onclick="toggleOrientation(${idx})">
                ${ship.horizontal ? '→' : '↓'}
            </button>
        </div>
    `).join('');
}

function toggleOrientation(idx) {
    battleState.ships[idx].horizontal = !battleState.ships[idx].horizontal;
    updateShipPalette();
}

function placeShip(cellIdx) {
    const ship = battleState.ships.find(s => !s.placed);
    if (!ship) return;

    const row = Math.floor(cellIdx / 10);
    const col = cellIdx % 10;

    if (ship.horizontal && col + ship.size > 10) return alert('Too close to edge');
    if (!ship.horizontal && row + ship.size > 10) return alert('Too close to edge');

    for (let i = 0; i < ship.size; i++) {
        const idx = ship.horizontal ? cellIdx + i : cellIdx + (i * 10);
        battleState.grid[idx] = 1;
        document.getElementById(`cell-${idx}`).classList.add('ship');
    }

    ship.placed = true;
    updateShipPalette();
}

function resetBattleships() {
    battleState = {
        ships: [
            { name: 'Carrier', size: 5, horizontal: true, placed: false },
            { name: 'Battleship', size: 4, horizontal: true, placed: false },
            { name: 'Cruiser', size: 3, horizontal: true, placed: false },
            { name: 'Destroyer', size: 3, horizontal: true, placed: false },
            { name: 'Submarine', size: 2, horizontal: true, placed: false }
        ],
        grid: Array(100).fill(0)
    };
    initBattleships();
}

function startBattleships() {
    if (!battleState.ships.every(s => s.placed)) return alert('Place all ships first!');
    if (socket && gameState.roomCode) {
        socket.emit('placeBattleships', {
            roomCode: gameState.roomCode,
            playerName: gameState.playerName,
            ships: battleState.ships.map(s => ({ name: s.name, size: s.size, horizontal: s.horizontal }))
        });
    }
}

// ============ WORDLE ============
function submitWordleWord() {
    const word = document.getElementById('wordleWord').value.toUpperCase().trim();
    if (word.length !== 5) return alert('5 letters only');
    if (socket && gameState.roomCode) {
        socket.emit('setWordleWord', {
            roomCode: gameState.roomCode,
            playerName: gameState.playerName,
            word: word
        });
        document.getElementById('wordleStatus').textContent = '✅ Word set!';
    }
}

// ============ SCORES ============
function updateLeaderboard() {
    const sorted = Object.entries(gameState.scores).sort((a, b) => b[1] - a[1]);
    const board = document.getElementById('leaderboard');
    
    board.innerHTML = sorted.map((item, idx) => {
        const [player, score] = item;
        const className = idx === 0 ? 'gold' : idx === 1 ? 'silver' : idx === 2 ? 'bronze' : 'other';
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}`;
        return `
            <div class="leaderboard-item ${className}">
                <span class="leaderboard-medal">${medal}</span>
                <span class="leaderboard-name">${player}</span>
                <span class="leaderboard-score">${score}</span>
            </div>
        `;
    }).join('');
}