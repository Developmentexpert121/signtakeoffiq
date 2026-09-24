#!/usr/bin/env node
/**
 * score-takeoff.mjs — Phase 0 / "Q7" extraction scorer.
 *
 * Compares what the pipeline EXTRACTED for a job against a hand-labelled
 * ground-truth, and prints precision / recall / F1 for rooms and signs plus the
 * specific items that were missed or hallucinated. This is the "did we get all
 * the items correctly?" measuring stick — run it before and after any quality
 * change so improvements (or regressions) are objective instead of vibes.
 *
 * Zero dependencies. Pure Node ESM. Compares two JSON files.
 *
 * Usage:
 *   node scripts/takeoff-eval/score-takeoff.mjs --expected <expected.json> --actual <actual.json>
 *   node scripts/takeoff-eval/score-takeoff.mjs -e fixtures/foo.expected.json -a foo.actual.json
 *   node scripts/takeoff-eval/score-takeoff.mjs --help
 *
 * See README.md in this folder for the file formats and how to capture an
 * actual.json from the running API.
 */

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { expected: null, actual: null, limit: 25 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--expected" || a === "-e") out.expected = argv[++i];
    else if (a === "--actual" || a === "-a") out.actual = argv[++i];
    else if (a === "--limit" || a === "-l") out.limit = Number(argv[++i]) || 25;
  }
  return out;
}

const HELP = `score-takeoff — compare extracted takeoff vs hand-labelled truth

  --expected, -e   Path to ground-truth JSON (rooms + signs you verified by hand)
  --actual,   -a   Path to extracted JSON (from the API or a DB dump)
  --limit,    -l   Max missed/extra items to list per category (default 25)
  --help,     -h   This help

Both files may be either:
  { "rooms": [...], "signs": [...] }            (preferred — one job)
  or a bare array of rooms                       (then pass signs separately)

Room object   : { "roomNumber": "101", "roomName": "OFFICE", "level": "1" }
Sign object   : { "roomNumber": "101", "signType": "Room ID", "qty": 1 }

Matching keys :
  rooms  -> normalized roomNumber (falls back to roomName when no number)
  signs  -> normalized roomNumber + "|" + normalized signType
`;

// ---------------------------------------------------------------------------
// normalisation + extraction of lists from varied shapes
// ---------------------------------------------------------------------------
const norm = (v) => String(v ?? "").trim().toUpperCase().replace(/\s+/g, " ");

function asList(json, key) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json[key])) return json[key];
  if (json && Array.isArray(json.data)) return json.data; // common API envelope
  if (json && json[key] && Array.isArray(json[key].data)) return json[key].data;
  return [];
}

function roomKey(r) {
  const num = norm(r.roomNumber ?? r.room_number ?? r.number);
  if (num) return num;
  return `NAME:${norm(r.roomName ?? r.room_name ?? r.name)}`;
}

