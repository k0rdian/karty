const socket = io();

// ── GSAP Fallback (if CDN fails to load) ──
if (typeof gsap === 'undefined') {
    const noop = () => {};
    const noopTl = () => ({ from: noopTl, to: noopTl, fromTo: noopTl, kill: noop, clear: noop });
    window.gsap = { from: noop, to: noop, fromTo: noop, set: noop, killTweensOf: noop, timeline: noopTl };
}

const loginScreen = document.getElementById('login-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');
const winnerScreen = document.getElementById('winner-screen');

const passwordInput = document.getElementById('password-input');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');

const usernameInput = document.getElementById('username-input');
const roomGrid = document.getElementById('room-grid');
const lobbyError = document.getElementById('lobby-error');

// Generate 20 room cards dynamically
const TOTAL_ROOMS = 20;
let roomStatusInterval = null;

function createRoomCards() {
    roomGrid.innerHTML = '';
    for (let i = 1; i <= TOTAL_ROOMS; i++) {
        const card = document.createElement('div');
        card.className = 'room-card';
        card.dataset.room = i;
        card.id = `room-card-${i}`;
        card.innerHTML = `
            <svg class="room-indicator" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">
                <circle class="indicator-pulse" cx="5" cy="5" r="3.5"/>
                <circle class="indicator-dot" cx="5" cy="5" r="2.5"/>
            </svg>
            <span class="room-number">${i}</span>
            <span class="room-status" id="room-status-${i}">Wolny</span>
        `;
        card.addEventListener('click', () => {
            const name = usernameInput.value.trim();
            if (!name) {
                lobbyError.textContent = 'Wpisz imię!';
                return;
            }
            lobbyError.textContent = '';
            localStorage.setItem(STORAGE_KEYS.name, name);
            localStorage.setItem(STORAGE_KEYS.room, String(i));
            currentRoomId = String(i);
            socket.emit('joinRoom', { roomNumber: i, playerName: name, sessionId, isRestore: false });
        });
        roomGrid.appendChild(card);
    }
}

function fetchRoomStatuses() {
    fetch('/api/rooms')
        .then(res => res.json())
        .then(statuses => {
            statuses.forEach(room => {
                const card = document.getElementById(`room-card-${room.id}`);
                const statusEl = document.getElementById(`room-status-${room.id}`);
                if (!card || !statusEl) return;

                const isInGame = room.gameState && room.gameState !== 'LOBBY';
                const isLobby = room.gameState === 'LOBBY';

                card.classList.toggle('in-game', isInGame);

                if (isInGame) {
                    statusEl.textContent = `W grze (${room.playerCount})`;
                } else if (isLobby) {
                    statusEl.textContent = `Lobby (${room.playerCount})`;
                } else {
                    statusEl.textContent = 'Wolny';
                }
            });
        })
        .catch(() => { /* silent fail */ });
}

function startRoomStatusPolling() {
    fetchRoomStatuses();
    if (roomStatusInterval) clearInterval(roomStatusInterval);
    roomStatusInterval = setInterval(fetchRoomStatuses, 5000);
}

function stopRoomStatusPolling() {
    if (roomStatusInterval) {
        clearInterval(roomStatusInterval);
        roomStatusInterval = null;
    }
}

createRoomCards();

const timerEl = document.getElementById('timer');
const roundInfoEl = document.getElementById('round-info');
const questionTextEl = document.getElementById('question-text');
const questionArea = document.getElementById('question-area');
const questionCardEl = questionArea.querySelector('.black-card');
const statusTextEl = document.getElementById('status-text');

const answersTitle = document.getElementById('answers-title');
const submittedArea = document.getElementById('submitted-answers-area');
const winnerBanner = document.getElementById('round-winner-banner');
const jokerBackdrop = document.getElementById('joker-backdrop');

const handArea = document.getElementById('hand-area');
const handWrapper = document.getElementById('hand-wrapper');
const jokerComposer = document.getElementById('joker-composer');
const jokerInput = document.getElementById('joker-input');
const jokerCounter = document.getElementById('joker-counter');
const jokerCancelBtn = document.getElementById('joker-cancel-btn');
const jokerSubmitBtn = document.getElementById('joker-submit-btn');
const confirmSelectionBtn = document.getElementById('confirm-selection-btn');
const swapHandBtn = document.getElementById('swap-hand-btn');
const startNextRoundBtn = document.getElementById('start-next-round-btn');

