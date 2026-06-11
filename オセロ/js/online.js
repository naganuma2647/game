/* Online play for Othello via PeerJS (WebRTC).
 *
 * Host: creates a room -> gets a 5-char room code -> shares it.
 * Guest: enters the code -> connects. Host plays Black, Guest plays White.
 * Moves are relayed as small JSON messages through the data connection.
 *
 * No account or server of your own needed: PeerJS's free broker only helps
 * the two browsers find each other; the game data goes peer-to-peer.
 */
(function () {
  const Game = window.OthelloGame;

  // Room codes use unambiguous characters (no 0/O, 1/I/L).
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const PREFIX = "othello-9x9-"; // namespace so codes don't collide with other apps
  const HOST = 1, GUEST = 2; // colors: host=black, guest=white

  // DOM
  const onlineBtn = document.getElementById("online-btn");
  const lobby = document.getElementById("online-lobby");
  const closeLobby = document.getElementById("lobby-close");
  const createBtn = document.getElementById("create-room");
  const joinBtn = document.getElementById("join-room");
  const codeInput = document.getElementById("join-code");
  const statusEl = document.getElementById("online-status");
  const codeBox = document.getElementById("room-code-box");
  const codeText = document.getElementById("room-code");
  const copyBtn = document.getElementById("copy-code");

  let peer = null;
  let conn = null;

  function randomCode() {
    let s = "";
    for (let i = 0; i < 5; i++) {
      s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    return s;
  }

  function setStatus(msg) { statusEl.textContent = msg; }

  function openLobby() { lobby.hidden = false; resetLobby(); }
  function hideLobby() { lobby.hidden = true; }
  function resetLobby() {
    setStatus("");
    codeBox.hidden = true;
    codeInput.value = "";
    createBtn.disabled = false;
    joinBtn.disabled = false;
  }

  function fail(msg) {
    setStatus(msg);
    createBtn.disabled = false;
    joinBtn.disabled = false;
    if (peer && !peer.destroyed) { peer.destroy(); }
    peer = null;
  }

  // Wire a data connection's lifecycle once it exists.
  function bindConnection(c, myColor) {
    conn = c;
    c.on("open", () => {
      hideLobby();
      Game.startOnline(myColor, (msg) => { try { c.send(msg); } catch (e) {} });
    });
    c.on("data", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "move") Game.remoteMove(msg.row, msg.col);
      else if (msg.t === "pass") Game.remotePass();
    });
    c.on("close", () => Game.peerLeft());
    c.on("error", () => Game.peerLeft());
  }

  function host() {
    if (typeof Peer === "undefined") { fail("通信ライブラリの読み込みに失敗しました。再読み込みしてください。"); return; }
    createBtn.disabled = true;
    joinBtn.disabled = true;
    const code = randomCode();
    setStatus("部屋を作成中…");
    peer = new Peer(PREFIX + code);
    peer.on("open", () => {
      codeText.textContent = code;
      codeBox.hidden = false;
      setStatus("相手の参加を待っています…（このコードを相手に送ってください）");
    });
    peer.on("connection", (c) => {
      setStatus("相手が参加しました。対局を開始します。");
      bindConnection(c, HOST);
    });
    peer.on("error", (err) => {
      if (err && err.type === "unavailable-id") fail("部屋番号が重複しました。もう一度お試しください。");
      else fail("接続エラー: " + (err && err.type ? err.type : "不明") + "（再読み込みして再試行してください）");
    });
  }

  function join() {
    if (typeof Peer === "undefined") { fail("通信ライブラリの読み込みに失敗しました。再読み込みしてください。"); return; }
    const code = (codeInput.value || "").trim().toUpperCase();
    if (code.length !== 5) { setStatus("5文字の部屋番号を入力してください。"); return; }
    createBtn.disabled = true;
    joinBtn.disabled = true;
    setStatus("接続中…");
    peer = new Peer(); // random id for the guest
    peer.on("open", () => {
      const c = peer.connect(PREFIX + code, { reliable: true });
      let opened = false;
      c.on("open", () => { opened = true; });
      bindConnection(c, GUEST);
      // If nothing opens within a few seconds, the room code is likely wrong.
      setTimeout(() => { if (!opened) fail("接続できませんでした。部屋番号を確認してください。"); }, 6000);
    });
    peer.on("error", (err) => {
      if (err && err.type === "peer-unavailable") fail("その部屋番号は見つかりません。番号を確認してください。");
      else fail("接続エラー: " + (err && err.type ? err.type : "不明"));
    });
  }

  // Events
  if (onlineBtn) onlineBtn.addEventListener("click", openLobby);
  if (closeLobby) closeLobby.addEventListener("click", () => { resetLobby(); hideLobby(); if (peer && !conn) { peer.destroy(); peer = null; } });
  if (createBtn) createBtn.addEventListener("click", host);
  if (joinBtn) joinBtn.addEventListener("click", join);
  if (codeInput) codeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });
  if (copyBtn) copyBtn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(codeText.textContent); copyBtn.textContent = "コピー済み"; setTimeout(() => copyBtn.textContent = "コピー", 1500); }
    catch (e) { /* clipboard may be blocked; user can copy manually */ }
  });
})();
