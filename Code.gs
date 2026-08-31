/**
 * FANTASY STOCK LEAGUE — Google Apps Script backend
 *
 * Google Sheets is the database. GOOGLEFINANCE supplies the closing prices.
 * This file is the whole server: no API keys, no hosting bill.
 *
 * SETUP (once, about ten minutes)
 *  1. Create a Google Sheet. Extensions > Apps Script. Paste this file in.
 *  2. Run  setup()  once and grant permissions. It builds every tab.
 *  3. Paste us_universe_300.csv into the Universe tab (ticker, name, family, tier).
 *     Then run  seedValues().
 *  4. Run  refreshPrices()  once by hand and check the Prices tab fills in.
 *  5. Triggers (clock icon in the Apps Script editor):
 *       refreshPrices  — day timer, 21:00–22:00 in your timezone (after the US close)
 *       settleWeek     — week timer, Saturday 02:00
 *  6. Deploy > New deployment > Web app.
 *       Execute as: Me.   Who has access: Anyone.
 *     Copy the /exec URL into assets/config.js in the GitHub repo.
 *
 * WHY GET-ONLY: an Apps Script web app cannot answer a CORS preflight. A POST with
 * Content-Type: application/json triggers one and fails from the browser. Everything
 * here therefore travels as a GET with a JSON payload in the query string, which
 * needs no preflight. Payloads stay well inside the ~8k URL limit.
 */

var SHEETS = {
  universe: ['ticker', 'name', 'family', 'tier', 'value', 'lastPoints', 'prevValue'],
  quotes:   ['ticker', 'price'],
  prices:   ['date', 'ticker', 'close'],
  users:    ['email', 'name', 'joined'],
  leagues:  ['code', 'name', 'ownerEmail', 'maxManagers', 'week', 'created'],
  managers: ['code', 'email', 'name', 'credits', 'points', 'lastWeek', 'week',
             'squad', 'lineup', 'conviction', 'paid', 'streak']
};

var BUDGET = 300000000;
var SQUAD_SIZE = 10;
var LINEUP_SIZE = 7;
var WEEKLY_INCOME = 2000000;
var BANDS = { A: [55, 75], B: [35, 55], C: [20, 35], D: [10, 20] };

// ---------------------------------------------------------------- helpers
function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet(name) {
  var s = ss().getSheetByName(name);
  if (!s) {
    s = ss().insertSheet(name);
    s.appendRow(SHEETS[name]);
    s.setFrozenRows(1);
  }
  return s;
}

function rows(name) {
  var s = sheet(name);
  var v = s.getDataRange().getValues();
  if (v.length < 2) return [];
  var head = v[0];
  return v.slice(1).map(function (r, i) {
    var o = { _row: i + 2 };
    head.forEach(function (h, j) { o[h] = r[j]; });
    return o;
  });
}

function writeRow(name, rowIndex, obj) {
  var s = sheet(name);
  var head = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  s.getRange(rowIndex, 1, 1, head.length)
   .setValues([head.map(function (h) { return obj[h] === undefined ? '' : obj[h]; })]);
}

