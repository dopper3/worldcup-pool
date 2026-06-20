// Nettzone World Cup Pool — Cloudflare Worker
//
// One Worker does everything:
//   • Serves the static site (Workers Static Assets, bound as env.ASSETS).
//   • Exposes a small JSON API under /api/* backed by D1 (env.DB).
//   • On a cron trigger, fetches the FIFA World Cup knockout bracket from
//     ESPN and stores a normalized snapshot in D1 (kv['scores']).
//
// There is no Google Form and no GitHub Action — entries are submitted
// straight from the site to /api/* and land in D1 instantly.

// ---------------------------------------------------------------------------
// Bracket structure (FIFA 2026, 48-team format). Knockout match numbers are
// fixed: R32 = 73-88, R16 = 89-96, QF = 97-100, SF = 101-102, 3rd = 103,
// Final = 104. ESPN's per-event `matchNumber` (core API) gives us the number;
// we also hardcode the known event-id → matchNumber map so the common case
// needs zero extra subrequests and stays robust if an event briefly 404s.
// ---------------------------------------------------------------------------
const KNOWN_MATCH_NUMBERS = {
  "760486": 73, "760489": 74, "760488": 75, "760487": 76, "760492": 77,
  "760490": 78, "760491": 79, "760495": 80, "760494": 81, "760493": 82,
  "760496": 83, "760497": 84, "760498": 85, "760500": 86, "760501": 87,
  "760499": 88, "760503": 89, "760502": 90, "760504": 91, "760505": 92,
  "760506": 93, "760507": 94, "760509": 95, "760508": 96, "760510": 97,
  "760511": 98, "760512": 99, "760513": 100, "760514": 101, "760515": 102,
  "760516": 103, "760517": 104,
};

// Round metadata keyed by round key. `points` is the per-correct-pick value
// for the bracket contest (escalating by round). `base` lets us turn a
// matchNumber into a 1-based slot number within the round (slot = num - base).
const ROUNDS = [
  { key: "R32", label: "Round of 32", slug: "round-of-32", points: 1, base: 72, count: 16 },
  { key: "R16", label: "Round of 16", slug: "round-of-16", points: 2, base: 88, count: 8 },
  { key: "QF", label: "Quarterfinals", slug: "quarterfinals", points: 4, base: 96, count: 4 },
  { key: "SF", label: "Semifinals", slug: "semifinals", points: 8, base: 100, count: 2 },
  { key: "F", label: "Final", slug: "final", points: 16, base: 103, count: 1 },
];
const ROUND_BY_SLUG = Object.fromEntries(ROUNDS.map((r) => [r.slug, r]));

// The 3rd-place playoff is its own bonus contest, not part of the bracket tree.
// matchNumber 103 → slot 1 (base 102). Kept out of `matches` so the bracket and
// match-picks game are unaffected; exposed as snapshot.thirdPlace.
const THIRD_PLACE_SLUG = "3rd-place-match";
const THIRD_META = { key: "3P", label: "Third-place playoff", base: 102 };

// Feeders: for each knockout slot, which two slots of the previous round feed
// it. Derived directly from ESPN's event names — note R16 feeders are NOT
// sequential, so this map is load-bearing.
const FEEDERS = {
  R16: { 1: [5, 2], 2: [3, 1], 3: [6, 4], 4: [8, 7], 5: [12, 11], 6: [10, 9], 7: [16, 14], 8: [15, 13] },
  QF: { 1: [2, 1], 2: [6, 5], 3: [4, 3], 4: [8, 7] },
  SF: { 1: [2, 1], 2: [4, 3] },
  F: { 1: [2, 1] },
};
const PREV_ROUND = { R16: "R32", QF: "R16", SF: "QF", F: "SF" };

const UA = { "User-Agent": "nettzone-wc-pool/1.0 (cloudflare worker)" };
const ESPN_SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const ESPN_CORE_COMP = (id) =>
  `https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world/events/${id}/competitions/${id}?lang=en`;

// ===========================================================================
// HTTP entry point
// ===========================================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: String(err && err.message || err) }, 500);
      }
    }
    // Everything else is a static asset.
    return env.ASSETS.fetch(request);
  },

  // Cron trigger — refresh the scores snapshot.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshScores(env));
  },
};

