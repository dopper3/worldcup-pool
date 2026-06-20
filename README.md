# Nettzone World Cup Pool

A tiny, self-hosted World Cup 2026 **knockout pool** — no Google Forms, no
spreadsheets, no servers to babysit. Friends submit picks straight from the
site; scores refresh themselves from ESPN every few minutes. The whole thing
runs on **one Cloudflare Worker** (free tier) with a **D1** database, served
from your own domain.

It's the spiritual successor to the [PGA pool](https://github.com/dopper3/pga-pool),
rebuilt to remove the single biggest source of friction in that design: the
Google Form.

---

## The format

Three contests, **knockout stage only** (Round of 32 → Final). Enter any mix.

### Contest 1 — Bracket · `$40`
Fill in the entire knockout bracket: pick the winner of every match from the
Round of 32 to the Final. Points escalate each round:

| Round | Matches | Points / correct pick | Round max |
|-------|--------:|----------------------:|----------:|
| Round of 32 | 16 | 1 | 16 |
| Round of 16 | 8 | 2 | 16 |
| Quarterfinals | 4 | 4 | 16 |
| Semifinals | 2 | 8 | 16 |
| Final | 1 | 16 | 16 |
| **Total** | | | **80** |

A pick only scores if that team **actually wins in that round** — so a busted
pick takes its whole branch down with it (standard bracket behaviour). Plus two
bonuses: **+5** for the exact final scoreline, **+5** for the correct Golden
Boot (top scorer, settled manually at the end). The bracket **locks at the
first Round of 32 kickoff**.

### Contest 2 — Match picks · `$10`
Predict the final score of each knockout match. **Exact score = 3 pts**, right
result (W/D/L) only = **1 pt**. Each match locks at its own kickoff, and nobody
can see anyone else's pick for a match until it kicks off. Predict as many or as
few matches as you like.

### Bonus — Third-place playoff · `$5`
Predict the score of the 3rd-place playoff (the two losing semifinalists). Same
scoring as match picks (exact = 3, right result = 1), **winner takes all** (ties
split). Locks at that match's kickoff.

### Payouts & settlement
Bracket and Match picks pay **1st 70% / 2nd 30%, 3rd gets their entry back**
(winner-take-all under 3 entries); the Third-place bonus is winner-take-all. The
**Results** tab computes live projected payouts across all three contests, each
player's net balance, and the **minimum set of transfers** to settle up — the
same settlement engine as the PGA pool.

---

## Why this is better than the PGA pool's design

The PGA pool worked, but entry flow had real friction. This rebuild fixes it:

| | PGA pool (old) | World Cup pool (new) |
|---|---|---|
| **Submitting an entry** | Site pre-fills a **Google Form** in a new tab → you click submit on the form → a GitHub Action polls a published-CSV of the linked Sheet every 5 min → commits `entries.json`. | Native on-site form **POSTs straight to the Worker** → lands in D1 **instantly**. No second tab, no 5-minute lag. |
| **Setup** | Create a Google Form, link a Sheet, publish as CSV, copy entry IDs, set repo variables, hardcode form URLs in JS. | None. The form is just part of the site. |
| **Pick privacy** | Picks lived in a public repo file; hidden only by client-side JS. | Server **withholds** everyone's picks until lock (bracket) / kickoff (per match). Can't be scraped early. |
| **Scores** | GitHub Action cron → commits JSON to the repo. | Cloudflare **Cron Trigger** → D1. No commit noise, no Actions minutes. |
| **Hosting** | GitHub Pages. | Cloudflare Pages-class hosting on **your own domain**, same origin as the API (zero CORS). |
| **Moving parts** | GitHub Pages + GitHub Actions (×3) + Google Forms + Google Sheets. | One Worker. One database. |

Everything stays **free** and the repo is still the source of truth.

---

## Architecture

```
                          ┌──────────────────────────────────────┐
   Browser  ──────────▶   │            Cloudflare Worker          │
   (your domain)          │                                      │
                          │  fetch()  ─ serves /public (static)   │
                          │           ─ /api/* JSON endpoints  ───┼──▶  D1 (SQLite)
                          │                                      │     • kv['scores']
   ESPN fifa.world  ◀─────┤  scheduled()  cron every 3 min        │     • brackets
   (knockout API)         │           ─ fetch + normalize  ──────┼──▶  • predictions
                          └──────────────────────────────────────┘
```