const gameSettings = document.getElementById('game-settings');
const startGameBtn = document.getElementById('start-game-btn');
const roundLimitInput = document.getElementById('round-limit-input');
const roundDisplay = document.getElementById('round-display');
const roundMinusBtn = document.getElementById('round-minus-btn');
const roundPlusBtn = document.getElementById('round-plus-btn');
const botCountDisplay = document.getElementById('bot-count-display');
const botMinusBtn = document.getElementById('bot-minus-btn');
const botPlusBtn = document.getElementById('bot-plus-btn');
const allowSwapCheck = document.getElementById('allow-swap-check');
const allowJokerCheck = document.getElementById('allow-joker-check');

const scoreList = document.getElementById('score-list');
const winnerNameEl = document.getElementById('winner-name');
const gameEndReasonEl = document.getElementById('game-end-reason');
const restartYesBtn = document.getElementById('restart-yes-btn');
const restartNoBtn = document.getElementById('restart-no-btn');
const restartStatusEl = document.getElementById('restart-status');

const roundTransition = document.getElementById('round-transition');
const transitionTitle = document.getElementById('transition-title');
const transitionSubtitle = document.getElementById('transition-subtitle');

const STORAGE_KEYS = {
    auth: 'cah_auth',
    room: 'cah_room',
    name: 'cah_name',
    session: 'cah_session_id'
};

const MIN_ROUNDS = 10;
const MAX_ROUNDS = 100;
const JOKER_CARD_TOKEN = '__JOKER_CARD__';
const JOKER_MAX_TEXT_LENGTH = 100;

let myPlayerId = null;
let currentRoomId = null;
let isLeader = false;
let isCzar = false;
let hasSubmitted = false;

let latestHand = [];
let selectedCardIndex = null;
let currentGameState = 'LOBBY';
let lastTransitionKey = '';
let questionMinimizeTimeout = null;
let transitionTimeout = null;

// ── GSAP animation tracking state ──
let prevHandContent = '';
let prevSubmittedKey = '';
let prevScores = {};
let prevQuestion = '';
let overlayTimeline = null;
let swiperInstance = null;

const sessionId = ensureSessionId();

hydrateFromStorage();
updateJokerCounter();

loginBtn.addEventListener('click', () => {
    const password = passwordInput.value;

    socket.emit('login', password, (response) => {
        if (response.success) {
            localStorage.setItem(STORAGE_KEYS.auth, '1');
            loginError.textContent = '';

            gsap.to(loginScreen, {
                opacity: 0,
                scale: 0.96,
                duration: 0.25,
                ease: 'power2.in',
                force3D: true,
                onComplete: () => {
                    loginScreen.classList.remove('active');
                    gsap.set(loginScreen, { clearProps: 'all' });
                    lobbyScreen.classList.add('active');
                    startRoomStatusPolling();
                    gsap.from(lobbyScreen, {
                        opacity: 0,
                        y: 20,
                        duration: 0.35,
                        ease: 'power2.out',
                        force3D: true,
                        clearProps: 'all'
                    });
                }
            });

            tryRestoreSession();
            return;
        }

        loginError.textContent = response.message;
    });
});

// Room card click handlers are set up in createRoomCards()

startGameBtn.addEventListener('click', () => {
    const roundLimit = parseInt(roundLimitInput.value, 10);
    if (!Number.isInteger(roundLimit) || roundLimit < MIN_ROUNDS || roundLimit > MAX_ROUNDS) {
        alert(`Liczba rund musi być liczbą całkowitą od ${MIN_ROUNDS} do ${MAX_ROUNDS}.`);
        return;
    }

    const settings = {
        roundLimit,
        allowSwap: allowSwapCheck.checked,
        allowJoker: allowJokerCheck.checked,
    };

    socket.emit('startGame', settings);
});

roundMinusBtn.addEventListener('click', () => {
    const val = parseInt(roundLimitInput.value, 10) || MIN_ROUNDS;
    const newVal = Math.max(MIN_ROUNDS, val - 5);
    roundLimitInput.value = newVal;
    roundDisplay.textContent = newVal;
});

roundPlusBtn.addEventListener('click', () => {
    const val = parseInt(roundLimitInput.value, 10) || MIN_ROUNDS;
    const newVal = Math.min(MAX_ROUNDS, val + 5);
    roundLimitInput.value = newVal;
    roundDisplay.textContent = newVal;
});

botPlusBtn.addEventListener('click', () => {
    socket.emit('addBot');
});

botMinusBtn.addEventListener('click', () => {
    socket.emit('removeBot');
});

startNextRoundBtn.addEventListener('click', () => {
    socket.emit('startNextRound');
});

swapHandBtn.addEventListener('click', () => {
    if (!confirm('Czy na pewno chcesz przetasować swoje karty?\nWymiana jest możliwa tylko raz w trakcie rozgrywki.')) return;
    socket.emit('swapHand');
    swapHandBtn.classList.add('hidden');
});