// ===========================================================================
// API router
// ===========================================================================
async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method.toUpperCase();

  if (path === "/api/scores" && method === "GET") {
    const snap = await readKv(env, "scores");
    return json(snap || { tournament: null, matches: [], teams: [], rounds: ROUNDS, bracketReady: false });
  }

  if (path === "/api/refresh" && method === "POST") {
    // Manual kick (handy right after deploy). Open by design — it only
    // re-reads public ESPN data; abuse just wastes a fetch.
    const snap = await refreshScores(env);
    return json({ ok: true, matches: snap.matches.length, bracketReady: snap.bracketReady });
  }

  if (path === "/api/brackets" && method === "GET") {
    return json(await getBrackets(env));
  }
  if (path === "/api/bracket" && method === "POST") {
    return await submitBracket(request, env);
  }

  if (path === "/api/predictions" && method === "GET") {
    return json(await getPredictions(env));
  }
  if (path === "/api/prediction" && method === "POST") {
    return await submitPrediction(request, env);
  }

  return json({ error: "not found" }, 404);
}

// ===========================================================================
// Brackets (main contest)
// ===========================================================================
async function getBrackets(env) {
  const snap = (await readKv(env, "scores")) || {};
  const cutoff = snap.tournament && snap.tournament.bracketCutoff
    ? Date.parse(snap.tournament.bracketCutoff) : null;
  const locked = cutoff != null && Date.now() < cutoff; // hide picks pre-cutoff
  const { results } = await env.DB.prepare(
    "SELECT display_name, picks_json, updated_at FROM brackets ORDER BY display_name COLLATE NOCASE"
  ).all();
  const entries = (results || []).map((r) => {
    const base = { displayName: r.display_name, updatedAt: r.updated_at };
    if (locked) return base; // names only until the bracket locks
    let picks = {};
    try { picks = JSON.parse(r.picks_json); } catch {}
    return { ...base, picks };
  });
  return { locked, cutoff: snap.tournament ? snap.tournament.bracketCutoff : null, entries };
}

async function submitBracket(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "invalid JSON" }, 400);

  const displayName = cleanName(body.displayName);
  if (!displayName) return json({ error: "Enter a display name." }, 400);

  const snap = (await readKv(env, "scores")) || {};
  const cutoff = snap.tournament && snap.tournament.bracketCutoff
    ? Date.parse(snap.tournament.bracketCutoff) : null;
  if (cutoff != null && Date.now() >= cutoff) {
    return json({ error: "The bracket has locked — Round of 32 has started." }, 403);
  }
  if (!snap.bracketReady) {
    return json({ error: "The Round of 32 matchups aren't set yet." }, 409);
  }

  // Validate the picked tree against the real R32 matchups + feeders.
  const picks = body.picks || {};
  const v = validateBracket(picks, snap);
  if (!v.ok) return json({ error: v.error }, 400);

  const payload = JSON.stringify(v.normalized);
  const now = new Date().toISOString();
  // Latest submission for a given (case-insensitive) name wins.
  await env.DB.prepare(
    `INSERT INTO brackets (norm_name, display_name, picks_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(norm_name) DO UPDATE SET
       display_name=excluded.display_name,
       picks_json=excluded.picks_json,
       updated_at=excluded.updated_at`
  ).bind(normName(displayName), displayName, payload, now).run();

  return json({ ok: true });
}

// Validate a predicted bracket tree. Each round's winners must be drawn from
// the actual participants of that slot (R32 from ESPN teams; later rounds from
// the player's own advancing picks via the feeder map).
function validateBracket(picks, snap) {
  const byNum = indexMatches(snap);
  const winners = (picks.winners) || {};
  const out = { winners: {}, champion: null, goldenBoot: cleanText(picks.goldenBoot, 60),
    finalWinnerGoals: clampGoals(picks.finalWinnerGoals), finalLoserGoals: clampGoals(picks.finalLoserGoals) };

  // R32: pick must be one of the two real teams in that match.
  out.winners.R32 = {};
  for (let slot = 1; slot <= 16; slot++) {
    const m = byNum[72 + slot];
    if (!m) return { ok: false, error: `Missing Round of 32 match ${slot}.` };
    const pick = String((winners.R32 || {})[slot] || "");
    const ids = [m.home.id, m.away.id].map(String);
    if (!ids.includes(pick)) return { ok: false, error: `Pick a winner for Round of 32 match ${slot}.` };
    out.winners.R32[slot] = pick;
  }

  // R16 → Final: winner must be one of the two feeder-slot winners.
  for (const round of ["R16", "QF", "SF", "F"]) {
    out.winners[round] = {};
    const meta = ROUNDS.find((r) => r.key === round);
    const prev = PREV_ROUND[round];
    for (let slot = 1; slot <= meta.count; slot++) {
      const [a, b] = FEEDERS[round][slot];
      const feederWinners = [out.winners[prev][a], out.winners[prev][b]];
      const pick = String((winners[round] || {})[slot] || "");
      if (!feederWinners.map(String).includes(pick)) {
        return { ok: false, error: `Pick a winner for ${meta.label} match ${slot}.` };
      }
      out.winners[round][slot] = pick;
    }
  }
  out.champion = out.winners.F[1];
  return { ok: true, normalized: out };
}

