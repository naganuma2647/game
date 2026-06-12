/* Generic N-player online room (PeerJS), star topology with a host-authoritative
 * relay. Up to `maxPlayers` peers share one 5-digit room. The HOST keeps the
 * canonical seat list and serializes every action: a client calls send(msg),
 * the host stamps it with the sender's seat and broadcasts {t:'act',from,msg}
 * to EVERYONE (including the original sender). Nobody applies an action locally
 * until it echoes back, so all clients apply actions in one identical order =
 * deterministic lockstep across N players.
 *
 * Shared randomness: the host generates one seed at match start and ships it to
 * all clients, which replace Math.random with the same seeded PRNG. Combined
 * with the ordered action stream, every client computes the same game. (Hidden
 * info such as hands is rendered per-seat by the game, not enforced by the wire
 * — same casual-trust model as the 2-player click-relay games.)
 *
 * Room id namespace ("ngroom-"+code) matches shared/lobby.js, so the hub's
 * "join by number" probe can connect, learn the game via {t:'hello'}, and
 * redirect here. On connection the host always sends hello first for that.
 *
 * Per-game usage:
 *   OnlineRoom.init({
 *     gameId, minPlayers, maxPlayers,
 *     onStart(seat, nPlayers, send),   // seat 0..n-1; Math.random already seeded
 *     onMessage(fromSeat, msg),        // an action (already in global order)
 *     onRoster(count, max),            // lobby roster changed (optional)
 *     onLeft(seat),                    // a peer dropped mid-game (optional)
 *     note,                            // extra lobby help text (optional)
 *   });
 * send(msg) broadcasts to all seats (each receives it via onMessage, in order).
 */
