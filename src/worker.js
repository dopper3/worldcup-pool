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

// Manual override for when the bracket locks. Normally the cutoff is the first
// Round of 32 kickoff (computed below from ESPN), but set this to an ISO
// timestamp to reopen/extend bracket picks. Set back to null to restore the
// automatic "locks at first R32 kickoff" behaviour.
//   2026-06-29T16:00:00-04:00  =  4pm Eastern (EDT), Mon June 29 2026.
const BRACKET_CUTOFF_OVERRIDE = "2026-06-29T16:00:00-04:00";

const UA = { "User-Agent": "nettzone-wc-pool/1.0 (cloudflare worker)" };
const ESPN_SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const ESPN_CORE_COMP = (id) =>
  `https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world/events/${id}/competitions/${id}?lang=en`;
const ESPN_TEAM_ROSTER = (id) =>
  `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/teams/${id}/roster`;

// Auth / sessions.
const COOKIE = "wc_sess";
const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const PBKDF2_ITERS = 100000;

// Player-to-score contest: rolling window of "current" games (group + knockout)
// so the contest can run immediately, independent of the bracket. Spans a few
// days back (for grading just-finished games) through a couple weeks ahead.
const PLAYER_GAMES_BACK_DAYS = 3;
const PLAYER_GAMES_AHEAD_DAYS = 16;
const ROSTER_TTL_MS = 12 * 60 * 60 * 1000; // refetch a team's roster at most twice a day
const ROSTERS_PER_RUN = 8;                 // bound subrequests per cron tick

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
    return json(await getBrackets(request, env));
  }
  if (path === "/api/bracket" && method === "POST") {
    return await submitBracket(request, env);
  }

  if (path === "/api/predictions" && method === "GET") {
    return json(await getPredictions(request, env));
  }
  if (path === "/api/prediction" && method === "POST") {
    return await submitPrediction(request, env);
  }

  // --- auth ---
  if (path === "/api/register" && method === "POST") return await register(request, env);
  if (path === "/api/login" && method === "POST") return await login(request, env);
  if (path === "/api/logout" && method === "POST") return await logout(request, env);
  if (path === "/api/me" && method === "GET") {
    const user = await getSessionUser(request, env);
    return json({ user: user ? publicUser(user) : null });
  }

  // --- player-to-score contest ---
  if (path === "/api/rosters" && method === "GET") {
    return json({ rosters: (await readKv(env, "rosters")) || {} });
  }
  if (path === "/api/player-picks" && method === "GET") {
    return json(await getPlayerPicks(request, env));
  }
  if (path === "/api/player-pick" && method === "POST") {
    return await submitPlayerPick(request, env);
  }
  if (path === "/api/player-pick/override" && method === "POST") {
    return await overridePlayerPick(request, env);
  }

  return json({ error: "not found" }, 404);
}

// ===========================================================================
// Auth — self-signup accounts, server-side sessions, HttpOnly cookie
// ===========================================================================
function publicUser(u) { return { id: u.id, username: u.username, isAdmin: !!u.isAdmin }; }

function isAdmin(username, env) {
  const list = String((env && env.ADMIN_USERNAMES) || "").split(",").map(normName).filter(Boolean);
  return list.includes(normName(username));
}

const enc = new TextEncoder();
function b64(bytes) { let s = ""; const a = new Uint8Array(bytes); for (const x of a) s += String.fromCharCode(x); return btoa(s); }
function unb64(str) { return Uint8Array.from(atob(str), (c) => c.charCodeAt(0)); }
function randToken(n = 32) { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64(a).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c])); }

async function derivePassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" }, key, 256);
  return b64(bits);
}
async function hashPassword(password) {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  return { hash: await derivePassword(password, salt), salt: b64(salt) };
}
async function verifyPassword(password, hashB64, saltB64) {
  let saltBytes; try { saltBytes = unb64(saltB64); } catch { return false; }
  const calc = await derivePassword(password, saltBytes);
  // Constant-time-ish compare.
  if (calc.length !== hashB64.length) return false;
  let diff = 0; for (let i = 0; i < calc.length; i++) diff |= calc.charCodeAt(i) ^ hashB64.charCodeAt(i);
  return diff === 0;
}

