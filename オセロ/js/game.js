/* Othello game controller — wires the board UI to OthelloAI.
 * Each color (black/white) is configured before the game as human or CPU,
 * and a CPU has its own strength level.
 *
 * Online play (PeerJS): when an online session is active, both colors are
 * human, the local player only controls their own color, and each local move
 * is sent to the peer. See js/online.js, which drives this via window.OthelloGame.
 */
(function () {
  const AI = window.OthelloAI;
  const SIZE = AI.SIZE;
  const BLACK = 1, WHITE = 2;

  // Setup screen
  const setupEl = document.getElementById("setup");
  const gameEl = document.getElementById("game");
  const startBtn = document.getElementById("start");
  const blackLevelSel = document.getElementById("black-level");
  const whiteLevelSel = document.getElementById("white-level");

  // Game screen
  const boardEl = document.getElementById("board");
  const countBlackEl = document.getElementById("count-black");
  const countWhiteEl = document.getElementById("count-white");
  const labelBlackEl = document.getElementById("label-black");
  const labelWhiteEl = document.getElementById("label-white");
  const turnEl = document.getElementById("turn-indicator");
  const messageEl = document.getElementById("message");
  const resetBtn = document.getElementById("reset");
  const passBtn = document.getElementById("pass");
  const backBtn = document.getElementById("back");
  const undoBtn = document.getElementById("undo");
  const assistEl = document.getElementById("assist");
  const scoreBlackEl = document.getElementById("score-black");
  const scoreWhiteEl = document.getElementById("score-white");

  // Display names for the five CPU difficulty levels.
  const LEVEL_NAMES = { 1: "入門", 2: "やさしい", 3: "ふつう", 4: "強い", 5: "最強" };

  // Per-color settings, filled in from the setup screen on start.
  // { type: "human" | "cpu", level: "1".."5" }
  const players = {
    [BLACK]: { type: "human", level: "3" },
    [WHITE]: { type: "cpu", level: "3" },
  };

  // Online session: null for local play, else { myColor, send(msg) }.
  let online = null;

  let board, current, busy, gameOver;
  let history = []; // snapshots { board, current } captured before each move
  const cells = [];

  const colorName = (p) => (p === BLACK ? "黒" : "白");
  const isCpu = (p) => !online && players[p].type === "cpu";
  function isCpuTurn() { return !gameOver && isCpu(current); }
  // Can the local human act right now?
  function myTurn() {
    if (gameOver || busy) return false;
    if (online) return current === online.myColor;
    return !isCpu(current);
  }

  function playerLabel(p) {
    if (online) {
      const mine = p === online.myColor ? "あなた" : "相手";
      return `${colorName(p)}（${mine}）`;
    }
    if (players[p].type === "human") return `${colorName(p)}（人間）`;
    const lv = LEVEL_NAMES[players[p].level] || players[p].level;
    return `${colorName(p)}（CPU・Lv${players[p].level} ${lv}）`;
  }

  /* ---------- Setup screen ---------- */

  // Enable a color's strength select only when that color is set to CPU.
  function syncLevelEnabled() {
    const blackType = document.querySelector('input[name="black-type"]:checked').value;
    const whiteType = document.querySelector('input[name="white-type"]:checked').value;
    blackLevelSel.disabled = blackType !== "cpu";
    whiteLevelSel.disabled = whiteType !== "cpu";
  }

  document.querySelectorAll('input[name="black-type"], input[name="white-type"]')
    .forEach((el) => el.addEventListener("change", syncLevelEnabled));

  function readConfig() {
    players[BLACK].type = document.querySelector('input[name="black-type"]:checked').value;
    players[WHITE].type = document.querySelector('input[name="white-type"]:checked').value;
    players[BLACK].level = blackLevelSel.value;
    players[WHITE].level = whiteLevelSel.value;
  }

  function showSetup() {
    gameEl.hidden = true;
    setupEl.hidden = false;
  }

  function enterGameScreen() {
    setupEl.hidden = true;
    gameEl.hidden = false;
    labelBlackEl.textContent = playerLabel(BLACK);
    labelWhiteEl.textContent = playerLabel(WHITE);
    // Online play hides single-device-only controls.
    undoBtn.style.display = online ? "none" : "";
    backBtn.style.display = online ? "none" : "";
    resetBtn.style.display = online ? "none" : "";
    assistEl.parentElement.style.display = online ? "none" : "";
    newGame();
  }

  startBtn.addEventListener("click", () => {
    online = null;
    readConfig();
    enterGameScreen();
  });

  /* ---------- Board ---------- */

  function buildGrid() {
    boardEl.innerHTML = "";
    cells.length = 0;
    for (let r = 0; r < SIZE; r++) {
      cells.push([]);
      for (let c = 0; c < SIZE; c++) {
        const cell = document.createElement("div");
        cell.className = "cell";
        const piece = document.createElement("div");
        piece.className = "piece";
        cell.appendChild(piece);
        const score = document.createElement("span");
        score.className = "hint-score";
        cell.appendChild(score);
        cell.addEventListener("click", () => onCellClick(r, c));
        boardEl.appendChild(cell);
        cells[r].push(cell);
      }
    }
  }

  function newGame() {
    board = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
    board[3][3] = WHITE; board[3][4] = BLACK;
    board[4][3] = BLACK; board[4][4] = WHITE;
    current = BLACK;
    busy = false;
    gameOver = false;
    history = [];
    messageEl.textContent = "";
    render();
    maybeCpuMove();
  }

  function render() {
    const moves = gameOver ? [] : AI.legalMoves(board, current);
    const moveSet = new Set(moves.map((m) => m.row * SIZE + m.col));
    const humanToMove = myTurn();

    // AI-assistant evaluation overlay (only for a human's turn, local play).
    let scoreMap = null, rankOf = null;
    if (!online && assistEl.checked && humanToMove && moves.length) {
      scoreMap = new Map();
      for (const m of AI.evaluateMoves(board, current)) {
        scoreMap.set(m.row * SIZE + m.col, m.score);
      }
      const uniqueDesc = [...new Set(scoreMap.values())].sort((a, b) => b - a);
      rankOf = (s) => uniqueDesc.indexOf(s); // 0 = best, 1 = 2nd, ...
    }

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const cell = cells[r][c];
        const piece = cell.querySelector(".piece");
        const scoreEl = cell.querySelector(".hint-score");
        const v = board[r][c];
        piece.classList.toggle("black", v === BLACK);
        piece.classList.toggle("white", v === WHITE);
        piece.classList.toggle("show", v !== 0);
        cell.classList.toggle("has-piece", v !== 0);

        // Only show hints when the local human is on the move.
        const key = r * SIZE + c;
        const showHint = humanToMove && moveSet.has(key);
        cell.classList.toggle("playable", showHint);

        const hasScore = scoreMap && scoreMap.has(key);
        cell.classList.toggle("assist", !!hasScore);
        const rank = hasScore ? rankOf(scoreMap.get(key)) : -1;
        cell.classList.toggle("rank1", rank === 0);
        cell.classList.toggle("rank2", rank === 1);
        cell.classList.toggle("rank3", rank === 2);
        scoreEl.textContent = hasScore ? scoreMap.get(key) : "";
      }
    }

    const { black, white } = AI.counts(board);
    countBlackEl.textContent = black;
    countWhiteEl.textContent = white;

    scoreBlackEl.classList.toggle("active", !gameOver && current === BLACK);
    scoreWhiteEl.classList.toggle("active", !gameOver && current === WHITE);

    if (gameOver) {
      turnEl.textContent = "終了";
    } else if (online) {
      turnEl.textContent = current === online.myColor ? "あなたの番" : "相手の番";
    } else if (isCpuTurn()) {
      turnEl.textContent = `${colorName(current)}の番（CPU思考中…）`;
    } else {
      turnEl.textContent = `${colorName(current)}の番`;
    }

    // Pass is offered only when the local human is to move and has no legal move.
    const noMoves = !gameOver && moves.length === 0;
    passBtn.disabled = !(noMoves && humanToMove);

    undoBtn.disabled = busy || online || history.length === 0;
  }

  function onCellClick(r, c) {
    if (!myTurn()) return;
    const flips = AI.flipsFor(board, r, c, current);
    if (!flips.length) return;
    if (online) online.send({ t: "move", row: r, col: c });
    play({ row: r, col: c, flips });
  }

  function play(move) {
    // Snapshot the position before the move so it can be undone.
    history.push({ board: board.map((row) => row.slice()), current });
    board = AI.applyMove(board, move, current);
    current = AI.opponent(current);
    advanceTurn();
  }

  // Step back to the most recent position where a human is to move.
  // In human-vs-CPU this rewinds both the CPU reply and the player's move.
  function undo() {
    if (busy || online || history.length === 0) return;
    let snap = history.pop();
    while (isCpu(snap.current) && history.length > 0) {
      snap = history.pop();
    }
    board = snap.board.map((row) => row.slice());
    current = snap.current;
    gameOver = false;
    messageEl.textContent = "";
    render();
    // If we landed on a CPU's turn (e.g. CPU-vs-CPU), let it resume.
    maybeCpuMove();
  }

  // After a move, handle pass / game-over, then trigger CPU if needed.
  function advanceTurn() {
    const myMoves = AI.legalMoves(board, current);
    if (myMoves.length === 0) {
      const oppMoves = AI.legalMoves(board, AI.opponent(current));
      if (oppMoves.length === 0) {
        endGame();
        return;
      }
      messageEl.textContent = `${colorName(current)}は打てる場所がないためパス`;
      current = AI.opponent(current);
      render();
      maybeCpuMove();
      return;
    }
    messageEl.textContent = "";
    render();
    maybeCpuMove();
  }

  function maybeCpuMove() {
    if (!isCpuTurn()) return;
    busy = true;
    render();
    // Small delay so the move is visible, not instant.
    setTimeout(() => {
      const move = AI.chooseMove(board, current, players[current].level);
      busy = false;
      if (!move) { advanceTurn(); return; }
      play(move);
    }, 450);
  }

  function endGame() {
    gameOver = true;
    render();
    const { black, white } = AI.counts(board);
    let result;
    if (black > white) result = "黒の勝ち！";
    else if (white > black) result = "白の勝ち！";
    else result = "引き分け";
    if (online) {
      const won = (black > white && online.myColor === BLACK) ||
                  (white > black && online.myColor === WHITE);
      const tag = black === white ? "引き分け" : (won ? "あなたの勝ち！🎉" : "相手の勝ち…");
      messageEl.textContent = `ゲーム終了 — ${tag}（黒 ${black} : ${white} 白）`;
    } else {
      messageEl.textContent = `ゲーム終了 — ${result}（黒 ${black} : ${white} 白）`;
    }
  }

  passBtn.addEventListener("click", () => {
    if (passBtn.disabled) return;
    if (online) online.send({ t: "pass" });
    messageEl.textContent = "";
    current = AI.opponent(current);
    advanceTurn();
  });

  resetBtn.addEventListener("click", newGame);
  backBtn.addEventListener("click", showSetup);
  undoBtn.addEventListener("click", undo);
  assistEl.addEventListener("change", render);

  buildGrid();
  syncLevelEnabled();

  /* ---------- Online API (called by js/online.js) ---------- */
  window.OthelloGame = {
    // Begin an online match. myColor: 1 (host=black) or 2 (guest=white).
    startOnline(myColor, sendFn) {
      online = { myColor, send: sendFn };
      enterGameScreen();
    },
    // Apply a move received from the peer.
    remoteMove(row, col) {
      if (!online) return;
      const flips = AI.flipsFor(board, row, col, current);
      if (!flips.length) return; // out of sync / illegal — ignore
      play({ row, col, flips });
    },
    remotePass() {
      if (!online) return;
      current = AI.opponent(current);
      advanceTurn();
    },
    // The peer disconnected.
    peerLeft() {
      if (!online) return;
      gameOver = true;
      messageEl.textContent = "相手の接続が切れました。";
      render();
    },
  };
})();