restartYesBtn.addEventListener('click', () => {
    socket.emit('decideNewGame', true);
});

restartNoBtn.addEventListener('click', () => {
    socket.emit('decideNewGame', false);
});

function submitSelectedCard() {
    if (selectedCardIndex === null) return;
    const selectedCard = latestHand[selectedCardIndex];
    if (!selectedCard) return;

    const payload = { cardContent: selectedCard };
    if (isJokerCard(selectedCard)) {
        const jokerText = jokerInput.value.trim();
        if (!jokerText) {
            alert('Wpisz treść dla karty JOKER (max 100 znaków).');
            jokerInput.focus();
            return;
        }
        if (jokerText.length > JOKER_MAX_TEXT_LENGTH) {
            alert(`Treść JOKERA może mieć maksymalnie ${JOKER_MAX_TEXT_LENGTH} znaków.`);
            jokerInput.focus();
            return;
        }
        payload.jokerText = jokerText;
    }

    socket.emit('submitAnswer', payload);
    hasSubmitted = true;
    selectedCardIndex = null;
    jokerInput.value = '';
    updateJokerCounter();
    statusTextEl.textContent = 'Odpowiedź wysłana. Czekaj na innych.';
    renderHand(latestHand);
}

confirmSelectionBtn.addEventListener('click', () => {
    if (selectedCardIndex === null) return;
    const selectedCard = latestHand[selectedCardIndex];
    if (!selectedCard) return;

    if (isJokerCard(selectedCard)) {
        // Open the composer for the user to type their answer
        jokerInput.value = '';
        updateJokerCounter();
        setJokerComposerVisible(true);
        jokerInput.focus();
        return;
    }

    submitSelectedCard();
});

jokerSubmitBtn.addEventListener('click', submitSelectedCard);

jokerCancelBtn.addEventListener('click', () => {
    setJokerComposerVisible(false);
});

jokerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        submitSelectedCard();
    }
});

jokerInput.addEventListener('input', () => {
    if (jokerInput.value.length > JOKER_MAX_TEXT_LENGTH) {
        jokerInput.value = jokerInput.value.slice(0, JOKER_MAX_TEXT_LENGTH);
    }
    updateJokerCounter();
});

socket.on('connect', () => {
    tryRestoreSession();
});

socket.on('updateRoom', (roomData) => {
    currentGameState = roomData.gameState;

    showGameScreen();

    const myPlayer = roomData.players.find((player) => player.id === myPlayerId || player.id === socket.id);
    if (myPlayer) {
        myPlayerId = myPlayer.id;
        isLeader = myPlayer.isLeader;
        isCzar = myPlayer.isCzar;
        hasSubmitted = myPlayer.hasSubmitted;
    }

    currentRoomId = roomData.id;
    localStorage.setItem(STORAGE_KEYS.room, roomData.id);
    syncRoundLimitState(roomData.roundLimit);

    if (isLeader && roomData.gameState === 'LOBBY') {
        gameSettings.classList.remove('hidden');
        questionArea.classList.add('hidden');
        // Sync bot count display
        const botCount = roomData.players.filter(p => p.id && p.id.startsWith('BOT-')).length;
        botCountDisplay.textContent = botCount;
    } else {
        gameSettings.classList.add('hidden');
        if (roomData.gameState !== 'LOBBY') {
            questionArea.classList.remove('hidden');
        }
    }

    if (roomData.canStartNextRound) {
        startNextRoundBtn.classList.remove('hidden');
    } else {
        startNextRoundBtn.classList.add('hidden');
    }

    if (roomData.canSwapHand && roomData.allowSwap !== false) {
        swapHandBtn.classList.remove('hidden');
    } else {
        swapHandBtn.classList.add('hidden');
    }

    roundInfoEl.textContent = getRoundInfoText(roomData);
    statusTextEl.textContent = getStatusText(roomData);

    renderQuestionContent(roomData);

    updateQuestionArea(roomData.gameState);
    updateScoreboard(roomData.players, roomData.czarId);
    renderSubmittedAnswers(roomData);
    renderWinnerBanner(roomData);
    renderHand(latestHand);
    showRoundTransition(roomData);

    if (roomData.gameState === 'ENDED') {
        gameScreen.classList.remove('active');
        winnerScreen.classList.add('active');

        gsap.from(winnerScreen, {
            opacity: 0,
            y: 20,
            scale: 0.95,
            duration: 0.5,
            ease: 'back.out(1.5)',
            force3D: true,
            clearProps: 'all'
        });

        winnerNameEl.textContent = roomData.winnerName ? `Wygrywa: ${roomData.winnerName}` : 'Brak zwycięzcy';
        gameEndReasonEl.textContent = roomData.endReason || '';

        if (roomData.canDecideRestart) {
            restartYesBtn.classList.remove('hidden');
            restartNoBtn.classList.remove('hidden');
            restartStatusEl.textContent = 'Jako lider wybierz: TAK lub NIE (2 minuty na decyzję).';
        } else {
            restartYesBtn.classList.add('hidden');
            restartNoBtn.classList.add('hidden');
            restartStatusEl.textContent = 'Oczekiwanie na decyzję lidera (max 2 minuty).';
        }
    }
});