function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}
function sessionCookie(token, maxAgeSec, secure) {
  const bits = [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSec}`];
  if (secure) bits.push("Secure"); // omit on http (e.g. `wrangler dev`) so the cookie sticks
  return bits.join("; ");
}
function isSecure(request) { try { return new URL(request.url).protocol === "https:"; } catch { return true; } }

async function getSessionUser(request, env) {
  const token = getCookie(request, COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT u.id AS id, u.username AS username, s.expires_at AS expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?1"
  ).bind(token).first();
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?1").bind(token).run();
    return null;
  }
  return { id: row.id, username: row.username, isAdmin: isAdmin(row.username, env) };
}

async function newSession(env, userId) {
  const token = randToken(32);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)"
  ).bind(token, userId, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString()).run();
  return token;
}

function validUsername(s) { return typeof s === "string" && /^[A-Za-z0-9 ._-]{3,30}$/.test(s.trim()); }

async function register(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "invalid JSON" }, 400);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!validUsername(username)) return json({ error: "Username must be 3–30 characters (letters, numbers, space . _ -)." }, 400);
  if (password.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);

  const id = randToken(16);
  const { hash, salt } = await hashPassword(password);
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT INTO users (id, norm_username, username, pass_hash, pass_salt, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ).bind(id, normName(username), username, hash, salt, now).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return json({ error: "That username is taken." }, 409);
    throw e;
  }
  const token = await newSession(env, id);
  return json({ user: publicUser({ id, username, isAdmin: isAdmin(username, env) }) }, 200,
    { "set-cookie": sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000), isSecure(request)) });
}

async function login(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "invalid JSON" }, 400);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) return json({ error: "Enter your username and password." }, 400);

  const row = await env.DB.prepare(
    "SELECT id, username, pass_hash, pass_salt FROM users WHERE norm_username = ?1"
  ).bind(normName(username)).first();
  if (!row || !(await verifyPassword(password, row.pass_hash, row.pass_salt))) {
    return json({ error: "Wrong username or password." }, 401);
  }
  const token = await newSession(env, row.id);
  return json({ user: publicUser({ id: row.id, username: row.username, isAdmin: isAdmin(row.username, env) }) }, 200,
    { "set-cookie": sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000), isSecure(request)) });
}

async function logout(request, env) {
  const token = getCookie(request, COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?1").bind(token).run();
  const secure = isSecure(request) ? " Secure;" : "";
  return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0` });
}

// ===========================================================================
// Brackets (main contest)
// ===========================================================================
async function getBrackets(request, env) {
  const snap = (await readKv(env, "scores")) || {};
  const cutoff = snap.tournament && snap.tournament.bracketCutoff
    ? Date.parse(snap.tournament.bracketCutoff) : null;
  const locked = cutoff != null && Date.now() < cutoff; // hide picks pre-cutoff
  const user = await getSessionUser(request, env);
  const { results } = await env.DB.prepare(
    "SELECT user_id, display_name, picks_json, updated_at FROM brackets ORDER BY display_name COLLATE NOCASE"
  ).all();
  let mine = null; // the logged-in user always gets their own picks back, even pre-cutoff
  const entries = (results || []).map((r) => {
    if (user && r.user_id === user.id) { try { mine = JSON.parse(r.picks_json); } catch {} }
    const base = { displayName: r.display_name, updatedAt: r.updated_at };
    if (locked) return base; // names only until the bracket locks
    let picks = {};
    try { picks = JSON.parse(r.picks_json); } catch {}
    return { ...base, picks };
  });
  return { locked, cutoff: snap.tournament ? snap.tournament.bracketCutoff : null, entries, mine };
}

