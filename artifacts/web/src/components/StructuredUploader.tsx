import { useState, useEffect } from "react";
import { Info, CheckCircle2, AlertTriangle, Circle } from "lucide-react";
import { DualZoneUploader, JobFileItem } from "@/components/DualZoneUploader";
import { getBuildingTypeOption } from "@/lib/buildingTypes";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type AuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface JobMaterialSpec {
  jobId:          string;
  substrate:      string | null;
  finishMethod:   string | null;
  brailleSpec:    string | null;
  mountingHeight: string | null;
  manufacturer:   string | null;
  source:         "sign_schedule" | "manual";
}

interface JobStats {
  totalSigns:      number;
  highConfidence:  number;
  needsReview:     number;
  detectedRooms:   number;
  scheduleRows:    number;
}

interface StructuredUploaderProps {
  jobId: string;
  authFetch: AuthFetch;
  files: JobFileItem[];
  canAct: boolean;
  onRefresh: () => void;
  buildingType: string;
  onFloorLabelChange?: (label: string) => void;
  jobStats?: JobStats | null;
}

interface SlotCardProps {
  icon: string;
  title: string;
  badge: string;
  badgeClass: string;
  description: string;
  children: React.ReactNode;
}

function SlotCard({ icon, title, badge, badgeClass, description, children }: SlotCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <span className="text-xl leading-none mt-0.5">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-foreground">{title}</h4>
            {badge && (
              <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none", badgeClass)}>
                {badge}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

interface ChecklistItemProps {
  done: boolean;
  warn?: boolean;
  label: string;
}

function ChecklistItem({ done, warn, label }: ChecklistItemProps) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {done ? (
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
      ) : warn ? (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      ) : (
        <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
      )}
      <span className={cn("leading-tight", done ? "text-foreground" : "text-muted-foreground")}>{label}</span>
    </div>
  );
}

export function StructuredUploader({
  jobId,
  authFetch,
  files,
  canAct,
  onRefresh,
  buildingType,
  onFloorLabelChange,
  jobStats,
}: StructuredUploaderProps) {
  const [floorLabel, setFloorLabel] = useState("");
  const [materialSpec, setMaterialSpec] = useState<JobMaterialSpec | null>(null);
  const [splitBannerDismissed, setSplitBannerDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/jobs/${jobId}/material-spec`)
      .then(r => r.ok ? r.json() : null)
      .then((data: JobMaterialSpec | null) => {
        if (!cancelled) setMaterialSpec(data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [jobId, files.length, authFetch]);

  const safeBuildingType = buildingType || "unknown";
  const guide = getBuildingTypeOption(safeBuildingType)?.uploadGuide;

  const typedFiles = files.map(f => ({ ...f, fileCategory: (f as { fileCategory?: string | null }).fileCategory ?? null }));
  const floorPlanFiles  = typedFiles.filter(f => !f.fileCategory || f.fileCategory === "floor_plan");
  const roomScheduleFiles = typedFiles.filter(f => f.fileCategory === "room_schedule");
  const signScheduleFiles = typedFiles.filter(f => f.fileCategory === "sign_schedule");
  const signDetailsFiles  = typedFiles.filter(f => f.fileCategory === "sign_details");

  const floorPlanMsg = (): { ok: boolean; warn: boolean; text: string } => {
    if (floorPlanFiles.length === 0) return { ok: false, warn: false, text: "" };
    if (jobStats) {
      if (jobStats.detectedRooms === 0) {
        return { ok: false, warn: true, text: "No rooms found in floor plans — check that uploaded pages show room labels" };
      }
      return { ok: true, warn: false, text: `Floor plans processed — ${jobStats.detectedRooms} room${jobStats.detectedRooms !== 1 ? "s" : ""} extracted` };
    }
    return { ok: true, warn: false, text: `Floor plans processed — ${floorPlanFiles.length} file${floorPlanFiles.length !== 1 ? "s" : ""}` };
  };

  const roomScheduleMsg = (): { ok: boolean; warn: boolean; text: string } | null => {
    if (roomScheduleFiles.length === 0) return null;
    if (jobStats) {
      if (jobStats.scheduleRows === 0) {
        return { ok: false, warn: true, text: "Room schedule uploaded but no rooms extracted — check that the file contains a room or finish schedule table" };
      }
      return { ok: true, warn: false, text: `Room schedule — ${jobStats.scheduleRows} room${jobStats.scheduleRows !== 1 ? "s" : ""} matched` };
    }
    return { ok: true, warn: false, text: "Room schedule uploaded" };
  };

  const signScheduleMsg = (): { ok: boolean; warn: boolean; text: string } | null => {
    if (signScheduleFiles.length === 0) return null;
    if (materialSpec) {
      const parts = [materialSpec.substrate, materialSpec.finishMethod].filter(Boolean);
      const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
      return { ok: true, warn: false, text: `Sign schedule — material specs extracted${detail}` };
    }
    return { ok: false, warn: true, text: "Sign schedule uploaded but material specs not found — check that the file contains sign type or material specifications" };
  };

  const signDetailsMsg = (): { ok: boolean; warn: boolean; text: string } | null => {
    if (signDetailsFiles.length === 0) return null;
    return { ok: true, warn: false, text: `Sign drawings uploaded — ${signDetailsFiles.length} file${signDetailsFiles.length !== 1 ? "s" : ""} (used for pricing)` };
  };

  const fpMsg  = floorPlanMsg();
  const rsMsg  = roomScheduleMsg();
  const ssMsg  = signScheduleMsg();
  const sdMsg  = signDetailsMsg();

  const showConfidence = fpMsg.text || rsMsg || ssMsg || sdMsg;

  return (
    <div className="flex flex-col gap-5">
      {/* Header with info button */}
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">Upload Construction Documents</h3>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="rounded-full p-0.5 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label="Upload guidance"
            >
              <Info className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-4" side="right" align="start">
            {guide ? (
              <div className="flex flex-col gap-3 text-xs">
                <div>
                  <p className="font-semibold text-foreground mb-1.5">Look for:</p>
                  <ul className="flex flex-col gap-1">
                    {guide.lookFor.map(item => (
                      <li key={item} className="flex items-start gap-1.5 text-muted-foreground">
                        <span className="text-green-500 shrink-0 mt-px">✓</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="border-t border-border pt-3">
                  <p className="font-semibold text-foreground mb-1.5">Avoid uploading:</p>
                  <ul className="flex flex-col gap-1">
                    {guide.avoid.map(item => (
                      <li key={item} className="flex items-start gap-1.5 text-muted-foreground">
                        <span className="text-destructive shrink-0 mt-px">✕</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3 text-xs text-muted-foreground">
                <p className="font-semibold text-foreground">Upload order (human estimator workflow):</p>
                <ol className="flex flex-col gap-1.5 list-decimal list-inside">
                  <li><strong>Sign Schedule / Specs</strong> (AA8xx) — drives sign count and type when present</li>
                  <li><strong>Sign Drawings / Details</strong> — sign type elevations and dimensions for pricing</li>
                  <li><strong>Floor Plans</strong> (A-1xx) — room locations and marker placement</li>
                  <li><strong>Room / Finish Schedule</strong> (A-7xx) — room name and finish data</li>
                </ol>
                <p>Select a building type to see project-specific guidance.</p>
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {/* Slot 1 — Sign Schedule / Specs */}
      <SlotCard
        icon="🪧"
        title="Sign Schedule / Specs"
        badge="Optional"
        badgeClass="bg-muted text-muted-foreground"
        description="Upload your interior signage schedule (e.g. AA831). If present, this drives the sign count and type — most accurate path. Accepts image-based or text-based schedules."
      >
        <DualZoneUploader
          jobId={jobId}
          authFetch={authFetch}
          files={signScheduleFiles}
          canAct={canAct}
          onRefresh={onRefresh}
          slotMode
          filterCategory="sign_schedule"
          warnSizeMB={20}
          warnSizeMessage="This file seems large for a schedule document."
        />
        <p className="text-xs text-muted-foreground leading-relaxed">
          Look for sheets labeled AA8xx, sign schedule, or interior signage schedule
        </p>
        {guide?.signScheduleHint && (
          <p className="text-xs text-muted-foreground leading-relaxed">{guide.signScheduleHint}</p>
        )}
      </SlotCard>

      {/* Slot 2 — Sign Drawings / Details */}
      <SlotCard
        icon="📐"
        title="Sign Drawings / Details"
        badge="Optional"
        badgeClass="bg-muted text-muted-foreground"
        description="Upload sign type detail sheets showing dimensions, materials, and copy layout for each sign type. Used to accurately price each sign."
      >
        <DualZoneUploader
          jobId={jobId}
          authFetch={authFetch}
          files={signDetailsFiles}
          canAct={canAct}
          onRefresh={onRefresh}
          slotMode
          filterCategory="sign_details"
          warnSizeMB={20}
          warnSizeMessage="This file seems large for a sign details document."
        />
        <p className="text-xs text-muted-foreground leading-relaxed">
          Look for sheets showing sign type elevations, dimensions, and material callouts
        </p>
      </SlotCard>

      {/* Slot 3 — Floor Plans */}
      <SlotCard
        icon="🗺️"
        title="Floor Plans"
        badge="Required"
        badgeClass="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
        description="Upload architectural floor plan sheets (A-1xx). Used for room locations and installer marker placement."
      >
        <DualZoneUploader
          jobId={jobId}
          authFetch={authFetch}
          files={floorPlanFiles}
          canAct={canAct}
          onRefresh={onRefresh}
          slotMode
          filterCategory="floor_plan"
          warnSizeMB={50}
          warnSizeMessage="This file is larger than expected for floor plans. If you've uploaded a full permit package, consider uploading only the floor plan pages (typically A-1xx sheets)."
        />
        {(() => {
          const multiPageFile = floorPlanFiles.find(f => (f.pageCount ?? 0) > 1 && !splitBannerDismissed.has(f.id));
          if (!multiPageFile) return null;
          return (
            <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 px-3 py-2 text-xs text-blue-800 dark:text-blue-300">
              <span className="shrink-0 mt-0.5">ℹ️</span>
              <span className="flex-1">
                This PDF has {multiPageFile.pageCount} pages. If it contains both floor plans and a finish schedule, consider uploading just the floor plan pages (A-1xx) here and the finish schedule page (A-7xx) to the Room Schedule slot for better accuracy.
              </span>
              <button
                onClick={() => setSplitBannerDismissed(prev => new Set([...prev, multiPageFile.id]))}
                className="shrink-0 text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-200 font-medium ml-1"
              >
                Dismiss
              </button>
            </div>
          );
        })()}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-foreground">What floors does this contain?</label>
          <input
            type="text"
            placeholder="e.g. First floor, or Floors 1–3"
            value={floorLabel}
            onChange={e => {
              setFloorLabel(e.target.value);
              onFloorLabelChange?.(e.target.value);
            }}
            onBlur={async () => {
              if (floorPlanFiles.length === 0) return;
              for (const f of floorPlanFiles) {
                try {
                  await authFetch(`/api/jobs/${jobId}/files/${f.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ floorLabel }),
                  });
                } catch {
                  // non-blocking
                }
              }
            }}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Look for sheets labeled A-1xx showing room layouts and door locations
        </p>
      </SlotCard>

      {/* Slot 4 — Room / Finish Schedule */}
      <SlotCard
        icon="📋"
        title="Room / Finish Schedule"
        badge="Optional"
        badgeClass="bg-muted text-muted-foreground"
        description="Upload room schedule or finish schedule if available. Provides additional room name and finish data."
      >
        <DualZoneUploader
          jobId={jobId}
          authFetch={authFetch}
          files={roomScheduleFiles}
          canAct={canAct}
          onRefresh={onRefresh}
          slotMode
          filterCategory="room_schedule"
          warnSizeMB={20}
          warnSizeMessage="This file seems large for a schedule document."
        />
        <p className="text-xs text-muted-foreground leading-relaxed">
          Look for sheets labeled A-7xx or room data schedules
        </p>
        {guide?.roomScheduleHint && (
          <p className="text-xs text-muted-foreground leading-relaxed">{guide.roomScheduleHint}</p>
        )}
      </SlotCard>

      {/* Progress checklist */}
      <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 flex flex-col gap-2">
        <p className="text-xs font-semibold text-foreground mb-0.5">Upload Status</p>
        <ChecklistItem
          done={signScheduleFiles.length > 0}
          label={signScheduleFiles.length > 0 ? `Sign schedule — ${signScheduleFiles.length} file${signScheduleFiles.length !== 1 ? "s" : ""}` : "Sign schedule — Not uploaded (optional)"}
        />
        <ChecklistItem
          done={signDetailsFiles.length > 0}
          label={signDetailsFiles.length > 0 ? `Sign drawings — ${signDetailsFiles.length} file${signDetailsFiles.length !== 1 ? "s" : ""}` : "Sign drawings — Not uploaded (optional)"}
        />
        <ChecklistItem
          done={floorPlanFiles.length > 0}
          label={
            floorPlanFiles.length > 0
              ? `Floor plans — ${floorPlanFiles.length} file${floorPlanFiles.length !== 1 ? "s" : ""}`
              : "Floor plans — Not uploaded"
          }
        />
        <ChecklistItem
          done={roomScheduleFiles.length > 0}
          label={roomScheduleFiles.length > 0 ? "Room schedule — Uploaded" : "Room schedule — Not uploaded (optional)"}
        />
      </div>

      {/* Estimation disclaimer */}
      <p className="text-sm text-gray-400">AI-powered takeoff — plan reading, ADA logic, and sign schedule extraction in a single automated pass.</p>

      {/* Per-slot confidence messages — shown after a scan has run */}
      {showConfidence && (
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 flex flex-col gap-2">
          <p className="text-xs font-semibold text-foreground mb-0.5">Extraction Results</p>

          {ssMsg ? (
            <ChecklistItem done={ssMsg.ok} warn={ssMsg.warn} label={ssMsg.text} />
          ) : signScheduleFiles.length === 0 ? (
            <ChecklistItem
              done={false}
              warn={false}
              label="No sign schedule uploaded — upload Division 10 specs or AA8xx schedule to drive sign count"
            />
          ) : null}

          {sdMsg && (
            <ChecklistItem done={sdMsg.ok} warn={sdMsg.warn} label={sdMsg.text} />
          )}

          {fpMsg.text && (
            <ChecklistItem done={fpMsg.ok} warn={fpMsg.warn} label={fpMsg.text} />
          )}

          {rsMsg ? (
            <ChecklistItem done={rsMsg.ok} warn={rsMsg.warn} label={rsMsg.text} />
          ) : roomScheduleFiles.length === 0 ? (
            <ChecklistItem
              done={false}
              warn={false}
              label="No room schedule uploaded — upload a Room or Finish Schedule (A-7xx) to improve accuracy"
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
