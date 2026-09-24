# UI/UX Updates — Sign Takeoff IQ Frontend

## Overview
Make the following targeted changes to the frontend in `artifacts/web/src`. 
Do NOT modify any backend files, pipeline logic, or API routes.
Do NOT change any existing functionality — only update visual presentation and navigation structure.

---

## 1. LOGO & BRAND — Update everywhere the logo appears

The logo currently uses a generic SVG icon (three diagonal lines) and the name "SIGN TAKEOFF IQ".

Update the brand to **"SignTakeoff IQ"** with a new logo.

Files to update:
- `src/components/layout/Sidebar.tsx` — logo in header (both collapsed and expanded states)
- `src/pages/LandingPage.tsx` — logo in header

**New logo SVG** — replace both existing inline SVGs with this:
```tsx
<svg viewBox="0 0 32 32" fill="none" className="w-5 h-5" xmlns="http://www.w3.org/2000/svg">
  {/* Blueprint grid */}
  <rect width="32" height="32" rx="4" fill="currentColor" fillOpacity="0.15"/>
  {/* Room outline */}
  <rect x="4" y="4" width="14" height="10" rx="1" stroke="currentColor" strokeWidth="1.5"/>
  {/* Door gap */}
  <line x1="4" y1="9" x2="7" y2="9" stroke="currentColor" strokeWidth="1.5"/>
  {/* Sign marker - filled diamond */}
  <circle cx="11" cy="9" r="2.5" fill="currentColor"/>
  {/* Leader line */}
  <line x1="13.5" y1="7" x2="20" y2="4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  {/* Sign label box */}
  <rect x="20" y="2" width="10" height="6" rx="1" fill="currentColor" fillOpacity="0.3" stroke="currentColor" strokeWidth="1"/>
  <line x1="22" y1="4.5" x2="28" y2="4.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
  <line x1="22" y1="6" x2="26" y2="6" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
  {/* Second room */}
  <rect x="4" y="18" width="10" height="10" rx="1" stroke="currentColor" strokeWidth="1.5"/>
  {/* Sign marker 2 */}
  <circle cx="9" cy="23" r="2" fill="currentColor"/>
  {/* Schedule lines bottom right */}
  <line x1="18" y1="18" x2="28" y2="18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  <line x1="18" y1="21" x2="28" y2="21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  <line x1="18" y1="24" x2="24" y2="24" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
</svg>
```

**Brand name changes:**
- In Sidebar expanded state: Change `SIGN TAKEOFF IQ` to `SignTakeoff IQ` (mixed case, not all-caps)
- In Sidebar expanded state: Change subtitle from `Precision Portal` to `Sign Estimating Platform`
- In LandingPage header: Same changes as above
- The `w-8 h-8` logo container should use `bg-primary` and the SVG should use `text-primary-foreground`

---

## 2. SIDEBAR NAVIGATION — Reorder and rename items

In `src/components/layout/Sidebar.tsx`, update `mainNavItems`:

```tsx
const mainNavItems = [
  { href: "/new-upload", label: "New Job", icon: FileUp },
  { href: "/jobs", label: "Jobs", icon: FolderOpen },
  { href: "/training", label: "Training", icon: BookOpen },
  { href: "/activity", label: "Activity", icon: Clock },
];
```

Changes:
- "New Upload" → "New Job"  
- "All Jobs" → "Jobs"
- "Training Import" → "Training"
- Move Activity to the bottom of main nav (currently 3rd, move to 4th)

---

## 3. DASHBOARD / HOME PAGE — Update upload page layout

In `src/pages/Home.tsx`, make these changes:

**a) Add a project name field above the file dropzone:**
```tsx
{/* Project Name input — add this before the dropzone div */}
<div className="space-y-2">
  <label className="text-sm font-display font-semibold uppercase tracking-wider text-muted-foreground">
    Project Name
  </label>
  <input
    type="text"
    value={projectName}
    onChange={(e) => setProjectName(e.target.value)}
    placeholder="e.g. Westover ARB Bldg 7087, NOVO Riverside Phase 2"
    className="w-full px-4 py-2.5 rounded-lg bg-card border border-border text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 font-mono text-sm"
  />
</div>
```

Add `const [projectName, setProjectName] = useState("");` to the component state.

Pass `projectName` to the upload mutation: update `handleUpload` to include it:
```tsx
const result = await uploadMutation.mutateAsync({ 
  data: { files, projectName: projectName.trim() || undefined }
});
```

**b) Update the header copy:**
- Title: "New Extraction Job" → "Start a New Takeoff"
- Subtitle: change to "Upload architectural construction PDFs. The system identifies rooms, applies sign type rules, and produces a complete sign schedule."

**c) Update button text:**
- "Upload & Scan" → "Upload & Extract Signs"

---

## 4. JOB DETAIL TABS — Reorder and simplify tab navigation

