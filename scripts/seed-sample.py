#!/usr/bin/env python3
"""Fetch the live ESPN World Cup knockout data and write data/scores.sample.json.

This mirrors the Worker's scheduled handler (src/worker.js → refreshScores) so
you can eyeball the normalized snapshot, and so the site has something to render
when previewing locally before the Worker's cron has run for real.

Usage:  python scripts/seed-sample.py
"""
import json, re, sys, urllib.request
from pathlib import Path

UA = {"User-Agent": "nettzone-wc-pool/1.0"}
SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260628-20260720"
OUT = Path(__file__).resolve().parent.parent / "data" / "scores.sample.json"

# event id -> FIFA match number (R32 73-88, R16 89-96, QF 97-100, SF 101-102,
# 3rd 103, Final 104). Same map the Worker hardcodes.
KNOWN = {"760486":73,"760489":74,"760488":75,"760487":76,"760492":77,"760490":78,
"760491":79,"760495":80,"760494":81,"760493":82,"760496":83,"760497":84,"760498":85,
"760500":86,"760501":87,"760499":88,"760503":89,"760502":90,"760504":91,"760505":92,
"760506":93,"760507":94,"760509":95,"760508":96,"760510":97,"760511":98,"760512":99,
"760513":100,"760514":101,"760515":102,"760516":103,"760517":104}
ROUNDS = [("R32","Round of 32","round-of-32",1,72,16),("R16","Round of 16","round-of-16",2,88,8),
("QF","Quarterfinals","quarterfinals",4,96,4),("SF","Semifinals","semifinals",8,100,2),
("F","Final","final",16,103,1)]
BY_SLUG = {r[2]: r for r in ROUNDS}
FEEDERS = {"R16":{1:[5,2],2:[3,1],3:[6,4],4:[8,7],5:[12,11],6:[10,9],7:[16,14],8:[15,13]},
"QF":{1:[2,1],2:[6,5],3:[4,3],4:[8,7]},"SF":{1:[2,1],2:[4,3]},"F":{1:[2,1]}}


def placeholder(name, team):
    if not team or team.get("id") is None:
        return True
    if re.search(r"winner|loser|place|group\s|runner|third", name, re.I):
        return True
    logo = team.get("logo")
    return not logo or "/countries/" not in logo


def build(ev, num, rnd):
    comp = ev["competitions"][0]
    st = comp["status"]["type"]
    comps = comp["competitors"]
    home = next((c for c in comps if c.get("homeAway") == "home"), comps[0])
    away = next((c for c in comps if c.get("homeAway") == "away"), comps[1])

    def side(c):
        t = c.get("team", {})
        name = t.get("displayName", "TBD")
        return {"id": str(t["id"]) if t.get("id") is not None else None, "name": name,
                "abbr": t.get("abbreviation", ""), "flag": t.get("logo", ""),
                "score": (int(float(c["score"])) if c.get("score") not in (None, "") else None),
                "placeholder": placeholder(name, t)}

    h, a = side(home), side(away)
    state = (st.get("state") or "pre").lower()
    win = None
    if state == "post":
        win = h["id"] if home.get("winner") else a["id"] if away.get("winner") else None
    return {"id": str(ev["id"]), "matchNumber": num, "round": rnd[0], "roundLabel": rnd[1],
            "slot": num - rnd[4], "date": ev["date"],
            "status": "in" if state == "in" else "post" if state == "post" else "pre",
            "statusDetail": st.get("shortDetail") or "Scheduled", "home": h, "away": a, "winnerId": win}


def main():
    data = json.load(urllib.request.urlopen(urllib.request.Request(SCOREBOARD, headers=UA), timeout=40))
    matches, teams = [], {}
    for ev in data.get("events", []):
        slug = (ev.get("season") or {}).get("slug", "")
        if slug not in BY_SLUG:
            continue
        num = KNOWN.get(str(ev["id"]))
        if not num:
            print("UNKNOWN EVENT", ev["id"], slug, ev["name"], file=sys.stderr)
            continue
        m = build(ev, num, BY_SLUG[slug])
        matches.append(m)
        for s in (m["home"], m["away"]):
            if s["id"] and not s["placeholder"]:
                teams[s["id"]] = {"id": s["id"], "name": s["name"], "abbr": s["abbr"], "flag": s["flag"]}
    matches.sort(key=lambda m: m["matchNumber"])

    # Third-place playoff (bonus contest), built separately.
    third = None
    tp = next((e for e in data.get("events", []) if (e.get("season") or {}).get("slug") == "3rd-place-match"), None)
    if tp and KNOWN.get(str(tp["id"])):
        third = build(tp, KNOWN[str(tp["id"])], ("3P", "Third-place playoff", "3rd-place-match", 0, 102, 1))
        for s in (third["home"], third["away"]):
            if s["id"] and not s["placeholder"]:
                teams[s["id"]] = {"id": s["id"], "name": s["name"], "abbr": s["abbr"], "flag": s["flag"]}

    r32 = [m for m in matches if m["round"] == "R32"]
    ready = len(r32) == 16 and all(not m["home"]["placeholder"] and not m["away"]["placeholder"] for m in r32)
    cutoff = min((m["date"] for m in r32), default=None)
    snap = {
        "tournament": {"name": "FIFA World Cup 2026", "season": 2026,
                       "stage": "knockout" if r32 else "group", "bracketReady": ready,
                       "bracketCutoff": cutoff, "live": any(m["status"] == "in" for m in matches),
                       "complete": bool(matches) and all(m["status"] == "post" for m in matches),
                       "lastUpdated": "sample"},
        "rounds": [{"key": r[0], "label": r[1], "points": r[3], "count": r[5]} for r in ROUNDS],
        "feeders": FEEDERS, "matches": matches, "thirdPlace": third,
        "teams": sorted(teams.values(), key=lambda t: t["name"]), "bracketReady": ready}
    OUT.write_text(json.dumps(snap, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {OUT.name}: {len(matches)} matches, {len(teams)} real teams, "
          f"bracketReady={ready}, cutoff={cutoff}")


if __name__ == "__main__":
    main()