socket.on('updatePlayer', (playerData) => {
    latestHand = playerData.hand || [];
    renderHand(latestHand);
});

socket.on('timerUpdate', (time) => {
    timerEl.textContent = String(time);
    timerEl.classList.toggle('danger', time <= 5);

    if (time <= 5) {
        gsap.fromTo(timerEl,
            { scale: 1.15 },
            { scale: 1, duration: 0.25, ease: 'power2.out', force3D: true, overwrite: 'auto' }
        );
    }

    if (currentGameState === 'COUNTDOWN') {
        renderCountdownCounter(time);
    }
});

socket.on('error', (msg) => {
    if (typeof msg === 'string' && msg.includes('Gra już trwa w tym pokoju.')) {
        localStorage.removeItem(STORAGE_KEYS.room);
        currentRoomId = null;
    }

    alert(msg);
});

socket.on('jokerAwarded', () => {
    showOverlay('ZDOBYŁEŚ JOKERA', 'Masz specjalną kartę. Wpisz własną odpowiedź (max 100 znaków).');
});

socket.on('roomClosed', ({ reason }) => {
    resetToFreshEntry();
    if (reason === 'leader_declined') {
        alert('Lider zakończył sesję. Pokój został zwolniony.');
    } else if (reason === 'decision_timeout') {
        alert('Brak decyzji przez 2 minuty. Pokój został zwolniony.');
    } else if (reason === 'expired') {
        alert('Poprzednia sesja wygasła. Dołącz ponownie od nowa.');
    } else if (reason === 'inactivity') {
        alert('Pokój został zwolniony z powodu braku aktywności przez 10 minut.');
    }
});

function ensureSessionId() {
    const stored = localStorage.getItem(STORAGE_KEYS.session);
    if (stored) return stored;

    const generated = window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    localStorage.setItem(STORAGE_KEYS.session, generated);
    return generated;
}

function hydrateFromStorage() {
    const savedName = localStorage.getItem(STORAGE_KEYS.name);
    if (savedName) {
        usernameInput.value = savedName;
    }

    if (localStorage.getItem(STORAGE_KEYS.auth) === '1') {
        loginScreen.classList.remove('active');
        lobbyScreen.classList.add('active');
        startRoomStatusPolling();
    }
}

function tryRestoreSession() {
    if (localStorage.getItem(STORAGE_KEYS.auth) !== '1') return;

    const savedRoom = currentRoomId || localStorage.getItem(STORAGE_KEYS.room);
    const savedName = localStorage.getItem(STORAGE_KEYS.name);

    if (!savedRoom || !savedName) return;

    currentRoomId = savedRoom;
    usernameInput.value = savedName;

    socket.emit('joinRoom', {
        roomNumber: savedRoom,
        playerName: savedName,
        sessionId,
        isRestore: true
    });
}

function resetToFreshEntry() {
    Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));

    myPlayerId = null;
    currentRoomId = null;
    isLeader = false;
    isCzar = false;
    hasSubmitted = false;
    latestHand = [];
    selectedCardIndex = null;
    currentGameState = 'LOBBY';
    lastTransitionKey = '';
    prevHandContent = '';
    prevSubmittedKey = '';
    prevScores = {};
    prevQuestion = '';

    if (overlayTimeline) {
        overlayTimeline.kill();
        overlayTimeline = null;
    }

    if (swiperInstance) {
        swiperInstance.destroy(true, true);
        swiperInstance = null;
    }
    handArea.innerHTML = '<div class="swiper-wrapper" id="hand-wrapper"></div>';
    submittedArea.innerHTML = '';
    answersTitle.classList.add('hidden');
    submittedArea.classList.add('hidden');
    winnerBanner.classList.add('hidden');
    setJokerComposerVisible(false);
    jokerInput.value = '';
    updateJokerCounter();
    confirmSelectionBtn.classList.add('hidden');
    startNextRoundBtn.classList.add('hidden');
    restartYesBtn.classList.add('hidden');
    restartNoBtn.classList.add('hidden');
    restartStatusEl.textContent = '';
    gameEndReasonEl.textContent = '';
    timerEl.classList.remove('danger');
    gsap.set(roundTransition, { opacity: 0 });
    roundTransition.classList.add('hidden');
    gameSettings.classList.add('hidden');
    roundLimitInput.value = '10';
    roundDisplay.textContent = '10';
    botCountDisplay.textContent = '0';
    allowSwapCheck.checked = true;
    allowJokerCheck.checked = true;
    clearCountdownCardStyle();

    winnerScreen.classList.remove('active');
    gameScreen.classList.remove('active');
    lobbyScreen.classList.remove('active');
    loginScreen.classList.add('active');
    stopRoomStatusPolling();
}