// ===========================================================================
// Per-match predictions (side game)
// ===========================================================================
async function getPredictions(env) {
  const snap = (await readKv(env, "scores")) || {};
  const byId = {};
  for (const m of snap.matches || []) byId[String(m.id)] = m;
  if (snap.thirdPlace) byId[String(snap.thirdPlace.id)] = snap.thirdPlace;
  const now = Date.now();

  const { results } = await env.DB.prepare(
    "SELECT display_name, match_id, home_goals, away_goals, updated_at FROM predictions"
  ).all();

  const entries = (results || []).map((r) => {
    const m = byId[String(r.match_id)];
    const kickoff = m ? Date.parse(m.date) : null;
    const revealed = kickoff != null && now >= kickoff; // hide picks until kickoff
    const base = { displayName: r.display_name, matchId: String(r.match_id), updatedAt: r.updated_at, revealed };
    if (revealed) { base.home = r.home_goals; base.away = r.away_goals; }
    return base;
  });
  return { entries };
}

async function submitPrediction(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "invalid JSON" }, 400);

  const displayName = cleanName(body.displayName);
  if (!displayName) return json({ error: "Enter a display name." }, 400);

  const matchId = String(body.matchId || "");
  const home = clampGoals(body.home);
  const away = clampGoals(body.away);
  if (home == null || away == null) return json({ error: "Enter both scores (0–20)." }, 400);

  const snap = (await readKv(env, "scores")) || {};
  const all = (snap.matches || []).slice();
  if (snap.thirdPlace) all.push(snap.thirdPlace);
  const m = all.find((x) => String(x.id) === matchId);
  if (!m) return json({ error: "Unknown match." }, 404);
  if (Date.now() >= Date.parse(m.date)) {
    return json({ error: "That match has already kicked off." }, 403);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO predictions (norm_name, display_name, match_id, home_goals, away_goals, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(norm_name, match_id) DO UPDATE SET
       display_name=excluded.display_name,
       home_goals=excluded.home_goals,
       away_goals=excluded.away_goals,
       updated_at=excluded.updated_at`
  ).bind(normName(displayName), displayName, matchId, home, away, now).run();

  return json({ ok: true });
}

// ===========================================================================
// ESPN fetch + normalize → D1 kv['scores']
// ===========================================================================
async function refreshScores(env) {
  // Query the knockout window only. A wider range makes ESPN silently cap the
  // result set and drop the late rounds (SF/Final); this window returns all 32.
  const res = await fetch(`${ESPN_SCOREBOARD}?dates=20260628-20260720`, { headers: UA });
  if (!res.ok) throw new Error(`ESPN scoreboard ${res.status}`);
  const data = await res.json();
  const events = data.events || [];

  const matches = [];
  const teamMap = new Map();
  const needNumber = []; // events missing from KNOWN_MATCH_NUMBERS

  for (const ev of events) {
    const slug = (ev.season && ev.season.slug) || "";
    const round = ROUND_BY_SLUG[slug];
    if (!round) continue; // skip group stage
    let num = KNOWN_MATCH_NUMBERS[String(ev.id)];
    if (!num) { needNumber.push(ev); continue; }
    matches.push(buildMatch(ev, num, round, teamMap));
  }

  // Fallback: resolve any unknown event's matchNumber from the core API.
  if (needNumber.length) {
    await Promise.all(needNumber.map(async (ev) => {
      try {
        const r = await fetch(ESPN_CORE_COMP(ev.id), { headers: UA });
        const c = await r.json();
        const num = c.matchNumber;
        const round = ROUND_BY_SLUG[(ev.season && ev.season.slug) || ""];
        if (num && round) matches.push(buildMatch(ev, num, round, teamMap));
      } catch (_) { /* skip */ }
    }));
  }

  matches.sort((a, b) => a.matchNumber - b.matchNumber);

  // Third-place playoff (bonus contest) — built separately from the bracket.
  let thirdPlace = null;
  const tpEvent = events.find((e) => ((e.season && e.season.slug) || "") === THIRD_PLACE_SLUG);
  if (tpEvent) {
    let num = KNOWN_MATCH_NUMBERS[String(tpEvent.id)];
    if (!num) {
      try { const r = await fetch(ESPN_CORE_COMP(tpEvent.id), { headers: UA }); num = (await r.json()).matchNumber; } catch (_) {}
    }
    if (num) thirdPlace = buildMatch(tpEvent, num, THIRD_META, teamMap);
  }

  const r32 = matches.filter((m) => m.round === "R32");
  const bracketReady = r32.length === 16 && r32.every((m) => !m.home.placeholder && !m.away.placeholder);
  const bracketCutoff = r32.length ? r32.map((m) => m.date).sort()[0] : null;

  const anyLive = matches.some((m) => m.status === "in");
  const allDone = matches.length > 0 && matches.every((m) => m.status === "post");

  const snapshot = {
    tournament: {
      name: "FIFA World Cup 2026",
      season: 2026,
      stage: r32.length ? "knockout" : "group",
      bracketReady,
      bracketCutoff,
      live: anyLive,
      complete: allDone,
      lastUpdated: new Date().toISOString(),
    },
    rounds: ROUNDS.map(({ key, label, points, count }) => ({ key, label, points, count })),
    feeders: FEEDERS,
    matches,
    thirdPlace,
    teams: [...teamMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    bracketReady,
  };

  await writeKv(env, "scores", snapshot);
  return snapshot;
}

function buildMatch(ev, num, round, teamMap) {
  const comp = (ev.competitions || [])[0] || {};
  const status = (comp.status && comp.status.type) || {};
  const competitors = comp.competitors || [];
  const home = competitors.find((c) => c.homeAway === "home") || competitors[0] || {};
  const away = competitors.find((c) => c.homeAway === "away") || competitors[1] || {};

  const side = (c) => {
    const t = (c && c.team) || {};
    const name = t.displayName || "TBD";
    const placeholder = isPlaceholder(name, t);
    const tm = {
      id: t.id != null ? String(t.id) : null,
      name,
      abbr: t.abbreviation || "",
      flag: t.logo || "",
      score: c && c.score != null && c.score !== "" ? Number(c.score) : null,
      placeholder,
    };
    if (!placeholder && tm.id) {
      teamMap.set(tm.id, { id: tm.id, name: tm.name, abbr: tm.abbr, flag: tm.flag });
    }
    return tm;
  };

  const h = side(home), a = side(away);
  const state = (status.state || "pre").toLowerCase();
  let winnerId = null, loserId = null;
  if (state === "post") {
    if (home.winner) { winnerId = h.id; loserId = a.id; }
    else if (away.winner) { winnerId = a.id; loserId = h.id; }
  }

  return {
    id: String(ev.id),
    matchNumber: num,
    round: round.key,
    roundLabel: round.label,
    slot: num - round.base,
    date: ev.date,
    status: state === "in" ? "in" : state === "post" ? "post" : "pre",
    statusDetail: status.shortDetail || status.detail || status.description || "Scheduled",
    home: h,
    away: a,
    winnerId,
    loserId,
  };
}

function isPlaceholder(name, team) {
  if (!team || team.id == null) return true;
  if (/winner|loser|place|group\s|runner|third/i.test(name)) return true;
  // Real nations carry a country flag logo; placeholders don't.
  if (!team.logo || !/\/countries\//.test(team.logo)) {
    // Mexico / United States etc. always have flags, so no-flag ⇒ placeholder.
    return true;
  }
  return false;
}

function indexMatches(snap) {
  const byNum = {};
  for (const m of snap.matches || []) byNum[m.matchNumber] = m;
  return byNum;
}

// ===========================================================================
// D1 kv helpers + misc
// ===========================================================================
async function readKv(env, key) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = ?1").bind(key).first();
  if (!row || !row.v) return null;
  try { return JSON.parse(row.v); } catch { return null; }
}
async function writeKv(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v"
  ).bind(key, JSON.stringify(value)).run();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function normName(s) { return (s || "").trim().toLowerCase().replace(/\s+/g, " "); }
function cleanName(s) { return cleanText(s, 40); }
function cleanText(s, max) {
  if (typeof s !== "string") return "";
  return s.trim().slice(0, max);
}
function clampGoals(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const i = Math.round(v);
  if (i < 0 || i > 20) return null;
  return i;
}
