require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const csv = require('csv-parser');

const app = express();
app.use(express.json());
app.get("/api", (req, res) => {
  res.json({ ok: true });
});
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.PASSWORD || '12345';

const MAX_PLAYERS = 10;
const MIN_ROUNDS = 10;
const MAX_ROUNDS = 100;
const RECONNECT_GRACE_MS = 90_000;
const GAME_END_DECISION_TIMEOUT_MS = 120_000;
const ROOM_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;
const ROUND_TIME_SECONDS = 90;
const ROUND_SCORING_DELAY_MS = 4_000;
const FINAL_ROUND_REVEAL_MS = 10_000;
const JOKER_CARD_TOKEN = '__JOKER_CARD__';
const JOKER_DRAW_CHANCE = 0.1;
const JOKER_MAX_ANSWER_LENGTH = 100;

const rooms = {};
let answerDeck = [];
let questionDeck = [];

function loadDecks() {
    const questions = [];
    const answers = [];

    fs.createReadStream('pytania.csv')
        .pipe(csv({ separator: ';' }))
        .on('data', (data) => {
            const question = (data.Pytania || '').trim();
            if (question) questions.push(question);
        })
        .on('end', () => {
            questionDeck = [...new Set(questions)];
            console.log(`Loaded ${questionDeck.length} unique questions.`);
        });

    fs.createReadStream('odpowiedzi.csv')
        .pipe(csv({ separator: ';' }))
        .on('data', (data) => {
            const answer = (data.Odpowiedzi || '').trim();
            if (answer) answers.push(answer);
        })
        .on('end', () => {
            answerDeck = [...new Set(answers)];
            console.log(`Loaded ${answerDeck.length} unique answers.`);
        });
}

function createRoom(roomId) {
    return {
        id: roomId,
        players: [],
        gameState: 'LOBBY',
        roundLimit: null,
        allowSwap: true,
        allowJoker: true,
        questionDeck: [],
        answerDeck: [],
        currentQuestion: null,
        submittedAnswers: [],
        roundTimeRemaining: 0,
        timerInterval: null,
        czarIndex: 0,
        roundNumber: 0,
        roundWinnerId: null,
        roundWinnerCard: null,
        roundWinnerName: null,
        winnerName: null,
        endReason: null,
        restartDecisionTimeout: null,
        inactivityTimeout: null
    };
}

function generateSessionId() {
    return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseRoundLimit(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < MIN_ROUNDS || parsed > MAX_ROUNDS) {
        return null;
    }
    return parsed;
}

function getCurrentCzar(room) {
    if (!room || room.players.length === 0) return null;
    if (room.czarIndex < 0 || room.czarIndex >= room.players.length) {
        room.czarIndex = 0;
    }
    return room.players[room.czarIndex] || null;
}

function clearRoomTimer(room) {
    if (!room) return;
    if (room.timerInterval) {
        clearInterval(room.timerInterval);
        room.timerInterval = null;
    }
}

function clearRestartDecisionTimeout(room) {
    if (!room) return;
    if (room.restartDecisionTimeout) {
        clearTimeout(room.restartDecisionTimeout);
        room.restartDecisionTimeout = null;
    }
}

function clearInactivityTimeout(room) {
    if (!room) return;
    if (room.inactivityTimeout) {
        clearTimeout(room.inactivityTimeout);
        room.inactivityTimeout = null;
    }
}

function resetInactivityTimeout(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    clearInactivityTimeout(room);
    room.inactivityTimeout = setTimeout(() => {
        cleanupRoom(roomId, 'inactivity');
    }, ROOM_INACTIVITY_TIMEOUT_MS);
}

function cleanupRoom(roomId, closeReason = null) {
    const room = rooms[roomId];
    if (!room) return;
    clearRoomTimer(room);
    clearRestartDecisionTimeout(room);
    clearInactivityTimeout(room);
    room.players.forEach((player) => {
        if (player.disconnectTimeout) {
            clearTimeout(player.disconnectTimeout);
        }
        if (closeReason && !player.isBot) {
            const playerSocket = io.sockets.sockets.get(player.id);
            if (playerSocket) {
                playerSocket.emit('roomClosed', { reason: closeReason });
                playerSocket.leave(roomId);
            }
        }
    });
    delete rooms[roomId];
}