function appendObj(name, obj) {
  var s = sheet(name);
  var head = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  s.appendRow(head.map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function parseJSON(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
}

function today() {
  return Utilities.formatDate(new Date(), ss().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

function isoWeek(dateStr) {
  var d = new Date(dateStr + 'T12:00:00');
  var t = new Date(d.valueOf());
  t.setDate(t.getDate() + 3 - ((d.getDay() + 6) % 7));
  var week1 = new Date(t.getFullYear(), 0, 4);
  var n = 1 + Math.round(((t - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return t.getFullYear() + '-W' + (n < 10 ? '0' + n : n);
}

// ---------------------------------------------------------------- setup
function setup() {
  Object.keys(SHEETS).forEach(function (k) { sheet(k); });
  SpreadsheetApp.getUi().alert(
    'Tabs created.\n\n1. Paste us_universe_300.csv into Universe (ticker, name, family, tier)\n' +
    '2. Run seedValues()\n3. Run refreshPrices()\n4. Add the two triggers\n5. Deploy as a web app');
}

/** Give every company a starting value from its tier band. Deterministic. */
function seedValues() {
  var s = sheet('universe');
  var data = rows('universe');
  data.forEach(function (r) {
    if (r.value) return;
    var band = BANDS[String(r.tier).trim().toUpperCase()] || BANDS.D;
    var h = 0, tk = String(r.ticker);
    for (var i = 0; i < tk.length; i++) h = (h * 31 + tk.charCodeAt(i)) % 9973;
    var v = (band[0] + (h % 1000) / 1000 * (band[1] - band[0])) * 1000000;
    s.getRange(r._row, 5).setValue(Math.round(v));      // value
    s.getRange(r._row, 7).setValue(Math.round(v));      // prevValue
  });
  SpreadsheetApp.flush();
}

// ---------------------------------------------------------------- prices
/**
 * Writes GOOGLEFINANCE formulas into Quotes, waits for them to calculate,
 * then copies the VALUES into the Prices history. The copy is the whole point:
 * a formula shows today's number and forgets yesterday's.
 */
function refreshPrices() {
  var uni = rows('universe').filter(function (r) { return r.ticker; });
  if (!uni.length) throw new Error('Universe is empty');

  var q = sheet('quotes');
  q.clear();
  q.appendRow(['ticker', 'price']);
  var formulas = uni.map(function (r) {
    return [r.ticker, '=IFERROR(GOOGLEFINANCE("' + r.ticker + '","close"),"")'];
  });
  q.getRange(2, 1, formulas.length, 2).setValues(formulas);
  SpreadsheetApp.flush();
  Utilities.sleep(8000);                      // let GOOGLEFINANCE resolve

  var vals = q.getRange(2, 1, formulas.length, 2).getValues();
  var d = today();
  var existing = {};
  rows('prices').forEach(function (r) {
    if (String(r.date) === d) existing[r.ticker] = true;
  });

  var out = [];
  vals.forEach(function (v) {
    var tk = v[0], px = v[1];
    if (!tk || existing[tk]) return;
    if (typeof px !== 'number' || !isFinite(px) || px <= 0) return;
    out.push([d, tk, px]);
  });
  if (out.length) {
    sheet('prices').getRange(sheet('prices').getLastRow() + 1, 1, out.length, 3).setValues(out);
  }
  return out.length + ' closes captured for ' + d;
}

// ---------------------------------------------------------------- scoring
function weeklyScores() {
  var uni = rows('universe').filter(function (r) { return r.ticker; });
  var fam = {}; uni.forEach(function (r) { fam[r.ticker] = r.family; });

  // group closes by ticker and ISO week
  var byTicker = {};
  rows('prices').forEach(function (r) {
    if (!r.ticker || !r.close) return;
    var d = (r.date instanceof Date)
      ? Utilities.formatDate(r.date, ss().getSpreadsheetTimeZone(), 'yyyy-MM-dd')
      : String(r.date);
    var w = isoWeek(d);
    byTicker[r.ticker] = byTicker[r.ticker] || {};
    byTicker[r.ticker][w] = byTicker[r.ticker][w] || [];
    byTicker[r.ticker][w].push([d, Number(r.close)]);
  });

  var weeks = {};
  Object.keys(byTicker).forEach(function (t) {
    Object.keys(byTicker[t]).forEach(function (w) { weeks[w] = true; });
  });
  var sorted = Object.keys(weeks).sort();
  if (sorted.length < 2) return { week: null, scores: {} };
  var cur = sorted[sorted.length - 1], prev = sorted[sorted.length - 2];

  var rets = {}, dailies = {};
  Object.keys(byTicker).forEach(function (t) {
    var a = byTicker[t][prev], b = byTicker[t][cur];
    if (!a || !b) return;
    a.sort(); b.sort();
    var from = a[a.length - 1][1], to = b[b.length - 1][1];
    if (!from) return;
    rets[t] = (to / from - 1) * 100;
    var series = [from].concat(b.map(function (x) { return x[1]; }));
    var dr = [];
    for (var i = 1; i < series.length; i++) dr.push((series[i] / series[i - 1] - 1) * 100);
    dailies[t] = dr;
  });

  var tickers = Object.keys(rets);
  if (!tickers.length) return { week: cur, scores: {} };

  var rm = 0; tickers.forEach(function (t) { rm += rets[t]; }); rm /= tickers.length;
  var groups = {};
  tickers.forEach(function (t) {
    groups[fam[t]] = groups[fam[t]] || [];
    groups[fam[t]].push(rets[t]);
  });
  var rf = {};
  Object.keys(groups).forEach(function (f) {
    var s = 0; groups[f].forEach(function (v) { s += v; }); rf[f] = s / groups[f].length;
  });

  // daily benchmarks for the consistency term
  var maxd = 0;
  tickers.forEach(function (t) { maxd = Math.max(maxd, dailies[t].length); });
  var dayM = [], dayF = {};
  Object.keys(groups).forEach(function (f) { dayF[f] = []; });
  for (var k = 0; k < maxd; k++) {
    var all = [], perFam = {};
    tickers.forEach(function (t) {
      if (dailies[t].length <= k) return;
      all.push(dailies[t][k]);
      perFam[fam[t]] = perFam[fam[t]] || [];
      perFam[fam[t]].push(dailies[t][k]);
    });
    dayM.push(all.length ? all.reduce(function (a, b) { return a + b; }, 0) / all.length : 0);
    Object.keys(dayF).forEach(function (f) {
      var v = perFam[f] || [];
      dayF[f].push(v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : 0);
    });
  }

  var scores = {};
  tickers.forEach(function (t) {
    var B = 0.5 * rm + 0.5 * rf[fam[t]];
    var alpha = rets[t] - B;
    var core = Math.max(-100, Math.min(100, Math.round(alpha * 10)));
    var D = 0;
    for (var k = 0; k < dailies[t].length && k < dayM.length; k++) {
      var bench = 0.5 * dayM[k] + 0.5 * dayF[fam[t]][k];
      if (dailies[t][k] > bench) D++;
    }
    var cons = Math.round((D - 2.5) * 8);
    scores[t] = { ret: rets[t], alpha: alpha, core: core, cons: cons, D: D, total: core + cons };
  });
  return { week: cur, market: rm, scores: scores };
}

/** Weekly trigger: score every company, move values, pay income, update tables. */
function settleWeek() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var res = weeklyScores();
    if (!res.week) return 'not enough price history yet';

    var uSheet = sheet('universe');
    var uni = rows('universe');
    uni.forEach(function (r) {
      var s = res.scores[r.ticker];
      if (!s) return;
      var val = Number(r.value) || 0;
      var perf = Math.max(-0.10, Math.min(0.10, s.total / 1000));
      var next = Math.max(5000000, Math.min(300000000, Math.round(val * (1 + perf))));
      uSheet.getRange(r._row, 5).setValue(next);          // value
      uSheet.getRange(r._row, 6).setValue(s.total);       // lastPoints
      uSheet.getRange(r._row, 7).setValue(val);           // prevValue
    });

    rows('managers').forEach(function (m) {
      var lineup = parseJSON(m.lineup, []);
      var conv = m.conviction;
      var wk = 0;
      lineup.forEach(function (tk) {
        var s = res.scores[tk];
        if (!s) return;
        wk += (tk === conv) ? s.total * 2 : s.total;
      });
      m.lastWeek = wk;
      m.points = (Number(m.points) || 0) + wk;
      m.credits = (Number(m.credits) || 0) + WEEKLY_INCOME;
      m.week = (Number(m.week) || 1) + 1;
      m.streak = wk > 0 ? (Number(m.streak) || 0) + 1 : 0;
      m.lineup = JSON.stringify([]);
      m.conviction = '';
      writeRow('managers', m._row, m);
    });

    rows('leagues').forEach(function (l) {
      l.week = (Number(l.week) || 1) + 1;
      writeRow('leagues', l._row, l);
    });
    return 'settled ' + res.week;
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- API
function doGet(e) {
  var p = e && e.parameter ? e.parameter : {};
  var action = p.action || 'ping';
  var out;
  try {
    switch (action) {
      case 'ping':     out = { ok: true, time: today() }; break;
      case 'universe': out = { ok: true, companies: apiUniverse() }; break;
      case 'state':    out = apiState(p.code, p.email); break;
      case 'create':   out = mutate(function () { return apiCreate(p); }); break;
      case 'join':     out = mutate(function () { return apiJoin(p); }); break;
      case 'sign':     out = mutate(function () { return apiTrade(p, 'buy'); }); break;
      case 'sell':     out = mutate(function () { return apiTrade(p, 'sell'); }); break;
      case 'lineup':   out = mutate(function () { return apiLineup(p); }); break;
      default:         out = { ok: false, error: 'unknown action ' + action };
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }

  // JSONP when a callback is supplied. An Apps Script web app cannot answer a
  // CORS preflight, and its /exec URL redirects to googleusercontent.com, so a
  // plain fetch() is fragile. A script tag always works.
  if (p.callback) {
    return ContentService
      .createTextOutput(p.callback + '(' + JSON.stringify(out) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return jsonOut(out);
}

/** Every write goes through one script lock. This is what stops two managers
 *  signing the same company at the same moment. */
function mutate(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy, try again' };
  try { return fn(); } finally { lock.releaseLock(); }
}

function apiUniverse() {
  return rows('universe').filter(function (r) { return r.ticker; }).map(function (r) {
    return { t: r.ticker, n: r.name, f: r.family,
             v: Number(r.value) || 0, p: Number(r.lastPoints) || 0,
             pv: Number(r.prevValue) || Number(r.value) || 0 };
  });
}

function leagueOf(code) {
  var found = null;
  rows('leagues').forEach(function (l) {
    if (String(l.code).toUpperCase() === String(code).toUpperCase()) found = l;
  });
  return found;
}

function managersOf(code) {
  return rows('managers').filter(function (m) {
    return String(m.code).toUpperCase() === String(code).toUpperCase();
  });
}

function ownedMap(code) {
  var own = {};
  managersOf(code).forEach(function (m) {
    parseJSON(m.squad, []).forEach(function (tk) { own[tk] = m.email; });
  });
  return own;
}

function apiState(code, email) {
  if (!code) return { ok: false, error: 'no league code' };
  var l = leagueOf(code);
  if (!l) return { ok: false, error: 'league not found' };
  var ms = managersOf(code).map(function (m) {
    return { email: m.email, name: m.name, points: Number(m.points) || 0,
             lastWeek: Number(m.lastWeek) || 0, week: Number(m.week) || 1,
             credits: Number(m.credits) || 0, streak: Number(m.streak) || 0,
             squad: parseJSON(m.squad, []), lineup: parseJSON(m.lineup, []),
             conviction: m.conviction || null, paid: parseJSON(m.paid, {}),
             me: email && String(m.email).toLowerCase() === String(email).toLowerCase() };
  });
  return { ok: true, league: { code: l.code, name: l.name, week: Number(l.week) || 1,
           max: Number(l.maxManagers) || 12 }, managers: ms, owned: ownedMap(code) };
}

function apiCreate(p) {
  var name = String(p.league || '').trim();
  var email = String(p.email || '').trim().toLowerCase();
  var who = String(p.name || '').trim();
  if (!name || !email || !who) return { ok: false, error: 'league name, your name and email are all required' };
  var code = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  if (!code) return { ok: false, error: 'league name needs at least one letter or number' };
  if (leagueOf(code)) return { ok: false, error: 'that league name is taken — pick another' };

  appendObj('leagues', { code: code, name: name, ownerEmail: email,
                         maxManagers: Number(p.max) || 12, week: 1, created: new Date() });
  registerUser(email, who);
  addManager(code, email, who);
  return { ok: true, code: code };
}

function apiJoin(p) {
  var code = String(p.league || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  var email = String(p.email || '').trim().toLowerCase();
  var who = String(p.name || '').trim();
  if (!code || !email || !who) return { ok: false, error: 'league name, your name and email are all required' };
  var l = leagueOf(code);
  if (!l) return { ok: false, error: 'no league called that. Check the spelling with whoever invited you.' };
  var ms = managersOf(code);
  var already = null;
  ms.forEach(function (m) {
    if (String(m.email).toLowerCase() === email) already = m;
  });
  if (already) return { ok: true, code: code, rejoined: true };
  if (ms.length >= (Number(l.maxManagers) || 12)) {
    return { ok: false, error: 'this league is full (' + ms.length + ' managers)' };
  }
  registerUser(email, who);
  addManager(code, email, who);
  return { ok: true, code: code };
}

function registerUser(email, name) {
  var seen = false;
  rows('users').forEach(function (u) {
    if (String(u.email).toLowerCase() === email) seen = true;
  });
  if (!seen) appendObj('users', { email: email, name: name, joined: new Date() });
}

function addManager(code, email, name) {
  appendObj('managers', { code: code, email: email, name: name, credits: BUDGET,
    points: 0, lastWeek: 0, week: 1, squad: '[]', lineup: '[]',
    conviction: '', paid: '{}', streak: 0 });
}

function findManager(code, email) {
  var found = null;
  managersOf(code).forEach(function (m) {
    if (String(m.email).toLowerCase() === String(email).toLowerCase()) found = m;
  });
  return found;
}

function apiTrade(p, kind) {
  var m = findManager(p.code, p.email);
  if (!m) return { ok: false, error: 'you are not in this league' };
  var tk = String(p.ticker || '').toUpperCase();
  var uni = {}; rows('universe').forEach(function (r) { if (r.ticker) uni[r.ticker] = r; });
  var c = uni[tk];
  if (!c) return { ok: false, error: 'unknown company ' + tk };

  var squad = parseJSON(m.squad, []);
  var paid = parseJSON(m.paid, {});
  var credits = Number(m.credits) || 0;
  var value = Number(c.value) || 0;

  if (kind === 'buy') {
    if (squad.length >= SQUAD_SIZE) return { ok: false, error: 'your squad is full' };
    var own = ownedMap(p.code);
    if (own[tk]) return { ok: false, error: tk + ' is already owned in this league' };
    var cost = Math.round(value * 1.02);
    if (credits < cost) return { ok: false, error: 'not enough credits' };

    // You must still be able to fill the remaining slots afterwards. Reserving
    // "cheapest company x slots left" is wrong: that company gets bought and the
    // floor rises. Reserve the exact sum of the k cheapest still available.
    var free = [];
    Object.keys(uni).forEach(function (t) {
      if (!own[t] && t !== tk) free.push(Math.round((Number(uni[t].value) || 0) * 1.02));
    });
    free.sort(function (a, b) { return a - b; });
    var slotsAfter = SQUAD_SIZE - squad.length - 1, need = 0;
    if (slotsAfter > free.length) return { ok: false, error: 'not enough free companies left' };
    for (var k = 0; k < slotsAfter; k++) need += free[k];
    if (credits - cost < need) {
      return { ok: false, error: 'that would strand you: you need ' +
        Math.round(need / 1e6) + 'M to fill your last ' + slotsAfter + ' slots' };
    }
    credits -= cost; squad.push(tk); paid[tk] = cost;
  } else {
    if (squad.indexOf(tk) < 0) return { ok: false, error: 'you do not own ' + tk };
    credits += Math.round(value * 0.9);
    squad = squad.filter(function (x) { return x !== tk; });
    delete paid[tk];
    var lu = parseJSON(m.lineup, []).filter(function (x) { return x !== tk; });
    m.lineup = JSON.stringify(lu);
    if (m.conviction === tk) m.conviction = '';
  }

  m.squad = JSON.stringify(squad);
  m.paid = JSON.stringify(paid);
  m.credits = credits;
  writeRow('managers', m._row, m);
  return { ok: true, credits: credits, squad: squad };
}

function apiLineup(p) {
  var m = findManager(p.code, p.email);
  if (!m) return { ok: false, error: 'you are not in this league' };
  var lineup = parseJSON(p.lineup, []);
  var squad = parseJSON(m.squad, []);
  if (lineup.length !== LINEUP_SIZE) return { ok: false, error: 'field exactly ' + LINEUP_SIZE };
  for (var i = 0; i < lineup.length; i++) {
    if (squad.indexOf(lineup[i]) < 0) return { ok: false, error: lineup[i] + ' is not in your squad' };
  }
  var conv = String(p.conviction || '');
  if (lineup.indexOf(conv) < 0) return { ok: false, error: 'your conviction must be in the lineup' };
  m.lineup = JSON.stringify(lineup);
  m.conviction = conv;
  writeRow('managers', m._row, m);
  return { ok: true };
}