async function submitBracket(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: "Sign in to submit your bracket." }, 401);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "invalid JSON" }, 400);

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
  // One bracket per account; latest submission replaces it.
  await env.DB.prepare(
    `INSERT INTO brackets (user_id, display_name, picks_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(user_id) DO UPDATE SET
       display_name=excluded.display_name,
       picks_json=excluded.picks_json,
       updated_at=excluded.updated_at`
  ).bind(user.id, user.username, payload, now).run();

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
async function getPredictions(request, env) {
  const snap = (await readKv(env, "scores")) || {};
  const byId = {};
  for (const m of snap.matches || []) byId[String(m.id)] = m;
  if (snap.thirdPlace) byId[String(snap.thirdPlace.id)] = snap.thirdPlace;
  const now = Date.now();
  const user = await getSessionUser(request, env);

  const { results } = await env.DB.prepare(
    "SELECT user_id, display_name, match_id, home_goals, away_goals, updated_at FROM predictions"
  ).all();

  const mine = {}; // matchId -> {home, away} for the logged-in user, revealed or not
  const entries = (results || []).map((r) => {
    if (user && r.user_id === user.id) mine[String(r.match_id)] = { home: r.home_goals, away: r.away_goals };
    const m = byId[String(r.match_id)];
    const kickoff = m ? Date.parse(m.date) : null;
    const revealed = kickoff != null && now >= kickoff; // hide picks until kickoff
    const base = { displayName: r.display_name, matchId: String(r.match_id), updatedAt: r.updated_at, revealed };
    if (revealed) { base.home = r.home_goals; base.away = r.away_goals; }
    return base;
  });
  return { entries, mine };
}

async function submitPrediction(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: "Sign in to make match picks." }, 401);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "invalid JSON" }, 400);

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
    `INSERT INTO predictions (user_id, display_name, match_id, home_goals, away_goals, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(user_id, match_id) DO UPDATE SET
       display_name=excluded.display_name,
       home_goals=excluded.home_goals,
       away_goals=excluded.away_goals,
       updated_at=excluded.updated_at`
  ).bind(user.id, user.username, matchId, home, away, now).run();

  return json({ ok: true });
}

// ===========================================================================
// Player-to-score contest (pick a player to score in a game; $5 each, 2 pts)
// ===========================================================================
// A pick's identity within a user: the ESPN athlete id when known, else a
// normalized name. Used both for "pick each player at most once" and as the
// stable handle for admin overrides.
function playerKeyOf(playerId, playerName) {
  const id = String(playerId || "").trim();
  if (id) return "id:" + id;
  return "nm:" + (playerName || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function getPlayerPicks(request, env) {
  const snap = (await readKv(env, "scores")) || {};
  const byId = {};
  for (const g of snap.playerGames || []) byId[String(g.id)] = g;
  const now = Date.now();
  const overrides = (await readKv(env, "pp_overrides")) || {};
  const user = await getSessionUser(request, env);

  const { results } = await env.DB.prepare(
    "SELECT user_id, display_name, match_id, player_id, player_name, player_key, updated_at FROM player_picks"
  ).all();

  const mine = {}; // matchId -> [{playerId, playerName, playerKey}] for the logged-in user
  const entries = (results || []).map((r) => {
    if (user && r.user_id === user.id) {
      (mine[String(r.match_id)] = mine[String(r.match_id)] || []).push(
        { playerId: String(r.player_id), playerName: r.player_name, playerKey: r.player_key });
    }
    const g = byId[String(r.match_id)];
    const kickoff = g ? Date.parse(g.date) : null;
    const revealed = kickoff != null && now >= kickoff; // hide picks until kickoff
    const base = { userId: r.user_id, displayName: r.display_name, matchId: String(r.match_id), playerKey: r.player_key, updatedAt: r.updated_at, revealed };
    if (revealed) { base.playerId = String(r.player_id); base.playerName = r.player_name; }
    return base;
  });
  return { entries, overrides, mine };
}

async function submitPlayerPick(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: "Sign in to pick a player." }, 401);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "invalid JSON" }, 400);
  const matchId = String(body.matchId || "");

  const snap = (await readKv(env, "scores")) || {};
  const g = (snap.playerGames || []).find((x) => String(x.id) === matchId);
  if (!g) return json({ error: "That game isn't open for picks." }, 404);
  if (Date.now() >= Date.parse(g.date)) return json({ error: "That game has already kicked off." }, 403);

  const playerId = String(body.playerId || "").trim();
  const playerName = cleanText(body.playerName, 80);
  // Caller may pass an explicit playerKey (e.g. to remove a name-based pick);
  // otherwise derive it from the id/name.
  const playerKey = String(body.playerKey || "").trim() || playerKeyOf(playerId, playerName);

  // Removing a single pick before kickoff is allowed — no forced $5 for a misclick.
  if (body.remove) {
    if (!playerKey || playerKey === "nm:") return json({ error: "Which pick? Missing player." }, 400);
    await env.DB.prepare("DELETE FROM player_picks WHERE user_id = ?1 AND player_key = ?2").bind(user.id, playerKey).run();
    return json({ ok: true, removed: true });
  }

  if (!playerName) return json({ error: "Pick a player." }, 400);
  if (playerKey === "nm:") return json({ error: "Enter a valid player name." }, 400);

  // Same player can't be picked twice — but only flag it if the existing pick is
  // for a different game (re-saving the same player on the same game is just an edit).
  const existing = await env.DB.prepare(
    "SELECT match_id FROM player_picks WHERE user_id = ?1 AND player_key = ?2"
  ).bind(user.id, playerKey).first();
  if (existing && String(existing.match_id) !== matchId) {
    const other = (snap.playerGames || []).find((x) => String(x.id) === String(existing.match_id));
    return json({ error: `You already picked ${playerName} for ${other ? other.name : "another game"}. Each player can only be picked once.` }, 409);
  }

  const now = new Date().toISOString();
  // Unique per (user, player). Stacking different players on one game is fine;
  // re-saving the same player just refreshes the row (still one $5 stake).
  await env.DB.prepare(
    `INSERT INTO player_picks (user_id, display_name, match_id, player_id, player_name, player_key, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT(user_id, player_key) DO UPDATE SET
       display_name=excluded.display_name,
       match_id=excluded.match_id,
       player_id=excluded.player_id,
       player_name=excluded.player_name,
       updated_at=excluded.updated_at`
  ).bind(user.id, user.username, matchId, playerId, playerName, playerKey, now).run();
  return json({ ok: true });
}