In `src/pages/JobDetails.tsx`, update the tab bar to reorder tabs so the most useful ones come first.

**New tab order (left to right):**
1. Overview (new — see section 5 below)
2. Sign Schedule (rename from "Sign Table")
3. Floor Plans
4. Rooms (rename from "Room Inventory") 
5. Sheets Analysis
6. Sign Type Summary
7. Sign Pages
8. Sign Specs
9. Verification
10. Timeline
11. Coordinates *(keep conditional: only when completed/failed)*
12. AI Scans *(keep conditional: only when completed/failed)*
13. Training *(remove from tabs — accessible via sidebar)*

**Tab label changes:**
- "Sign Table" → "Sign Schedule"
- "Room Inventory" → "Rooms"
- Keep all badge logic (verification badge on Sign Schedule tab, room count badge on Rooms tab)

**Update the tab state type** to match — add `"overview"` and remove old names, add new names. Update `parseTabParam` default to `"overview"`.

---

## 5. OVERVIEW TAB — Add a new Overview tab to Job Detail

Add a new "Overview" tab as the first tab in JobDetails. This is shown when `activeTab === "overview"`.

The Overview tab content should be a clean summary panel:

```tsx
{activeTab === "overview" && (
  <div className="flex-1 overflow-auto bg-card border-t border-border">
    <div className="max-w-4xl mx-auto p-8 space-y-8">
      
      {/* Status + key metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard title="Total Signs" value={totalSigns} 
          icon={<ListFilter className="w-4 h-4 text-muted-foreground" />} />
        <SummaryCard title="High Confidence" value={highConfidenceCount}
          icon={<CheckCircle2 className="w-4 h-4 text-accent" />} accent="accent" />
        <SummaryCard title="Needs Review" value={flaggedCount}
          icon={<AlertTriangle className="w-4 h-4 text-primary" />} accent="primary" />
        <CostCard
          inputTokens={...} outputTokens={...} />
      </div>

      {/* Job metadata */}
      <div className="rounded-lg border border-border/60 bg-card p-6 space-y-4">
        <h3 className="text-xs font-display font-bold uppercase tracking-wider text-muted-foreground">
          Job Details
        </h3>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground text-xs uppercase tracking-wide font-display">Location</span>
            <p className="text-foreground mt-0.5 font-mono">
              {[job.projectAddress, job.projectCity, job.projectState].filter(Boolean).join(", ") || "—"}
            </p>
          </div>
          <div>
            <span className="text-muted-foreground text-xs uppercase tracking-wide font-display">Jurisdiction</span>
            <p className="text-foreground mt-0.5 font-mono">{job.jurisdiction || "—"}</p>
          </div>
          <div>
            <span className="text-muted-foreground text-xs uppercase tracking-wide font-display">Building Type</span>
            <p className="text-foreground mt-0.5 font-mono capitalize">{(job as any).buildingType || "Other"}</p>
          </div>
          <div>
            <span className="text-muted-foreground text-xs uppercase tracking-wide font-display">AI Model</span>
            <p className="text-foreground mt-0.5 font-mono text-xs">{(job as any).aiModel || "claude-sonnet-4-6"}</p>
          </div>
          <div>
            <span className="text-muted-foreground text-xs uppercase tracking-wide font-display">AI Vision Threshold</span>
            <p className="text-foreground mt-0.5 font-mono">{(job as any).aiVisionThreshold || "System default"}</p>
          </div>
          <div>
            <span className="text-muted-foreground text-xs uppercase tracking-wide font-display">AI Vision Scans Used</span>
            <p className="text-foreground mt-0.5 font-mono">{(job as any).aiVisionScansUsed ?? 0} of 10</p>
          </div>
        </div>
      </div>

      {/* Pipeline log summary */}
      <div className="rounded-lg border border-border/60 bg-card p-6 space-y-3">
        <h3 className="text-xs font-display font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          Pipeline Log
          {isCompleted && <span className="text-teal-400">✓ Processing complete</span>}
        </h3>
        {(() => {
          const jobLog = (job as any).processingLog;
          const totalStep = jobLog?.find((s: any) => s.step === "total");
          const stepCount = jobLog?.filter((s: any) => s.step !== "total" && !s.step.match(/[0-9a-f]{8}-/)).length ?? 0;
          const lastRunAt = jobLog?.[0]?.startedAt;
          return (
            <div className="text-sm font-mono text-muted-foreground space-y-1">
              {lastRunAt && <p>Last run: {format(new Date(lastRunAt), "PPP 'at' p")}</p>}
              {stepCount > 0 && <p>{stepCount} steps completed{totalStep ? ` · ${formatDuration(totalStep.durationMs)} total` : ""}</p>}
              {(job as any).aiRetryMax != null && (
                <p>AI retry settings: max {(job as any).aiRetryMax ?? 3} attempts, {(job as any).aiBaseDelayMs ?? 5000} ms base delay</p>
              )}
            </div>
          );
        })()}
      </div>

      {/* File uploads */}
      <div className="rounded-lg border border-border/60 bg-card p-6 space-y-3">
        <h3 className="text-xs font-display font-bold uppercase tracking-wider text-muted-foreground">
          File Uploads
        </h3>
        <p className="text-sm text-muted-foreground">Upload construction PDFs for this job.</p>
        {files.length > 0 ? (
          <div className="space-y-2">
            {files.map(f => (
              <div key={f.id} className="flex items-center gap-3 p-3 rounded bg-secondary border border-border/50">
                <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-mono text-foreground flex-1 truncate">{f.originalName}</span>
                <span className="text-xs font-mono text-muted-foreground shrink-0">
                  {f.pageCount ? `${f.pageCount} pages` : ""}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground/50 italic">No files uploaded yet.</p>
        )}
        <button
          onClick={() => {/* open file upload dialog */}}
          className="mt-2 flex items-center gap-2 px-4 py-2 rounded border border-dashed border-border hover:border-primary/50 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <FileText className="w-4 h-4" />
          Upload PDFs
        </button>
      </div>

    </div>
  </div>
)}
```

