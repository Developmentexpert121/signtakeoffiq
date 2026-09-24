The Floor Plan viewer is broken. The plan image renders as a tiny thumbnail in the corner instead of filling the viewer. Markers are listed in a sidebar panel but are NOT overlaid on the floor plan image itself.

The correct behavior (reference implementation) is:
- Floor plan image fills the ENTIRE viewer canvas (pan + zoom)
- Colored circular markers are positioned directly ON the plan at room coordinates
- Each marker is color-coded by sign type (Exit=red, Restroom=teal, Room ID=amber, Room ID w/insert=purple)
- A legend overlay shows sign type counts
- Clicking a marker opens an edit popover
- Page navigation shows multi-page plans

---

**STEP 1 — Find the Floor Plan viewer component**

```
grep -rn "Floor Plan\|FloorPlan\|floor-plan\|floorplan\|canvas\|marker" artifacts/web/src --include="*.tsx" | grep -iv "test\|spec" | head -20
```

Open the main floor plan viewer component file.

---

**STEP 2 — Identify the layout bug**

The plan image is tiny because the viewer container has no explicit height or it's constrained by a parent. Find and fix the container CSS:

The viewer div must be:
```tsx
// The outer container must fill available height
<div className="relative w-full" style={{ height: 'calc(100vh - 280px)', minHeight: '500px', background: '#000', overflow: 'hidden' }}>
  {/* Pan/zoom wrapper */}
  <div
    style={{
      position: 'absolute',
      transformOrigin: '0 0',
      transform: `scale(${zoom}) translate(${panX}px, ${panY}px)`,
      cursor: isDragging ? 'grabbing' : 'grab',
    }}
    onMouseDown={handleMouseDown}
  >
    {/* Floor plan image */}
    <img
      src={planImageUrl}
      style={{ display: 'block', maxWidth: 'none' }}
      draggable={false}
    />
    {/* Markers overlaid on image */}
    {markers.map(marker => (
      <div
        key={marker.id}
        style={{
          position: 'absolute',
          left: `${(marker.x / 1000) * imageWidth}px`,
          top: `${(marker.y / 1000) * imageHeight}px`,
          transform: 'translate(-50%, -50%)',
          width: '24px',
          height: '24px',
          borderRadius: '50%',
          backgroundColor: getSignTypeColor(marker.signType),
          border: '2px solid white',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '10px',
          fontWeight: 'bold',
          color: 'white',
          zIndex: 10,
        }}
        onClick={() => handleMarkerClick(marker)}
        title={`${marker.roomNumber} - ${marker.signType}`}
      />
    ))}
  </div>
</div>
```

**The key fix:** Markers must be children of the SAME div as the image, positioned absolutely relative to the image using normalized 0-1000 coordinates converted to pixels.

---

**STEP 3 — Fix coordinate conversion**

Signs are stored with x/y coordinates in 0-1000 normalized space. To overlay on the image:

```typescript
// Convert normalized 0-1000 coords to pixel position on the displayed image
const markerLeft = (sign.x / 1000) * naturalImageWidth;
const markerTop = (sign.y / 1000) * naturalImageHeight;
```

Get the natural image dimensions after it loads:
```tsx
const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
<img
  src={planImageUrl}
  onLoad={(e) => {
    const img = e.currentTarget;
    setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
  }}
/>
```

---

**STEP 4 — Fix sign type colors**

Use these exact colors to match the reference design:
```typescript
const SIGN_TYPE_COLORS: Record<string, string> = {
  'ROOM ID': '#f59e0b',           // amber
  'ROOM ID W/INSERT': '#8b5cf6',  // purple  
  'RESTROOM': '#14b8a6',          // teal
  'EXIT': '#ef4444',              // red
  'STAIR': '#3b82f6',             // blue
  'ELEVATOR': '#06b6d4',          // cyan
  'MAX OCCUPANCY': '#f97316',     // orange
  'EVAC MAP': '#84cc16',          // lime
  'DEFAULT': '#f59e0b',           // amber fallback
};

function getSignTypeColor(signType: string): string {
  const key = (signType || '').toUpperCase();
  for (const [k, v] of Object.entries(SIGN_TYPE_COLORS)) {
    if (key.includes(k)) return v;
  }
  return SIGN_TYPE_COLORS.DEFAULT;
}
```

---

**STEP 5 — Fix pan/zoom**

The viewer needs working pan and zoom:
```typescript
const [zoom, setZoom] = useState(1);
const [pan, setPan] = useState({ x: 0, y: 0 });
const [isDragging, setIsDragging] = useState(false);
const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

const handleWheel = (e: React.WheelEvent) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  setZoom(z => Math.max(0.1, Math.min(5, z * delta)));
};

const handleMouseDown = (e: React.MouseEvent) => {
  setIsDragging(true);
  setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
};

const handleMouseMove = (e: React.MouseEvent) => {
  if (!isDragging) return;
  setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
};

const handleMouseUp = () => setIsDragging(false);
```

Apply to the outer container:
```tsx
<div
  onWheel={handleWheel}
  onMouseDown={handleMouseDown}
  onMouseMove={handleMouseMove}
  onMouseUp={handleMouseUp}
  onMouseLeave={handleMouseUp}
>
```

---

**STEP 6 — Fix the image URL**

The floor plan image is served from the API. Verify the URL is correct:
```
grep -rn "rasterized\|planImage\|sheet.*image\|page.*image" artifacts/web/src --include="*.tsx" | head -10
```

The image URL should be: `/api/jobs/${jobId}/sheets/${sheetId}/image`

Verify the API endpoint exists:
```
curl -s http://localhost:8080/api/jobs/$(echo "SELECT id FROM jobs ORDER BY created_at DESC LIMIT 1;" | psql $DATABASE_URL -t | tr -d ' ')/sheets 2>&1 | head -50
```

---

**STEP 7 — Legend overlay**

Add a legend in the top-left corner of the viewer (positioned absolute, z-index 20):
```tsx
<div style={{ position: 'absolute', top: 12, left: 12, zIndex: 20, background: 'rgba(0,0,0,0.8)', borderRadius: 8, padding: '8px 12px' }}>
  {Object.entries(signTypeCounts).map(([type, count]) => (
    <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: getSignTypeColor(type) }} />
      <span style={{ color: 'white', fontSize: 11 }}>{type}</span>
      <span style={{ color: '#999', fontSize: 11 }}>{count}</span>
    </div>
  ))}
</div>
```

---

**STEP 8 — Remove the sidebar panel**

Remove or hide the sidebar that lists markers as a vertical list on the right. The floor plan canvas should be the hero element taking full width. Sign details should appear in a popover/modal on marker click, not a persistent sidebar.

---

**EXPECTED RESULT**

Floor plan tab shows:
- Full-width floor plan image filling the viewer
- Colored circular markers positioned directly on the plan at room locations
- Legend overlay (top-left) showing sign type counts with colored dots
- Mouse wheel zoom, click-drag pan
- Clicking a marker shows a popover with sign details
- Page navigation for multi-page plans
- Marker count badge (top-right): "45 markers"