- **`src/worker.js`** — the entire backend.
  - `fetch`: serves the static site (`env.ASSETS`) and the JSON API.
  - `scheduled`: pulls the ESPN knockout scoreboard, reconstructs the bracket
    (match numbers 73–104, with the exact feeder map ESPN encodes in its event
    names), and writes a normalized snapshot to `kv['scores']`.
- **`public/`** — the static site: `index.html`, `assets/app.js` (renderer +
  scoring + pickers + settlement), `assets/style.css`.
- **`schema.sql`** — the three D1 tables (`kv`, `brackets`, `predictions`).
- **`scripts/seed-sample.py`** — mirrors the Worker's fetch so you can inspect a
  real snapshot (`data/scores.sample.json`) without deploying.

### API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/scores` | Normalized ESPN snapshot (matches, bracket tree, teams). |
| `GET` | `/api/brackets` | Bracket entries. Picks hidden until the bracket locks. |
| `POST` | `/api/bracket` | Submit/replace a bracket (validated against the real draw). |
| `GET` | `/api/predictions` | Match predictions. Each hidden until its match kicks off. |
| `POST` | `/api/prediction` | Submit/replace one match-score prediction. |
| `POST` | `/api/refresh` | Manually trigger a score refresh (handy right after deploy). |

Entries dedupe by **display name** (case-insensitive) — latest submission wins,
exactly like the PGA pool.

---

## One-time deploy

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and
Node installed (for the `wrangler` CLI). ~10 minutes, all free tier.

```bash
# 1. Install the CLI and log in
npm install                       # installs wrangler locally
npx wrangler login                # opens a browser to authorize

# 2. Create the D1 database, then paste the printed database_id into wrangler.toml
npx wrangler d1 create wc-pool
#   → copy "database_id = ..." into the [[d1_databases]] block in wrangler.toml

# 3. Create the tables
npm run db:init                   # wrangler d1 execute wc-pool --file=schema.sql --remote

# 4. Deploy the Worker (site + API + cron, all in one)
npm run deploy

# 5. Populate scores once immediately (the cron will keep it fresh after this)
curl -X POST https://wc-pool.<your-subdomain>.workers.dev/api/refresh
```

### Put it on your own domain
In the Cloudflare dashboard: **Workers & Pages → wc-pool → Settings → Domains &
Routes → Add → Custom domain**, and enter e.g. `worldcup.yourdomain.com`. If the
domain's DNS is already on Cloudflare this is one click and HTTPS is automatic.

That's it. The cron trigger refreshes scores every 3 minutes; the bracket picker
opens automatically once the group stage finishes and the Round of 32 matchups
are known, and locks itself at the first R32 kickoff.

### Local preview
```bash
npm run db:init:local                    # create tables in the local D1
npx wrangler dev                         # serves on http://localhost:8787
curl -X POST http://localhost:8787/api/refresh   # pull live ESPN data into local D1
```

---

## Tweakable constants

| Where | What |
|---|---|
| `public/assets/app.js` top | `FEES`, `ROUND_POINTS`, `BONUS_FINAL_SCORE`, `EXACT_POINTS`, `RESULT_POINTS` |
| `src/worker.js` `ROUNDS` | Per-round point values (must match `app.js`) |
| `src/worker.js` `FEEDERS` | Bracket adjacency (fixed for 2026 — don't touch unless FIFA reseeds) |
| `wrangler.toml` `[triggers]` | Cron cadence for the score fetch |

> **Note on timing:** the 2026 World Cup group stage runs to ~June 27, with the
> Round of 32 starting June 28 and the Final on July 19. The bracket can only be
> filled once the R32 matchups are set, so the bracket picker stays closed (with
> an explanatory message) until then and the match-picks game runs throughout.

---

## How scoring stays fair without trusting the bracket diagram

Bracket points are awarded by **round-level intersection**: for each round, you
score for every team you advanced that actually won its match that round. This
is robust to ESPN data quirks and naturally self-correcting — a team can only
appear in your "Round-of-16 winners" if you advanced it there, and only scores
if it truly won in the Round of 16. The feeder map (which R32 winners meet in
which R16 slot) is taken straight from ESPN's own bracket, so the picker mirrors
the real draw.