function syncRoundLimitState(roundLimit) {
    if (!Number.isInteger(roundLimit)) return;
    roundLimitInput.value = roundLimit;
    roundDisplay.textContent = roundLimit;
}

function isJokerCard(cardText) {
    return cardText === JOKER_CARD_TOKEN;
}

function updateJokerCounter() {
    jokerCounter.textContent = `${jokerInput.value.length}/${JOKER_MAX_TEXT_LENGTH}`;
}

function setJokerComposerVisible(visible) {
    if (visible) {
        jokerComposer.classList.remove('hidden');
        jokerBackdrop.classList.remove('hidden');
        document.body.classList.add('joker-popup-active');

        gsap.from(jokerComposer, {
            scale: 0.9,
            opacity: 0,
            y: 20,
            duration: 0.3,
            ease: 'power3.out',
            force3D: true,
            clearProps: 'transform,opacity'
        });
        gsap.from(jokerBackdrop, {
            opacity: 0,
            duration: 0.2,
            ease: 'power2.out',
            clearProps: 'opacity'
        });
        return;
    }

    jokerComposer.classList.add('hidden');
    jokerBackdrop.classList.add('hidden');
    document.body.classList.remove('joker-popup-active');
}

function getRoundInfoText(roomData) {
    if (roomData.roundNumber <= 0) {
        if (Number.isInteger(roomData.roundLimit)) {
            return `Przygotowanie (${roomData.roundLimit} rund)`;
        }
        return 'Przygotowanie';
    }

    if (Number.isInteger(roomData.roundLimit)) {
        return `Runda ${roomData.roundNumber}/${roomData.roundLimit}`;
    }

    return `Runda ${roomData.roundNumber}`;
}

function renderQuestionContent(roomData) {
    if (roomData.gameState === 'COUNTDOWN') {
        renderCountdownCounter(roomData.timeRemaining);
        return;
    }

    clearCountdownCardStyle();

    if (roomData.currentQuestion) {
        const isNewQuestion = roomData.currentQuestion !== prevQuestion;
        prevQuestion = roomData.currentQuestion;
        questionTextEl.textContent = roomData.currentQuestion;

        if (isNewQuestion) {
            gsap.from(questionCardEl, {
                rotateY: 90,
                opacity: 0,
                duration: 0.5,
                ease: 'power3.out',
                force3D: true,
                clearProps: 'transform,opacity'
            });
        }
    } else if (roomData.gameState === 'LOBBY') {
        questionTextEl.textContent = 'Czekaj na\nrozpoczęcie...';
    }
}

function renderCountdownCounter(time) {
    const counter = Number.isFinite(time) ? Math.max(0, Math.floor(time)) : 0;
    questionTextEl.textContent = String(counter);
    questionTextEl.classList.add('countdown-counter');
    questionCardEl.classList.add('countdown-card');

    gsap.fromTo(questionTextEl,
        { scale: 1.4, opacity: 0.3 },
        { scale: 1, opacity: 1, duration: 0.35, ease: 'power2.out', force3D: true, overwrite: 'auto' }
    );
}

function clearCountdownCardStyle() {
    questionTextEl.classList.remove('countdown-counter');
    questionCardEl.classList.remove('countdown-card');
}

function showGameScreen() {
    const wasActive = gameScreen.classList.contains('active');
    loginScreen.classList.remove('active');
    lobbyScreen.classList.remove('active');
    winnerScreen.classList.remove('active');
    gameScreen.classList.add('active');
    stopRoomStatusPolling();

    if (!wasActive) {
        gsap.from(gameScreen, {
            opacity: 0,
            duration: 0.4,
            ease: 'power2.out',
            clearProps: 'all'
        });
    }
}

function shouldHideHand() {
    return isCzar && ['COUNTDOWN', 'ANSWERING', 'JUDGING', 'SCORING', 'ROUND_PAUSE'].includes(currentGameState);
}

