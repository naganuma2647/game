/* Shogi (本将棋) rules engine.
 * Exposes window.Shogi: board setup, move generation (incl. drops &
 * promotion), check / checkmate detection, and move application.
 *
 * Board: 9x9 array, board[row][col]. row 0 = top (Gote's home), row 8 =
 * bottom (Sente's home). A piece is { type, owner, promoted }.
 *   owner: 0 = Sente (bottom, moves up), 1 = Gote (top, moves down).
 *   type:  'P' 歩, 'L' 香, 'N' 桂, 'S' 銀, 'G' 金, 'K' 玉/王, 'R' 飛, 'B' 角.
 *
 * Known simplification: 打ち歩詰め (pawn-drop checkmate) is NOT forbidden.
 */
(function () {
  const N = 9;
  const SENTE = 0, GOTE = 1;
  const opp = (o) => (o === SENTE ? GOTE : SENTE);
  const inside = (r, c) => r >= 0 && r < N && c >= 0 && c < N;

  // Drop-able / hand piece types (no King).
  const HAND_TYPES = ["R", "B", "G", "S", "N", "L", "P"];

  // Step moves and slide directions, from Sente's view (forward = row - 1).
  const STEP = {
    P: [[-1, 0]],
    L: [],
    N: [[-2, -1], [-2, 1]],
    S: [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 1]],
    G: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]],
    K: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]],
    R: [],
    B: [],
  };
  const SLIDE = {
    P: [], N: [], S: [], G: [], K: [],
    L: [[-1, 0]],
    R: [[-1, 0], [1, 0], [0, -1], [0, 1]],
    B: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
  };
  const GOLD_STEP = STEP.G;

  function moveVectors(piece) {
    if (piece.promoted) {
      if (piece.type === "R") {
        return { step: [[-1, -1], [-1, 1], [1, -1], [1, 1]], slide: SLIDE.R };
      }
      if (piece.type === "B") {
        return { step: [[-1, 0], [1, 0], [0, -1], [0, 1]], slide: SLIDE.B };
      }
      return { step: GOLD_STEP, slide: [] }; // +P/+L/+N/+S move like gold
    }
    return { step: STEP[piece.type], slide: SLIDE[piece.type] };
  }

  // Destination squares for the piece at (r,c) — ignores leaving own king in check.
  function pieceMoves(board, r, c) {
    const p = board[r][c];
    const sign = p.owner === SENTE ? 1 : -1; // flip forward for Gote
    const { step, slide } = moveVectors(p);
    const res = [];
    for (const [dr, dc] of step) {
      const nr = r + dr * sign, nc = c + dc;
      if (inside(nr, nc) && (!board[nr][nc] || board[nr][nc].owner !== p.owner)) {
        res.push([nr, nc]);
      }
    }
    for (const [dr, dc] of slide) {
      let nr = r + dr * sign, nc = c + dc;
      while (inside(nr, nc)) {
        if (!board[nr][nc]) {
          res.push([nr, nc]);
        } else {
          if (board[nr][nc].owner !== p.owner) res.push([nr, nc]);
          break;
        }
        nr += dr * sign; nc += dc;
      }
    }
    return res;
  }

  function findKing(board, owner) {
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const p = board[r][c];
        if (p && p.type === "K" && p.owner === owner) return [r, c];
      }
    }
    return null;
  }

  // Is `owner`'s king currently attacked?
  function inCheck(board, owner) {
    const k = findKing(board, owner);
    if (!k) return true; // king captured == worst case
    const enemy = opp(owner);
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const p = board[r][c];
        if (!p || p.owner !== enemy) continue;
        for (const [nr, nc] of pieceMoves(board, r, c)) {
          if (nr === k[0] && nc === k[1]) return true;
        }
      }
    }
    return false;
  }

  /* ---------- zones / promotion rules ---------- */

  const inZone = (owner, row) => (owner === SENTE ? row <= 2 : row >= 6);
  const lastRank = (owner, row) => (owner === SENTE ? row === 0 : row === 8);
  const lastTwoRanks = (owner, row) =>
    owner === SENTE ? row <= 1 : row >= 7;

  function canPromote(piece, fromRow, toRow) {
    if (piece.promoted) return false;
    if (piece.type === "G" || piece.type === "K") return false;
    return inZone(piece.owner, fromRow) || inZone(piece.owner, toRow);
  }

  // Must promote when the piece would otherwise have no future move.
  function mustPromote(piece, toRow) {
    if (piece.promoted) return false;
    if (piece.type === "P" || piece.type === "L") return lastRank(piece.owner, toRow);
    if (piece.type === "N") return lastTwoRanks(piece.owner, toRow);
    return false;
  }

  /* ---------- state ---------- */

  function emptyHands() {
    const h = () => ({ R: 0, B: 0, G: 0, S: 0, N: 0, L: 0, P: 0 });
    return { 0: h(), 1: h() };
  }

  function initialBoard() {
    const b = Array.from({ length: N }, () => new Array(N).fill(null));
    const back = ["L", "N", "S", "G", "K", "G", "S", "N", "L"];
    const pc = (type, owner, promoted = false) => ({ type, owner, promoted });
    // Gote (top, owner 1) — gote 飛 at 8筋 = col 1, gote 角 at 2筋 = col 7
    for (let c = 0; c < N; c++) b[0][c] = pc(back[c], GOTE);
    b[1][1] = pc("R", GOTE); b[1][7] = pc("B", GOTE);
    for (let c = 0; c < N; c++) b[2][c] = pc("P", GOTE);
    // Sente (bottom, owner 0) — sente 角 at 8筋 = col 1 (左), sente 飛 at 2筋 = col 7 (右)
    for (let c = 0; c < N; c++) b[6][c] = pc("P", SENTE);
    b[7][1] = pc("B", SENTE); b[7][7] = pc("R", SENTE);
    for (let c = 0; c < N; c++) b[8][c] = pc(back[c], SENTE);
    return b;
  }

  function initialState() {
    return { board: initialBoard(), hands: emptyHands(), turn: SENTE };
  }

  function cloneState(s) {
    return {
      board: s.board.map((row) => row.slice()),
      hands: { 0: { ...s.hands[0] }, 1: { ...s.hands[1] } },
      turn: s.turn,
    };
  }

  /* ---------- move generation ---------- */

  // A move: { from:[r,c]|null, to:[r,c], promote:bool, drop:type|null,
  //           capture:type|null, capturedKing:bool }
  function mkMove(from, to, promote, capture, capturedKing) {
    return { from, to, promote, drop: null, capture, capturedKing: !!capturedKing };
  }

  function dropOk(state, type, owner, r, c) {
    if (state.board[r][c]) return false;
    if (type === "P" || type === "L") {
      if (lastRank(owner, r)) return false;
    }
    if (type === "N" && lastTwoRanks(owner, r)) return false;
    if (type === "P") {
      // 二歩: no own unpromoted pawn already in this file.
      for (let rr = 0; rr < N; rr++) {
        const p = state.board[rr][c];
        if (p && p.owner === owner && p.type === "P" && !p.promoted) return false;
      }
    }
    return true;
  }

  // Pseudo-legal moves (does not filter out leaving own king in check).
  function pseudoMoves(state) {
    const { board, hands, turn } = state;
    const moves = [];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const p = board[r][c];
        if (!p || p.owner !== turn) continue;
        for (const [nr, nc] of pieceMoves(board, r, c)) {
          const target = board[nr][nc];
          const cap = target ? target.type : null;
          const capK = !!(target && target.type === "K");
          if (mustPromote(p, nr)) {
            moves.push(mkMove([r, c], [nr, nc], true, cap, capK));
          } else {
            moves.push(mkMove([r, c], [nr, nc], false, cap, capK));
            if (canPromote(p, r, nr)) {
              moves.push(mkMove([r, c], [nr, nc], true, cap, capK));
            }
          }
        }
      }
    }
    for (const type of HAND_TYPES) {
      if (hands[turn][type] <= 0) continue;
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          if (dropOk(state, type, turn, r, c)) {
            moves.push({ from: null, to: [r, c], promote: false, drop: type, capture: null, capturedKing: false });
          }
        }
      }
    }
    return moves;
  }

  function applyMove(state, move) {
    const ns = cloneState(state);
    const owner = state.turn;
    const [tr, tc] = move.to;
    if (move.drop) {
      ns.hands[owner][move.drop] -= 1;
      ns.board[tr][tc] = { type: move.drop, owner, promoted: false };
    } else {
      const [fr, fc] = move.from;
      const p = ns.board[fr][fc];
      const captured = ns.board[tr][tc];
      if (captured) {
        ns.hands[owner][captured.type] += 1; // captured piece reverts, switches side
      }
      ns.board[fr][fc] = null;
      ns.board[tr][tc] = {
        type: p.type,
        owner: p.owner,
        promoted: p.promoted || move.promote,
      };
    }
    ns.turn = opp(owner);
    return ns;
  }

  // Fully legal moves for the side to move.
  function legalMoves(state) {
    return pseudoMoves(state).filter((m) => {
      const ns = applyMove(state, m);
      return !inCheck(ns.board, state.turn);
    });
  }

  // Legal destinations from a square, with promote options annotated.
  // Returns [{ to:[r,c], canPromote, mustPromote }]
  function legalFrom(state, fr, fc) {
    const moves = legalMoves(state).filter(
      (m) => m.from && m.from[0] === fr && m.from[1] === fc
    );
    const byTo = new Map();
    for (const m of moves) {
      const key = m.to[0] * N + m.to[1];
      const e = byTo.get(key) || { to: m.to, canPromote: false, mustPromote: false, plain: false };
      if (m.promote) e.canPromote = true;
      else e.plain = true;
      byTo.set(key, e);
    }
    // mustPromote = promote available but plain not legal
    return [...byTo.values()].map((e) => ({
      to: e.to,
      canPromote: e.canPromote,
      mustPromote: e.canPromote && !e.plain,
    }));
  }

  // Legal drop squares for a hand piece type.
  function legalDrops(state, type) {
    return legalMoves(state)
      .filter((m) => m.drop === type)
      .map((m) => m.to);
  }

  function isCheckmate(state) {
    return inCheck(state.board, state.turn) && legalMoves(state).length === 0;
  }

  // No legal move at all (mate or — practically never in shogi — stalemate).
  function isStuck(state) {
    return legalMoves(state).length === 0;
  }

  window.Shogi = {
    N, SENTE, GOTE, HAND_TYPES,
    opp,
    initialState, cloneState,
    pieceMoves, pseudoMoves, legalMoves, legalFrom, legalDrops,
    applyMove, inCheck, findKing,
    isCheckmate, isStuck,
    canPromote, mustPromote, inZone,
  };
})();