// Admin manual fallback: force a single pick to count (or not) when feed
// auto-grading can't resolve it. Keyed per-pick (user + game + player) since a
// user may hold several picks in one game. body.hit true/false sets; null clears.
async function overridePlayerPick(request, env) {
  const user = await getSessionUser(request, env);
  if (!user || !user.isAdmin) return json({ error: "Admins only." }, 403);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "invalid JSON" }, 400);
  const matchId = String(body.matchId || "");
  const userId = String(body.userId || "");
  const playerKey = String(body.playerKey || "").trim();
  if (!matchId || !userId || !playerKey) return json({ error: "Need userId, matchId and playerKey." }, 400);

  const overrides = (await readKv(env, "pp_overrides")) || {};
  const key = `${userId}:${matchId}:${playerKey}`;
  if (body.hit === null || body.hit === undefined) delete overrides[key];
  else overrides[key] = !!body.hit;
  await writeKv(env, "pp_overrides", overrides);
  return json({ ok: true, overrides });
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
  const bracketCutoff = BRACKET_CUTOFF_OVERRIDE
    || (r32.length ? r32.map((m) => m.date).sort()[0] : null);

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

  // Player-to-score contest games — a rolling slate of current World Cup games
  // (group + knockout), fetched independently so the contest runs immediately.
  // A failure here must not wipe the previous slate, so we fall back to it.
  try {
    const pg = await fetchPlayerGames();
    snapshot.playerGames = pg.games;
    await refreshRosters(env, pg.teamIds);
  } catch (_) {
    const prev = await readKv(env, "scores");
    snapshot.playerGames = (prev && prev.playerGames) || [];
  }

  await writeKv(env, "scores", snapshot);
  return snapshot;
}