function renderHand(hand) {
    const wrapper = document.getElementById('hand-wrapper') || handWrapper;
    if (!wrapper) return;

    const canPickCard = currentGameState === 'ANSWERING' && !hasSubmitted && !shouldHideHand();
    if (!canPickCard) {
        if (swiperInstance) {
            swiperInstance.destroy(true, true);
            swiperInstance = null;
        }
        wrapper.innerHTML = '';
        handArea.classList.add('hidden');
        selectedCardIndex = null;
        prevHandContent = '';
        confirmSelectionBtn.classList.add('hidden');
        setJokerComposerVisible(false);
        return;
    }

    // Check if hand content actually changed (new deal)
    const newHandContent = hand.join('|||');
    const isNewDeal = newHandContent !== prevHandContent;

    if (!isNewDeal) {
        // Hand hasn't changed, just update selection visuals
        updateSelectionVisuals(hand);
        return;
    }

    prevHandContent = newHandContent;

    // Destroy previous swiper instance for fresh rebuild
    if (swiperInstance) {
        swiperInstance.destroy(true, true);
        swiperInstance = null;
    }

    wrapper.innerHTML = '';
    handArea.classList.remove('hidden');

    hand.forEach((cardText, index) => {
        const slide = document.createElement('div');
        slide.className = 'swiper-slide';

        const card = document.createElement('div');
        card.className = 'card white-card';
        card.dataset.cardIndex = index;
        if (isJokerCard(cardText)) {
            card.classList.add('joker-card');
            card.textContent = 'JOKER\nWpisz w\u0142asn\u0105 odpowied\u017a';
        } else {
            card.textContent = cardText;
        }

        if (index === selectedCardIndex) {
            card.classList.add('selected');
        }

        slide.appendChild(card);
        wrapper.appendChild(slide);
    });

    updateSelectionUI(hand);

    // Initialize Swiper with coverflow effect
    const initialSlide = selectedCardIndex !== null ? selectedCardIndex : Math.floor(hand.length / 2);

    swiperInstance = new Swiper('#hand-area', {
        effect: 'coverflow',
        grabCursor: true,
        centeredSlides: true,
        slidesPerView: 'auto',
        initialSlide: initialSlide,
        coverflowEffect: {
            rotate: 12,
            stretch: 80,
            depth: 50,
            modifier: 1,
            slideShadows: false,
        },
        spaceBetween: 10,
        keyboard: {
            enabled: true,
        },
        on: {
            slideChange: function () {
                const activeIdx = this.activeIndex;
                if (activeIdx === undefined || activeIdx < 0 || activeIdx >= hand.length) return;
                selectCard(activeIdx, hand);
            },
        },
    });

    // Auto-select the initially centered card
    selectCard(initialSlide, hand);

    // GSAP: Animate card deal
    const cards = wrapper.querySelectorAll('.card');
    gsap.from(cards, {
        y: 80,
        opacity: 0,
        scale: 0.85,
        duration: 0.4,
        stagger: 0.04,
        ease: 'power3.out',
        force3D: true,
        clearProps: 'transform,opacity'
    });
}

function selectCard(index, hand) {
    if (selectedCardIndex === index) return;
    selectedCardIndex = index;
    updateSelectionVisuals(hand);
}

function updateSelectionVisuals(hand) {
    const wrapper = document.getElementById('hand-wrapper');
    if (!wrapper) return;

    const allCards = wrapper.querySelectorAll('.card');
    allCards.forEach((card) => {
        const idx = parseInt(card.dataset.cardIndex, 10);
        card.classList.toggle('selected', idx === selectedCardIndex);
    });

    updateSelectionUI(hand);
}

function updateSelectionUI(hand) {
    confirmSelectionBtn.classList.add('hidden');
    confirmSelectionBtn.textContent = 'Wybierz';

    if (selectedCardIndex !== null && hand[selectedCardIndex]) {
        confirmSelectionBtn.classList.remove('hidden');
    } else {
        selectedCardIndex = null;
    }
}