(function () {
  const ROOM_PREFIX = "ngroom-";
  const ALPHABET = "0123456789";
  function randomCode() { let s = ""; for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]; return s; }
  const roomId = (code) => ROOM_PREFIX + code;

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function init(cfg) {
    const MIN = cfg.minPlayers || 2, MAX = cfg.maxPlayers || 4;
    let peer = null;
    let isHost = false, started = false, mySeat = 0, nPlayers = 0;
    // host only: seat 0 is the host; guests[] holds {conn, seat, alive}
    let guests = [];

    /* ---------- lobby UI ---------- */
    const ui = document.createElement('div');
    ui.innerHTML = `
<style>
#online-btn{position:fixed;top:10px;right:10px;z-index:99998;background:#2563c9;color:#fff;border:none;border-radius:999px;padding:9px 14px;font:600 13px/1 'Segoe UI',sans-serif;cursor:pointer}
#online-btn:hover{background:#2f74e0}
#online-lobby{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px}
#online-lobby[hidden]{display:none}
.oc-card{position:relative;background:#1d2330;border:1px solid rgba(255,255,255,.2);border-radius:14px;padding:22px 20px;width:100%;max-width:360px;text-align:center;color:#edf1f8;font-family:'Segoe UI','Hiragino Sans',sans-serif}
.oc-card h2{margin:0 0 6px;font-size:18px}
.oc-note{font-size:12px;opacity:.8;line-height:1.6;margin:0 0 14px}
#lobby-close{position:absolute;top:8px;right:12px;background:none;border:none;color:#edf1f8;font-size:22px;cursor:pointer;opacity:.7}
.oc-sec h3{font-size:14px;margin:0 0 8px}
.oc-div{margin:14px 0;font-size:11px;opacity:.6;display:flex;align-items:center;gap:8px}
.oc-div::before,.oc-div::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.18)}
.oc-btn{background:#e0a13a;border:none;color:#1d2330;font-weight:700;padding:9px 20px;border-radius:8px;cursor:pointer;font-size:14px}
.oc-btn:disabled{opacity:.5;cursor:default}
#room-code-box{margin-top:10px;padding:10px;background:rgba(255,255,255,.06);border-radius:9px}
#room-code-box[hidden]{display:none}
#room-code{font-size:30px;font-weight:800;letter-spacing:.22em;color:#ffd34d;font-family:Consolas,monospace;display:block;margin:4px 0}
#copy-code{background:#3a4358;border:none;color:#fff;padding:5px 12px;border-radius:7px;cursor:pointer;font-size:12px}
.oc-join{display:flex;gap:8px;justify-content:center}
#join-code{width:120px;font-size:18px;font-weight:700;letter-spacing:.18em;text-align:center;padding:7px;border-radius:8px;border:none}
#oc-roster{margin:10px 0 0;font-size:13px;color:#bcd}
#oc-roster b{color:#ffd34d}
#start-room{margin-top:12px}
#start-room[hidden]{display:none}
#online-status{min-height:18px;margin:12px 0 0;font-size:12px;font-weight:600;color:#ffd34d;line-height:1.5}
#oc-badge{position:fixed;top:10px;right:10px;z-index:99998;background:rgba(0,0,0,.65);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:9px 14px;font:600 13px/1 'Segoe UI',sans-serif;display:none}
</style>
<button id="online-btn">🌐 オンライン</button>
<div id="online-lobby" hidden>
  <div class="oc-card">
    <button id="lobby-close">×</button>
    <h2>🌐 オンライン対戦（最大${MAX}人）</h2>
    <p class="oc-note">同じ部屋番号を共有して対戦します。${cfg.note || ''}</p>
    <div class="oc-sec"><h3>部屋を作る</h3>
      <button id="create-room" class="oc-btn">部屋を作成</button>
      <div id="room-code-box" hidden><span style="font-size:11px;opacity:.7">部屋番号</span><span id="room-code">-----</span><button id="copy-code">コピー</button></div>
    </div>
    <div class="oc-div">または</div>
    <div class="oc-sec"><h3>部屋に参加する</h3>
      <div class="oc-join"><input id="join-code" maxlength="5" placeholder="5桁の番号" inputmode="numeric" autocomplete="off"><button id="join-room" class="oc-btn">参加</button></div>
    </div>
    <p id="oc-roster"></p>
    <button id="start-room" class="oc-btn" hidden>この人数で開始</button>
    <p id="online-status"></p>
  </div>
</div>
<div id="oc-badge">🌐</div>`;
    document.body.appendChild(ui);

    const $ = (id) => document.getElementById(id);
    const badge = $('oc-badge');
    function setStatus(m) { $('online-status').textContent = m || ''; }
    function openLobby() { $('online-lobby').hidden = false; }
    function hideLobby() { $('online-lobby').hidden = true; }
    function showBadge(m) { badge.style.display = 'block'; if (m != null) badge.textContent = m; }

    /* ---------- send / receive ---------- */
    // send(msg): broadcast to all seats. Host stamps & fans out; guest forwards
    // to host. Delivery (including to the sender) happens via deliver().
    function send(msg) {
      if (!started) return;
      if (isHost) hostBroadcast(0, msg);
      else { try { hostConn().send({ t: 'action', msg }); } catch (_) {} }
    }
    let _hostConn = null;
    function hostConn() { return _hostConn; }

    function deliver(fromSeat, msg) {
      try { cfg.onMessage && cfg.onMessage(fromSeat, msg); } catch (e) { console.error(e); }
    }

    // Host: stamp an action with its origin seat and send to everyone.
    function hostBroadcast(fromSeat, msg) {
      const pkt = { t: 'act', from: fromSeat, msg };
      guests.forEach(g => { if (g.alive) { try { g.conn.send(pkt); } catch (_) {} } });
      deliver(fromSeat, msg); // host applies in the same global order
    }

    function rosterText() {
      const txt = `参加者 <b>${nPlayersNow()}/${MAX}</b>人` + (nPlayersNow() < MIN ? `（最低${MIN}人で開始できます）` : '');
      $('oc-roster').innerHTML = txt;
      try { cfg.onRoster && cfg.onRoster(nPlayersNow(), MAX); } catch (_) {}
    }
    function nPlayersNow() { return isHost ? 1 + guests.filter(g => g.alive).length : nPlayers; }

    /* ---------- HOST ---------- */
    function host() {
      if (typeof Peer === 'undefined') { setStatus('通信ライブラリの読み込みに失敗しました。'); return; }
      isHost = true;
      $('create-room').disabled = true; $('join-room').disabled = true;
      const code = randomCode();
      setStatus('部屋を作成中…');
      peer = new Peer(roomId(code));
      peer.on('open', () => {
        $('room-code').textContent = code;
        $('room-code-box').hidden = false;
        $('start-room').hidden = false;
        rosterText();
        setStatus('参加者を待っています。この番号を相手に送ってください。');
      });
      peer.on('connection', (c) => {
        // First, greet so the hub's 2-player probe can learn the game & redirect.
        const greet = () => { try { c.send({ t: 'hello', game: cfg.gameId }); } catch (_) {} };
        if (c.open) greet(); else c.on('open', greet);
        c.on('data', (m) => hostOnData(c, m));
        c.on('close', () => hostDrop(c));
        c.on('error', () => hostDrop(c));
      });
      peer.on('error', (err) => {
        const t = err && err.type;
        if (t === 'unavailable-id') setStatus('その番号は使用中です。もう一度お試しください。');
        else setStatus('接続エラー: ' + (t || '不明'));
        $('create-room').disabled = false; $('join-room').disabled = false;
        isHost = false;
      });
    }
    function hostOnData(c, m) {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'join') {
        if (started) { try { c.send({ t: 'full' }); } catch (_) {} return; }
        if (1 + guests.length >= MAX) { try { c.send({ t: 'full' }); } catch (_) {} return; }
        const seat = 1 + guests.length;
        guests.push({ conn: c, seat, alive: true });
        try { c.send({ t: 'seat', seat }); } catch (_) {}
        rosterText();
        setStatus(`プレイヤー${seat + 1}が参加しました（${nPlayersNow()}/${MAX}）。`);
      } else if (m.t === 'action') {
        const g = guests.find(x => x.conn === c && x.alive);
        if (g && started) hostBroadcast(g.seat, m.msg);
      }
    }
    function hostDrop(c) {
      const g = guests.find(x => x.conn === c && x.alive);
      if (!g) return;
      g.alive = false;
      rosterText();
      if (started) {
        guests.forEach(x => { if (x.alive) { try { x.conn.send({ t: 'left', seat: g.seat }); } catch (_) {} } });
        try { cfg.onLeft && cfg.onLeft(g.seat); } catch (_) {}
        showBadge('🌐 プレイヤー' + (g.seat + 1) + 'が退出しました');
      } else {
        setStatus(`プレイヤー${g.seat + 1}が退出しました（${nPlayersNow()}/${MAX}）。`);
      }
    }
    function hostStart() {
      if (started || !isHost) return;
      const n = nPlayersNow();
      if (n < MIN) { setStatus(`最低${MIN}人必要です。`); return; }
      started = true;
      // Re-number seats compactly over the survivors so seats are 0..n-1.
      const alive = guests.filter(g => g.alive);
      alive.forEach((g, i) => { g.seat = i + 1; });
      guests = alive;
      nPlayers = n;
      const seed = (Math.random() * 0x7fffffff) | 0;
      guests.forEach(g => { try { g.conn.send({ t: 'start', seed, n, seat: g.seat }); } catch (_) {} });
      beginMatch(0, n, seed);
    }

    /* ---------- GUEST ---------- */
    function joinCode(code) {
      if (typeof Peer === 'undefined') { setStatus('通信ライブラリの読み込みに失敗しました。'); return; }
      if (!/^\d{5}$/.test(code)) { setStatus('5桁の数字を入力してください。'); return; }
      $('create-room').disabled = true; $('join-room').disabled = true;
      setStatus('接続中…');
      peer = new Peer();
      peer.on('open', () => {
        const c = peer.connect(roomId(code), { reliable: true });
        _hostConn = c;
        let settled = false;
        c.on('data', (m) => {
          if (!m || typeof m !== 'object') return;
          if (m.t === 'hello') {
            if (m.game === cfg.gameId) { try { c.send({ t: 'join' }); } catch (_) {} }
            else {
              // Different game: bounce to the right page (carry the code).
              const path = (window.OnlineLobby && OnlineLobby.GAME_PATHS) ? OnlineLobby.GAME_PATHS[m.game] : null;
              if (!path) { setStatus('不明なゲームの部屋です。'); return; }
              try { peer.destroy(); } catch (_) {}
              location.href = (cfg.basePrefix || '../') + path + '?autojoin=' + code;
            }
          } else if (m.t === 'seat') {
            settled = true; mySeat = m.seat;
            setStatus('参加しました。ホストの開始を待っています…');
            showBadge('🌐 待機中…');
          } else if (m.t === 'full') {
            setStatus('満員、または対局が始まっています。');
          } else if (m.t === 'start') {
            beginMatch(m.seat, m.n, m.seed);
          } else if (m.t === 'act') {
            deliver(m.from, m.msg);
          } else if (m.t === 'left') {
            try { cfg.onLeft && cfg.onLeft(m.seat); } catch (_) {}
            showBadge('🌐 プレイヤー' + (m.seat + 1) + 'が退出しました');
          }
        });
        c.on('error', () => { if (!settled) setStatus('接続できませんでした。番号を確認してください。'); });
        c.on('close', () => { if (started) { showBadge('🌐 ホストの接続が切れました'); } });
        setTimeout(() => { if (!settled) setStatus('応答がありません。番号を確認して再試行してください。'); }, 8000);
      });
      peer.on('error', (err) => {
        const t = err && err.type;
        if (t === 'peer-unavailable') setStatus('その部屋番号は見つかりません。');
        else setStatus('接続エラー: ' + (t || '不明'));
        $('create-room').disabled = false; $('join-room').disabled = false;
      });
    }

    /* ---------- match start ---------- */
    function beginMatch(seat, n, seed) {
      started = true; mySeat = seat; nPlayers = n;
      Math.random = mulberry32(seed);
      hideLobby();
      $('online-btn').style.display = 'none';
      showBadge('🌐 オンライン（あなたはP' + (seat + 1) + '）');
      try { cfg.onStart && cfg.onStart(seat, n, send); } catch (e) { console.error(e); }
    }

    /* ---------- wire DOM ---------- */
    $('online-btn').addEventListener('click', openLobby);
    $('lobby-close').addEventListener('click', () => { if (!started && peer) { try { peer.destroy(); } catch (_) {} peer = null; isHost = false; $('create-room').disabled = false; $('join-room').disabled = false; $('room-code-box').hidden = true; $('start-room').hidden = true; setStatus(''); } hideLobby(); });
    $('create-room').addEventListener('click', host);
    $('join-room').addEventListener('click', () => joinCode(($('join-code').value || '').trim()));
    $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinCode(($('join-code').value || '').trim()); });
    $('start-room').addEventListener('click', hostStart);
    $('copy-code').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('room-code').textContent); $('copy-code').textContent = 'コピー済み'; setTimeout(() => $('copy-code').textContent = 'コピー', 1500); } catch (_) {} });

    // Hub shortcuts: ?create / ?autojoin / ?online
    const params = new URLSearchParams(location.search);
    if (params.has('autojoin')) { openLobby(); setStatus('部屋に参加しています…'); joinCode(params.get('autojoin')); }
    else if (params.has('create')) { openLobby(); host(); }
    else if (params.has('online')) { openLobby(); }

    return {
      send,
      isOnline: () => started,
      seat: () => mySeat,
      count: () => nPlayers,
    };
  }

  window.OnlineRoom = { init };
})();
