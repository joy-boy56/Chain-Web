const WebSocket = require('ws');

const PORT = process.env.PORT || 3001;
const wss = new WebSocket.Server({
    port: PORT,
    host: '0.0.0.0'
});
console.log(`WebSocket server running on port:${PORT}`);

const rooms = new Map();

function generateRoomCode() {
    let code;
    do { code = Math.random().toString(36).substring(2, 8).toUpperCase(); }
    while (rooms.has(code));
    return code;
}

function broadcast(roomCode, data) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const msg = JSON.stringify(data);
    room.connections.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
}

function sendTo(roomCode, playerId, data) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const ws = room.connections.get(playerId);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

wss.on('connection', (ws) => {
    let currentPlayerId = null;
    let currentRoomCode = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            switch (data.type) {
                case 'create_room': createRoom(ws, data); break;
                case 'join_room': joinRoom(ws, data); break;
                case 'start_game': startGame(data); break;
                case 'move': handleMove(data); break;
                case 'leave_room': leaveRoom(data); break;
            }
        } catch (err) {
            console.error('Message error:', err);
        }
    });

    ws.on('close', () => {
        if (currentRoomCode && currentPlayerId)
            leaveRoom({ roomCode: currentRoomCode, playerId: currentPlayerId });
    });

    // ─────────────────────────────────────────
    function createRoom(ws, data) {
        const code = generateRoomCode();
        const playerId = data.playerId;

        const room = {
            code,
            host: playerId,
            players: [playerId],
            connections: new Map([[playerId, ws]]),
            gameStarted: false,
            gridRows: data.gridRows || 6,
            gridCols: data.gridCols || 9,
            gameState: null
        };
        rooms.set(code, room);

        currentPlayerId = playerId;
        currentRoomCode = code;

        ws.send(JSON.stringify({
            type: 'room_created',
            roomCode: code,
            playerId,
            gridRows: room.gridRows,
            gridCols: room.gridCols
        }));
    }

    // ─────────────────────────────────────────
    function joinRoom(ws, data) {
        const room = rooms.get(data.roomCode);
        if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found' })); return; }
        if (room.gameStarted) { ws.send(JSON.stringify({ type: 'error', message: 'Game already started' })); return; }
        if (room.players.length >= 4) { ws.send(JSON.stringify({ type: 'error', message: 'Room is full' })); return; }

        room.players.push(data.playerId);
        room.connections.set(data.playerId, ws);

        currentPlayerId = data.playerId;
        currentRoomCode = data.roomCode;

        // Tell the new player they joined, with current player list and grid info
        ws.send(JSON.stringify({
            type: 'room_joined',
            roomCode: data.roomCode,
            playerId: data.playerId,
            players: room.players,
            gridRows: room.gridRows,
            gridCols: room.gridCols
        }));

        // Tell everyone else someone joined
        broadcast(data.roomCode, {
            type: 'player_joined',
            players: room.players
        });
    }

    // ─────────────────────────────────────────
    function startGame(data) {
        const room = rooms.get(data.roomCode);
        if (!room) return;
        if (room.host !== data.playerId) return;
        if (room.players.length < 2) return;

        room.gameStarted = true;

        const rows = room.gridRows;
        const cols = room.gridCols;

        // Initialise server-side grid  ({player, count})
        const grid = [];
        for (let r = 0; r < rows; r++) {
            grid[r] = [];
            for (let c = 0; c < cols; c++)
                grid[r][c] = { player: -1, count: 0 };
        }

        room.gameState = {
            grid,
            rows,
            cols,
            turn: 0,
            moveCount: 0,
            eliminated: Array(room.players.length).fill(false),
            gameOver: false,
            winner: -1
        };

        broadcast(data.roomCode, {
            type: 'game_start',
            players: room.players,
            gridRows: rows,
            gridCols: cols
        });
    }

    // ─────────────────────────────────────────
    function handleMove(data) {
        const room = rooms.get(data.roomCode);
        if (!room || !room.gameStarted || !room.gameState) return;

        const gs = room.gameState;
        const playerIndex = room.players.indexOf(data.playerId);
        if (playerIndex === -1) return;
        if (gs.turn !== playerIndex) return;          // not your turn
        if (gs.gameOver) return;

        const { rows, cols, grid } = gs;
        const x = data.x, y = data.y;                // x=col, y=row
        if (x < 0 || y < 0 || y >= rows || x >= cols) return;

        const cell = grid[y][x];
        if (cell.player !== -1 && cell.player !== playerIndex) return;  // wrong owner

        // Place orb
        cell.player = playerIndex;
        cell.count++;
        gs.moveCount++;

        // Explode
        processExplosions(gs);

        // Check win
        checkElimination(gs);

        // Advance turn
        if (!gs.gameOver) {
            do { gs.turn = (gs.turn + 1) % room.players.length; }
            while (gs.eliminated[gs.turn] && !gs.gameOver);
        }

        broadcast(data.roomCode, {
            type: 'game_state',
            state: {
                grid: gs.grid,
                turn: gs.turn,
                moveCount: gs.moveCount,
                eliminated: gs.eliminated,
                gameOver: gs.gameOver,
                winner: gs.winner
            }
        });
    }

    // ─────────────────────────────────────────
    function processExplosions(gs) {
        const { grid, rows, cols } = gs;
        let changed = true;
        let safetyLimit = 1000;

        while (changed && safetyLimit-- > 0) {
            changed = false;
            // Collect all cells that should explode
            const burst = [];
            for (let r = 0; r < rows; r++)
                for (let c = 0; c < cols; c++)
                    if (grid[r][c].count > criticalMass(c, r, cols, rows))
                        burst.push([r, c]);

            if (burst.length === 0) break;
            changed = true;

            burst.forEach(([r, c]) => {
                const owner = grid[r][c].player;
                const mass = criticalMass(c, r, cols, rows);
                grid[r][c].count -= (mass + 1);
                if (grid[r][c].count <= 0) { grid[r][c].count = 0; grid[r][c].player = -1; }

                const neighbors = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
                neighbors.forEach(([nr, nc]) => {
                    if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) return;
                    grid[nr][nc].player = owner;
                    grid[nr][nc].count++;
                });
            });
        }
    }

    // Critical mass = max orbs before explosion (matches client maxOrbs logic)
    function criticalMass(x, y, cols, rows) {
        const corner = (x === 0 || x === cols - 1) && (y === 0 || y === rows - 1);
        const edge = x === 0 || x === cols - 1 || y === 0 || y === rows - 1;
        return corner ? 1 : edge ? 2 : 3;
    }

    // ─────────────────────────────────────────
    function checkElimination(gs) {
        const { grid, rows, cols } = gs;

        // Count cells per player (only after enough moves)
        if (gs.moveCount < gs.eliminated.length) return;

        const active = new Set();
        for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++)
                if (grid[r][c].player !== -1) active.add(grid[r][c].player);

        gs.eliminated = gs.eliminated.map((_, i) => !active.has(i) && active.size > 0);

        if (active.size === 1) {
            gs.gameOver = true;
            gs.winner = [...active][0];
        }
    }

    // ─────────────────────────────────────────
    function leaveRoom(data) {
        const room = rooms.get(data.roomCode);
        if (!room) return;

        room.players = room.players.filter(p => p !== data.playerId);
        room.connections.delete(data.playerId);

        if (room.players.length === 0) {
            rooms.delete(data.roomCode);
            return;
        }

        if (room.host === data.playerId) room.host = room.players[0];

        broadcast(data.roomCode, {
            type: 'player_left',
            players: room.players
        });
    }
});