function renderSubmittedAnswers(roomData) {
    const stateAllowsAnswers = ['ANSWERING', 'JUDGING', 'SCORING', 'ROUND_PAUSE'].includes(roomData.gameState);
    const shouldShowAnswers = stateAllowsAnswers && roomData.submittedAnswers.length > 0;

    if (!shouldShowAnswers) {
        answersTitle.classList.add('hidden');
        submittedArea.classList.add('hidden');
        submittedArea.innerHTML = '';
        prevSubmittedKey = '';
        return;
    }

    if (roomData.gameState === 'ANSWERING') {
        answersTitle.textContent = 'Nadesłane odpowiedzi';
    } else {
        answersTitle.textContent = 'Prezentacja odpowiedzi';
    }
    answersTitle.classList.remove('hidden');
    submittedArea.classList.remove('hidden');
    submittedArea.innerHTML = '';

    if (!roomData.submittedAnswers.length) {
        const empty = document.createElement('p');
        empty.className = 'answers-empty';
        empty.textContent = 'Brak odpowiedzi w tej rundzie.';
        submittedArea.appendChild(empty);
        return;
    }

    const newSubmittedKey = roomData.submittedAnswers.map(a => a.playerId + ':' + a.card).join('|||');
    const isNewReveal = newSubmittedKey !== prevSubmittedKey;
    prevSubmittedKey = newSubmittedKey;

    roomData.submittedAnswers.forEach((answer, index) => {
        const card = document.createElement('div');
        card.className = 'card white-card submitted-card';
        card.textContent = answer.card;
        card.dataset.owner = answer.playerId;

        if (['SCORING', 'ROUND_PAUSE'].includes(roomData.gameState) && answer.playerId === roomData.roundWinnerId) {
            card.classList.add('winner');
        }

        if (isCzar && roomData.gameState === 'JUDGING') {
            card.classList.add('pickable');
            card.title = 'Wybierz zwycięzcę';
            card.addEventListener('click', () => {
                socket.emit('chooseWinner', answer.playerId);
            });
        }

        submittedArea.appendChild(card);
    });

    // GSAP: Animate submitted cards
    if (isNewReveal) {
        const cards = submittedArea.querySelectorAll('.submitted-card');

        if (submittedArea.querySelector('.submitted-card.winner')) {
            // Winner round: quick reveal, CSS @keyframes handles glow pulse
            gsap.from(cards, {
                opacity: 0,
                y: 20,
                duration: 0.3,
                stagger: 0.05,
                ease: 'power2.out',
                force3D: true,
                clearProps: 'opacity'
            });
        } else {
            // Normal reveal: staggered slide-in
            gsap.from(cards, {
                opacity: 0,
                y: 40,
                scale: 0.9,
                duration: 0.4,
                stagger: 0.08,
                ease: 'power3.out',
                force3D: true,
                clearProps: 'transform,opacity'
            });
        }
    }
}

function renderWinnerBanner(roomData) {
    if (!['SCORING', 'ROUND_PAUSE'].includes(roomData.gameState)) {
        winnerBanner.classList.add('hidden');
        winnerBanner.textContent = '';
        return;
    }

    const wasHidden = winnerBanner.classList.contains('hidden');
    winnerBanner.classList.remove('hidden');

    if (!roomData.roundWinnerName) {
        winnerBanner.textContent = 'Runda bez punktu.';
    } else {
        winnerBanner.textContent = `Wygrywa: ${roomData.roundWinnerName}`;
    }

    if (wasHidden) {
        gsap.from(winnerBanner, {
            y: -20,
            opacity: 0,
            duration: 0.4,
            ease: 'power3.out',
            force3D: true,
            clearProps: 'transform,opacity'
        });
    }
}

function updateScoreboard(players, czarId) {
    const newScores = {};
    players.forEach(p => { newScores[p.id] = p.score; });

    scoreList.innerHTML = '';

    players.forEach((player) => {
        const li = document.createElement('li');

        const offlineSuffix = player.isConnected ? '' : ' (offline)';
        li.textContent = `${player.name}${offlineSuffix}: ${player.score}`;

        if (player.isLeader) li.classList.add('leader');
        if (player.id === czarId) li.classList.add('czar');


        scoreList.appendChild(li);

        // GSAP: Highlight score change
        if (prevScores[player.id] !== undefined && prevScores[player.id] !== player.score) {
            gsap.fromTo(li,
                { backgroundColor: 'rgba(16, 185, 129, 0.4)' },
                { backgroundColor: 'rgba(255, 255, 255, 0.06)', duration: 1, ease: 'power2.out' }
            );
        }
    });

    prevScores = newScores;
}

function updateQuestionArea(gameState) {
    if (questionMinimizeTimeout) {
        clearTimeout(questionMinimizeTimeout);
        questionMinimizeTimeout = null;
    }

    questionArea.classList.remove('minimized');
}

