# Takeoff evaluation harness (Phase 0)

Two diagnostic tools that let you *measure* the ingestion pipeline before changing
it — so any future speed or quality work can be proven instead of guessed.

| Tool | Question it answers | Lives in |
|---|---|---|
| **Timing (S7)** | *Where does the 10–15 min go?* | code instrumentation — see below |
| **Scorer (Q7)** | *Did we get all the rooms/signs — and the right counts?* | `score-takeoff.mjs` |
| **Converter** | *Turn an XLSX (AI export OR human golden copy) into scorer JSON* | `xlsx-to-json.py` |

> The fastest path to a baseline: export the AI takeoff as XLSX, get the human
> "golden copy" in the same XLSX layout, run **both** through `xlsx-to-json.py`,
> then score golden (expected) vs AI (actual). See "Quick start" below.

---

## 1. Timing — where the time goes (S7)

Per-call timing is now built into the pipeline (`artifacts/api-server/src/lib/timing.ts`).
Every **sidecar** HTTP call and every **Gemini** call is timed.

**On by default.** Disable with `PIPELINE_TIMING=false` in the api-server env.

### What you'll see
During a run, the api-server logs one line per call as it finishes:

```
[timing] sidecar/parse-index 8421ms {"timeoutMs":120000}
[timing] sidecar/rasterize 40213ms {"pages":3,"dpi":150}
[timing] gemini:gemini-2.5-pro 18342ms {"model":"gemini-2.5-pro"}
```

At the end of the job it logs an aggregate breakdown, e.g.:

```
[timing] ===== Job <id> breakdown — 712.4s tracked across 64 call(s) =====
[timing]   gemini:gemini-2.5-pro          31x  total   402.1s  avg  12970ms  max  41200ms
[timing]   sidecar/rasterize              12x  total   180.9s  avg  15075ms  max  40213ms
[timing]   sidecar/parse-index             6x  total    58.0s  avg   9667ms  max  18400ms
[timing]   gemini:gemini-2.5-flash         9x  total    41.3s  avg   4588ms  max   9100ms
```

The same summary is persisted to the DB at `jobs.metadata.timing` so you can read it
without scraping logs:

```sql
select metadata->'timing' from jobs where id = '<jobId>';
```

`metadata.timing` shape: `{ totalTrackedMs, callCount, byOp: [{ op, count, totalMs, avgMs, maxMs, failures }] }`.

> Note: "tracked" time only counts sidecar + Gemini calls (the two dominant buckets).
> CPU work between calls (dedup, rules engine) shows up as the gap between
> `metadata.steps[].durationMs` (already recorded) and `metadata.timing.totalTrackedMs`.

---

## Quick start — golden copy vs AI, from two XLSX files

If you already have the AI's XLSX export and a human "golden copy" XLSX in the same
layout (the app's Takeoff sheet: `Floor | Room # | Room Name | Sign Type | Size | Qty | …`):

```bash
# 1. convert both spreadsheets to scorer JSON (one tool, same format for both)
python3 scripts/takeoff-eval/xlsx-to-json.py golden_copy.xlsx -o golden.json
python3 scripts/takeoff-eval/xlsx-to-json.py ai_export.xlsx  -o ai.json

# 2. score: golden is the truth (expected), AI is what we produced (actual)
node scripts/takeoff-eval/score-takeoff.mjs -e golden.json -a ai.json
```

`xlsx-to-json.py` needs `openpyxl` (`pip install openpyxl`). It auto-detects the
header row, reads the **Takeoff** sheet, drops section/subtotal rows, and emits
`{ rooms, signs }`. A worked example (the Tower Dist AI export converted) lives at
`fixtures/tower-dist.ai.json`.

---

## 2. Scorer — did we extract the right things AND the right counts (Q7)

`score-takeoff.mjs` compares **what the pipeline extracted** against **a hand-labelled
ground truth** and reports, in four sections:

1. **ROOMS** — precision / recall / F1, plus rooms missed and hallucinated.
2. **SIGNS (presence)** — same, keyed on `roomNumber|signType`. "Did we find the
   right *kinds* of signs in the right rooms?"
3. **SIGN QUANTITIES** — for items present in both, does the **count** match? Lists
   the biggest qty mismatches (e.g. `101C|UNIT ID expected 3, got 1`). Presence F1
   is blind to counts; this is where under/over-quoting shows up.
4. **BY SIGN TYPE** — total qty per sign type (expected vs got vs delta), the same
   view as the export's Summary sheet — the number a customer actually quotes from.

### Step A — label ~10 PDFs by hand (the ground truth)
For each test PDF, open it and write down the rooms and signs that *should* be found.
Save one file per job, e.g. `fixtures/job-acme.expected.json` (see `example.expected.json`):

```json
{
  "rooms": [{ "roomNumber": "101", "roomName": "LOBBY", "level": "1" }],
  "signs": [{ "roomNumber": "101", "signType": "Room ID", "qty": 1 }]
}
```

### Step B — capture what the pipeline actually extracted
Run the pipeline on that PDF, then fetch the results from the API (both routes require
the same auth header the web app uses — copy the `Authorization` bearer token from your
browser devtools):

```bash
# rooms
curl -s -H "Authorization: Bearer <token>" \
  http://localhost:3001/api/jobs/<jobId>/rooms > job-acme.rooms.json
# signs
curl -s -H "Authorization: Bearer <token>" \
  http://localhost:3001/api/jobs/<jobId>/signs > job-acme.signs.json
```

The scorer accepts a bare array OR a `{rooms,signs}` object OR a `{data:[...]}` envelope,
so you can either point it at the two raw files separately or stitch them into one:

```json
{ "rooms": [ ...contents of job-acme.rooms.json... ],
  "signs": [ ...contents of job-acme.signs.json... ] }
```

### Step C — score
```bash
node scripts/takeoff-eval/score-takeoff.mjs \
  --expected scripts/takeoff-eval/fixtures/job-acme.expected.json \
  --actual   scripts/takeoff-eval/job-acme.actual.json
```

Output:
```
── ROOMS ───────────────────────────────────────────
  expected: 42   extracted: 39
  matched (TP): 37   missed (FN): 5   extra (FP): 2
  precision: 94.9%   recall: 88.1%   F1: 91.4%
  MISSED (in truth, not extracted) — quality gap:
    - 217   "STORAGE"
    - 219A  "JAN. CLOSET"
    …
```

Run it **before** and **after** a change to the same fixtures: recall going up = catching
more items; precision going up = fewer false positives.

---

## How this maps to the roadmap
- These two tools **are** Phase 0. They unblock the later phases (concurrency, retries,
  room-recognition, model A/B) by making every change measurable.
- Matching is intentionally simple (normalized `roomNumber`, and `roomNumber|signType`).
  If your PDFs use non-numeric room IDs, that's itself a finding — it's exactly the
  "broaden room recognition" quality gap (Q3) the roadmap calls out.