// ---------------------------------------------------------------------------
// Player-to-score contest: rolling slate of current games + goal scorers.
// ---------------------------------------------------------------------------
async function fetchPlayerGames() {
  const now = Date.now();
  const fmt = (ms) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  };
  const from = fmt(now - PLAYER_GAMES_BACK_DAYS * 86400000);
  const to = fmt(now + PLAYER_GAMES_AHEAD_DAYS * 86400000);
  const res = await fetch(`${ESPN_SCOREBOARD}?dates=${from}-${to}`, { headers: UA });
  if (!res.ok) throw new Error(`ESPN scoreboard ${res.status}`);
  const data = await res.json();
  const teamIds = new Set();
  const games = [];
  for (const ev of data.events || []) {
    const g = buildPlayerGame(ev, teamIds);
    if (g) games.push(g);
  }
  games.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return { games, teamIds: [...teamIds] };
}

function buildPlayerGame(ev, teamIds) {
  const comp = (ev.competitions || [])[0] || {};
  const status = (comp.status && comp.status.type) || {};
  const competitors = comp.competitors || [];
  const home = competitors.find((c) => c.homeAway === "home") || competitors[0] || {};
  const away = competitors.find((c) => c.homeAway === "away") || competitors[1] || {};
  const h = playerSide(home), a = playerSide(away);
  // Need two real teams to pick a scorer; skip TBD/placeholder fixtures.
  if (h.placeholder || a.placeholder || !h.id || !a.id) return null;
  teamIds.add(h.id);
  teamIds.add(a.id);
  const state = (status.state || "pre").toLowerCase();
  return {
    id: String(ev.id),
    name: ev.shortName || ev.name || `${h.name} v ${a.name}`,
    date: ev.date,
    status: state === "in" ? "in" : state === "post" ? "post" : "pre",
    statusDetail: status.shortDetail || status.detail || status.description || "Scheduled",
    league: (ev.season && ev.season.slug) || "",
    home: h,
    away: a,
    scorers: parseScorers(comp),
  };
}

function playerSide(c) {
  const t = (c && c.team) || {};
  const name = t.displayName || "TBD";
  return {
    id: t.id != null ? String(t.id) : null,
    name,
    abbr: t.abbreviation || "",
    flag: t.logo || "",
    placeholder: isPlaceholder(name, t),
  };
}

// Goal scorers from ESPN scoring plays. Excludes penalty-shootout goals (they
// don't change the score line) and own goals (the player scored for the
// opponent, not "to score" in the prop sense). Deduped by athlete id.
function parseScorers(comp) {
  const out = [];
  const seen = new Set();
  for (const d of comp.details || []) {
    if (!d.scoringPlay || d.shootout || d.ownGoal) continue;
    const ath = (d.athletesInvolved || [])[0];
    if (!ath || ath.id == null) continue;
    const id = String(ath.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: ath.displayName || ath.fullName || ath.shortName || "Scorer",
      teamId: (ath.team && String(ath.team.id)) || (d.team && String(d.team.id)) || null,
    });
  }
  return out;
}

async function refreshRosters(env, teamIds) {
  const cache = (await readKv(env, "rosters")) || {};
  const now = Date.now();
  const todo = teamIds
    .filter((id) => !cache[id] || now - (cache[id].fetchedAt || 0) > ROSTER_TTL_MS)
    .slice(0, ROSTERS_PER_RUN);
  if (!todo.length) return cache;
  await Promise.all(todo.map(async (id) => {
    try {
      const r = await fetch(ESPN_TEAM_ROSTER(id), { headers: UA });
      if (!r.ok) return;
      const d = await r.json();
      const players = (d.athletes || [])
        .map((a) => ({ id: String(a.id), name: a.displayName || a.fullName }))
        .filter((p) => p.id && p.name);
      if (players.length) cache[id] = { fetchedAt: now, name: (d.team && d.team.displayName) || "", players };
    } catch (_) { /* leave any prior cache entry intact */ }
  }));
  await writeKv(env, "rosters", cache);
  return cache;
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

function json(obj, status = 200, extraHeaders = null) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return new Response(JSON.stringify(obj), { status, headers });
}
function normName(s) { return (s || "").trim().toLowerCase().replace(/\s+/g, " "); }
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