function emitRoomUpdate(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.players.forEach((player) => {
        if (player.isBot) return;
        const targetSocket = io.sockets.sockets.get(player.id);
        if (!targetSocket) return;
        targetSocket.emit('updateRoom', getRoomPublicData(room, player.id));
    });
}

function emitPlayerUpdate(player) {
    if (!player || player.isBot) return;
    const targetSocket = io.sockets.sockets.get(player.id);
    if (targetSocket) {
        targetSocket.emit('updatePlayer', player);
    }
}

function notifyJokerAward(player) {
    if (!player || player.isBot) return;
    const targetSocket = io.sockets.sockets.get(player.id);
    if (targetSocket) {
        targetSocket.emit('jokerAwarded');
    }
}

function mapSubmittedAnswerPlayer(room, fromId, toId) {
    room.submittedAnswers.forEach((answer) => {
        if (answer.playerId === fromId) {
            answer.playerId = toId;
        }
    });
}

function getPlayerBySocketId(socketId) {
    for (const [roomId, room] of Object.entries(rooms)) {
        const player = room.players.find((p) => p.id === socketId);
        if (player) return { roomId, room, player };
    }
    return null;
}

function removePlayerFromRoom(roomId, playerId) {
    const room = rooms[roomId];
    if (!room) return;

    const removeIndex = room.players.findIndex((p) => p.id === playerId);
    if (removeIndex === -1) return;

    const [removedPlayer] = room.players.splice(removeIndex, 1);
    if (removedPlayer.disconnectTimeout) {
        clearTimeout(removedPlayer.disconnectTimeout);
    }

    room.submittedAnswers = room.submittedAnswers.filter((a) => a.playerId !== removedPlayer.id);

    if (room.players.length === 0) {
        cleanupRoom(roomId);
        return;
    }

    if (removeIndex < room.czarIndex) {
        room.czarIndex -= 1;
    }
    if (room.czarIndex >= room.players.length) {
        room.czarIndex = 0;
    }

    if (!room.players.some((p) => p.isLeader)) {
        room.players[0].isLeader = true;
    }

    if (room.gameState === 'ANSWERING') {
        checkAllAnswered(roomId);
    }

    emitRoomUpdate(roomId);
}

loadDecks();

app.use(express.static('public'));

