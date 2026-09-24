Do the following steps in exact order. Do not skip any step.

---

**STEP 1 — Check if the source fix is saved**

Run:
```
grep "ROOM_NUMBER_RE" artifacts/api-server/src/lib/pipeline.ts
```

If output still contains `\d{3,4}` → fix was NOT saved, go to STEP 2.
If output contains `1[0-4]` → fix IS saved, skip to STEP 3.

---

**STEP 2 — Apply the fix now (only if Step 1 shows old regex)**

Open `artifacts/api-server/src/lib/pipeline.ts` and make these 3 edits:

**Edit 1** — Find and replace this exact line:
```
export const ROOM_NUMBER_RE = /^(\d{3,4}[A-Z]?|[A-Z]\d{3}[A-Z]?)$/;
```
With:
```
export const ROOM_NUMBER_RE = /^(\d{3}[A-Z]?|1[0-4]\d{2}[A-Z]?\.?\d?|2[0-4]\d{2}[A-Z]?\.?\d?|[A-Z]{1,2}P?\d?-\d{3}[A-Z]?|[A-Z]\d{3}[A-Z]?)$/;
const YEAR_RE = /^(19|20)\d{2}$/;
```

**Edit 2** — Inside `extractRoomsFromWords`, find:
```
    if (!ROOM_NUMBER_RE.test(word.text)) continue;
    if (usedIndices.has(i)) continue;

    const roomNumber = word.text;
    const rx = word.x0;
    const ry = word.y0;
```
Replace with:
```
    if (!ROOM_NUMBER_RE.test(word.text)) continue;
    if (YEAR_RE.test(word.text)) continue;
    if (usedIndices.has(i)) continue;

    const roomNumber = word.text;
    const rx = word.x0;
    const ry = word.y0;

    if (rx > pageWidth * 0.78 || ry > pageHeight * 0.88) continue;
```

**Edit 3** — Inside the same function, find:
```
    const roomName = rawName ? expandSynonyms(rawName) : `ROOM ${roomNumber}`;
```
Replace with:
```
    const isAddressLike = rawName.includes(",") ||
      /\b(AVE|BLVD|ST\b|RD\b|MA\b|NY\b|CA\b|COPYRIGHT|JACOBS|CORPS|DRAWING)\b/.test(rawName);
    if (isAddressLike) continue;

    const roomName = rawName ? expandSynonyms(rawName) : `ROOM ${roomNumber}`;
```

---

**STEP 3 — Rebuild the compiled output**

Run:
```
cd artifacts/api-server && pnpm run build 2>&1 | tail -5
```

Must complete with no TypeScript errors. The dist/index.mjs file must be updated.

---

**STEP 4 — Restart the API server so it loads the new build**

Run:
```
pkill -f "dist/index.mjs" 2>/dev/null; sleep 2; cd /home/runner/workspace/artifacts/api-server && node --enable-source-maps ./dist/index.mjs &
```

Then verify:
```
curl -s http://localhost:8080/healthz
```

Must return `{"status":"ok"}`.

---

**STEP 5 — Confirm all 4 fixes are present in source**

Run:
```
grep -c "YEAR_RE\|titleBlock\|isAddressLike\|1\[0-4\]" artifacts/api-server/src/lib/pipeline.ts
```

Must return `4`. If less than 4, some edits are missing — recheck Step 2.

---

**STEP 6 — Reset the test job and trigger reprocess**

Run:
```
echo "SELECT id, name FROM jobs ORDER BY created_at DESC LIMIT 3;" | psql $DATABASE_URL
```

Then reset the most recent job status so it can be reprocessed via the UI Rescan button:
```
echo "UPDATE jobs SET status='completed', total_signs=0 WHERE name='Test 2';" | psql $DATABASE_URL
echo "DELETE FROM rooms WHERE job_id IN (SELECT id FROM jobs WHERE name='Test 2');" | psql $DATABASE_URL
echo "DELETE FROM signs WHERE job_id IN (SELECT id FROM jobs WHERE name='Test 2');" | psql $DATABASE_URL
```

Now go to the app UI and click **Rescan** on the Test 2 job.

---

**EXPECTED RESULTS**

SOF 7087 / Test 2 job after rescan:
- Rooms tab: ~90 rooms with IDs like 1100, 1101, 1119, 2100, 2102
- Sign Schedule: ~123 signs populated
- Floor Plan: markers visible on the plan image
- Total Signs counter: non-zero
