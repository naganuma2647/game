/* Shogi UI controller. */
(function () {
  const S = window.Shogi;
  const AI = window.ShogiAI;
  const N = S.N;
  const SENTE = S.SENTE, GOTE = S.GOTE;

  // Display characters.
  const BASE = { R: "飛", B: "角", G: "金", S: "銀", N: "桂", L: "香", P: "歩" };
  const PROMO = { R: "竜", B: "馬", S: "全", N: "圭", L: "杏", P: "と" };
  const HAND_ORDER = ["R", "B", "G", "S", "N", "L", "P"];

  function pieceChar(p) {
    if (p.type === "K") return p.owner === SENTE ? "玉" : "王";
    if (p.promoted) return PROMO[p.type] || BASE[p.type];
    return BASE[p.type];
  }
  const sideName = (o) => (o === SENTE ? "先手" : "後手");

  // DOM
  const setupEl = document.getElementById("setup");
  const gameEl = document.getElementById("game");
  const startBtn = document.getElementById("start");
  const senteLevel = document.getElementById("sente-level");
  const goteLevel = document.getElementById("gote-level");
  const boardEl = document.getElementById("board");
  const turnEl = document.getElementById("turn-indicator");
  const messageEl = document.getElementById("message");
  const handSenteEl = document.getElementById("hand-sente-pieces");
  const handGoteEl = document.getElementById("hand-gote-pieces");
  const undoBtn = document.getElementById("undo");
  const resetBtn = document.getElementById("reset");
  const backBtn = document.getElementById("back");
  const promoOverlay = document.getElementById("promo-overlay");
  const promoYes = document.getElementById("promo-yes");
  const promoNo = document.getElementById("promo-no");
  const assistEl = document.getElementById("assist");
  const assistHintEl = document.getElementById("assist-hint");

  const ASSIST_DEPTH = 3;
  const RANK_KANJI = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];

  const players = {
    [SENTE]: { type: "human", level: "2" },
    [GOTE]: { type: "cpu", level: "2" },
  };

  // Online session: null for local play, else { myColor, send(msg) }.
  let online = null;

  let state, busy, gameOver, lastMove;
  let history = [];
  let sel = null;        // { kind:'board', r, c } | { kind:'hand', type, owner }
  let selDetail = null;  // Map(key -> {canPromote,mustPromote}) for board moves
  let targetSet = new Set();
  let assistEvals = null; // cached [{move,score}] for the current position
  let bestMove = null;    // recommended move for the side to move
  const cells = [];

  // Can the local human act now? (online: only on my color's turn)
  const isHumanTurn = () => {
    if (busy || gameOver) return false;
    if (online) return state.turn === online.myColor;
    return players[state.turn].type === "human";
  };
  const isCpu = (o) => !online && players[o].type === "cpu";

  /* ---------- setup ---------- */

  function syncLevels() {
    senteLevel.disabled =
      document.querySelector('input[name="sente-type"]:checked').value !== "cpu";
    goteLevel.disabled =
      document.querySelector('input[name="gote-type"]:checked').value !== "cpu";
  }
  document.querySelectorAll('input[name="sente-type"], input[name="gote-type"]')
    .forEach((el) => el.addEventListener("change", syncLevels));

  function enterGameScreen() {
    setupEl.hidden = true;
    gameEl.hidden = false;
    undoBtn.style.display = online ? "none" : "";
    resetBtn.style.display = online ? "none" : "";
    backBtn.style.display = online ? "none" : "";
    if (assistEl) assistEl.parentElement.style.display = online ? "none" : "";
    newGame();
  }

  startBtn.addEventListener("click", () => {
    online = null;
    players[SENTE].type = document.querySelector('input[name="sente-type"]:checked').value;
    players[GOTE].type = document.querySelector('input[name="gote-type"]:checked').value;
    players[SENTE].level = senteLevel.value;
    players[GOTE].level = goteLevel.value;
    enterGameScreen();
  });
  backBtn.addEventListener("click", () => {
    gameEl.hidden = true;
    setupEl.hidden = false;
  });

  /* ---------- board build ---------- */

  function buildGrid() {
    boardEl.innerHTML = "";
    cells.length = 0;
    for (let r = 0; r < N; r++) {
      cells.push([]);
      for (let c = 0; c < N; c++) {
        const cell = document.createElement("div");
        cell.className = "cell";
        cell.addEventListener("click", () => onCellClick(r, c));
        boardEl.appendChild(cell);
        cells[r].push(cell);
      }
    }
  }

  function newGame() {
    state = S.initialState();
    busy = false;
    gameOver = false;
    lastMove = null;
    history = [];
    assistEvals = null;
    clearSelection();
    messageEl.textContent = "";
    render();
    maybeCpu();
  }

  function clearSelection() {
    sel = null;
    selDetail = null;
    targetSet = new Set();
  }

  /* ---------- AI assistant ---------- */

  function ensureAssist() {
    if (online || !assistEl.checked || !isHumanTurn()) { assistEvals = null; bestMove = null; return; }
    if (assistEvals) return; // cached for this position
    assistEvals = AI.evaluateMoves(state, ASSIST_DEPTH);
    let best = null, bs = -Infinity;
    for (const e of assistEvals) if (e.score > bs) { bs = e.score; best = e.move; }
    bestMove = best;
  }

  function fmtScore(s) {
    if (s >= AI.MATE - 1000) return "詰";
    if (s <= -AI.MATE + 1000) return "負";
    return (s > 0 ? "+" : "") + s;
  }

  function notation(move) {
    const side = state.turn === SENTE ? "☗" : "☖";
    const sq = `${9 - move.to[1]}${RANK_KANJI[move.to[0]]}`;
    if (move.drop) return `${side}${sq}${BASE[move.drop]}打`;
    const p = state.board[move.from[0]][move.from[1]];
    return `${side}${sq}${pieceChar(p)}${move.promote ? "成" : ""}`;
  }

  // Best cached score for a destination from the selected piece / hand.
  function assistScoreFor(r, c) {
    if (!assistEvals || !sel) return null;
    let best = null;
    for (const e of assistEvals) {
      const m = e.move;
      if (m.to[0] !== r || m.to[1] !== c) continue;
      if (sel.kind === "board") {
        if (!m.from || m.from[0] !== sel.r || m.from[1] !== sel.c) continue;
      } else {
        if (m.drop !== sel.type) continue;
      }
      if (best === null || e.score > best) best = e.score;
    }
    return best;
  }

  // Map of target-key -> rank (0,1,2) among the currently shown destinations.
  function assistRanks() {
    const scores = new Map();
    if (assistEvals && sel) {
      for (const k of targetSet) {
        const s = assistScoreFor(Math.floor(k / N), k % N);
        if (s !== null) scores.set(k, s);
      }
    }
    const uniq = [...new Set(scores.values())].sort((a, b) => b - a);
    const ranks = new Map();
    for (const [k, s] of scores) ranks.set(k, { score: s, rank: uniq.indexOf(s) });
    return ranks;
  }

  /* ---------- rendering ---------- */

  function render() {
    const key = (r, c) => r * N + c;
    ensureAssist();
    const ranks = assistRanks();
    const assistOn = assistEl.checked && isHumanTurn();
    const reco = assistOn ? bestMove : null;

    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const cell = cells[r][c];
        const p = state.board[r][c];
        const k = key(r, c);
        let cls = "cell";
        if (sel && sel.kind === "board" && sel.r === r && sel.c === c) cls += " selected";
        if (lastMove && lastMove.to && lastMove.to[0] === r && lastMove.to[1] === c) cls += " last-move";
        if (lastMove && lastMove.from && lastMove.from[0] === r && lastMove.from[1] === c) cls += " last-move";
        if (targetSet.has(k)) {
          cls += " target";
          if (p) cls += " capture";
        }
        if (isHumanTurn() && p && p.owner === state.turn) cls += " selectable";

        // recommendation highlight
        if (reco) {
          if (reco.from && reco.from[0] === r && reco.from[1] === c) cls += " reco-from";
          if (reco.to[0] === r && reco.to[1] === c) cls += " reco-to";
        }

        // per-destination evaluation number
        let hintText = "";
        const ri = ranks.get(k);
        if (ri) {
          cls += " assist";
          if (ri.rank === 0) cls += " rank1";
          else if (ri.rank === 1) cls += " rank2";
          else if (ri.rank === 2) cls += " rank3";
          hintText = fmtScore(ri.score);
        }

        cell.className = cls;
        let inner = "";
        if (p) {
          inner += `<div class="piece ${p.owner === GOTE ? "gote" : "sente"}${p.promoted ? " promoted" : ""}">${pieceChar(p)}</div>`;
        }
        inner += `<span class="hint-score">${hintText}</span>`;
        cell.innerHTML = inner;
      }
    }
    renderHand(handSenteEl, SENTE, reco);
    renderHand(handGoteEl, GOTE, reco);
    renderTurn();
    renderAssistHint(reco);
    undoBtn.disabled = busy || history.length === 0;
  }

  function renderAssistHint(reco) {
    if (!reco) { assistHintEl.textContent = ""; return; }
    const e = assistEvals.find((x) => x.move === reco);
    const sc = e ? ` (${fmtScore(e.score)})` : "";
    assistHintEl.textContent = `推奨手: ${notation(reco)}${sc}　— 駒を選ぶと各手の評価値が出ます`;
  }

  function renderHand(container, owner, reco) {
    container.innerHTML = "";
    const canSelect = isHumanTurn() && owner === state.turn;
    for (const t of HAND_ORDER) {
      const cnt = state.hands[owner][t];
      if (cnt <= 0) continue;
      const el = document.createElement("span");
      el.className = "hand-piece" + (canSelect ? " selectable" : "");
      if (sel && sel.kind === "hand" && sel.owner === owner && sel.type === t) {
        el.className += " selected";
      }
      // Recommended move is dropping this piece -> outline it.
      if (reco && reco.drop === t && owner === state.turn) {
        el.className += " reco-drop";
      }
      el.innerHTML = `${BASE[t]}<span class="cnt">${cnt}</span>`;
      if (canSelect) el.addEventListener("click", () => onHandClick(owner, t));
      container.appendChild(el);
    }
  }

  function renderTurn() {
    if (gameOver) { turnEl.textContent = "対局終了"; return; }
    let txt;
    if (online) {
      txt = state.turn === online.myColor ? "あなたの番" : "相手の番";
    } else {
      txt = `${sideName(state.turn)}番`;
      if (isCpu(state.turn) && busy) txt += "（CPU思考中…）";
    }
    if (S.inCheck(state.board, state.turn)) {
      turnEl.innerHTML = `${txt} <span class="check">王手！</span>`;
    } else {
      turnEl.textContent = txt;
    }
  }

  /* ---------- interaction ---------- */

  function onCellClick(r, c) {
    if (!isHumanTurn()) return;
    const k = r * N + c;
    if (targetSet.has(k)) {
      if (sel.kind === "board") executeBoardMove(r, c);
      else executeDrop(r, c);
      return;
    }
    const p = state.board[r][c];
    if (p && p.owner === state.turn) {
      selectBoard(r, c);
    } else {
      clearSelection();
      render();
    }
  }

  function onHandClick(owner, type) {
    if (!isHumanTurn() || owner !== state.turn) return;
    if (sel && sel.kind === "hand" && sel.type === type) {
      clearSelection();
      render();
      return;
    }
    sel = { kind: "hand", type, owner };
    selDetail = null;
    targetSet = new Set(S.legalDrops(state, type).map(([r, c]) => r * N + c));
    render();
  }

  function selectBoard(r, c) {
    sel = { kind: "board", r, c };
    selDetail = new Map();
    targetSet = new Set();
    for (const m of S.legalFrom(state, r, c)) {
      const k = m.to[0] * N + m.to[1];
      targetSet.add(k);
      selDetail.set(k, { canPromote: m.canPromote, mustPromote: m.mustPromote });
    }
    render();
  }

  async function executeBoardMove(r, c) {
    const detail = selDetail.get(r * N + c);
    let promote = false;
    if (detail.mustPromote) promote = true;
    else if (detail.canPromote) promote = await askPromotion();
    const move = { from: [sel.r, sel.c], to: [r, c], promote, drop: null };
    if (online) online.send({ t: "move", move });
    doMove(move);
  }

  function executeDrop(r, c) {
    const move = { from: null, to: [r, c], promote: false, drop: sel.type };
    if (online) online.send({ t: "move", move });
    doMove(move);
  }

  /* ---------- promotion dialog ---------- */

  let promoResolver = null;
  function askPromotion() {
    return new Promise((resolve) => {
      promoResolver = resolve;
      promoOverlay.hidden = false;
    });
  }
  function resolvePromo(v) {
    promoOverlay.hidden = true;
    if (promoResolver) { const r = promoResolver; promoResolver = null; r(v); }
  }
  promoYes.addEventListener("click", () => resolvePromo(true));
  promoNo.addEventListener("click", () => resolvePromo(false));

  /* ---------- move application ---------- */

  function doMove(move) {
    history.push({ state: S.cloneState(state), lastMove });
    state = S.applyMove(state, move);
    lastMove = { from: move.from, to: move.to };
    assistEvals = null; // position changed
    clearSelection();

    if (S.isStuck(state)) {
      gameOver = true;
      const loser = state.turn;
      const winner = S.opp(loser);
      const checked = S.inCheck(state.board, loser);
      if (online) {
        const youWin = winner === online.myColor;
        const head = checked ? "詰み！ " : "";
        messageEl.textContent = head + (youWin ? "あなたの勝ち🎉" : "相手の勝ち…");
      } else {
        messageEl.textContent = checked
          ? `詰み！ ${sideName(winner)}の勝ち`
          : `${sideName(winner)}の勝ち（${sideName(loser)}は指せる手がありません）`;
      }
    }
    render();
    if (!gameOver) maybeCpu();
  }

  function maybeCpu() {
    if (gameOver || !isCpu(state.turn)) return;
    busy = true;
    render();
    setTimeout(() => {
      const move = AI.chooseMove(state, Number(players[state.turn].level));
      busy = false;
      if (!move) { // no legal move
        gameOver = true;
        const winner = S.opp(state.turn);
        messageEl.textContent = `${sideName(winner)}の勝ち`;
        render();
        return;
      }
      doMove(move);
    }, 350);
  }

  function undo() {
    if (busy || history.length === 0) return;
    let snap = history.pop();
    while (isCpu(snap.state.turn) && history.length > 0) snap = history.pop();
    state = snap.state;
    lastMove = snap.lastMove;
    gameOver = false;
    assistEvals = null;
    clearSelection();
    messageEl.textContent = "";
    render();
    maybeCpu();
  }

  undoBtn.addEventListener("click", undo);
  resetBtn.addEventListener("click", newGame);
  assistEl.addEventListener("change", () => { assistEvals = null; render(); });

  buildGrid();
  syncLevels();

  /* ---------- Online API (called by js/online.js) ---------- */
  window.ShogiGame = {
    // myColor: 0 (host=sente) or 1 (guest=gote).
    startOnline(myColor, sendFn) {
      online = { myColor, send: sendFn };
      enterGameScreen();
    },
    remoteMove(move) {
      if (!online || gameOver) return;
      doMove(move);
    },
    peerLeft() {
      if (!online) return;
      gameOver = true;
      messageEl.textContent = "相手の接続が切れました。";
      render();
    },
  };
})();
