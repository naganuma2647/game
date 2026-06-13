/* Generic online layer for single-file games (PeerJS, room numbers shared
 * with the other games via shared/lobby.js).
 *
 * How it works: both peers run the SAME deterministic game. At match start the
 * host sends a random seed; both sides replace Math.random with the same
 * seeded PRNG and reset the game into 2-player (pvp) mode. From then on every
 * click is relayed to the peer and replayed there by element index, so the two
 * DOMs stay in lockstep. Input is gated by whose turn it is, read from the
 * game's own status text.
 *
 * Per-game config: OnlineCore.init({ gameId, statusSel, hostMark, guestMark,
 *   pvpSel (button that switches the game to 2P mode; null = none),
 *   hideSel (mode buttons to hide during online; null = none), note })
 */
(function () {
  let _replaying = false, _send = null;

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function init(cfg) {
    let online = false, mySeat = 0, sendFn = null, sticky = 0, replaying = false;

    /* ---- lobby UI (ids match shared/lobby.js) ---- */
    const ui = document.createElement('div');
    ui.innerHTML = `
<style>
#online-btn{position:fixed;top:10px;right:10px;z-index:99998;background:#2563c9;color:#fff;border:none;border-radius:999px;padding:9px 14px;font:600 13px/1 'Segoe UI',sans-serif;cursor:pointer}
#online-btn:hover{background:#2f74e0}
#online-lobby{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px}
#online-lobby[hidden]{display:none}
.oc-card{position:relative;background:#1d2330;border:1px solid rgba(255,255,255,.2);border-radius:14px;padding:22px 20px;width:100%;max-width:340px;text-align:center;color:#edf1f8;font-family:'Segoe UI','Hiragino Sans',sans-serif}
.oc-card h2{margin:0 0 6px;font-size:18px}
.oc-note{font-size:12px;opacity:.8;line-height:1.6;margin:0 0 14px}
#lobby-close{position:absolute;top:8px;right:12px;background:none;border:none;color:#edf1f8;font-size:22px;cursor:pointer;opacity:.7}
.oc-sec h3{font-size:14px;margin:0 0 8px}
.oc-div{margin:14px 0;font-size:11px;opacity:.6;display:flex;align-items:center;gap:8px}
.oc-div::before,.oc-div::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.18)}
.oc-btn{background:#e0a13a;border:none;color:#1d2330;font-weight:700;padding:9px 20px;border-radius:8px;cursor:pointer;font-size:14px}
.oc-home{display:inline-block;margin-top:14px;color:#cfd6e4;font-size:13px;text-decoration:none;border:1px solid rgba(255,255,255,.25);border-radius:999px;padding:7px 16px}
.oc-home:hover{background:rgba(255,255,255,.08)}
#room-code-box{margin-top:10px;padding:10px;background:rgba(255,255,255,.06);border-radius:9px}
#room-code-box[hidden]{display:none}
#room-code{font-size:30px;font-weight:800;letter-spacing:.22em;color:#ffd34d;font-family:Consolas,monospace;display:block;margin:4px 0}
#copy-code{background:#3a4358;border:none;color:#fff;padding:5px 12px;border-radius:7px;cursor:pointer;font-size:12px}
.oc-join{display:flex;gap:8px;justify-content:center}
#join-code{width:120px;font-size:18px;font-weight:700;letter-spacing:.18em;text-align:center;padding:7px;border-radius:8px;border:none}
#online-status{min-height:18px;margin:12px 0 0;font-size:12px;font-weight:600;color:#ffd34d;line-height:1.5}
#oc-badge{position:fixed;top:10px;right:10px;z-index:99998;background:rgba(0,0,0,.65);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:9px 14px;font:600 13px/1 'Segoe UI',sans-serif;display:none}
</style>
<button id="online-btn">🌐 オンライン</button>
<div id="online-lobby" hidden>
  <div class="oc-card">
    <button id="lobby-close">×</button>
    <h2>🌐 オンライン対戦</h2>
    <p class="oc-note">2人で同じ部屋番号を共有して対戦します。${cfg.note || ''}</p>
    <div class="oc-sec"><h3>部屋を作る</h3>
      <button id="create-room" class="oc-btn">部屋を作成</button>
      <div id="room-code-box" hidden><span style="font-size:11px;opacity:.7">部屋番号</span><span id="room-code">----</span><button id="copy-code">コピー</button></div>
    </div>
    <div class="oc-div">または</div>
    <div class="oc-sec"><h3>部屋に参加する</h3>
      <div class="oc-join"><input id="join-code" maxlength="4" placeholder="4桁の番号" inputmode="numeric" autocomplete="off"><button id="join-room" class="oc-btn">参加</button></div>
    </div>
    <p id="online-status"></p>
    <a href="../index.html" class="oc-home">← 一覧に戻る</a>
  </div>
</div>
<div id="oc-badge">🌐</div>`;
    document.body.appendChild(ui);
    const badge = document.getElementById('oc-badge');

    /* ---- turn tracking from the game's own status text ---- */
    function updateSticky() {
      const el = document.querySelector(cfg.statusSel);
      const t = el ? el.textContent : '';
      if (cfg.hostMark && t.includes(cfg.hostMark)) sticky = 0;
      else if (cfg.guestMark && t.includes(cfg.guestMark)) sticky = 1;
    }
    function updateBadge(msg) {
      if (!online) return;
      updateSticky();
      const mine = sticky === mySeat;
      badge.textContent = msg || ('🌐 ' + (mine ? 'あなたの番' : '相手の番'));
      // あなたの番を緑＋強調で目立たせる
      badge.style.background = mine ? '#16a34a' : 'rgba(40,40,46,.85)';
      badge.style.boxShadow = mine ? '0 0 0 4px rgba(34,197,94,.35)' : 'none';
      badge.style.fontWeight = mine ? '800' : '600';
      badge.style.fontSize = mine ? '15px' : '13px';
    }
    setInterval(() => updateBadge(), 700);

    /* ---- click relay ---- */
    const allEls = () => document.getElementsByTagName('*');
    function elIndex(el) { return Array.prototype.indexOf.call(allEls(), el); }
    function replayClick(i) {
      const el = allEls()[i];
      if (!el) return;
      replaying = true; _replaying = true;
      try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
      finally { replaying = false; _replaying = false; }
      updateBadge();
    }

    document.addEventListener('click', (e) => {
      if (!online || replaying) return;
      if (cfg.blockRelay && cfg.blockRelay()) return;
      const t = e.target;
      if (t.closest && t.closest('#online-lobby,#online-btn,#oc-badge')) return; // local-only UI
      updateSticky();
      if (sticky !== mySeat) {
        e.preventDefault(); e.stopPropagation();
        updateBadge('🌐 相手の番です…');
        return;
      }
      try { sendFn && sendFn({ t: 'click', i: elIndex(t) }); } catch (_) {}
    }, true);

    /* ---- match start: seed RNG, switch the game to 2P mode ---- */
    function beginMatch(seed) {
      Math.random = mulberry32(seed);
      online = true;
      sticky = 0;
      if (cfg.hideSel) document.querySelectorAll(cfg.hideSel).forEach(el => el.style.display = 'none');
      if (cfg.pvpSel) {
        const b = document.querySelector(cfg.pvpSel);
        if (b) { replaying = true; try { b.click(); } finally { replaying = false; } }
      }
      badge.style.display = 'block';
      document.getElementById('online-btn').style.display = 'none';
      updateBadge(cfg.startNote ? ('🌐 ' + cfg.startNote) : undefined);
      if (cfg.afterStart) cfg.afterStart(mySeat);
      applyFlip();
    }

    /* ---- guest sees the board from their own side (rotate 180°), keeping
       piece labels upright. cfg.flip = { board: '<sel>', upright: '<sel>' } ---- */
    function applyFlip() {
      if (mySeat !== 1 || !cfg.flip) return;
      const b = cfg.flip.board, u = cfg.flip.upright;
      const st = document.createElement('style');
      st.textContent =
        `${b}{transform:rotate(180deg)}` +
        (u ? `${b} ${u}{transform:rotate(180deg);transform-box:fill-box;transform-origin:center}` : '');
      document.head.appendChild(st);
    }

    /* ---- wire into the shared lobby (same room namespace as other games) ---- */
    window.OnlineLobby.init({
      gameId: cfg.gameId,
      hostColor: 0,
      guestColor: 1,
      basePrefix: '../',
      startOnline: (seat, send) => {
        mySeat = seat; sendFn = send; _send = send;
        if (seat === 0) {
          const seed = (Math.random() * 0x7fffffff) | 0;
          try { send({ t: 'seed', seed }); } catch (_) {}
          beginMatch(seed);
        } else {
          badge.style.display = 'block';
          badge.textContent = '🌐 同期中…';
        }
      },
      applyRemote: (msg) => {
        if (msg.t === 'seed') beginMatch(msg.seed);
        else if (msg.t === 'click') replayClick(msg.i);
        else if (cfg.customMsg) cfg.customMsg(msg);
      },
      onPeerLeft: () => {
        if (!online) return;
        online = false;
        badge.textContent = '🌐 相手の接続が切れました';
        badge.style.background = 'rgba(160,40,40,.85)';
      },
    });
  }

  window.OnlineCore = {
    init,
    send: (m) => { try { _send && _send(m); } catch (_) {} },
    isReplaying: () => _replaying,
  };
})();
