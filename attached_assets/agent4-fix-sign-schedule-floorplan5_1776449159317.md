The Sign Schedule tab shows "Sign Schedule Data Grid" placeholder text but renders no data, even though 178 signs exist in the database. This is a frontend rendering bug.

**STEP 1 — Find the Sign Schedule component**

Run:
```
grep -rn "Sign Schedule Data Grid\|SignSchedule\|sign-schedule\|sign_schedule" artifacts/web/src --include="*.tsx" --include="*.ts" | head -20
```

Open the component file that contains "Sign Schedule Data Grid".

**STEP 2 — Diagnose why it's blank**

The most common causes are:

A) The component is rendering a placeholder instead of the real grid
B) The API call to fetch signs is failing or returning empty
C) The data grid library failed to load
D) Signs are fetched but the component has a conditional that prevents rendering

Check which API endpoint the component calls to fetch signs:
```
grep -rn "useQuery\|fetch\|api.*sign\|signs.*api\|/signs\|/api/jobs" artifacts/web/src --include="*.tsx" | grep -i "sign" | head -15
```

**STEP 3 — Verify signs exist in the database**

Run:
```
echo "SELECT count(*), job_id FROM signs GROUP BY job_id;" | psql $DATABASE_URL
```

Then check the API returns them:
```
curl -s "http://localhost:8080/api/jobs/$(echo "SELECT id FROM jobs WHERE name='Test 2';" | psql $DATABASE_URL -t | tr -d ' ')/signs" | head -100
```

If the API returns 401 → the frontend needs auth. If it returns signs → the bug is in the component.

**STEP 4 — Fix the component**

Look at the Sign Schedule component. It likely has one of these issues:

Issue A — Placeholder never replaced:
The component contains a `<div>Sign Schedule Data Grid</div>` placeholder that was never replaced with real code. Replace it with a working table:

```tsx
// Replace the placeholder with this working sign table
const SignScheduleTab = ({ jobId }: { jobId: string }) => {
  const { data: signs, isLoading } = useQuery({
    queryKey: ['signs', jobId],
    queryFn: () => fetch(`/api/jobs/${jobId}/signs`, {
      headers: { Authorization: `Bearer ${await getToken()}` }
    }).then(r => r.json())
  });

  if (isLoading) return <div className="text-gray-400 p-8">Loading signs...</div>;
  if (!signs?.length) return <div className="text-gray-400 p-8">No signs found</div>;

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-700 text-gray-400 text-left">
            <th className="p-3">Sign ID</th>
            <th className="p-3">Room #</th>
            <th className="p-3">Room Name</th>
            <th className="p-3">Sign Type</th>
            <th className="p-3">Quantity</th>
            <th className="p-3">Confidence</th>
            <th className="p-3">Source</th>
            <th className="p-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {signs.map((sign: any) => (
            <tr key={sign.id} className="border-b border-gray-800 hover:bg-gray-800/50">
              <td className="p-3 font-mono text-xs text-gray-400">{sign.signId || sign.id?.slice(-6)}</td>
              <td className="p-3 font-mono">{sign.roomNumber}</td>
              <td className="p-3">{sign.roomName}</td>
              <td className="p-3">
                <span className="px-2 py-0.5 rounded text-xs bg-amber-500/20 text-amber-400 font-mono">
                  {sign.signType}
                </span>
              </td>
              <td className="p-3 text-center">{sign.quantity ?? 1}</td>
              <td className="p-3">
                <span className={`px-2 py-0.5 rounded text-xs ${
                  (sign.confidence ?? 0) >= 85 ? 'bg-green-500/20 text-green-400' :
                  (sign.confidence ?? 0) >= 70 ? 'bg-yellow-500/20 text-yellow-400' :
                  'bg-red-500/20 text-red-400'
                }`}>
                  {sign.confidence ?? 0}%
                </span>
              </td>
              <td className="p-3 text-xs text-gray-400">{sign.source}</td>
              <td className="p-3 text-xs text-gray-400">{sign.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
```

Issue B — API route missing:
If `GET /api/jobs/:jobId/signs` returns 404, add the route in `artifacts/api-server/src/routes/signs.ts`:
```typescript
router.get('/:jobId/signs', requireTenantAuth, async (req, res) => {
  const signs = await db.query.signsTable.findMany({
    where: and(
      eq(signsTable.jobId, req.params.jobId),
      eq(signsTable.tenantId, req.tenantId)
    ),
    orderBy: [asc(signsTable.roomNumber)]
  });
  res.json(signs);
});
```

**STEP 5 — Also fix Floor Plan tab (blank white canvas)**

The Floor Plan tab shows a blank white canvas with 0 markers. Check if sheets have rasterized paths:
```
echo "SELECT sheet_id, sheet_type, rasterized_path IS NOT NULL as has_image FROM job_sheets WHERE job_id IN (SELECT id FROM jobs WHERE name='Test 2') LIMIT 10;" | psql $DATABASE_URL
```

If `has_image` is false for all rows → rasterization is saving NULL paths. Find and fix the rasterize step in `pipeline.ts` to ensure the PNG is uploaded to storage and the path is saved.

If `has_image` is true → find the Floor Plan component and fix the image URL it constructs to load the rasterized PNG.

**STEP 6 — Rebuild frontend**

After fixing the components:
```
cd artifacts/web && pnpm run build 2>&1 | tail -5
```

Or if running in dev mode (Vite), the changes hot-reload automatically.

**EXPECTED RESULT**

Sign Schedule tab: table with 178 rows showing Room #, Room Name, Sign Type, Confidence, Source, Status columns.

Floor Plan tab: floor plan image visible with colored markers overlaid at room positions.