function signKey(s) {
  const num = norm(s.roomNumber ?? s.room_number ?? s.number);
  const type = norm(s.signType ?? s.sign_type ?? s.type);
  return `${num}|${type}`;
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------
function score(expectedList, actualList, keyFn) {
  const expByKey = new Map();
  for (const e of expectedList) {
    const k = keyFn(e);
    if (k && k !== "|" && !k.startsWith("NAME:NAME")) expByKey.set(k, e);
  }
  const actByKey = new Map();
  for (const a of actualList) {
    const k = keyFn(a);
    if (k && k !== "|") actByKey.set(k, a);
  }

  const truePos = [];
  const missed = []; // in expected, not in actual (false negatives)
  const extra = []; // in actual, not in expected (false positives)

  for (const [k, e] of expByKey) {
    if (actByKey.has(k)) truePos.push(k);
    else missed.push({ key: k, item: e });
  }
  for (const [k, a] of actByKey) {
    if (!expByKey.has(k)) extra.push({ key: k, item: a });
  }

  const tp = truePos.length;
  const fn = missed.length;
  const fp = extra.length;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    expectedCount: expByKey.size,
    actualCount: actByKey.size,
    tp, fp, fn, precision, recall, f1, missed, extra,
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

// ---------------------------------------------------------------------------
// quantity scoring — the presence/absence F1 above is blind to counts.
// A takeoff that finds "Unit ID in room 204" but says qty=1 when the human
// says qty=3 scores a perfect TP above, yet under-quotes the job. These
// functions compare the actual numbers.
// ---------------------------------------------------------------------------
function signQty(s) {
  const q = Number(s.qty ?? s.quantity ?? 1);
  return Number.isFinite(q) ? q : 1;
}

// Sum qty per key (rows with the same room|signType collapse, qtys add).
function aggregateQty(list, keyFn) {
  const m = new Map();
  for (const it of list) {
    const k = keyFn(it);
    if (!k || k === "|") continue;
    const prev = m.get(k);
    if (prev) prev.qty += signQty(it);
    else m.set(k, { qty: signQty(it), item: it });
  }
  return m;
}

function scoreQty(expectedList, actualList, keyFn) {
  const exp = aggregateQty(expectedList, keyFn);
  const act = aggregateQty(actualList, keyFn);
  let expTotal = 0, actTotal = 0, qtyExact = 0, qtyOff = 0;
  const mismatches = [];
  for (const [, v] of exp) expTotal += v.qty;
  for (const [, v] of act) actTotal += v.qty;
  for (const [k, e] of exp) {
    if (!act.has(k)) continue; // missing items already shown as FN above
    const a = act.get(k);
    if (a.qty === e.qty) qtyExact++;
    else { qtyOff++; mismatches.push({ key: k, expected: e.qty, actual: a.qty, item: e.item }); }
  }
  return { expTotal, actTotal, qtyExact, qtyOff, mismatches };
}

// Roll up total qty per sign type — mirrors the export's Summary sheet, the
// view a customer actually quotes from ("how many Exit signs total?").
function rollupByType(list) {
  const m = new Map();
  for (const it of list) {
    const t = norm(it.signType ?? it.sign_type ?? it.type);
    if (!t) continue;
    m.set(t, (m.get(t) || 0) + signQty(it));
  }
  return m;
}

function printQtySection(qs, limit) {
  console.log(`\n── SIGN QUANTITIES ─────────────────────────────────────`);
  console.log(`  total qty  expected: ${qs.expTotal}   extracted: ${qs.actTotal}   delta: ${qs.actTotal - qs.expTotal >= 0 ? "+" : ""}${qs.actTotal - qs.expTotal}`);
  const matchedKeys = qs.qtyExact + qs.qtyOff;
  const qtyAcc = matchedKeys === 0 ? 1 : qs.qtyExact / matchedKeys;
  console.log(`  of matched items: ${qs.qtyExact} exact qty, ${qs.qtyOff} wrong qty  (qty accuracy ${pct(qtyAcc)})`);
  if (qs.mismatches.length) {
    console.log(`  QTY MISMATCHES (matched item, wrong count):`);
    const sorted = [...qs.mismatches].sort((a, b) => Math.abs(b.actual - b.expected) - Math.abs(a.actual - a.expected));
    for (const m of sorted.slice(0, limit)) {
      const d = m.actual - m.expected;
      console.log(`    - ${m.key}  expected ${m.expected}, got ${m.actual}  (${d >= 0 ? "+" : ""}${d})  ${summarize(m.item)}`);
    }
    if (sorted.length > limit) console.log(`    … and ${sorted.length - limit} more`);
  }
}

function printByTypeSection(expSigns, actSigns) {
  const exp = rollupByType(expSigns);
  const act = rollupByType(actSigns);
  const types = [...new Set([...exp.keys(), ...act.keys()])].sort();
  console.log(`\n── BY SIGN TYPE (total qty) ────────────────────────────`);
  console.log(`  ${"sign type".padEnd(28)} ${"expected".padStart(9)} ${"got".padStart(7)} ${"delta".padStart(7)}`);
  for (const t of types) {
    const e = exp.get(t) || 0;
    const a = act.get(t) || 0;
    const d = a - e;
    const flag = d === 0 ? "" : "  <-- diff";
    console.log(`  ${t.slice(0, 28).padEnd(28)} ${String(e).padStart(9)} ${String(a).padStart(7)} ${(d >= 0 ? "+" : "") + d}`.padEnd(56) + flag);
  }
}

function printSection(title, r, limit) {
  console.log(`\n── ${title} ───────────────────────────────────────────`);
  console.log(`  expected: ${r.expectedCount}   extracted: ${r.actualCount}`);
  console.log(`  matched (TP): ${r.tp}   missed (FN): ${r.fn}   extra (FP): ${r.fp}`);
  console.log(`  precision: ${pct(r.precision)}   recall: ${pct(r.recall)}   F1: ${pct(r.f1)}`);
  if (r.missed.length) {
    console.log(`  MISSED (in truth, not extracted) — quality gap:`);
    for (const m of r.missed.slice(0, limit)) {
      console.log(`    - ${m.key}  ${summarize(m.item)}`);
    }
    if (r.missed.length > limit) console.log(`    … and ${r.missed.length - limit} more`);
  }
  if (r.extra.length) {
    console.log(`  EXTRA (extracted, not in truth) — possible false positives:`);
    for (const x of r.extra.slice(0, limit)) {
      console.log(`    - ${x.key}  ${summarize(x.item)}`);
    }
    if (r.extra.length > limit) console.log(`    … and ${r.extra.length - limit} more`);
  }
}

function summarize(item) {
  const name = item.roomName ?? item.room_name ?? item.name;
  const type = item.signType ?? item.sign_type ?? item.type;
  const bits = [];
  if (name) bits.push(`"${name}"`);
  if (type) bits.push(type);
  if (item.qty != null) bits.push(`qty=${item.qty}`);
  return bits.join(" ");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.expected || !args.actual) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  let expected, actual;
  try {
    expected = JSON.parse(readFileSync(args.expected, "utf8"));
    actual = JSON.parse(readFileSync(args.actual, "utf8"));
  } catch (err) {
    console.error(`Failed to read/parse input: ${err.message}`);
    process.exit(1);
  }

  const expRooms = asList(expected, "rooms");
  const actRooms = asList(actual, "rooms");
  const expSigns = asList(expected, "signs");
  const actSigns = asList(actual, "signs");

  console.log(`\n=== Takeoff extraction score ===`);
  console.log(`expected: ${args.expected}`);
  console.log(`actual:   ${args.actual}`);

  const roomScore = score(expRooms, actRooms, roomKey);
  printSection("ROOMS", roomScore, args.limit);

  if (expSigns.length || actSigns.length) {
    const signScore = score(expSigns, actSigns, signKey);
    printSection("SIGNS (presence: room|type)", signScore, args.limit);

    const qtyScore = scoreQty(expSigns, actSigns, signKey);
    printQtySection(qtyScore, args.limit);
    printByTypeSection(expSigns, actSigns);

    console.log(`\n── OVERALL ─────────────────────────────────────────────`);
    console.log(`  rooms  F1 ${pct(roomScore.f1)}   recall ${pct(roomScore.recall)}`);
    console.log(`  signs  F1 ${pct(signScore.f1)}   recall ${pct(signScore.recall)}`);
    const totalDelta = qtyScore.actTotal - qtyScore.expTotal;
    console.log(`  total sign qty  expected ${qtyScore.expTotal}  got ${qtyScore.actTotal}  (${totalDelta >= 0 ? "+" : ""}${totalDelta})`);
  } else {
    console.log(`\n(no signs in either file — scored rooms only)`);
  }
  console.log("");
}

main();
