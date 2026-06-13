/* Shared online lobby for all games (PeerJS).
 *
 * One room number works across every game: the HOST picks a game and creates a
 * 5-digit room; the GUEST only types the number. On connect the host announces
 * which game it is, and if the guest is on a different page it is redirected to
 * the right game (carrying ?autojoin=<code>) and reconnects there.
 *
 * Each game page calls OnlineLobby.init({...}) with its own settings.
 * The HUB page calls OnlineLobby.initGuestOnly() for a game-agnostic join box.
 *
 * Room id namespace is shared across games: ROOM_PREFIX + code.
 */
(function () {
  const ROOM_PREFIX = "ngroom-"; // shared across all games
  const ALPHABET = "0123456789";

  // gameId -> path from the game/ root (used for cross-game redirect).
  const GAME_PATHS = {
    mahjong: "麻雀ゲーム/index.html",
    othello: "オセロ/index.html",
    gomoku: "五目並べ/index.html",
    shogi: "将棋ゲーム/index.html",
    catan: "カタン/index.html",
    tictactoe: "games/tictactoe.html",
    connect4: "games/connect4.html",
    hex: "games/hex.html",
    checkers: "games/checkers.html",
    chess: "games/chess.html",
    go: "games/go.html",
    mancala: "games/mancala.html",
    dobutsu: "games/dobutsu.html",
    memory: "games/memory.html",
    backgammon: "games/backgammon.html",
    hasami: "games/hasami.html",
    geister: "games/geister.html",
    dots: "games/dots.html",
    chinese: "games/chinese.html",
    yacht: "games/yacht.html",
    chinchiro: "games/chinchiro.html",
    blackjack: "games/blackjack.html",
    hitblow: "games/hitblow.html",
    sevens: "games/sevens.html",
    daifugo: "games/daifugo.html",
    otrio: "games/otrio.html",
    quoridor: "games/quoridor.html",
  };

  function randomCode() {
    let s = "";
    for (let i = 0; i < 4; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
  }
  const roomId = (code) => ROOM_PREFIX + code;

  // Resolve a path that works whether we're on the hub (game/) or in a game
  // subfolder (game/<game>/). `fromRoot` is the path relative to game/.
  function urlFromHere(fromRoot, basePrefix) {
    return (basePrefix || "") + fromRoot;
  }

  /* ============ per-game init (lobby on a game page) ============ */
  // cfg: {
  //   gameId, hostColor, guestColor,
  //   startOnline(myColor, send), applyRemote(msg),
  //   onPeerLeft(), basePrefix (e.g. "../" to reach game/ root)
  // }
  function init(cfg) {
    const els = grabEls();
    let peer = null, conn = null;

    function setStatus(m) { if (els.status) els.status.textContent = m; }
    function openLobby() { if (els.lobby) { els.lobby.hidden = false; resetLobby(); } }
    function hideLobby() { if (els.lobby) els.lobby.hidden = true; }
    function resetLobby() {
      setStatus("");
      if (els.codeBox) els.codeBox.hidden = true;
      if (els.codeInput) els.codeInput.value = "";
      if (els.createBtn) els.createBtn.disabled = false;
      if (els.joinBtn) els.joinBtn.disabled = false;
    }
    function fail(m) {
      setStatus(m);
      if (els.createBtn) els.createBtn.disabled = false;
      if (els.joinBtn) els.joinBtn.disabled = false;
      if (peer && !peer.destroyed) peer.destroy();
      peer = null;
    }

    // Bind the real game connection (after both sides agree on the game).
    function bindGame(c, myColor) {
      conn = c;
      const begin = () => {
        hideLobby();
        cfg.startOnline(myColor, (msg) => { try { c.send(msg); } catch (e) {} });
      };
      // The guest binds after the connection is already open (it learned the
      // game from the first message), so on("open") may never fire again —
      // start immediately in that case.
      if (c.open) begin(); else c.on("open", begin);
      c.on("data", (msg) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.t === "hello" || msg.t === "join") return; // handshake, ignore here
        cfg.applyRemote(msg);
      });
      c.on("close", () => cfg.onPeerLeft());
      c.on("error", () => cfg.onPeerLeft());
    }

    /* ---- HOST ---- */
    function host() {
      if (typeof Peer === "undefined") { fail("通信ライブラリの読み込みに失敗しました。再読み込みしてください。"); return; }
      if (els.createBtn) els.createBtn.disabled = true;
      if (els.joinBtn) els.joinBtn.disabled = true;
      const code = randomCode();
      setStatus("部屋を作成中…");
      peer = new Peer(roomId(code));
      peer.on("open", () => {
        if (els.codeText) els.codeText.textContent = code;
        if (els.codeBox) els.codeBox.hidden = false;
        setStatus("相手の参加を待っています…（この番号を相手に送ってください）");
      });
      // The host accepts incoming connections. Each guest first learns the
      // game via "hello"; a matching guest then sends "join" to start.
      peer.on("connection", (c) => {
        const sayHello = () => { try { c.send({ t: "hello", game: cfg.gameId }); } catch (e) {} };
        if (c.open) sayHello(); else c.on("open", sayHello);
        c.on("data", (msg) => {
          if (msg && msg.t === "join") {
            setStatus("相手が参加しました。対局を開始します。");
            bindGame(c, cfg.hostColor);
          }
        });
      });
      peer.on("error", (err) => {
        if (err && err.type === "unavailable-id") fail("その番号は使用中です。もう一度お試しください。");
        else fail("接続エラー: " + (err && err.type ? err.type : "不明") + "（再読み込みして再試行）");
      });
    }

    /* ---- GUEST ---- */
    // Connect to a room, learn the host's game. If it matches this page, start;
    // otherwise redirect to the correct game page carrying ?autojoin=code.
    function joinCode(code, opts) {
      if (typeof Peer === "undefined") { fail("通信ライブラリの読み込みに失敗しました。再読み込みしてください。"); return; }
      if (!/^\d{4}$/.test(code)) { setStatus("4桁の数字の部屋番号を入力してください。"); return; }
      if (els.createBtn) els.createBtn.disabled = true;
      if (els.joinBtn) els.joinBtn.disabled = true;
      setStatus("接続中…");
      peer = new Peer();
      peer.on("open", () => {
        const c = peer.connect(roomId(code), { reliable: true });
        let settled = false;
        c.on("data", (msg) => {
          if (settled || !msg) return;
          if (msg.t === "hello") {
            settled = true;
            if (msg.game === cfg.gameId) {
              // Same game: ask to start, then run.
              try { c.send({ t: "join" }); } catch (e) {}
              bindGame(c, cfg.guestColor);
            } else {
              // Different game: go to that game's page and auto-join there.
              const path = GAME_PATHS[msg.game];
              if (!path) { fail("不明なゲームの部屋です。"); return; }
              try { peer.destroy(); } catch (e) {}
              location.href = urlFromHere(path, cfg.basePrefix) + "?autojoin=" + code + "&_v=2";
            }
          }
        });
        c.on("error", () => { if (!settled) fail("接続できませんでした。番号を確認してください。"); });
        setTimeout(() => { if (!settled) fail("接続できませんでした。番号を確認してください。"); }, 7000);
      });
      peer.on("error", (err) => {
        if (err && err.type === "peer-unavailable") fail("その部屋番号は見つかりません。番号を確認してください。");
        else fail("接続エラー: " + (err && err.type ? err.type : "不明"));
      });
    }

    // Wire DOM
    if (els.onlineBtn) els.onlineBtn.addEventListener("click", openLobby);
    if (els.closeLobby) els.closeLobby.addEventListener("click", () => { resetLobby(); hideLobby(); if (peer && !conn) { try { peer.destroy(); } catch (e) {} peer = null; } });
    if (els.createBtn) els.createBtn.addEventListener("click", host);
    if (els.joinBtn) els.joinBtn.addEventListener("click", () => joinCode((els.codeInput.value || "").trim()));
    if (els.codeInput) els.codeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinCode((els.codeInput.value || "").trim()); });
    if (els.copyBtn) els.copyBtn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(els.codeText.textContent); els.copyBtn.textContent = "コピー済み"; setTimeout(() => els.copyBtn.textContent = "コピー", 1500); }
      catch (e) {}
    });

    // Auto-open lobby from the hub shortcut, or auto-join after a redirect.
    const params = new URLSearchParams(location.search);
    if (params.has("autojoin")) {
      const code = params.get("autojoin");
      openLobby();
      setStatus("部屋に参加しています…");
      joinCode(code);
    } else if (params.has("create")) {
      // Hub's "部屋を作成" flow: open the lobby and create the room right away.
      openLobby();
      host();
    } else if (params.has("online")) {
      openLobby();
    }
  }

  function grabEls() {
    return {
      onlineBtn: document.getElementById("online-btn"),
      lobby: document.getElementById("online-lobby"),
      closeLobby: document.getElementById("lobby-close"),
      createBtn: document.getElementById("create-room"),
      joinBtn: document.getElementById("join-room"),
      codeInput: document.getElementById("join-code"),
      status: document.getElementById("online-status"),
      codeBox: document.getElementById("room-code-box"),
      codeText: document.getElementById("room-code"),
      copyBtn: document.getElementById("copy-code"),
    };
  }

  window.OnlineLobby = { init, ROOM_PREFIX, GAME_PATHS };
})();
