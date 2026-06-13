/* Generic N-player online room (PeerJS), star topology with a host-authoritative
 * relay. Up to `maxPlayers` peers share one 4-digit room. The HOST keeps the
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
  function randomCode() { let s = ""; for (let i = 0; i < 4; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]; return s; }
  const roomId = (code) => ROOM_PREFIX + code;

  function init(cfg) {
    // Seeded RNG whose state is a single int we can read/restore, so a
    // reconnecting player can resume the exact same random sequence.
    let _rngA = 0;
    function stepRng() {
      let a = _rngA | 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      _rngA = a;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
    function seedRng(seed) { _rngA = seed | 0; Math.random = stepRng; }
    const MIN = cfg.minPlayers || 2, MAX = cfg.maxPlayers || 4;
    let peer = null;
    let isHost = false, started = false, mySeat = 0, nPlayers = 0, nCpus = 0;
    // host only: seat 0 is the host; guests[] holds {conn, seat, alive}
    let guests = [];
    let cpus = 0; // host's chosen CPU count, applied at start
    const gone = new Set(); // seats whose human left mid-game (relay auto-plays them)
    // Host migration: if the relay (host) leaves, the surviving peer with the
    // smallest seat becomes the new relay (a fresh Peer at roomId+'-'+gen) and
    // the others reconnect to it; the departed relay's seat becomes a CPU.
    let code = null;          // room code (host & guests both keep it)
    let gen = 0;              // relay generation (bumps on each migration)
    let relaySeat = 0;        // seat currently acting as relay
    let roster = new Set();   // alive human seats incl. the relay (for election)
    let migrating = false;

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
#cpu-row{margin:10px 0 0;font-size:12px;color:#bcd;display:flex;gap:6px;justify-content:center;align-items:center;flex-wrap:wrap}
#cpu-row[hidden]{display:none}
#cpu-row .lab{opacity:.85}
#cpu-row button{background:#3a4358;border:1px solid #555f7a;color:#edf1f8;padding:3px 10px;border-radius:14px;font-size:12px;cursor:pointer}
#cpu-row button.on{background:#e0a13a;border-color:#e0a13a;color:#1d2330;font-weight:700}
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
      <div id="room-code-box" hidden><span style="font-size:11px;opacity:.7">部屋番号</span><span id="room-code">----</span><button id="copy-code">コピー</button></div>
    </div>
    <div class="oc-div">または</div>
    <div class="oc-sec"><h3>部屋に参加する</h3>
      <div class="oc-join"><input id="join-code" maxlength="4" placeholder="4桁の番号" inputmode="numeric" autocomplete="off"><button id="join-room" class="oc-btn">参加</button></div>
    </div>
    <p id="oc-roster"></p>
    <div id="cpu-row" hidden><span class="lab">CPUを追加:</span><span id="cpu-btns"></span></div>
    <button id="start-room" class="oc-btn" hidden>この人数で開始</button>
    <button id="reclaim-room" class="oc-btn" hidden style="background:#3a8f5a;color:#fff;margin-top:10px">🔄 前の対局に再接続</button>
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
      const humans = nPlayersNow();
      let txt = `参加者 <b>${humans}/${MAX}</b>人`;
      if (isHost && cpus > 0) txt += `（+ CPU ${cpus}）`;
      const total = humans + (isHost ? cpus : 0);
      if (total < MIN) txt += `（最低${MIN}人で開始できます）`;
      $('oc-roster').innerHTML = txt;
      if (isHost) {
        const maxCpu = MAX - humans;
        const minCpu = Math.max(0, MIN - humans);
        if (cpus > maxCpu) cpus = maxCpu;
        if (cpus < minCpu) cpus = minCpu;
        renderCpuButtons(humans);
      }
      try { cfg.onRoster && cfg.onRoster(humans, MAX); } catch (_) {}
    }
    function renderCpuButtons(humans) {
      const row = $('cpu-row');
      const maxCpu = MAX - humans;
      row.hidden = !isHost || maxCpu < 1;
      let html = '';
      for (let i = 0; i <= maxCpu; i++) html += `<button data-cpu="${i}" class="${i === cpus ? 'on' : ''}">${i}</button>`;
      $('cpu-btns').innerHTML = html;
      $('cpu-btns').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { cpus = +b.dataset.cpu; rosterText(); }));
    }
    function nPlayersNow() { return isHost ? 1 + guests.filter(g => g.alive).length : nPlayers; }

    /* ---------- HOST / relay ---------- */
    function wireIncoming(c) {
      // First, greet so the hub's 2-player probe can learn the game & redirect.
      const greet = () => { try { c.send({ t: 'hello', game: cfg.gameId }); } catch (_) {} };
      if (c.open) greet(); else c.on('open', greet);
      c.on('data', (m) => hostOnData(c, m));
      c.on('close', () => hostDrop(c));
      c.on('error', () => hostDrop(c));
    }
    function broadcastRoster() {
      if (!isHost) return;
      // roster = relay seat + alive reconnected guests
      roster = new Set([relaySeat]);
      guests.forEach(g => { if (g.alive) roster.add(g.seat); });
      const pkt = { t: 'roster', seats: [...roster], relaySeat, gen };
      guests.forEach(g => { if (g.alive) { try { g.conn.send(pkt); } catch (_) {} } });
    }
    function host() {
      if (typeof Peer === 'undefined') { setStatus('通信ライブラリの読み込みに失敗しました。'); return; }
      isHost = true; relaySeat = 0;
      $('create-room').disabled = true; $('join-room').disabled = true;
      code = randomCode();
      setStatus('部屋を作成中…');
      peer = new Peer(roomId(code));
      peer.on('open', () => {
        $('room-code').textContent = code;
        $('room-code-box').hidden = false;
        $('start-room').hidden = false;
        rosterText();
        setStatus('参加者を待っています。この番号を相手に送ってください。');
      });
      peer.on('connection', wireIncoming);
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
      } else if (m.t === 'rejoin') {
        // a survivor reconnecting to the new relay after a migration
        if (typeof m.seat === 'number') {
          const ex = guests.find(g => g.seat === m.seat);
          if (ex) { ex.conn = c; ex.alive = true; } else guests.push({ conn: c, seat: m.seat, alive: true });
          gone.delete(m.seat);
          broadcastRoster();
        }
      } else if (m.t === 'reclaim') {
        // a previously-departed human is reconnecting to reclaim their seat
        const seat = m.seat;
        if (started && gone.has(seat) && m.game === cfg.gameId) {
          gone.delete(seat);
          const ex = guests.find(g => g.seat === seat);
          if (ex) { ex.conn = c; ex.alive = true; } else guests.push({ conn: c, seat, alive: true });
          roster.add(seat);
          try { c.send({ t: 'resume', seat, snap: snapshot(), relaySeat, gen }); } catch (_) {}
          broadcastRoster();
          showBadge('🌐 プレイヤー' + (seat + 1) + 'が再接続しました');
        } else {
          try { c.send({ t: 'full' }); } catch (_) {}
        }
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
        gone.add(g.seat);
        roster.delete(g.seat);
        guests.forEach(x => { if (x.alive) { try { x.conn.send({ t: 'left', seat: g.seat }); } catch (_) {} } });
        try { cfg.onLeft && cfg.onLeft(g.seat); } catch (_) {}
        showBadge('🌐 プレイヤー' + (g.seat + 1) + 'が退出しました');
      } else {
        setStatus(`プレイヤー${g.seat + 1}が退出しました（${nPlayersNow()}/${MAX}）。`);
      }
    }
    function hostStart() {
      if (started || !isHost) return;
      const humans = nPlayersNow();
      const n = humans + cpus;
      if (n < MIN) { setStatus(`最低${MIN}人必要です（CPUを増やせます）。`); return; }
      if (n > MAX) { setStatus(`${MAX}人以内にしてください。`); return; }
      started = true;
      const alive = guests.filter(g => g.alive);
      alive.forEach((g, i) => { g.seat = i + 1; });
      guests = alive;
      nPlayers = n;
      relaySeat = 0; gen = 0;
      roster = new Set([0]); guests.forEach(g => roster.add(g.seat));
      const seed = (Math.random() * 0x7fffffff) | 0;
      guests.forEach(g => { try { g.conn.send({ t: 'start', seed, n, seat: g.seat, cpus }); } catch (_) {} });
      beginMatch(0, n, seed, cpus);
      broadcastRoster();
    }

    /* ---------- GUEST ---------- */
    // Post-handshake messages from the relay (shared by initial + reconnected conn).
    function guestApply(m) {
      if (m.t === 'start') beginMatch(m.seat, m.n, m.seed, m.cpus || 0);
      else if (m.t === 'act') deliver(m.from, m.msg);
      else if (m.t === 'roster') { roster = new Set(m.seats); relaySeat = m.relaySeat; if (m.gen > gen) gen = m.gen; }
      else if (m.t === 'left') {
        gone.add(m.seat); roster.delete(m.seat);
        try { cfg.onLeft && cfg.onLeft(m.seat); } catch (_) {}
        showBadge('🌐 プレイヤー' + (m.seat + 1) + 'が退出しました');
      }
    }
    function joinCode(c0) {
      if (typeof Peer === 'undefined') { setStatus('通信ライブラリの読み込みに失敗しました。'); return; }
      if (!/^\d{4}$/.test(c0)) { setStatus('4桁の数字を入力してください。'); return; }
      code = c0;
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
          } else { guestApply(m); }
        });
        c.on('error', () => { if (!settled) setStatus('接続できませんでした。番号を確認してください。'); });
        c.on('close', () => { if (started) migrate(); });
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
    function beginMatch(seat, n, seed, cpusIn) {
      started = true; mySeat = seat; nPlayers = n; nCpus = cpusIn || 0;
      seedRng(seed);
      saveSession();
      hideLobby();
      $('online-btn').style.display = 'none';
      const cpuTxt = nCpus > 0 ? ` / CPU×${nCpus}` : '';
      showBadge('🌐 オンライン（あなたはP' + (seat + 1) + cpuTxt + '）');
      try { cfg.onStart && cfg.onStart(seat, n, send); } catch (e) { console.error(e); }
    }
    function saveSession() {
      try { sessionStorage.setItem('ngRoom:' + cfg.gameId, JSON.stringify({ code, seat: mySeat })); } catch (_) {}
    }
    // Snapshot of the live game for a reconnecting player (relay side).
    function snapshot() {
      return { rng: _rngA, n: nPlayers, cpus: nCpus, state: (cfg.getState ? cfg.getState() : null) };
    }

    /* ---------- host migration (relay left) ---------- */
    // The relay (host) dropped: its seat becomes a CPU, and the surviving peer
    // with the smallest seat becomes the new relay; the rest reconnect to it.
    function migrate() {
      if (migrating || !started) return;
      migrating = true;
      gone.add(relaySeat);
      roster.delete(relaySeat);
      try { cfg.onLeft && cfg.onLeft(relaySeat); } catch (_) {}
      showBadge('🌐 ホストが退出 — 引き継ぎ中…');
      elect();
    }
    function elect() {
      if (!roster.size) { showBadge('🌐 全員退出しました'); return; }
      const succ = Math.min(...roster);
      gen += 1;
      const nid = roomId(code) + '-' + gen;
      if (mySeat === succ) becomeRelay(nid);
      else setTimeout(() => reconnectTo(nid, succ), 300 + mySeat * 60);
    }
    function becomeRelay(nid) {
      isHost = true; relaySeat = mySeat; _hostConn = null;
      guests = []; // survivors will re-register via 'rejoin'
      try { if (peer && !peer.destroyed) peer.destroy(); } catch (_) {}
      peer = new Peer(nid);
      peer.on('open', () => {
        migrating = false;
        showBadge('🌐 あなたがホストを引き継ぎました');
        broadcastRoster();
        // nudge the game: if it is now an absent seat's turn, the relay auto-plays
        try { cfg.onLeft && cfg.onLeft(relaySeat); } catch (_) {}
      });
      peer.on('connection', wireIncoming);
      peer.on('error', () => { showBadge('🌐 引き継ぎに失敗しました（再読み込みしてください）'); });
    }
    function reconnectTo(nid, succ) {
      const go = () => {
        const c = peer.connect(nid, { reliable: true });
        _hostConn = c;
        let ok = false;
        c.on('open', () => { ok = true; migrating = false; try { c.send({ t: 'rejoin', seat: mySeat }); } catch (_) {} showBadge('🌐 新ホストに再接続しました'); });
        c.on('data', (m) => { if (m && typeof m === 'object') guestApply(m); });
        c.on('close', () => { if (started) migrate(); });
        c.on('error', () => {});
        // successor never showed up → drop it and re-elect
        setTimeout(() => { if (!ok && started) { roster.delete(succ); migrating = false; migrate(); } }, 5000);
      };
      if (!peer || peer.destroyed) { peer = new Peer(); peer.on('open', go); peer.on('error', () => {}); }
      else go();
    }

    /* ---------- reconnect (a departed human reclaims their seat) ---------- */
    function reclaim(savedCode, savedSeat) {
      if (typeof Peer === 'undefined') { setStatus('通信ライブラリの読み込みに失敗しました。'); return; }
      code = savedCode; mySeat = savedSeat;
      setStatus('前の対局に再接続しています…');
      peer = new Peer();
      peer.on('open', () => probeGen(0));
      peer.on('error', () => setStatus('再接続できませんでした。'));
    }
    // The current relay sits at roomId(code) (gen 0) or roomId(code)-N after
    // migrations; we don't know N, so probe a few generations.
    function probeGen(g) {
      if (g > MAX + 1) { setStatus('部屋が見つかりませんでした（対局が終了した可能性があります）。'); return; }
      const id = g === 0 ? roomId(code) : roomId(code) + '-' + g;
      const c = peer.connect(id, { reliable: true });
      let done = false;
      c.on('open', () => { try { c.send({ t: 'reclaim', seat: mySeat, game: cfg.gameId }); } catch (_) {} });
      c.on('data', (m) => {
        if (!m || typeof m !== 'object' || done) { if (m && m.t && started) guestApply(m); return; }
        if (m.t === 'resume') {
          done = true; _hostConn = c; relaySeat = m.relaySeat; gen = m.gen;
          c.on('close', () => { if (started) migrate(); });
          applyResume(m);
        } else if (m.t === 'full') {
          done = true; setStatus('再接続できません（席が空いていない、または対局終了）。');
        }
        // ignore hello; reclaim was already sent on open
      });
      c.on('error', () => { if (!done) probeGen(g + 1); });
      setTimeout(() => { if (!done) { try { c.close(); } catch (_) {} probeGen(g + 1); } }, 2500);
    }
    function applyResume(m) {
      const snap = m.snap;
      started = true; mySeat = m.seat; nPlayers = snap.n; nCpus = snap.cpus || 0;
      Math.random = stepRng; _rngA = snap.rng | 0; // resume the exact RNG stream
      saveSession();
      hideLobby();
      $('online-btn').style.display = 'none';
      showBadge('🌐 再接続しました（あなたはP' + (mySeat + 1) + '）');
      try { cfg.applyState && cfg.applyState({ seat: mySeat, n: nPlayers, send, state: snap.state }); }
      catch (e) { console.error(e); }
    }
    function savedSession() {
      try { const s = sessionStorage.getItem('ngRoom:' + cfg.gameId); return s ? JSON.parse(s) : null; } catch (_) { return null; }
    }

    /* ---------- wire DOM ---------- */
    $('online-btn').addEventListener('click', openLobby);
    $('lobby-close').addEventListener('click', () => { if (!started && peer) { try { peer.destroy(); } catch (_) {} peer = null; isHost = false; $('create-room').disabled = false; $('join-room').disabled = false; $('room-code-box').hidden = true; $('start-room').hidden = true; setStatus(''); } hideLobby(); });
    $('create-room').addEventListener('click', host);
    $('join-room').addEventListener('click', () => joinCode(($('join-code').value || '').trim()));
    $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinCode(($('join-code').value || '').trim()); });
    $('start-room').addEventListener('click', hostStart);
    // Offer reconnect if a previous session for this game is remembered.
    (function () {
      const saved = savedSession();
      const btn = $('reclaim-room');
      if (saved && cfg.applyState && /^\d{4}$/.test(saved.code || '')) {
        btn.hidden = false;
        btn.textContent = '🔄 前の対局に再接続（P' + ((saved.seat | 0) + 1) + '）';
        btn.addEventListener('click', () => { btn.disabled = true; reclaim(saved.code, saved.seat | 0); });
      }
    })();
    $('copy-code').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('room-code').textContent); $('copy-code').textContent = 'コピー済み'; setTimeout(() => $('copy-code').textContent = 'コピー', 1500); } catch (_) {} });

    // Hub shortcuts: ?create / ?autojoin / ?online
    const params = new URLSearchParams(location.search);
    if (params.has('autojoin')) { openLobby(); setStatus('部屋に参加しています…'); joinCode(params.get('autojoin')); }
    else if (params.has('create')) { openLobby(); host(); }
    else if (params.has('online')) { openLobby(); }

    const api = {
      send,
      isOnline: () => started,
      seat: () => mySeat,
      count: () => nPlayers,
      isCpu: (s) => started && nCpus > 0 && s >= (nPlayers - nCpus),
      isGone: (s) => gone.has(s),
      isAuto: (s) => gone.has(s) || (started && nCpus > 0 && s >= (nPlayers - nCpus)),
      isHost: () => isHost,
      cpuCount: () => nCpus,
    };
    Object.assign(window.OnlineRoom, api);
    return api;
  }

  window.OnlineRoom = { init };
})();
