// Nettzone World Cup Pool — client renderer + scoring.
//
// Reads everything from the Worker's JSON API:
//   GET /api/scores       normalized ESPN snapshot (matches, bracket, teams)
//   GET /api/brackets      bracket entries (picks hidden until lock)
//   GET /api/predictions   per-match predictions (each hidden until kickoff)
// and POSTs entries straight back. No Google Forms, no repo commits.

// ---------- contest config ----------
const FEES = { bracket: 40, predictions: 10, thirdPlace: 20 };
const ROUND_POINTS = { R32: 1, R16: 2, QF: 4, SF: 8, F: 16 };
const ROUND_ORDER = ["R32", "R16", "QF", "SF", "F"];
const ROUND_LABEL = { R32: "Round of 32", R16: "Round of 16", QF: "Quarterfinals", SF: "Semifinals", F: "Final" };
const ROUND_COUNT = { R32: 16, R16: 8, QF: 4, SF: 2, F: 1 };
const BONUS_FINAL_SCORE = 5;
const EXACT_POINTS = 3;
const RESULT_POINTS = 1;

// ---------- local persistence (so a user sees their own hidden picks) ----------
const LS = {
  name: "wc:name",
  bracket: "wc:bracket",
  preds: "wc:preds",
  nameMap: "wc:nameMap",
  tab: "wc:tab",
};
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const lsGetStr = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const lsSetStr = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// ---------- tiny DOM helper ----------
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

