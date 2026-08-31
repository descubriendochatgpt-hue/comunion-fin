/* Fantasy Stock League — front end.
   Talks to the Apps Script web app over JSONP, so it works from any static host. */
(function () {
  "use strict";

  var SQUAD = 10, LINEUP = 7, BUDGET = 300000000;
  var SHORT = { Technology: "Tech", Health: "Health", Money: "Money",
                Everyday: "Everyday", Industry: "Industry", "Industry & Energy": "Industry" };

  var S = { view: "auth", me: null, league: null, managers: [], owned: {},
            companies: [], busy: false, err: null, note: null, ready: false };
  var F = { q: "", fam: "all", sort: "cost-desc" };
  var draft = { lineup: [], conv: null };

  var $ = function (id) { return document.getElementById(id); };
  var money = function (n) { return (n / 1e6).toFixed(1) + "M"; };
  var sign = function (n) { return (n > 0 ? "+" : "") + Math.round(n); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };

  // ------------------------------------------------------------- transport
  var jsonpSeq = 0;
  function api(action, params) {
    return new Promise(function (resolve) {
      if (!window.FSL_CONFIG || !window.FSL_CONFIG.API_URL ||
          window.FSL_CONFIG.API_URL.indexOf("PASTE") === 0) {
        return resolve({ ok: false, error: "assets/config.js still has the placeholder URL. Paste your Apps Script /exec URL there." });
      }
      var cb = "fslcb" + (++jsonpSeq) + "_" + Date.now();
      var url = window.FSL_CONFIG.API_URL + "?action=" + encodeURIComponent(action) + "&callback=" + cb;
      Object.keys(params || {}).forEach(function (k) {
        if (params[k] !== undefined && params[k] !== null) {
          url += "&" + k + "=" + encodeURIComponent(params[k]);
        }
      });
      var script = document.createElement("script");
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true; cleanup();
        resolve({ ok: false, error: "the backend did not answer. Check the web app is deployed with access set to Anyone." });
      }, 20000);
      function cleanup() {
        clearTimeout(timer);
        delete window[cb];
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      window[cb] = function (data) { if (done) return; done = true; cleanup(); resolve(data); };
      script.onerror = function () {
        if (done) return; done = true; cleanup();
        resolve({ ok: false, error: "could not reach the backend URL" });
      };
      script.src = url;
      document.head.appendChild(script);
    });
  }

  // ------------------------------------------------------------- local profile
  function saveMe() { try { localStorage.setItem("fsl.me", JSON.stringify(S.me)); } catch (e) {} }
  function loadMe() { try { return JSON.parse(localStorage.getItem("fsl.me")); } catch (e) { return null; } }
  function forgetMe() { try { localStorage.removeItem("fsl.me"); } catch (e) {} }

  function co(t) {
    for (var i = 0; i < S.companies.length; i++) if (S.companies[i].t === t) return S.companies[i];
    return null;
  }
  function meMgr() {
    for (var i = 0; i < S.managers.length; i++) if (S.managers[i].me) return S.managers[i];
    return null;
  }
  function famOf(c) { return SHORT[c.f] || c.f; }
  function moveOf(c) { return c.pv ? (c.v - c.pv) / c.pv * 100 : 0; }

  // ------------------------------------------------------------- boot
  async function boot() {
    var params = new URLSearchParams(location.search);
    var invited = params.get("league");
    S.me = loadMe();
    if (invited && (!S.me || S.me.code !== invited.toUpperCase())) {
      S.invited = invited.toUpperCase();
      S.me = null;
    }
    render();
    var u = await api("universe", {});
    if (!u.ok) { S.err = u.error; S.view = "auth"; return render(); }
    S.companies = u.companies || [];
    S.ready = true;
    if (S.me) { await refresh(); } else { S.view = "auth"; render(); }
  }

  async function refresh() {
    if (!S.me) return;
    S.busy = true; render();
    var r = await api("state", { code: S.me.code, email: S.me.email });
    S.busy = false;
    if (!r.ok) { S.err = r.error; S.view = "auth"; S.me = null; forgetMe(); return render(); }
    S.league = r.league; S.managers = r.managers || []; S.owned = r.owned || {};
    var m = meMgr();
    draft.lineup = (m && m.lineup && m.lineup.length) ? m.lineup.slice() : [];
    draft.conv = m ? m.conviction : null;
    S.view = (m && m.squad.length < SQUAD) ? "build" : "team";
    render();
  }

  async function createLeague() {
    var name = $("lgName").value, who = $("myName").value, mail = $("myMail").value;
    S.busy = true; S.err = null; render();
    var r = await api("create", { league: name, name: who, email: mail, max: $("maxN").value || 12 });
    S.busy = false;
    if (!r.ok) { S.err = r.error; return render(); }
    S.me = { email: String(mail).trim().toLowerCase(), name: who, code: r.code };
    saveMe(); S.note = "League created. Share the link on the Invite tab."; await refresh();
  }

  async function joinLeague() {
    var name = $("lgName").value, who = $("myName").value, mail = $("myMail").value;
    S.busy = true; S.err = null; render();
    var r = await api("join", { league: name, name: who, email: mail });
    S.busy = false;
    if (!r.ok) { S.err = r.error; return render(); }
    S.me = { email: String(mail).trim().toLowerCase(), name: who, code: r.code };
    saveMe(); await refresh();
  }

  async function act(action, params, okNote) {
    S.busy = true; S.err = null; render();
    var r = await api(action, Object.assign({ code: S.me.code, email: S.me.email }, params));
    S.busy = false;
    if (!r.ok) { S.err = r.error; render(); return false; }
    if (okNote) S.note = okNote;
    await refresh();
    return true;
  }

  var buy = function (t) { return act("sign", { ticker: t }); };
  var sell = function (t) { return act("sell", { ticker: t }); };
  var saveLineup = function () {
    return act("lineup", { lineup: JSON.stringify(draft.lineup), conviction: draft.conv },
               "Lineup saved. It scores at the next settlement.");
  };

  // ------------------------------------------------------------- budget maths
  function spent(m) {
    var s = 0;
    m.squad.forEach(function (t) { var c = co(t); if (c) s += c.v; });
    return s;
  }
  function freeCosts() {
    var arr = [];
    S.companies.forEach(function (c) { if (!S.owned[c.t]) arr.push(c.v * 1.02); });
    return arr.sort(function (a, b) { return a - b; });
  }
  function reserve(k, excludeVal) {
    if (k <= 0) return 0;
    var arr = freeCosts(), s = 0, n = 0, skipped = (excludeVal === undefined);
    for (var i = 0; i < arr.length && n < k; i++) {
      if (!skipped && Math.abs(arr[i] - excludeVal) < 1) { skipped = true; continue; }
      s += arr[i]; n++;
    }
    return n < k ? Infinity : s;
  }
  function canSign(m, c) {
    if (S.owned[c.t]) return false;
    var cost = c.v * 1.02;
    return cost <= m.credits - reserve(SQUAD - m.squad.length - 1, cost);
  }

  // ------------------------------------------------------------- views
  function shareUrl() {
    return location.origin + location.pathname + "?league=" + (S.league ? S.league.code : "");
  }

  function authHTML() {
    var inv = S.invited
      ? '<p class="note" style="margin-bottom:10px">You were invited to <b>' + esc(S.invited) +
        '</b>. Fill your name and email and press Join.</p>' : "";
    return '<div class="eyebrow"><span>Sign in</span><span>' +
      (S.ready ? S.companies.length + " companies loaded" : "loading…") + '</span></div>' +
      '<div class="meter">' + inv +
      '<div class="search"><input type="text" id="lgName" placeholder="League name, e.g. Oficina Vigo" value="' +
        esc(S.invited || "") + '"></div>' +
      '<div class="search"><input type="text" id="myName" placeholder="Your manager name"></div>' +
      '<div class="search"><input type="text" id="myMail" placeholder="Your email"></div>' +
      '<div class="search" style="margin-bottom:0"><input type="text" id="maxN" placeholder="Max managers (12)" value="12"></div>' +
      '</div>' +
      '<button class="go" id="joinBtn">' + (S.busy ? "Working…" : "Join this league") + '</button>' +
      '<button class="go ghost" id="createBtn">Create it instead</button>' +
      '<p class="note" style="margin-top:12px">To join, you only need the league name someone gives you. ' +
      'Your email identifies you, so you can come back on any device.</p>';
  }

  function inviteHTML() {
    var full = S.managers.length >= S.league.max;
    return '<div class="eyebrow"><span>Invite your friends</span><span>' + S.managers.length +
      ' of ' + S.league.max + ' managers</span></div>' +
      '<div class="meter"><div class="mrow"><span>League name</span><b>' + esc(S.league.name) + '</b></div>' +
      '<div class="mrow" style="margin-top:6px"><span>They can also just type this</span><b class="mono">' +
      esc(S.league.code) + '</b></div></div>' +
      '<div class="eyebrow"><span>Share link</span></div>' +
      '<div class="meter"><input type="text" id="shareBox" readonly value="' + esc(shareUrl()) + '">' +
      '<button class="go" id="copyBtn" style="margin-top:9px">Copy the link</button></div>' +
      (full ? '<p class="note warn">This league is full.</p>'
            : '<p class="note">Anyone opening that link lands on the join screen with the league already filled in. ' +
              'They add their name and email and they are in.</p>') +
      '<hr class="rule"><div class="eyebrow"><span>Managers</span></div>' +
      S.managers.map(function (m) {
        return '<div class="res"><div class="g"><div class="n">' + esc(m.name) + (m.me ? " (you)" : "") +
          '</div><div class="m mono">' + esc(m.email) + ' · squad ' + m.squad.length + '/10</div></div></div>';
      }).join("") +
      '<button class="go ghost" id="outBtn">Sign out of this device</button>';
  }

  function buildHTML() {
    var m = meMgr();
    var pct = Math.min(100, (BUDGET - m.credits) / BUDGET * 100);
    var need = reserve(SQUAD - m.squad.length);
    var slots = [];
    for (var i = 0; i < SQUAD; i++) {
      var t = m.squad[i];
      slots.push(t === undefined ? '<div class="slot">' + (i + 1) + '</div>'
        : '<div class="slot full" data-sell="' + t + '"><b>' + t + '</b><span>' +
          money(co(t) ? co(t).v : 0) + '</span></div>');
    }
    var q = F.q.trim().toLowerCase();
    var list = S.companies.filter(function (c) { return !S.owned[c.t] || S.owned[c.t] === S.me.email; });
    if (F.fam !== "all") list = list.filter(function (c) { return famOf(c) === F.fam; });
    if (q) list = list.filter(function (c) {
      return c.t.toLowerCase().indexOf(q) >= 0 || String(c.n).toLowerCase().indexOf(q) >= 0;
    });
    list.sort(F.sort === "cost-desc" ? function (a, b) { return b.v - a.v; }
      : F.sort === "cost-asc" ? function (a, b) { return a.v - b.v; }
      : function (a, b) { return String(a.n).localeCompare(String(b.n)); });

    var rows = list.slice(0, 60).map(function (c) {
      var mine = S.owned[c.t] === S.me.email, can = canSign(m, c) && m.squad.length < SQUAD;
      return '<div class="res ' + ((!mine && !can) ? "taken" : "") + '"><div class="g"><div class="n">' +
        esc(c.n) + '</div><div class="m mono">' + c.t + ' · ' + famOf(c) + '</div></div>' +
        '<div class="c mono">' + money(c.v * 1.02) + '</div>' +
        (mine ? '<button class="mini" data-sell="' + c.t + '">Release</button>'
              : '<button class="add" data-buy="' + c.t + '" ' + (can ? "" : "disabled") + '>Sign</button>') +
        '</div>';
    }).join("") || '<div class="empty">Nothing matches that.</div>';

    return '<div class="meter"><div class="mrow"><span>Budget left</span><b class="mono">' +
      money(m.credits) + '</b></div><div class="bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="mrow" style="margin-top:6px"><span>' + m.squad.length + '/10 signed</span><span>' +
      (m.squad.length < SQUAD ? "cheapest way to fill the rest: " + money(need) : "squad complete") +
      '</span></div></div>' +
      '<div class="slots">' + slots.join("") + '</div>' + searchBar(false) +
      '<div class="results">' + rows + '</div>' +
      (m.squad.length === SQUAD
        ? '<p class="note" style="margin-top:12px">Squad complete. Field your seven on the Team sheet.</p>'
        : '<p class="note" style="margin-top:12px">Sign ' + (SQUAD - m.squad.length) + ' more to start playing.</p>');
  }

  function searchBar(withMove) {
    return '<div class="search"><input type="text" id="q" placeholder="Search by ticker or name" value="' +
      esc(F.q) + '" autocomplete="off"><select id="sort">' +
      '<option value="cost-desc"' + (F.sort === "cost-desc" ? " selected" : "") + '>Priciest</option>' +
      '<option value="cost-asc"' + (F.sort === "cost-asc" ? " selected" : "") + '>Cheapest</option>' +
      (withMove ? '<option value="move"' + (F.sort === "move" ? " selected" : "") + '>Biggest risers</option>' : "") +
      '<option value="name"' + (F.sort === "name" ? " selected" : "") + '>A–Z</option></select></div>' +
      '<div class="chips"><button class="fchip" data-fam="all" aria-pressed="' + (F.fam === "all") + '">All</button>' +
      ["Tech", "Health", "Money", "Everyday", "Industry"].map(function (f) {
        return '<button class="fchip" data-fam="' + f + '" aria-pressed="' + (F.fam === f) + '">' + f + '</button>';
      }).join("") + '</div>';
  }

  function teamHTML() {
    var m = meMgr();
    var chips = m.squad.map(function (t) {
      var c = co(t) || { t: t, n: t, v: 0, f: "", p: 0 };
      var on = draft.lineup.indexOf(t) >= 0, conv = draft.conv === t;
      var d = moveOf(c);
      var dv = d ? '<span class="dv ' + (d >= 0 ? "pos" : "neg") + '">' + (d >= 0 ? "▲" : "▼") +
        Math.abs(d).toFixed(1) + '%</span>' : "";
      var halo = c.p > 0 ? " up" : c.p < 0 ? " down" : "";
      return '<button class="chip ' + (on ? "on " : "") + (conv ? "conv " : "") + halo + '" data-id="' + t + '">' +
        (conv ? '<span class="star">★</span>' : "") + '<span class="tk">' + t + '</span>' +
        '<span class="vl mono">' + money(c.v) + ' ' + dv + '</span>' +
        '<span class="fm">' + famOf(c) + '</span></button>';
    }).join("");

    var n = draft.lineup.length, ok = (n === LINEUP && draft.conv);
    var msg = n < LINEUP ? '<span class="mono">' + n + '/7</span> fielded. Any seven you like.'
      : !draft.conv ? 'Seven in. Tap one again to set your <b>conviction</b> — it doubles, both ways.'
      : 'Conviction on <b>' + draft.conv + '</b>. Save it before the weekend settlement.';

    return rivalHTML() +
      '<div class="eyebrow"><span>Your squad · tap to field</span><span>week ' + S.league.week + '</span></div>' +
      '<div class="sheet">' + chips + '</div><hr class="rule"><p class="note">' + msg + '</p>' +
      '<button class="go" id="saveBtn" ' + (ok ? "" : "disabled") + '>' +
      (S.busy ? "Saving…" : "Save my lineup") + '</button>' +
      '<p class="note" style="margin-top:10px">Scores settle automatically once a week, from the closing ' +
      'prices your sheet captured. There is no button for it.</p>';
  }

  function rivalHTML() {
    var m = meMgr();
    if (!m || S.managers.length < 2) return "";
    var st = S.managers.slice().sort(function (a, b) { return b.points - a.points; });
    var i = st.findIndex(function (x) { return x.me; });
    var target = i > 0 ? st[i - 1] : st[1];
    if (!target) return "";
    var gap = Math.abs(Math.round(target.points - m.points));
    return '<div class="rival"><div><span class="rl">' + (i > 0 ? "Chasing" : "Being chased by") +
      '</span><b>' + esc(target.name) + '</b></div><div class="rg mono">' + (i > 0 ? "−" : "+") + gap + '</div></div>';
  }

  function marketHTML() {
    var m = meMgr();
    var q = F.q.trim().toLowerCase();
    var list = S.companies.filter(function (c) { return !S.owned[c.t]; });
    if (F.fam !== "all") list = list.filter(function (c) { return famOf(c) === F.fam; });
    if (q) list = list.filter(function (c) {
      return c.t.toLowerCase().indexOf(q) >= 0 || String(c.n).toLowerCase().indexOf(q) >= 0;
    });
    list.sort(F.sort === "cost-desc" ? function (a, b) { return b.v - a.v; }
      : F.sort === "cost-asc" ? function (a, b) { return a.v - b.v; }
      : F.sort === "move" ? function (a, b) { return moveOf(b) - moveOf(a); }
      : function (a, b) { return String(a.n).localeCompare(String(b.n)); });

    var rows = list.slice(0, 60).map(function (c) {
      var cost = c.v * 1.02, can = m.squad.length < SQUAD && m.credits >= cost;
      var d = moveOf(c);
      return '<div class="res ' + (can ? "" : "taken") + '"><div class="g"><div class="n">' + esc(c.n) +
        '</div><div class="m mono">' + c.t + ' · ' + famOf(c) +
        (d ? ' <span class="' + (d >= 0 ? "pos" : "neg") + '">' + (d >= 0 ? "▲" : "▼") +
             Math.abs(d).toFixed(1) + '%</span>' : "") + '</div></div>' +
        '<div class="c mono">' + money(cost) + '</div>' +
        '<button class="add" data-buy="' + c.t + '" ' + (can ? "" : "disabled") + '>Buy</button></div>';
    }).join("") || '<div class="empty">Nothing matches that.</div>';

    var mine = m.squad.map(function (t) {
      var c = co(t) || { v: 0, n: t };
      var paid = m.paid[t] || c.v, pl = paid ? (c.v - paid) / paid * 100 : 0;
      return '<div class="res"><div class="g"><div class="n">' + esc(c.n) + '</div><div class="m mono">' +
        t + ' · paid ' + money(paid) + ' · <span class="' + (pl >= 0 ? "pos" : "neg") + '">' +
        (pl >= 0 ? "+" : "") + pl.toFixed(1) + '%</span></div></div><div class="c mono">' +
        money(c.v * 0.9) + '</div><button class="mini" data-sell="' + t + '">Sell</button></div>';
    }).join("");

    return '<div class="meter"><div class="mrow"><span>Cash</span><b class="mono">' + money(m.credits) +
      '</b></div><div class="mrow" style="margin-top:6px"><span>' + m.squad.length + '/10 held</span><span>' +
      (m.squad.length === SQUAD ? "squad full — sell before you buy" : "buy " + (SQUAD - m.squad.length) + " more to play") +
      '</span></div></div>' +
      '<div class="eyebrow"><span>Your holdings · sell at 90%</span><span>P/L</span></div>' +
      '<div class="results" style="max-height:190px">' + mine + '</div><hr class="rule">' +
      '<div class="eyebrow"><span>On the market</span><span>buy price includes 2% fee</span></div>' +
      searchBar(true) + '<div class="results">' + rows + '</div>';
  }

  function tableHTML() {
    var st = S.managers.slice().sort(function (a, b) { return b.points - a.points; });
    return '<div class="eyebrow"><span>League ' + esc(S.league.name) + '</span><span>Season points</span></div>' +
      st.map(function (m, i) {
        return '<div class="row ' + (m.me ? "you" : "") + '"><div class="rank">' + (i + 1) + '</div>' +
          '<div class="grow"><div class="nm">' + esc(m.name) + '</div><div class="mt">week ' + m.week +
          ' · last week ' + sign(m.lastWeek) + (m.streak >= 3 ? " · 🔥" + m.streak : "") + '</div></div>' +
          '<div class="mono ' + (m.points >= 0 ? "pos" : "neg") + '" style="font-size:19px">' +
          sign(m.points) + '</div></div>';
      }).join("") +
      '<hr class="rule"><button class="go ghost" id="refreshBtn">Refresh from the sheet</button>' +
      '<p class="note" style="margin-top:10px">Points come from beating a 50/50 blend of the whole market and ' +
      'the company\'s own family. A company that rises with everything else scores nothing.</p>';
  }

  // ------------------------------------------------------------- shell
  function render() {
    var m = meMgr();
    var tabs = !S.me ? [] : (m && m.squad.length < SQUAD)
      ? [["build", "Squad build"], ["invite", "Invite"]]
      : [["team", "Team sheet"], ["market", "Market"], ["table", "Table"], ["invite", "Invite"]];
    $("tabs").innerHTML = tabs.map(function (t) {
      return '<button class="tab" data-v="' + t[0] + '" aria-selected="' + (S.view === t[0]) + '">' + t[1] + '</button>';
    }).join("");

    $("wkLabel").textContent = S.league ? (S.league.name + " · week " + S.league.week) : "Not signed in";
    if (m) {
      var st = S.managers.slice().sort(function (a, b) { return b.points - a.points; });
      $("pRank").textContent = (st.findIndex(function (x) { return x.me; }) + 1) + " of " + S.managers.length;
      $("pPts").textContent = Math.round(m.points);
      $("pCr").textContent = money(m.credits);
    } else {
      $("pRank").textContent = "—"; $("pPts").textContent = "—"; $("pCr").textContent = "—";
    }
    $("hl").textContent = !S.me ? "Join a league"
      : S.view === "build" ? "Build your ten"
      : S.view === "market" ? "The market"
      : S.view === "table" ? "The table"
      : S.view === "invite" ? "Invite" : "Field your seven";

    var body = !S.ready && !S.err ? '<div class="empty">Loading the company list…</div>'
      : !S.me ? authHTML()
      : S.view === "invite" ? inviteHTML()
      : S.view === "build" ? buildHTML()
      : S.view === "market" ? marketHTML()
      : S.view === "table" ? tableHTML() : teamHTML();

    $("view").innerHTML =
      (S.err ? '<p class="note warn banner">' + esc(S.err) + '</p>' : "") +
      (S.note ? '<p class="note banner ok">' + esc(S.note) + '</p>' : "") + body;
    S.note = null;
    wire();
  }

  function wire() {
    document.querySelectorAll(".tab").forEach(function (b) {
      b.addEventListener("click", function () { S.view = b.dataset.v; render(); });
    });
    var j = $("joinBtn"); if (j) j.addEventListener("click", joinLeague);
    var c = $("createBtn"); if (c) c.addEventListener("click", createLeague);
    var q = $("q");
    if (q) {
      q.addEventListener("input", function (e) {
        F.q = e.target.value; render();
        var n = $("q"); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
      });
      var so = $("sort"); if (so) so.addEventListener("change", function (e) { F.sort = e.target.value; render(); });
    }
    document.querySelectorAll("[data-fam]").forEach(function (b) {
      b.addEventListener("click", function () { F.fam = b.dataset.fam; render(); });
    });
    document.querySelectorAll("[data-buy]").forEach(function (b) {
      b.addEventListener("click", function () { buy(b.dataset.buy); });
    });
    document.querySelectorAll("[data-sell]").forEach(function (b) {
      b.addEventListener("click", function () { sell(b.dataset.sell); });
    });
    document.querySelectorAll(".chip[data-id]").forEach(function (b) {
      b.addEventListener("click", function () {
        var t = b.dataset.id, i = draft.lineup.indexOf(t);
        if (i >= 0) {
          if (draft.lineup.length === LINEUP && draft.conv !== t) { draft.conv = t; }
          else { draft.lineup.splice(i, 1); if (draft.conv === t) draft.conv = null; }
        } else if (draft.lineup.length < LINEUP) { draft.lineup.push(t); }
        render();
      });
    });
    var sb = $("saveBtn"); if (sb) sb.addEventListener("click", saveLineup);
    var rb = $("refreshBtn"); if (rb) rb.addEventListener("click", refresh);
    var ob = $("outBtn"); if (ob) ob.addEventListener("click", function () {
      forgetMe(); S.me = null; S.managers = []; S.view = "auth"; render();
    });
    var cp = $("copyBtn");
    if (cp) cp.addEventListener("click", function () {
      var box = $("shareBox"); box.select();
      try { document.execCommand("copy"); S.note = "Link copied."; }
      catch (e) { S.note = "Select the link and copy it."; }
      render();
    });
  }

  boot();
})();