This replicates the content currently shown in the image you shared (Overview tab with Job Details, AI Vision Scans Used, Pipeline Log, File Uploads sections).

---

## 6. TRAINING TAB — Remove from job detail, fix import UI

**a)** Remove the Training tab from the Job Detail tab bar entirely. Training is accessed via the sidebar navigation (`/training`), not per-job.

**b)** In `src/pages/Training.tsx`, fix the spreadsheet import to handle the "wide" format used by real estimator takeoffs.

The import parser currently expects columns: `Sign Type | Room # | Room Name | Level`

Real-world takeoffs (like SOF 7087) use a **wide format** where sign types are column headers:
```
Room # | Room | BB2A | BB2B | SS1A | BB3 | BB7A | BB7B | ...
1100   | CORRIDOR | 1 |   |   | 1 |   |   |
1101   | UCC/COMP RM | 1 |   |   |   |   |   |
```

Update the import form to show a clearer format hint:

Find the subtitle/description text near the file upload in Training.tsx and update it to:
```
"Accepts both tall format (Sign Type | Room # | Room Name | Level) and wide format (Room # | Room | BB2A | BB2B | ...) spreadsheets."
```

Also update the error message display: when the API returns HTTP 400 with a "Failed to read spreadsheet" error, show a more helpful message:
```tsx
{importError && (
  <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm space-y-2">
    <p className="font-semibold">Import failed</p>
    <p>{importError}</p>
    {importError.includes("Sign Type") && (
      <p className="text-xs text-destructive/70">
        Tip: Your spreadsheet uses a wide format (sign types as column headers). 
        This will be supported in an upcoming update. For now, convert to tall format: 
        Sign Type | Room # | Room Name | Level
      </p>
    )}
  </div>
)}
```

---

## 7. FLOOR PLAN VIEWER — Minor UX improvements

In `src/components/UnifiedPlanViewer.tsx`, make these small improvements:

**a)** Update the "no floor plan data" empty state message from whatever it currently says to:
```
"No floor plan pages detected for this job. Upload a PDF with floor plan sheets and re-run extraction."
```

**b)** The AI highlight toggle button label: change from whatever it currently says to "Highlight AI-detected signs" with a Brain icon if not already present.

---

## 8. LANDING PAGE — Update hero copy and styling

In `src/pages/LandingPage.tsx`:

**a)** Update the hero headline:
- Current: "Architectural Signage Data, Extracted Instantly."
- New: "Sign Takeoffs in Minutes, Not Hours."

**b)** Update the hero subtitle:
- Current: "The industry's first Bloomberg-terminal-style application for sign estimators..."
- New: "Upload architectural construction PDFs. Our rules engine reads room data, applies ADA and code sign-type rules, and produces a complete, exportable sign schedule — automatically."

**c)** Update the CTA button:
- Current: "Start Extracting →"  
- New: "Start Your First Takeoff →"

**d)** Update the feature cards/icons section if present — change any references to "Bloomberg terminal" to remove that phrase.

**e)** In the header "Log in" button: change to "Sign In" to match the rest of the app.

---

## Implementation notes

- All changes are in `artifacts/web/src/` only
- Do not modify `artifacts/api-server/` or `artifacts/pdf-sidecar/`
- After making changes, run: `cd artifacts/web && pnpm run build` to verify no TypeScript errors
- The tab state union type in JobDetails.tsx will need to be updated to include `"overview"` and rename `"table"` to `"schedule"` and `"rooms"` rename is already there as `"rooms"` — just update display labels
- Import `format` from `date-fns` and `formatDuration` is already defined in JobDetails.tsx