async function api(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path} (${r.status})`);
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function teamFlag(team) {
  if (!team || !team.flag) return null;
  const img = el("img", { class: "team-flag", src: team.flag, alt: "", loading: "lazy" });
  img.onerror = function () { this.style.display = "none"; };
  return img;
}
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  } catch { return iso; }
}

// ===========================================================================
// shared state
// ===========================================================================
let SNAP = null;       // /api/scores
let MATCH_BY_NUM = {}; // matchNumber -> match
let MATCH_BY_ID = {};  // id -> match
let TEAM_BY_ID = {};   // id -> {id,name,abbr,flag}
let FEEDERS = {};

function indexSnapshot(snap) {
  SNAP = snap;
  MATCH_BY_NUM = {}; MATCH_BY_ID = {}; TEAM_BY_ID = {};
  FEEDERS = snap.feeders || {};
  const allMatches = (snap.matches || []).slice();
  if (snap.thirdPlace) allMatches.push(snap.thirdPlace);
  for (const m of allMatches) {
    MATCH_BY_NUM[m.matchNumber] = m;
    MATCH_BY_ID[String(m.id)] = m;
    for (const side of [m.home, m.away]) {
      if (side && side.id && !side.placeholder) {
        TEAM_BY_ID[String(side.id)] = { id: String(side.id), name: side.name, abbr: side.abbr, flag: side.flag };
      }
    }
  }
  for (const t of snap.teams || []) TEAM_BY_ID[String(t.id)] = t;
}
const team = (id) => TEAM_BY_ID[String(id)] || null;
const teamName = (id) => (team(id) ? team(id).name : "—");

function matchOfSlot(round, slot) {
  const base = { R32: 72, R16: 88, QF: 96, SF: 100, F: 103 }[round];
  return MATCH_BY_NUM[base + slot];
}
const thirdPlaceId = () => (SNAP && SNAP.thirdPlace ? String(SNAP.thirdPlace.id) : null);

// ===========================================================================
// scoring
// ===========================================================================
function actualWinnersByRound() {
  const out = { R32: new Set(), R16: new Set(), QF: new Set(), SF: new Set(), F: new Set() };
  for (const m of SNAP.matches || []) {
    if (m.status === "post" && m.winnerId && out[m.round]) out[m.round].add(String(m.winnerId));
  }
  return out;
}

function scoreBracket(picks, actual) {
  const winners = (picks && picks.winners) || {};
  let total = 0;
  const perRound = {};
  for (const round of ROUND_ORDER) {
    const predicted = Object.values(winners[round] || {}).map(String);
    let correct = 0;
    for (const id of predicted) if (actual[round].has(id)) correct++;
    perRound[round] = { correct, predicted: predicted.length, points: correct * ROUND_POINTS[round] };
    total += perRound[round].points;
  }
  // Bonus: exact final scoreline.
  let finalBonus = 0;
  const finalMatch = matchOfSlot("F", 1);
  if (finalMatch && finalMatch.status === "post" && finalMatch.winnerId) {
    const wGoals = winnerGoals(finalMatch), lGoals = loserGoals(finalMatch);
    if (picks.finalWinnerGoals === wGoals && picks.finalLoserGoals === lGoals) finalBonus = BONUS_FINAL_SCORE;
  }
  total += finalBonus;
  return { total, perRound, finalBonus, champion: picks.champion };
}
const winnerGoals = (m) => (String(m.home.id) === String(m.winnerId) ? m.home.score : m.away.score);
const loserGoals = (m) => (String(m.home.id) === String(m.winnerId) ? m.away.score : m.home.score);

function scorePrediction(pred, match) {
  if (!match || match.status !== "post" || pred.home == null) return null;
  const ah = match.home.score, aa = match.away.score;
  if (ah == null || aa == null) return null;
  if (pred.home === ah && pred.away === aa) return { points: EXACT_POINTS, exact: true };
  const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  if (sign(pred.home - pred.away) === sign(ah - aa)) return { points: RESULT_POINTS, exact: false };
  return { points: 0, exact: false };
}

// ===========================================================================
// header
// ===========================================================================
function renderHeader() {
  const t = SNAP && SNAP.tournament;
  const status = document.getElementById("tournament-status");
  if (!t) { status.textContent = "Waiting for data…"; return; }
  let phase = t.stage === "knockout" ? "Knockout stage" : "Group stage";
  if (t.complete) phase = "Complete";
  else if (t.live) phase = "● Live";
  status.textContent = `${t.name} · ${phase}`;
  if (t.lastUpdated) {
    document.getElementById("last-updated").textContent =
      `Scores last refreshed ${new Date(t.lastUpdated).toLocaleString()}`;
  }
}

// ===========================================================================
// bracket standings
// ===========================================================================
function renderBracketStandings(bracketData) {
  const root = document.getElementById("bracket-standings");
  root.innerHTML = "";
  const entries = bracketData.entries || [];

  if (!entries.length) {
    root.appendChild(el("div", { class: "empty" }, [
      "No brackets yet. Be the first — head to ",
      el("strong", {}, "Make your bracket"), ".",
    ]));
    return;
  }

  // Pre-lock: show entrant names only (server already strips picks).
  if (bracketData.locked) {
    document.getElementById("bracket-hint").hidden = true;
    const card = el("div", { class: "precutoff" });
    card.appendChild(el("h2", { class: "precutoff-title" }, "Brackets are hidden until kickoff"));
    card.appendChild(el("p", { class: "precutoff-body" },
      `Picks unlock when the Round of 32 begins${bracketData.cutoff ? " (" + fmtDate(bracketData.cutoff) + ")" : ""}.`));
    card.appendChild(el("p", { class: "precutoff-count" },
      `${entries.length} ${entries.length === 1 ? "bracket" : "brackets"} submitted so far`));
    const list = el("ul", { class: "precutoff-list" });
    entries.map((e) => e.displayName).sort((a, b) => a.localeCompare(b))
      .forEach((n) => list.appendChild(el("li", {}, n)));
    card.appendChild(list);
    root.appendChild(card);
    return;
  }

  const actual = actualWinnersByRound();
  const scored = entries.map((e) => ({ ...e, ...scoreBracket(e.picks || {}, actual) }));
  scored.sort((a, b) => b.total - a.total || a.displayName.localeCompare(b.displayName));

  let lastTotal = null, lastRank = 0;
  scored.forEach((t, i) => { if (t.total !== lastTotal) { lastRank = i + 1; lastTotal = t.total; } t.rank = lastRank; });
  const tieCounts = {};
  scored.forEach((t) => (tieCounts[t.rank] = (tieCounts[t.rank] || 0) + 1));

  for (const t of scored) {
    const rankLabel = (tieCounts[t.rank] > 1 ? "T" : "") + t.rank;
    const card = el("div", { class: "pool-entry" });
    const champOk = t.champion && actual.F.has(String(t.champion));
    card.appendChild(el("div", { class: "pool-entry-header" }, [
      el("span", { class: "rank" }, rankLabel),
      el("span", { class: "name" }, [
        t.displayName,
        t.champion ? el("span", { class: "champ-pick" + (champOk ? " hit" : "") },
          [" 🏆 ", teamName(t.champion)]) : null,
      ]),
      el("span", { class: "total" }, String(t.total)),
    ]));

    const table = el("table");
    table.appendChild(el("thead", {}, el("tr", {}, [
      el("th", {}, "Round"), el("th", { class: "num" }, "Correct"), el("th", { class: "num" }, "Pts"),
    ])));
    const tbody = el("tbody");
    for (const round of ROUND_ORDER) {
      const pr = t.perRound[round];
      tbody.appendChild(el("tr", {}, [
        el("td", {}, ROUND_LABEL[round]),
        el("td", { class: "num" }, `${pr.correct}/${ROUND_COUNT[round]}`),
        el("td", { class: "num" }, String(pr.points)),
      ]));
    }
    if (t.finalBonus) {
      tbody.appendChild(el("tr", { class: "bonus-row" }, [
        el("td", {}, "Exact final score"), el("td", { class: "num" }, "✓"), el("td", { class: "num" }, "+" + t.finalBonus),
      ]));
    }
    table.appendChild(tbody);
    card.appendChild(table);
    if (t.goldenBoot) {
      card.appendChild(el("p", { class: "entry-foot" }, [
        el("strong", {}, "Golden Boot pick: "), t.goldenBoot, el("span", { class: "muted" }, " (settled manually)"),
      ]));
    }
    root.appendChild(card);
  }
}

// ===========================================================================
// bracket picker (interactive advancing bracket)
// ===========================================================================
let pickSel = {}; // `${round}-${slot}` -> teamId

function loadSavedBracket() {
  const saved = lsGet(LS.bracket, null);
  pickSel = {};
  if (saved && saved.winners) {
    for (const round of ROUND_ORDER) {
      for (const [slot, id] of Object.entries(saved.winners[round] || {})) pickSel[`${round}-${slot}`] = String(id);
    }
  }
  return saved;
}

function sanitizePicks() {
  // Drop any later-round pick whose team is no longer one of its feeders' winners.
  for (const round of ["R16", "QF", "SF", "F"]) {
    const prev = { R16: "R32", QF: "R16", SF: "QF", F: "SF" }[round];
    for (let slot = 1; slot <= ROUND_COUNT[round]; slot++) {
      const [a, b] = (FEEDERS[round] && FEEDERS[round][slot]) || [];
      const allowed = [pickSel[`${prev}-${a}`], pickSel[`${prev}-${b}`]].filter(Boolean).map(String);
      const cur = pickSel[`${round}-${slot}`];
      if (cur && !allowed.includes(String(cur))) delete pickSel[`${round}-${slot}`];
    }
  }
}

function renderBracketPicker() {
  const root = document.getElementById("bracket-picker");
  root.innerHTML = "";

  const t = SNAP.tournament || {};
  const locked = t.bracketCutoff && Date.now() >= Date.parse(t.bracketCutoff);

  if (locked) {
    root.appendChild(pickerClosedCard("The bracket is locked",
      "The Round of 32 has kicked off. Head to Bracket standings to follow along."));
    return;
  }
  if (!SNAP.bracketReady) {
    root.appendChild(pickerClosedCard("The bracket isn't set yet",
      "The Round of 32 matchups are decided when the group stage ends. This picker opens automatically once all 16 matchups are known — check back then."));
    return;
  }

  const saved = loadSavedBracket();
  sanitizePicks();

  const header = el("div", { class: "picker-intro" });
  header.appendChild(el("h2", {}, "Make your bracket"));
  header.appendChild(el("p", { class: "hint" },
    `Pick a winner in every match, all the way to the trophy. Locks ${fmtDate(t.bracketCutoff)}.`));
  root.appendChild(header);

  const nameWrap = el("div", { class: "picker-form" });
  nameWrap.appendChild(el("label", { class: "picker-label", for: "bk-name" }, "Your display name"));
  const nameInput = el("input", { id: "bk-name", type: "text", placeholder: "e.g. Pat M.", maxlength: "40", autocomplete: "off" });
  nameInput.value = (saved && saved.displayName) || lsGetStr(LS.name);
  nameWrap.appendChild(nameInput);
  root.appendChild(nameWrap);

  const rounds = el("div", { class: "bracket-rounds" });
  root.appendChild(rounds);
  drawPickerRounds(rounds);

  // Bonuses
  const bonus = el("div", { class: "picker-bonus" });
  bonus.appendChild(el("h3", {}, "Bonus picks"));
  bonus.appendChild(el("label", { class: "picker-label", for: "bk-gb" }, "Golden Boot — tournament top scorer (+5)"));
  const gb = el("input", { id: "bk-gb", type: "text", placeholder: "e.g. Kylian Mbappé", maxlength: "60", autocomplete: "off" });
  gb.value = (saved && saved.goldenBoot) || "";
  bonus.appendChild(gb);
  bonus.appendChild(el("label", { class: "picker-label" }, "Exact final scoreline (+5)"));
  const scoreRow = el("div", { class: "final-score-row" });
  const fw = el("input", { id: "bk-fw", type: "number", min: "0", max: "20", placeholder: "Winner" });
  const fl = el("input", { id: "bk-fl", type: "number", min: "0", max: "20", placeholder: "Loser" });
  if (saved && saved.finalWinnerGoals != null) fw.value = saved.finalWinnerGoals;
  if (saved && saved.finalLoserGoals != null) fl.value = saved.finalLoserGoals;
  scoreRow.appendChild(fw); scoreRow.appendChild(el("span", { class: "score-dash" }, "–")); scoreRow.appendChild(fl);
  bonus.appendChild(scoreRow);
  root.appendChild(bonus);

  const bar = el("div", { class: "picker-bar" });
  const count = el("span", { id: "bk-count", class: "picker-count" });
  bar.appendChild(count);
  const submit = el("button", { class: "picker-submit", type: "button", onclick: submitBracket }, "Submit bracket");
  bar.appendChild(submit);
  root.appendChild(bar);
  root.appendChild(el("p", { id: "bk-status", class: "picker-status" }, ""));
  updatePickerCount();
}

function drawPickerRounds(container) {
  container.innerHTML = "";
  for (const round of ROUND_ORDER) {
    const col = el("div", { class: "bracket-round" });
    col.appendChild(el("h3", { class: "bracket-round-title" },
      [ROUND_LABEL[round], el("span", { class: "round-pts" }, `${ROUND_POINTS[round]} pt${ROUND_POINTS[round] > 1 ? "s" : ""}`)]));
    for (let slot = 1; slot <= ROUND_COUNT[round]; slot++) {
      col.appendChild(drawPickerMatch(round, slot));
    }
    container.appendChild(col);
  }
}

function competitorsFor(round, slot) {
  if (round === "R32") {
    const m = matchOfSlot("R32", slot);
    return m ? [m.home.id, m.away.id].map(String) : [null, null];
  }
  const prev = { R16: "R32", QF: "R16", SF: "QF", F: "SF" }[round];
  const [a, b] = (FEEDERS[round] && FEEDERS[round][slot]) || [];
  return [pickSel[`${prev}-${a}`] || null, pickSel[`${prev}-${b}`] || null];
}

function drawPickerMatch(round, slot) {
  const wrap = el("div", { class: "bracket-match" });
  const [c1, c2] = competitorsFor(round, slot);
  const chosen = pickSel[`${round}-${slot}`];
  for (const id of [c1, c2]) {
    const known = !!id;
    const btn = el("button", {
      type: "button",
      class: "team-btn" + (chosen && String(chosen) === String(id) ? " chosen" : "") + (known ? "" : " tbd"),
      disabled: known ? null : "disabled",
      onclick: known ? () => choosePick(round, slot, String(id)) : null,
    });
    if (known) {
      const f = teamFlag(team(id));
      if (f) btn.appendChild(f);
      btn.appendChild(el("span", { class: "team-btn-name" }, teamName(id)));
    } else {
      btn.appendChild(el("span", { class: "team-btn-name muted" }, "Winner TBD"));
    }
    wrap.appendChild(btn);
  }
  return wrap;
}

function choosePick(round, slot, id) {
  pickSel[`${round}-${slot}`] = id;
  sanitizePicks();
  drawPickerRounds(document.querySelector(".bracket-rounds"));
  updatePickerCount();
}

function totalSlots() { return ROUND_ORDER.reduce((s, r) => s + ROUND_COUNT[r], 0); } // 31
function filledSlots() { return ROUND_ORDER.reduce((s, r) => {
  let n = 0; for (let i = 1; i <= ROUND_COUNT[r]; i++) if (pickSel[`${r}-${i}`]) n++; return s + n;
}, 0); }
function updatePickerCount() {
  const c = document.getElementById("bk-count");
  if (c) c.textContent = `${filledSlots()} / ${totalSlots()} picked`;
}

function buildPicksPayload() {
  const winners = {};
  for (const round of ROUND_ORDER) {
    winners[round] = {};
    for (let slot = 1; slot <= ROUND_COUNT[round]; slot++) {
      const v = pickSel[`${round}-${slot}`];
      if (v) winners[round][slot] = String(v);
    }
  }
  const fw = document.getElementById("bk-fw").value;
  const fl = document.getElementById("bk-fl").value;
  return {
    winners,
    champion: winners.F[1] || null,
    goldenBoot: document.getElementById("bk-gb").value.trim(),
    finalWinnerGoals: fw === "" ? null : Number(fw),
    finalLoserGoals: fl === "" ? null : Number(fl),
  };
}

async function submitBracket() {
  const name = document.getElementById("bk-name").value.trim();
  if (!name) return flash("bk-status", "Enter a display name first.", "error");
  if (filledSlots() !== totalSlots()) {
    return flash("bk-status", `Pick a winner in all ${totalSlots()} matches — you have ${filledSlots()}.`, "error");
  }
  const picks = buildPicksPayload();
  try {
    await apiPost("/api/bracket", { displayName: name, picks });
    lsSetStr(LS.name, name);
    lsSet(LS.bracket, { displayName: name, ...picks });
    flash("bk-status", "Bracket submitted! 🏆 Edit any time before kickoff.", "success");
  } catch (e) {
    flash("bk-status", e.message, "error");
  }
}

// ===========================================================================
// per-match predictions: standings
// ===========================================================================
function renderPredictionStandings(predData) {
  const root = document.getElementById("predictions-standings");
  root.innerHTML = "";
  const tpId = thirdPlaceId();
  const entries = (predData.entries || []).filter((e) => String(e.matchId) !== tpId);
  const players = new Map();
  for (const e of entries) {
    const key = e.displayName.trim().toLowerCase();
    if (!players.has(key)) players.set(key, { displayName: e.displayName, total: 0, exact: 0, made: 0, scored: 0 });
    const p = players.get(key);
    p.made++;
    if (!e.revealed || e.home == null) continue;
    const m = MATCH_BY_ID[String(e.matchId)];
    const s = scorePrediction({ home: e.home, away: e.away }, m);
    if (s) { p.scored++; p.total += s.points; if (s.exact) p.exact++; }
  }

  if (!players.size) {
    root.appendChild(el("div", { class: "empty" }, [
      "No match picks yet. Head to ", el("strong", {}, "Make match picks"), ".",
    ]));
    const bonusEmpty = renderThirdPlaceBonus(predData);
    if (bonusEmpty) root.appendChild(bonusEmpty);
    return;
  }

  const rows = [...players.values()].sort((a, b) => b.total - a.total || b.exact - a.exact || a.displayName.localeCompare(b.displayName));
  let lastTotal = null, lastRank = 0;
  rows.forEach((r, i) => { if (r.total !== lastTotal) { lastRank = i + 1; lastTotal = r.total; } r.rank = lastRank; });

  const table = el("table", { class: "lb-table" });
  table.appendChild(el("thead", {}, el("tr", {}, [
    el("th", { class: "pos" }, "#"), el("th", {}, "Player"),
    el("th", { class: "num" }, "Pts"), el("th", { class: "num" }, "Exact"), el("th", { class: "num" }, "Picks"),
  ])));
  const tbody = el("tbody");
  for (const r of rows) {
    tbody.appendChild(el("tr", {}, [
      el("td", { class: "pos" }, String(r.rank)),
      el("td", {}, r.displayName),
      el("td", { class: "num" }, String(r.total)),
      el("td", { class: "num" }, String(r.exact)),
      el("td", { class: "num" }, String(r.made)),
    ]));
  }
  table.appendChild(tbody);
  root.appendChild(table);

  const bonus = renderThirdPlaceBonus(predData);
  if (bonus) root.appendChild(bonus);
}

function renderThirdPlaceBonus(predData) {
  const tp = SNAP.thirdPlace;
  if (!tp) return null;
  const tpId = String(tp.id);
  const entries = (predData.entries || []).filter((e) => String(e.matchId) === tpId);

  const wrap = el("div", { class: "bonus-section" });
  wrap.appendChild(el("h2", { class: "bonus-title" }, "Bonus — Third-place playoff"));
  wrap.appendChild(el("p", { class: "hint" },
    [`Predict the score of the 3rd-place playoff. Exact = 3 pts, right result = 1 pt. Winner takes all. `,
      el("span", { class: "fee-tag" }, `$${FEES.thirdPlace} entry`)]));

  // Show the actual matchup / result line if we have it.
  if (!tp.home.placeholder || !tp.away.placeholder || tp.status !== "pre") {
    const line = el("p", { class: "bonus-matchup" }, [
      el("span", {}, tp.home.name),
      tp.status === "post" ? el("strong", {}, ` ${tp.home.score ?? "–"}–${tp.away.score ?? "–"} `) : el("span", {}, " v "),
      el("span", {}, tp.away.name),
      el("span", { class: "muted" }, tp.status === "post" ? "  (Full time)" : tp.status === "in" ? "  (Live)" : `  ${fmtDate(tp.date)}`),
    ]);
    wrap.appendChild(line);
  }

  if (!entries.length) { wrap.appendChild(el("div", { class: "empty" }, "No 3rd-place picks yet.")); return wrap; }

  const kicked = Date.now() >= Date.parse(tp.date);
  if (!kicked) {
    wrap.appendChild(el("p", { class: "precutoff-count" }, `${entries.length} pick${entries.length === 1 ? "" : "s"} in — hidden until kickoff`));
    return wrap;
  }

  const rows = entries.map((e) => {
    const s = scorePrediction({ home: e.home, away: e.away }, tp) || { points: 0, exact: false };
    return { displayName: e.displayName, pick: e.home != null ? `${e.home}–${e.away}` : "—", points: s.points, exact: s.exact };
  }).sort((a, b) => b.points - a.points || a.displayName.localeCompare(b.displayName));

  const table = el("table", { class: "lb-table" });
  table.appendChild(el("thead", {}, el("tr", {}, [
    el("th", {}, "Player"), el("th", { class: "num" }, "Pick"), el("th", { class: "num" }, "Pts"),
  ])));
  const tbody = el("tbody");
  for (const r of rows) tbody.appendChild(el("tr", {}, [
    el("td", {}, r.displayName), el("td", { class: "num" }, r.pick),
    el("td", { class: "num" }, String(r.points) + (r.exact ? " ✓" : "")),
  ]));
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// ===========================================================================
// per-match predictions: maker
// ===========================================================================
function renderPicksMaker(predData) {
  const root = document.getElementById("picks-maker");
  root.innerHTML = "";

  const knockout = (SNAP.matches || []).slice().sort((a, b) => a.matchNumber - b.matchNumber);
  if (!knockout.length) {
    root.appendChild(pickerClosedCard("No knockout matches yet",
      "Match picks open when the knockout schedule is set. Check back after the group stage."));
    return;
  }

  root.appendChild(el("h2", { class: "picker-intro-h" }, "Make match picks"));
  root.appendChild(el("p", { class: "hint" },
    "Predict the final score of any knockout match. Exact = 3 pts, right result = 1 pt. Locks at kickoff."));

  const nameWrap = el("div", { class: "picker-form" });
  nameWrap.appendChild(el("label", { class: "picker-label", for: "pk-name" }, "Your display name"));
  const nameInput = el("input", { id: "pk-name", type: "text", placeholder: "e.g. Pat M.", maxlength: "40", autocomplete: "off" });
  nameInput.value = lsGetStr(LS.name);
  nameInput.addEventListener("change", () => lsSetStr(LS.name, nameInput.value.trim()));
  nameWrap.appendChild(nameInput);
  root.appendChild(nameWrap);

  const savedPreds = lsGet(LS.preds, {});
  const list = el("div", { class: "picks-list" });
  let currentRound = null;
  for (const m of knockout) {
    if (m.round !== currentRound) {
      currentRound = m.round;
      list.appendChild(el("h3", { class: "picks-round-head" }, m.roundLabel));
    }
    list.appendChild(drawPickRow(m, savedPreds));
  }
  root.appendChild(list);

  if (SNAP.thirdPlace) {
    const bonus = el("div", { class: "picks-list" });
    bonus.appendChild(el("h3", { class: "picks-round-head" }, `Bonus — Third-place playoff ($${FEES.thirdPlace})`));
    bonus.appendChild(drawPickRow(SNAP.thirdPlace, savedPreds));
    root.appendChild(bonus);
  }
}

function drawPickRow(m, savedPreds) {
  const kicked = Date.now() >= Date.parse(m.date);
  const row = el("div", { class: "pick-row" + (kicked ? " locked" : "") });

  const meta = el("div", { class: "pick-meta" });
  meta.appendChild(el("span", { class: "pick-date" }, kicked ? (m.status === "post" ? "Full time" : "Kicked off") : fmtDate(m.date)));
  row.appendChild(meta);

  const matchup = el("div", { class: "pick-matchup" });
  matchup.appendChild(sideChip(m.home, m, "home"));
  if (m.status === "post") {
    matchup.appendChild(el("span", { class: "pick-score-actual" }, `${m.home.score ?? "–"}–${m.away.score ?? "–"}`));
  } else {
    matchup.appendChild(el("span", { class: "pick-vs" }, "v"));
  }
  matchup.appendChild(sideChip(m.away, m, "away"));
  row.appendChild(matchup);

  const saved = savedPreds[String(m.id)] || {};
  if (kicked) {
    const note = saved.home != null ? `Your pick: ${saved.home}–${saved.away}` : "No pick";
    row.appendChild(el("div", { class: "pick-locked-note" }, note));
  } else {
    const input = el("div", { class: "pick-input" });
    const h = el("input", { type: "number", min: "0", max: "20", class: "goal-in", placeholder: "0" });
    const a = el("input", { type: "number", min: "0", max: "20", class: "goal-in", placeholder: "0" });
    if (saved.home != null) h.value = saved.home;
    if (saved.away != null) a.value = saved.away;
    input.appendChild(h); input.appendChild(el("span", { class: "score-dash" }, "–")); input.appendChild(a);
    const save = el("button", { type: "button", class: "pick-save", onclick: () => savePrediction(m, h, a, status) }, "Save");
    input.appendChild(save);
    const status = el("span", { class: "pick-status" });
    input.appendChild(status);
    row.appendChild(input);
  }
  return row;
}

function sideChip(side, m, which) {
  const known = side && side.id && !side.placeholder;
  const chip = el("span", { class: "pick-team" + (m.status === "post" && String(m.winnerId) === String(side.id) ? " winner" : "") });
  if (known) {
    const f = teamFlag(team(side.id) || side);
    if (f) chip.appendChild(f);
    chip.appendChild(el("span", {}, side.name));
  } else {
    chip.appendChild(el("span", { class: "muted" }, side ? side.name : "TBD"));
  }
  return chip;
}

async function savePrediction(m, hInput, aInput, statusEl) {
  const name = document.getElementById("pk-name").value.trim();
  if (!name) { statusEl.textContent = "Enter a name first"; statusEl.className = "pick-status error"; return; }
  const home = hInput.value, away = aInput.value;
  if (home === "" || away === "") { statusEl.textContent = "Enter both"; statusEl.className = "pick-status error"; return; }
  try {
    await apiPost("/api/prediction", { displayName: name, matchId: m.id, home: Number(home), away: Number(away) });
    lsSetStr(LS.name, name);
    const preds = lsGet(LS.preds, {});
    preds[String(m.id)] = { home: Number(home), away: Number(away) };
    lsSet(LS.preds, preds);
    statusEl.textContent = "Saved ✓"; statusEl.className = "pick-status success";
  } catch (e) {
    statusEl.textContent = e.message; statusEl.className = "pick-status error";
  }
}

// ===========================================================================
// bracket tree (visual, actual results)
// ===========================================================================
function renderBracketTree() {
  const root = document.getElementById("bracket-tree");
  root.innerHTML = "";
  if (!SNAP.matches || !SNAP.matches.length) {
    root.appendChild(el("div", { class: "empty" }, "The knockout bracket appears here once it's set."));
    return;
  }
  root.appendChild(el("p", { class: "hint" }, "Live knockout bracket, straight from ESPN. Winners are highlighted."));
  const wrap = el("div", { class: "tree-wrap" });
  for (const round of ROUND_ORDER) {
    const col = el("div", { class: "tree-col" });
    col.appendChild(el("h3", { class: "tree-col-title" }, ROUND_LABEL[round]));
    for (let slot = 1; slot <= ROUND_COUNT[round]; slot++) {
      const m = matchOfSlot(round, slot);
      if (m) col.appendChild(treeMatch(m));
    }
    wrap.appendChild(col);
  }
  root.appendChild(wrap);
}

function treeMatch(m) {
  const box = el("div", { class: "tree-match" });
  for (const side of [m.home, m.away]) {
    const known = side && side.id && !side.placeholder;
    const win = m.status === "post" && String(m.winnerId) === String(side.id);
    const r = el("div", { class: "tree-side" + (win ? " winner" : "") });
    const nm = el("span", { class: "tree-name" });
    if (known) { const f = teamFlag(team(side.id) || side); if (f) nm.appendChild(f); nm.appendChild(el("span", {}, side.abbr || side.name)); }
    else nm.appendChild(el("span", { class: "muted" }, side ? (side.abbr || side.name) : "TBD"));
    r.appendChild(nm);
    r.appendChild(el("span", { class: "tree-score" }, m.status !== "pre" && side.score != null ? String(side.score) : ""));
    box.appendChild(r);
  }
  box.appendChild(el("div", { class: "tree-status" }, m.status === "post" ? "FT" : m.status === "in" ? "LIVE" : fmtDate(m.date)));
  return box;
}

// ===========================================================================
// teams
// ===========================================================================
let ALL_TEAMS = [];
function renderTeams() {
  ALL_TEAMS = (SNAP.teams || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  drawTeams(ALL_TEAMS);
}
function drawTeams(list) {
  const root = document.getElementById("teams-list");
  root.innerHTML = "";
  if (!list.length) {
    root.appendChild(el("div", { class: "empty" }, "Teams appear here once the knockout field is set."));
    return;
  }
  const grid = el("div", { class: "teams-grid" });
  for (const t of list) {
    const card = el("div", { class: "team-card" });
    const f = teamFlag(t); if (f) card.appendChild(f);
    card.appendChild(el("span", { class: "team-card-name" }, t.name));
    grid.appendChild(card);
  }
  root.appendChild(grid);
}

// ===========================================================================
// results / settlement
// ===========================================================================
function computeSplitResults(label, rankedEntries, fee) {
  // rankedEntries: [{displayName, total}] already sorted best-first.
  const N = rankedEntries.length;
  const pot = N * fee;
  if (!N) return { label, entries: [], fee, pot: 0, payouts: [], structure: "—" };

  let lastTotal = null, lastRank = 0;
  rankedEntries.forEach((t, i) => { if (t.total !== lastTotal) { lastRank = i + 1; lastTotal = t.total; } t.rank = lastRank; });
  const rank1 = rankedEntries.filter((t) => t.rank === 1);
  const rank2 = rankedEntries.filter((t) => t.rank === 2);
  const rank3 = rankedEntries.filter((t) => t.rank === 3);
  const payouts = [];

  if (N < 3) {
    const share = pot / rank1.length;
    rank1.forEach((t) => payouts.push({ displayName: t.displayName, amount: share, role: rank1.length > 1 ? "winner (tie)" : "winner" }));
    return { label, entries: rankedEntries.map((t) => t.displayName), fee, pot, payouts, structure: "Winner takes all (<3 entries)" };
  }

  const hasR2 = rank2.length > 0, hasR3 = rank3.length > 0;
  const refund = hasR3 ? rank3.length * fee : 0;
  const firstSecond = pot - refund;
  const firstTot = hasR2 ? 0.7 * firstSecond : firstSecond;
  const secondTot = hasR2 ? 0.3 * firstSecond : 0;
  const firstEach = firstTot / rank1.length;
  rank1.forEach((t) => payouts.push({ displayName: t.displayName, amount: firstEach, role: rank1.length > 1 ? (hasR2 ? "1st (tie)" : "1st+2nd (tie)") : "1st" }));
  if (hasR2 && secondTot > 0) {
    const each = secondTot / rank2.length;
    rank2.forEach((t) => payouts.push({ displayName: t.displayName, amount: each, role: rank2.length > 1 ? "2nd (tie)" : "2nd" }));
  }
  if (hasR3) rank3.forEach((t) => payouts.push({ displayName: t.displayName, amount: fee, role: rank3.length > 1 ? "3rd refund (tie)" : "3rd refund" }));
  return { label, entries: rankedEntries.map((t) => t.displayName), fee, pot, payouts, structure: "1st 70% / 2nd 30% / 3rd refund" };
}

function computeWinnerTakeAll(label, ranked, fee) {
  const N = ranked.length;
  const pot = N * fee;
  if (!N) return { label, entries: [], fee, pot: 0, payouts: [], structure: "Winner takes all" };
  const top = ranked[0].total;
  const winners = top > 0 ? ranked.filter((r) => r.total === top) : [];
  const payouts = [];
  if (winners.length) {
    const share = pot / winners.length;
    winners.forEach((w) => payouts.push({ displayName: w.displayName, amount: share, role: winners.length > 1 ? "winner (tie)" : "winner" }));
  }
  return { label, entries: ranked.map((r) => r.displayName), fee, pot, payouts, structure: "Winner takes all" };
}

function getNameMap() { return lsGet(LS.nameMap, {}); }
function resolvedName(n) { const m = getNameMap(); return m[(n || "").trim()] || n; }

function buildBalances(contests) {
  const people = new Map();
  const touch = (dn) => {
    const key = (dn || "").trim().toLowerCase();
    if (!people.has(key)) people.set(key, { display: (dn || "").trim(), net: 0 });
    return people.get(key);
  };
  for (const c of contests) {
    for (const e of c.entries) touch(e).net -= c.fee;
    for (const p of c.payouts) touch(p.displayName).net += p.amount;
  }
  return [...people.values()];
}
function settleTransactions(balances) {
  const EPS = 0.005;
  const cred = balances.filter((b) => b.net > EPS).map((b) => ({ name: b.display, amount: b.net })).sort((a, b) => b.amount - a.amount);
  const deb = balances.filter((b) => b.net < -EPS).map((b) => ({ name: b.display, amount: -b.net })).sort((a, b) => b.amount - a.amount);
  const txns = []; let i = 0, j = 0;
  while (i < cred.length && j < deb.length) {
    const pay = Math.min(cred[i].amount, deb[j].amount);
    txns.push({ from: deb[j].name, to: cred[i].name, amount: pay });
    cred[i].amount -= pay; deb[j].amount -= pay;
    if (cred[i].amount < EPS) i++; if (deb[j].amount < EPS) j++;
  }
  return txns;
}
const fmtMoney = (n) => { const a = Math.abs(n); return "$" + a.toFixed(a % 1 ? 2 : 0); };
const fmtMoneySigned = (n) => (Math.abs(n) < 0.005 ? "$0" : (n > 0 ? "+" : "−") + fmtMoney(n));

function renderResults(bracketData, predData) {
  const root = document.getElementById("results");
  root.innerHTML = "";

  const contests = [];

  // Bracket contest (only counts once picks are visible / locked).
  if (!bracketData.locked && (bracketData.entries || []).length) {
    const actual = actualWinnersByRound();
    const ranked = bracketData.entries.map((e) => ({ displayName: e.displayName, total: scoreBracket(e.picks || {}, actual).total }))
      .sort((a, b) => b.total - a.total);
    contests.push(computeSplitResults("Bracket", ranked, FEES.bracket));
  }

  const tpId = thirdPlaceId();

  // Match-picks contest (excludes the 3rd-place bonus match).
  const predPlayers = new Map();
  for (const e of predData.entries || []) {
    if (tpId && String(e.matchId) === tpId) continue;
    const key = e.displayName.trim().toLowerCase();
    if (!predPlayers.has(key)) predPlayers.set(key, { displayName: e.displayName, total: 0 });
    if (e.revealed && e.home != null) {
      const s = scorePrediction({ home: e.home, away: e.away }, MATCH_BY_ID[String(e.matchId)]);
      if (s) predPlayers.get(key).total += s.points;
    }
  }
  if (predPlayers.size) {
    const ranked = [...predPlayers.values()].sort((a, b) => b.total - a.total);
    contests.push(computeSplitResults("Match picks", ranked, FEES.predictions));
  }

  // Third-place bonus contest (winner-take-all).
  if (SNAP.thirdPlace && tpId) {
    const tpPlayers = new Map();
    for (const e of predData.entries || []) {
      if (String(e.matchId) !== tpId) continue;
      const key = e.displayName.trim().toLowerCase();
      if (!tpPlayers.has(key)) tpPlayers.set(key, { displayName: e.displayName, total: 0 });
      if (e.revealed && e.home != null) {
        const s = scorePrediction({ home: e.home, away: e.away }, SNAP.thirdPlace);
        if (s) tpPlayers.get(key).total += s.points;
      }
    }
    if (tpPlayers.size) {
      const ranked = [...tpPlayers.values()].sort((a, b) => b.total - a.total);
      contests.push(computeWinnerTakeAll("Third place", ranked, FEES.thirdPlace));
    }
  }

  root.appendChild(el("div", { class: "results-header" }, [
    el("h2", {}, "Settle up"),
    el("p", { class: "hint" }, SNAP.tournament && SNAP.tournament.complete
      ? "Final results. Pay along the arrows below — it's the fewest transfers that balances everyone."
      : "Projected from the live standings. Updates until the tournament is final."),
  ]));

  if (!contests.length) {
    root.appendChild(el("div", { class: "empty" }, "No entries to settle yet."));
    return;
  }

  // Pots
  const pots = el("div", { class: "results-section" });
  pots.appendChild(el("h3", { class: "results-section-title" }, "Prize pots"));
  for (const c of contests) {
    const card = el("div", { class: "results-contest-card" });
    card.appendChild(el("div", { class: "results-contest-header" }, [
      el("span", { class: "results-contest-name" }, c.label),
      el("span", { class: "results-contest-pot" }, fmtMoney(c.pot)),
    ]));
    card.appendChild(el("p", { class: "results-contest-meta" },
      `${c.entries.length} ${c.entries.length === 1 ? "entry" : "entries"} × ${fmtMoney(c.fee)} · ${c.structure}`));
    if (c.payouts.length) {
      const list = el("ul", { class: "results-payouts" });
      for (const p of c.payouts) list.appendChild(el("li", {}, [
        el("span", { class: "role" }, p.role), el("span", { class: "name" }, p.displayName), el("span", { class: "amount" }, fmtMoney(p.amount)),
      ]));
      card.appendChild(list);
    } else card.appendChild(el("p", { class: "results-winners pending" }, "Payouts TBD"));
    pots.appendChild(card);
  }
  root.appendChild(pots);

  // Balances (merged by mapped real name)
  const raw = buildBalances(contests);
  const merged = new Map();
  for (const b of raw) {
    const rn = resolvedName(b.display);
    if (merged.has(rn)) merged.get(rn).net += b.net;
    else merged.set(rn, { display: rn, net: b.net });
  }
  const balances = [...merged.values()].sort((a, b) => b.net - a.net);

  const balCard = el("div", { class: "results-section" });
  balCard.appendChild(el("h3", { class: "results-section-title" }, "Per-player balance"));
  const bt = el("table", { class: "results-table" });
  bt.appendChild(el("thead", {}, el("tr", {}, [el("th", {}, "Player"), el("th", { class: "num" }, "Net")])));
  const bb = el("tbody");
  for (const p of balances) {
    bb.appendChild(el("tr", { class: p.net > 0.005 ? "credit" : p.net < -0.005 ? "debit" : "" }, [
      el("td", { class: "name" }, p.display), el("td", { class: "num" }, fmtMoneySigned(p.net)),
    ]));
  }
  bt.appendChild(bb); balCard.appendChild(bt);
  balCard.appendChild(nameMapUI(raw, bracketData, predData));
  root.appendChild(balCard);

  // Transfers
  const txns = settleTransactions(balances);
  const settle = el("div", { class: "results-section" });
  settle.appendChild(el("h3", { class: "results-section-title" }, "Transfers"));
  if (!txns.length) settle.appendChild(el("p", { class: "hint" }, "Everyone's even — no transfers needed."));
  else {
    settle.appendChild(el("p", { class: "hint" }, `${txns.length} transfer${txns.length === 1 ? "" : "s"} settles the books.`));
    const list = el("ul", { class: "results-txns" });
    for (const t of txns) list.appendChild(el("li", {}, [
      el("span", { class: "from" }, t.from), el("span", { class: "arrow" }, " → "),
      el("span", { class: "to" }, t.to), el("span", { class: "amount" }, fmtMoney(t.amount)),
    ]));
    settle.appendChild(list);
  }
  root.appendChild(settle);
}

function nameMapUI(rawBalances, bracketData, predData) {
  const details = el("details", {});
  const summary = document.createElement("summary");
  summary.className = "results-section-title collapsible-title";
  summary.textContent = "Merge duplicate names";
  details.appendChild(summary);
  details.appendChild(el("p", { class: "hint" }, "Map a team name to a real person so multiple entries settle as one. Saved in your browser."));
  const map = getNameMap();
  const table = el("table", { class: "results-table name-map-table" });
  table.appendChild(el("thead", {}, el("tr", {}, [el("th", {}, "Entry name"), el("th", {}, "Real name")])));
  const body = el("tbody");
  for (const b of rawBalances) {
    const inp = el("input", { type: "text", class: "name-map-input", placeholder: b.display, value: map[b.display] || "" });
    inp.addEventListener("change", () => {
      const m = getNameMap();
      if (inp.value.trim()) m[b.display] = inp.value.trim(); else delete m[b.display];
      lsSet(LS.nameMap, m);
      renderResults(bracketData, predData);
    });
    body.appendChild(el("tr", {}, [el("td", { class: "name" }, b.display), el("td", {}, inp)]));
  }
  table.appendChild(body); details.appendChild(table);
  return details;
}

// ===========================================================================
// shared UI helpers
// ===========================================================================
function pickerClosedCard(title, body) {
  const card = el("div", { class: "picker-closed" });
  card.appendChild(el("h2", { class: "picker-closed-title" }, title));
  card.appendChild(el("p", { class: "picker-closed-body" }, body));
  return card;
}
let flashTimers = {};
function flash(id, msg, kind) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = msg;
  node.className = "picker-status visible " + (kind || "info");
  if (flashTimers[id]) clearTimeout(flashTimers[id]);
  flashTimers[id] = setTimeout(() => node.classList.remove("visible"), 5000);
}

// ===========================================================================
// tabs + auto-refresh + boot
// ===========================================================================
function wireTabs() {
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".tab-panel");
  tabs.forEach((tab) => tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    panels.forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
    lsSetStr(LS.tab, tab.dataset.tab);
  }));
  document.querySelectorAll("[data-jump]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    document.querySelector(`.tab[data-tab="${a.getAttribute("data-jump")}"]`).click();
  }));
  const saved = lsGetStr(LS.tab);
  if (saved) { const t = document.querySelector(`.tab[data-tab="${saved}"]`); if (t) t.click(); }
}

function safeToRefresh(tabId) {
  // Don't reload while someone is mid-entry on a picker tab.
  return tabId !== "make-bracket" && tabId !== "make-picks";
}
function startAutoRefresh() {
  setInterval(() => {
    const active = document.querySelector(".tab.active");
    if (active && safeToRefresh(active.dataset.tab)) location.reload();
  }, 45000);
}

function wireTeamSearch() {
  const input = document.getElementById("teams-search");
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    drawTeams(q ? ALL_TEAMS.filter((t) => t.name.toLowerCase().includes(q) || (t.abbr || "").toLowerCase().includes(q)) : ALL_TEAMS);
  });
}

async function main() {
  wireTabs();
  startAutoRefresh();
  wireTeamSearch();

  let scores, bracketData, predData;
  try {
    [scores, bracketData, predData] = await Promise.all([
      api("/api/scores"),
      api("/api/brackets").catch(() => ({ entries: [], locked: false })),
      api("/api/predictions").catch(() => ({ entries: [] })),
    ]);
  } catch (e) {
    const err = document.getElementById("error");
    err.textContent = e.message + " — the Worker may still be warming up. Try again shortly.";
    err.hidden = false;
    return;
  }

  indexSnapshot(scores);
  renderHeader();
  renderBracketStandings(bracketData);
  renderBracketPicker();
  renderPredictionStandings(predData);
  renderPicksMaker(predData);
  renderBracketTree();
  renderTeams();
  renderResults(bracketData, predData);
}

main();