function showRoundTransition(roomData) {
    const czarName = roomData.players.find((p) => p.id === roomData.czarId)?.name || 'Sędzia';
    const transitionKey = `${roomData.gameState}-${roomData.roundNumber}-${roomData.roundWinnerId || 'none'}`;

    if (transitionKey === lastTransitionKey) return;
    lastTransitionKey = transitionKey;

    if (roomData.gameState === 'COUNTDOWN') {
        showOverlay('Nowa runda za chwilę', `Sędzia: ${czarName}`);
        return;
    }

    if (roomData.gameState === 'ANSWERING') {
        showOverlay('Wybór odpowiedzi', isCzar ? 'Czekaj na odpowiedzi graczy.' : 'Wybierz kartę i zatwierdź.');
        return;
    }

    if (roomData.gameState === 'JUDGING') {
        showOverlay('Prezentacja odpowiedzi', isCzar ? 'Kliknij kartę, która wygrywa.' : `${czarName} wybiera zwycięzcę.`);
        return;
    }

    if (roomData.gameState === 'SCORING') {
        if (roomData.roundWinnerName) {
            showOverlay(`Punkt dla ${roomData.roundWinnerName}`, roomData.roundWinnerCard || '');
        } else {
            showOverlay('Brak punktu w tej rundzie', 'Przechodzimy dalej.');
        }
        return;
    }

    if (roomData.gameState === 'ROUND_PAUSE') {
        if (roomData.canStartNextRound) {
            showOverlay('Przerwa po rundzie', 'Jako nowy sędzia kliknij "Start nowej rundy".');
        } else {
            showOverlay('Przerwa po rundzie', 'Nowy sędzia przygotowuje kolejną rundę.');
        }
    }
}

function showOverlay(title, subtitle) {
    transitionTitle.textContent = title;
    transitionSubtitle.textContent = subtitle;

    roundTransition.classList.remove('hidden');

    if (overlayTimeline) {
        overlayTimeline.kill();
    }

    const content = roundTransition.querySelector('.round-transition-content');

    overlayTimeline = gsap.timeline();

    // Enter: fade in backdrop, then scale in content
    overlayTimeline.fromTo(roundTransition,
        { opacity: 0 },
        { opacity: 1, duration: 0.25, ease: 'power2.out' }
    );
    overlayTimeline.from(content, {
        scale: 0.9,
        y: 20,
        duration: 0.3,
        ease: 'power3.out',
        force3D: true,
        clearProps: 'transform'
    }, '-=0.1');

    // Exit: slide content up, fade out backdrop
    overlayTimeline.to(content, {
        scale: 0.95,
        y: -10,
        opacity: 0,
        duration: 0.2,
        ease: 'power2.in',
        force3D: true
    }, '+=1.2');
    overlayTimeline.to(roundTransition, {
        opacity: 0,
        duration: 0.15,
        ease: 'power2.in',
        onComplete: () => {
            roundTransition.classList.add('hidden');
            gsap.set(content, { clearProps: 'all' });
        }
    }, '-=0.05');
}

function getStatusText(room) {
    if (room.gameState === 'LOBBY') {
        if (isLeader) {
            return `Lobby - ustaw liczbę rund (${MIN_ROUNDS}-${MAX_ROUNDS}) i rozpocznij grę.`;
        }
        return 'Lobby - oczekiwanie na start.';
    }

    if (room.gameState === 'COUNTDOWN') {
        return 'Przygotujcie się, zaraz start rundy.';
    }

    if (room.gameState === 'ANSWERING') {
        if (isCzar) {
            const totalNeeded = Math.max(room.players.length - 1, 0);
            return `Jesteś sędzią. Odpowiedzi: ${room.submittedCount}/${totalNeeded}.`;
        }

        if (hasSubmitted) {
            return 'Odpowiedź wysłana. Czekaj na innych.';
        }

        return 'Wybierz kartę i zatwierdź przyciskiem "Wybierz".';
    }

    if (room.gameState === 'JUDGING') {
        if (isCzar) {
            return 'Kliknij kartę, która wygrywa rundę.';
        }

        const czarName = room.players.find((p) => p.id === room.czarId)?.name || 'Sędzia';
        return `${czarName} wybiera zwycięzcę.`;
    }

    if (room.gameState === 'SCORING') {
        if (room.roundWinnerName) {
            return `Rundę wygrywa ${room.roundWinnerName}.`;
        }
        return 'Runda zakończona bez punktu.';
    }

    if (room.gameState === 'ROUND_PAUSE') {
        if (room.canStartNextRound) {
            return 'Jesteś nowym sędzią. Kliknij "Start nowej rundy".';
        }
        const czarName = room.players.find((p) => p.id === room.czarId)?.name || 'Sędzia';
        return `Przerwa po rundzie. ${czarName} rozpocznie kolejną rundę.`;
    }

    if (room.gameState === 'ENDED') {
        return 'Gra zakończona.';
    }

    return '';
}