app.get('/check-auth', (req, res) => {
    res.sendStatus(200);
});

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('login', (password, callback) => {
        if (password === PASSWORD) {
            callback({ success: true });
        } else {
            callback({ success: false, message: 'Nieprawidłowe hasło' });
        }
    });

    socket.on('joinRoom', ({ roomNumber, playerName, sessionId, isRestore }) => {
        const parsedRoomNumber = Number(roomNumber);
        if (!Number.isInteger(parsedRoomNumber) || parsedRoomNumber < 1 || parsedRoomNumber > 5) return;
        const roomId = parsedRoomNumber.toString();
        const safeName = (playerName || '').trim();
        const safeSessionId = (sessionId || '').trim();
        const restoreAttempt = !!isRestore;

        if (!rooms[roomId]) {
            if (restoreAttempt) {
                socket.emit('roomClosed', { reason: 'expired' });
                return;
            }
            rooms[roomId] = createRoom(roomId);
        }

        const room = rooms[roomId];
        const reconnectPlayer = safeSessionId
            ? room.players.find((p) => !p.isBot && p.sessionId === safeSessionId)
            : null;

        if (reconnectPlayer) {
            const previousSocketId = reconnectPlayer.id;

            reconnectPlayer.id = socket.id;
            reconnectPlayer.disconnectedAt = null;
            if (safeName) {
                reconnectPlayer.name = safeName;
            }
            if (reconnectPlayer.disconnectTimeout) {
                clearTimeout(reconnectPlayer.disconnectTimeout);
                reconnectPlayer.disconnectTimeout = null;
            }

            if (previousSocketId && previousSocketId !== socket.id) {
                mapSubmittedAnswerPlayer(room, previousSocketId, socket.id);
                const previousSocket = io.sockets.sockets.get(previousSocketId);
                if (previousSocket && previousSocket.connected) {
                    previousSocket.disconnect(true);
                }
            }

            socket.join(roomId);
            resetInactivityTimeout(roomId);
            emitRoomUpdate(roomId);
            socket.emit('updatePlayer', reconnectPlayer);
            return;
        }

        if (room.gameState !== 'LOBBY') {
            socket.emit('error', 'Gra już trwa w tym pokoju.');
            return;
        }

        if (room.players.length >= MAX_PLAYERS) {
            socket.emit('error', 'Pokój jest pełny.');
            return;
        }

        if (!safeName) {
            socket.emit('error', 'Wpisz imię!');
            return;
        }

        const isLeader = room.players.length === 0;
        const player = {
            id: socket.id,
            sessionId: safeSessionId || generateSessionId(),
            name: safeName,
            isLeader,
            score: 0,
            hand: [],
            hasUsedSwap: false,
            isBot: false,
            disconnectedAt: null,
            disconnectTimeout: null
        };

        room.players.push(player);
        socket.join(roomId);

        resetInactivityTimeout(roomId);
        emitRoomUpdate(roomId);
        socket.emit('updatePlayer', player);
    });

    socket.on('startGame', (payload) => {
        const roomId = getRoomIdBySocket(socket);
        if (!roomId) return;

        const room = rooms[roomId];
        if (!room || room.gameState !== 'LOBBY') return;

        const player = room.players.find((p) => p.id === socket.id);
        if (!player || !player.isLeader) return;

        if (room.players.length < 2) {
            socket.emit('error', 'Do startu potrzeba minimum 2 graczy.');
            return;
        }

        const roundLimit = typeof payload === 'object' && payload !== null
            ? payload.roundLimit
            : payload;

        const validatedRoundLimit = parseRoundLimit(roundLimit);
        if (validatedRoundLimit === null) {
            socket.emit('error', `Liczba rund musi być liczbą całkowitą od ${MIN_ROUNDS} do ${MAX_ROUNDS}.`);
            return;
        }

        if (!questionDeck.length || !answerDeck.length) {
            socket.emit('error', 'Talie nie są jeszcze gotowe. Spróbuj ponownie za chwilę.');
            return;
        }

        room.roundLimit = validatedRoundLimit;

        if (typeof payload === 'object' && payload !== null) {
            room.allowSwap = payload.allowSwap !== false;
            room.allowJoker = payload.allowJoker !== false;
        }

        resetRoomForNewGame(room);
        room.players.forEach((p) => {
            emitPlayerUpdate(p);
        });

        resetInactivityTimeout(roomId);
        startCountdown(roomId);
    });

    socket.on('addBot', () => {
        const roomId = getRoomIdBySocket(socket);
        if (!roomId) return;

        const room = rooms[roomId];
        if (!room || room.gameState !== 'LOBBY') return;

        const player = room.players.find((p) => p.id === socket.id);
        if (!player || !player.isLeader) return;

        if (room.players.length >= MAX_PLAYERS) return;

        const bot = {
            id: `BOT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            sessionId: null,
            name: `Bot ${room.players.filter((p) => p.isBot).length + 1}`,
            isLeader: false,
            score: 0,
            hand: [],
            isBot: true,
            disconnectedAt: null,
            disconnectTimeout: null
        };

        room.players.push(bot);
        resetInactivityTimeout(roomId);
        emitRoomUpdate(roomId);
    });

    socket.on('removeBot', (botId) => {
        const roomId = getRoomIdBySocket(socket);
        if (!roomId) return;

        const room = rooms[roomId];
        if (!room || room.gameState !== 'LOBBY') return;

        const player = room.players.find((p) => p.id === socket.id);
        if (!player || !player.isLeader) return;

        let botIndex;
        if (botId) {
            botIndex = room.players.findIndex((p) => p.id === botId && p.isBot);
        } else {
            // Remove the last bot
            for (let i = room.players.length - 1; i >= 0; i--) {
                if (room.players[i].isBot) { botIndex = i; break; }
            }
        }
        if (botIndex === undefined || botIndex === -1) return;

        room.players.splice(botIndex, 1);
        resetInactivityTimeout(roomId);
        emitRoomUpdate(roomId);
    });

    socket.on('submitAnswer', (payload) => {
        const roomId = getRoomIdBySocket(socket);
        if (!roomId) return;

        const room = rooms[roomId];
        if (!room || room.gameState !== 'ANSWERING') return;

        const player = room.players.find((p) => p.id === socket.id);
        if (!player) return;

        const czar = getCurrentCzar(room);
        if (!czar || player.id === czar.id) return;

        if (room.submittedAnswers.some((a) => a.playerId === player.id)) return;

        let cardContent = '';
        let jokerText = '';

        if (typeof payload === 'string') {
            cardContent = payload;
        } else if (payload && typeof payload === 'object') {
            if (typeof payload.cardContent === 'string') {
                cardContent = payload.cardContent;
            }
            if (typeof payload.jokerText === 'string') {
                jokerText = payload.jokerText;
            }
        }

        cardContent = cardContent.trim();
        if (!cardContent) return;

        const isJokerCard = cardContent === JOKER_CARD_TOKEN;
        const normalizedJokerText = jokerText.trim();
        if (isJokerCard) {
            if (!normalizedJokerText) {
                socket.emit('error', 'Wpisz treść dla karty JOKER.');
                return;
            }
            if (normalizedJokerText.length > JOKER_MAX_ANSWER_LENGTH) {
                socket.emit('error', `Treść JOKERA może mieć maksymalnie ${JOKER_MAX_ANSWER_LENGTH} znaków.`);
                return;
            }
        }

        const cardIndex = player.hand.indexOf(cardContent);
        if (cardIndex === -1) return;

        player.hand.splice(cardIndex, 1);
        room.submittedAnswers.push({
            playerId: player.id,
            card: isJokerCard ? normalizedJokerText : cardContent
        });

        emitPlayerUpdate(player);
        resetInactivityTimeout(roomId);
        emitRoomUpdate(roomId);

        checkAllAnswered(roomId);
    });

    socket.on('swapHand', () => {
        const roomId = getRoomIdBySocket(socket);
        if (!roomId) return;

        const room = rooms[roomId];
        if (!room || room.gameState !== 'ANSWERING') return;
        if (!room.allowSwap) return;

        const player = room.players.find((p) => p.id === socket.id);
        if (!player || player.isBot) return;

        const czar = getCurrentCzar(room);
        if (!czar || player.id === czar.id) return;

        if (room.submittedAnswers.some((a) => a.playerId === player.id)) return;
        if (player.hasUsedSwap) return;

        const handSize = player.hand.length || 7;
        player.hand = [];
        player.hasUsedSwap = true;

        let drawn = 0;
        while (drawn < handSize && room.answerDeck.length > 0) {
            player.hand.push(room.answerDeck.pop());
            drawn++;
        }

        resetInactivityTimeout(roomId);
        emitPlayerUpdate(player);
        emitRoomUpdate(roomId);
    });

    socket.on('chooseWinner', (submittedAnswerPlayerId) => {
        const roomId = getRoomIdBySocket(socket);
        if (!roomId) return;

        const room = rooms[roomId];
        if (!room || room.gameState !== 'JUDGING') return;

        const player = room.players.find((p) => p.id === socket.id);
        const czar = getCurrentCzar(room);
        if (!player || !czar || player.id !== czar.id) return;

        resetInactivityTimeout(roomId);
        endRound(roomId, submittedAnswerPlayerId);
    });

    socket.on('startNextRound', () => {
        const roomId = getRoomIdBySocket(socket);
        if (!roomId) return;

        const room = rooms[roomId];
        if (!room || room.gameState !== 'ROUND_PAUSE') return;

        const player = room.players.find((p) => p.id === socket.id);
        const czar = getCurrentCzar(room);
        if (!player || !czar || player.id !== czar.id) return;

        if (room.questionDeck.length === 0) {
            endGame(roomId, 'Wyczerpały się pytania.');
            return;
        }

        resetInactivityTimeout(roomId);
        startCountdown(roomId);
    });

    socket.on('decideNewGame', (decision) => {
        const roomId = getRoomIdBySocket(socket);
        if (!roomId) return;

        const room = rooms[roomId];
        if (!room || room.gameState !== 'ENDED') return;

        const player = room.players.find((p) => p.id === socket.id);
        if (!player || !player.isLeader) return;

        clearRestartDecisionTimeout(room);
        resetInactivityTimeout(roomId);

        if (!decision) {
            cleanupRoom(roomId, 'leader_declined');
            return;
        }

        if (room.players.length < 2) {
            room.gameState = 'LOBBY';
            room.endReason = null;
            room.winnerName = null;
            room.roundTimeRemaining = 0;
            emitRoomUpdate(roomId);
            return;
        }

        if (!questionDeck.length || !answerDeck.length) {
            socket.emit('error', 'Talie nie są jeszcze gotowe. Spróbuj ponownie za chwilę.');
            room.gameState = 'LOBBY';
            emitRoomUpdate(roomId);
            return;
        }

        resetRoomForNewGame(room);
        room.players.forEach((p) => emitPlayerUpdate(p));
        startCountdown(roomId);
    });

    socket.on('disconnect', () => {
        const playerContext = getPlayerBySocketId(socket.id);
        if (!playerContext) return;

        const { roomId, room, player } = playerContext;
        if (!room || !player || player.isBot) return;

        player.disconnectedAt = Date.now();

        if (player.disconnectTimeout) {
            clearTimeout(player.disconnectTimeout);
        }

        const disconnectedSocketId = socket.id;
        const disconnectedSessionId = player.sessionId;

        player.disconnectTimeout = setTimeout(() => {
            const activeRoom = rooms[roomId];
            if (!activeRoom) return;

            const stalePlayer = activeRoom.players.find(
                (p) => !p.isBot && p.sessionId === disconnectedSessionId
            );

            if (!stalePlayer) return;
            if (!stalePlayer.disconnectedAt) return;
            if (stalePlayer.id !== disconnectedSocketId) return;

            removePlayerFromRoom(roomId, stalePlayer.id);
        }, RECONNECT_GRACE_MS);

        emitRoomUpdate(roomId);
    });
});

function getRoomIdBySocket(socket) {
    for (const [id, room] of Object.entries(rooms)) {
        if (room.players.find((p) => p.id === socket.id)) return id;
    }
    return null;
}

function getRoomPublicData(room, viewerId) {
    const czar = getCurrentCzar(room);
    const viewer = room.players.find((p) => p.id === viewerId) || null;
    const viewerIsCzar = !!(viewer && czar && viewer.id === czar.id);
    const viewerHasSubmitted = !!(viewer && room.submittedAnswers.some((a) => a.playerId === viewer.id));
    const revealToEveryone = ['JUDGING', 'SCORING', 'ROUND_PAUSE'].includes(room.gameState);
    const revealToSubmittedPlayers = room.gameState === 'ANSWERING' && viewer && !viewerIsCzar && viewerHasSubmitted;

    let submittedAnswers = [];
    if (revealToEveryone) {
        if (room.gameState === 'JUDGING' && !viewerIsCzar) {
            // During judging, non-czar players can see cards but not technical owner IDs.
            submittedAnswers = room.submittedAnswers.map((answer) => ({
                card: answer.card,
                playerId: null
            }));
        } else {
            submittedAnswers = room.submittedAnswers;
        }
    } else if (revealToSubmittedPlayers) {
        submittedAnswers = room.submittedAnswers.map((answer) => ({
            card: answer.card,
            playerId: null
        }));
    }

    return {
        id: room.id,
        players: room.players.map((p) => ({
            id: p.id,
            name: p.name,
            isLeader: p.isLeader,
            score: p.score,
            hasSubmitted: room.submittedAnswers.some((a) => a.playerId === p.id),
            isCzar: czar ? czar.id === p.id : false,
            isConnected: p.isBot ? true : !p.disconnectedAt
        })),
        gameState: room.gameState,
        roundLimit: room.roundLimit,
        currentQuestion: room.currentQuestion,
        submittedAnswers,
        submittedCount: room.submittedAnswers.length,
        timeRemaining: room.roundTimeRemaining,
        czarId: czar ? czar.id : null,
        winnerName: room.winnerName,
        roundNumber: room.roundNumber,
        roundWinnerId: room.roundWinnerId,
        roundWinnerCard: room.roundWinnerCard,
        roundWinnerName: room.roundWinnerName,
        canStartNextRound: room.gameState === 'ROUND_PAUSE' && viewerIsCzar,
        canDecideRestart: room.gameState === 'ENDED' && !!(viewer && viewer.isLeader),
        canSwapHand: room.gameState === 'ANSWERING' && room.allowSwap && !!(viewer && !viewerIsCzar && !viewerHasSubmitted && !viewer.hasUsedSwap),
        allowSwap: room.allowSwap,
        allowJoker: room.allowJoker,
        endReason: room.endReason
    };
}

function shuffle(array) {
    let currentIndex = array.length;
    let randomIndex;

    while (currentIndex !== 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex -= 1;

        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }

    return array;
}

function tryDrawJokerForPlayer(player) {
    if (!player || player.isBot) return false;
    if (Math.random() >= JOKER_DRAW_CHANCE) return false;

    player.hand.push(JOKER_CARD_TOKEN);
    notifyJokerAward(player);
    return true;
}

function replenishHands(room, handSize = 7, options = {}) {
    const { allowJoker = true } = options;
    if (!room || !room.players.length) return;

    let didDraw = true;
    while (didDraw) {
        didDraw = false;
        room.players.forEach((player) => {
            if (player.hand.length >= handSize) return;

            if (allowJoker && tryDrawJokerForPlayer(player)) {
                didDraw = true;
                return;
            }

            if (room.answerDeck.length === 0) return;

            player.hand.push(room.answerDeck.pop());
            didDraw = true;
        });
    }
}

function hasPlayableAnswersForRound(room) {
    const czar = getCurrentCzar(room);
    if (!czar) return false;
    return room.players.some((player) => player.id !== czar.id && player.hand.length > 0);
}

function resetRoomForNewGame(room) {
    room.questionDeck = shuffle([...questionDeck]);
    room.answerDeck = shuffle([...answerDeck]);
    room.roundNumber = 0;
    room.roundWinnerId = null;
    room.roundWinnerCard = null;
    room.roundWinnerName = null;
    room.winnerName = null;
    room.endReason = null;
    room.currentQuestion = null;
    room.submittedAnswers = [];
    room.roundTimeRemaining = 0;
    room.czarIndex = 0;
    clearRestartDecisionTimeout(room);
    clearRoomTimer(room);

    room.players.forEach((player) => {
        player.score = 0;
        player.hand = [];
        player.hasUsedSwap = false;
    });
    replenishHands(room, 7, { allowJoker: false });
}

function startCountdown(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    clearRoomTimer(room);
    room.gameState = 'COUNTDOWN';
    room.currentQuestion = null;
    room.roundTimeRemaining = 5;

    emitRoomUpdate(roomId);
    io.to(roomId).emit('timerUpdate', room.roundTimeRemaining);

    room.timerInterval = setInterval(() => {
        const liveRoom = rooms[roomId];
        if (!liveRoom) return;

        liveRoom.roundTimeRemaining -= 1;
        io.to(roomId).emit('timerUpdate', liveRoom.roundTimeRemaining);

        if (liveRoom.roundTimeRemaining <= 0) {
            clearRoomTimer(liveRoom);
            startRound(roomId);
        }
    }, 1000);
}

function startRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.players.length === 0) {
        cleanupRoom(roomId);
        return;
    }

    if (room.questionDeck.length === 0) {
        endGame(roomId, 'Wyczerpały się pytania.');
        return;
    }

    if (!hasPlayableAnswersForRound(room)) {
        endGame(roomId, 'Skończyły się karty odpowiedzi.');
        return;
    }

    room.currentQuestion = room.questionDeck.pop();
    room.gameState = 'ANSWERING';
    room.submittedAnswers = [];
    room.roundWinnerId = null;
    room.roundWinnerCard = null;
    room.roundWinnerName = null;
    room.roundTimeRemaining = ROUND_TIME_SECONDS;
    room.roundNumber += 1;

    emitRoomUpdate(roomId);
    io.to(roomId).emit('timerUpdate', room.roundTimeRemaining);

    const czar = getCurrentCzar(room);

    room.players
        .filter((p) => p.isBot && (!czar || p.id !== czar.id))
        .forEach((bot) => {
            setTimeout(() => {
                const liveRoom = rooms[roomId];
                if (!liveRoom || liveRoom.gameState !== 'ANSWERING') return;

                if (bot.hand.length === 0) return;

                const cardIndex = Math.floor(Math.random() * bot.hand.length);
                const [card] = bot.hand.splice(cardIndex, 1);

                liveRoom.submittedAnswers.push({
                    playerId: bot.id,
                    card
                });

                emitRoomUpdate(roomId);
                checkAllAnswered(roomId);
            }, Math.random() * 1_000 + 2_000);
        });

    clearRoomTimer(room);
    room.timerInterval = setInterval(() => {
        const liveRoom = rooms[roomId];
        if (!liveRoom) return;

        liveRoom.roundTimeRemaining -= 1;
        io.to(roomId).emit('timerUpdate', liveRoom.roundTimeRemaining);

        if (liveRoom.roundTimeRemaining <= 0) {
            clearRoomTimer(liveRoom);
            forceRandomAnswers(roomId);
            startJudging(roomId);
        }
    }, 1000);
}

function checkAllAnswered(roomId) {
    const room = rooms[roomId];
    if (!room || room.gameState !== 'ANSWERING') return;

    const czar = getCurrentCzar(room);
    if (!czar) return;

    const submittedPlayerIds = new Set(room.submittedAnswers.map((answer) => answer.playerId));
    const waitingPlayers = room.players.filter(
        (player) => player.id !== czar.id && player.hand.length > 0 && !submittedPlayerIds.has(player.id)
    );

    if (waitingPlayers.length === 0) {
        clearRoomTimer(room);
        startJudging(roomId);
    }
}

function forceRandomAnswers(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const czar = getCurrentCzar(room);
    if (!czar) return;

    room.players.forEach((player) => {
        if (player.id === czar.id) return;
        if (room.submittedAnswers.some((a) => a.playerId === player.id)) return;
        if (player.hand.length === 0) return;

        const nonJokerIndexes = player.hand
            .map((card, index) => (card === JOKER_CARD_TOKEN ? null : index))
            .filter((index) => index !== null);
        const cardIndex = nonJokerIndexes.length
            ? nonJokerIndexes[Math.floor(Math.random() * nonJokerIndexes.length)]
            : Math.floor(Math.random() * player.hand.length);

        const [card] = player.hand.splice(cardIndex, 1);
        const submittedCardText = card === JOKER_CARD_TOKEN ? 'JOKER (brak treści)' : card;

        room.submittedAnswers.push({
            playerId: player.id,
            card: submittedCardText
        });

        emitPlayerUpdate(player);
    });
}

function startJudging(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.gameState = 'JUDGING';
    room.roundTimeRemaining = ROUND_TIME_SECONDS;
    room.submittedAnswers = shuffle([...room.submittedAnswers]);

    emitRoomUpdate(roomId);

    if (!room.submittedAnswers.length) {
        endRound(roomId, null);
        return;
    }

    const czar = getCurrentCzar(room);

    if (czar && czar.isBot) {
        setTimeout(() => {
            const liveRoom = rooms[roomId];
            if (!liveRoom || liveRoom.gameState !== 'JUDGING') return;

            const winner = liveRoom.submittedAnswers[Math.floor(Math.random() * liveRoom.submittedAnswers.length)];
            endRound(roomId, winner ? winner.playerId : null);
        }, 5_000);
        return;
    }

    clearRoomTimer(room);
    room.timerInterval = setInterval(() => {
        const liveRoom = rooms[roomId];
        if (!liveRoom) return;

        liveRoom.roundTimeRemaining -= 1;
        io.to(roomId).emit('timerUpdate', liveRoom.roundTimeRemaining);

        if (liveRoom.roundTimeRemaining <= 0) {
            clearRoomTimer(liveRoom);
            const randomWinner = liveRoom.submittedAnswers[Math.floor(Math.random() * liveRoom.submittedAnswers.length)];
            endRound(roomId, randomWinner ? randomWinner.playerId : null);
        }
    }, 1000);
}

function enterRoundPause(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.gameState = 'ROUND_PAUSE';
    room.roundTimeRemaining = 0;

    if (room.players.length > 0) {
        room.czarIndex = (room.czarIndex + 1) % room.players.length;
    }

    replenishHands(room, 7, { allowJoker: room.allowJoker });
    room.players.forEach((player) => {
        emitPlayerUpdate(player);
    });

    io.to(roomId).emit('timerUpdate', 0);
    emitRoomUpdate(roomId);

    const nextCzar = getCurrentCzar(room);
    if (nextCzar && nextCzar.isBot) {
        setTimeout(() => {
            const liveRoom = rooms[roomId];
            if (!liveRoom || liveRoom.gameState !== 'ROUND_PAUSE') return;

            if (liveRoom.questionDeck.length === 0) {
                endGame(roomId, 'Wyczerpały się pytania.');
                return;
            }

            startCountdown(roomId);
        }, 4_000);
    }
}

function endRound(roomId, winnerId) {
    const room = rooms[roomId];
    if (!room) return;

    clearRoomTimer(room);

    let winnerName = null;
    if (winnerId) {
        const winner = room.players.find((p) => p.id === winnerId);
        if (winner) {
            winner.score += 1;
            winnerName = winner.name;
        }
    }

    const winnerAnswer = room.submittedAnswers.find((a) => a.playerId === winnerId);

    room.roundWinnerId = winnerId || null;
    room.roundWinnerCard = winnerAnswer ? winnerAnswer.card : null;
    room.roundWinnerName = winnerName;

    const roundLimit = parseRoundLimit(room.roundLimit);
    const isFinalRound = roundLimit !== null && room.roundNumber >= roundLimit;

    room.gameState = 'SCORING';
    room.roundTimeRemaining = 0;

    io.to(roomId).emit('timerUpdate', 0);
    emitRoomUpdate(roomId);

    const scoringDelay = isFinalRound ? FINAL_ROUND_REVEAL_MS : ROUND_SCORING_DELAY_MS;
    setTimeout(() => {
        const liveRoom = rooms[roomId];
        if (!liveRoom || liveRoom.gameState !== 'SCORING') return;

        if (isFinalRound) {
            endGame(roomId, `Osiągnięto ustalony limit rund (${roundLimit}).`);
            return;
        }

        enterRoundPause(roomId);
    }, scoringDelay);
}

function endGame(roomId, reason = 'Gra zakończona.') {
    const room = rooms[roomId];
    if (!room) return;

    clearRoomTimer(room);
    clearRestartDecisionTimeout(room);

    room.gameState = 'ENDED';
    room.roundTimeRemaining = 0;
    room.endReason = reason;

    const sortedPlayers = [...room.players].sort((a, b) => b.score - a.score);
    const winner = sortedPlayers[0];
    room.winnerName = winner ? winner.name : 'Brak zwycięzcy';

    room.restartDecisionTimeout = setTimeout(() => {
        cleanupRoom(roomId, 'decision_timeout');
    }, GAME_END_DECISION_TIMEOUT_MS);

    io.to(roomId).emit('timerUpdate', 0);
    emitRoomUpdate(roomId);
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
