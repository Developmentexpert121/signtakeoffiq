import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  JOB_DETAIL_TAB_PREFIX,
  JOB_DETAIL_LRU_KEY,
  JOB_DETAIL_LRU_MAX,
  readLru,
  migrateJobDetailTabKeys,
} from "@/lib/job-detail-tab-migration";
import { usePersistedTab } from "@/hooks/usePersistedTab";
import { usePersistedState } from "@/hooks/usePersistedState";
import { useLocation, useParams } from "wouter";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useAuthFetch } from "@/hooks/use-auth-fetch";
import { 
  useGetJob, 
  getGetJobQueryKey,
  useListRooms,
  getListRoomsQueryKey as apiListRoomsQueryKey,
  useListSigns,
  getListSignsQueryKey,
  useGetAiScans,
  getGetAiScansQueryKey,
  useProcessJob,
  useRescanJob,
  useReRuleJob,
  useCancelJob,
  useListJobSheets,
  getListJobSheetsQueryKey,
  getListJobFilesQueryKey,
  useUpdateJob,
  useUpdateSign,
  useListJobFiles,
  useUpdateRoomReviewStatus,
  useBulkReviewRooms,
  useGetTenant,
  useGetValidationResults,
  getGetValidationResultsQueryKey,
  useDismissRoomWarnings,
} from "@workspace/api-client-react";
import { ConfidenceHistogram, type ConfidenceBracket } from "@/components/ConfidenceHistogram";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Loader2, Play, RefreshCw, Download, CheckCircle2, AlertTriangle, Check, X, ChevronDown, ChevronUp, ChevronRight, XCircle, Clock, RotateCcw, Filter, Wand2, Pencil, MapPin, BarChart3, FileText, GraduationCap, FileSpreadsheet, Upload, SlidersHorizontal, Sparkles, FileDown, Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DismissibleBanner } from "@/components/DismissibleBanner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { FloorPlanTab } from "@/components/FloorPlanTab";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { DualZoneUploader } from "@/components/DualZoneUploader";
import { StructuredUploader } from "@/components/StructuredUploader";
import { CANONICAL_BUILDING_TYPES, getBuildingTypeOption, getBuildingTypeLabel } from "@/lib/buildingTypes";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";

interface RetryEvent {
  attempt: number;
  errorType: string;
  errorMessage: string;
  stepLabel: string;
  timestamp: string;
}

interface PipelineProgress {
  step: number;
  totalSteps: number;
  label: string;
  startedAt: string;
  stepStartedAt: string;
  estimatedTotalSeconds: number;
  retryLog?: RetryEvent[];
  aiRetryMax?: number;
  effectiveBaseDelayMs?: number;
}

function getProgress(metadata: Record<string, unknown> | null | undefined): PipelineProgress | null {
  if (!metadata) return null;
  const p = (metadata as Record<string, unknown>).progress;
  if (!p || typeof p !== "object") return null;
  return p as PipelineProgress;
}

function getErrorMessage(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const msg = (metadata as Record<string, unknown>).errorMessage;
  return typeof msg === "string" && msg ? msg : null;
}

function getFailedAt(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const ts = (metadata as Record<string, unknown>).failedAt;
  return typeof ts === "string" && ts ? ts : null;
}

interface Step6SheetResult {
  sheetId: string;
  status: "cached" | "fresh_scan" | "skipped_threshold" | "skipped_cap" | "timeout" | "skipped_filter";
}

interface PipelineStepRecord {
  step: number | string;
  label: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: "completed" | "running" | "failed";
  sheetResults?: Step6SheetResult[];
}

function getSteps(metadata: Record<string, unknown> | null | undefined): PipelineStepRecord[] {
  if (!metadata) return [];
  const s = (metadata as Record<string, unknown>).steps;
  if (!Array.isArray(s)) return [];
  return s as PipelineStepRecord[];
}

function Step6SheetResultsList({ results }: { results: Step6SheetResult[] }) {
  if (results.length === 0) return null;
  return (
    <ul className="mt-1 ml-16 space-y-0.5">
      {results.map((r, i) => (
        <li key={`${r.sheetId}-${i}`} className="flex items-center gap-2 text-xs">
          {r.status === "cached" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 rounded bg-sky-100 dark:bg-sky-900/30 px-1.5 py-0.5 text-sky-700 dark:text-sky-400 font-medium shrink-0 cursor-default">
                  used cache
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-center">
                Prior AI results were reused — no new Claude vision call was made, saving cost.
              </TooltipContent>
            </Tooltip>
          ) : r.status === "fresh_scan" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 rounded bg-amber-100 dark:bg-amber-900/30 px-1.5 py-0.5 text-amber-700 dark:text-amber-400 font-medium shrink-0 cursor-default">
                  fresh AI scan
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-center">
                A new Claude vision call was made for this sheet. Each fresh scan counts against the per-run AI cap.
              </TooltipContent>
            </Tooltip>
          ) : r.status === "skipped_filter" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-muted-foreground font-medium shrink-0 cursor-default">
                  text-only
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-center">
                Vision scan skipped — this sheet type (notes, egress, details, non-floor-plan) doesn't benefit from AI room extraction. Text extraction was used instead.
              </TooltipContent>
            </Tooltip>
          ) : r.status === "skipped_threshold" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-muted-foreground font-medium shrink-0 cursor-default">
                  skipped (above threshold)
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-center">
                This sheet's confidence was already above the AI vision threshold, so no scan was needed.
              </TooltipContent>
            </Tooltip>
          ) : r.status === "timeout" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 rounded bg-red-100 dark:bg-red-900/30 px-1.5 py-0.5 text-red-700 dark:text-red-400 font-medium shrink-0 cursor-default">
                  timed out
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-center">
                This sheet exceeded the 60-second per-sheet limit (rasterization + AI vision) and was skipped. Re-run the job to retry it.
              </TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-muted-foreground font-medium shrink-0 cursor-default">
                  skipped (cap reached)
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-center">
                The per-run AI scan cap was reached before this sheet could be processed. Raise the cap in Settings to scan more sheets per run.
              </TooltipContent>
            </Tooltip>
          )}
          <span className="truncate text-muted-foreground">{r.sheetId}</span>
        </li>
      ))}
    </ul>
  );
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

interface AiScanSummary {
  cacheHits: number;
  freshScans: number;
  skippedAboveThreshold: number;
  estimatedSavings: number;
  capPerRun?: number;
  capHit?: boolean;
}

function getAiScanSummary(metadata: Record<string, unknown> | null | undefined): AiScanSummary | null {
  if (!metadata) return null;
  const s = (metadata as Record<string, unknown>).aiScanSummary;
  if (!s || typeof s !== "object") return null;
  return s as AiScanSummary;
}

function getAiVisionSheetsSkipped(metadata: Record<string, unknown> | null | undefined): { count: number; titles: string[] } {
  if (!metadata) return { count: 0, titles: [] };
  const val = (metadata as Record<string, unknown>).aiVisionSheetsSkipped;
  const count = typeof val === "number" && val > 0 ? val : 0;
  const rawTitles = (metadata as Record<string, unknown>).aiVisionSheetsSkippedTitles;
  const titles = Array.isArray(rawTitles) ? (rawTitles as unknown[]).map(String) : [];
  return { count, titles };
}

function getReconciliationWarnings(metadata: Record<string, unknown> | null | undefined): string[] {
  if (!metadata) return [];
  const r = (metadata as Record<string, unknown>).reconciliation;
  if (!r || typeof r !== "object") return [];
  const warnings = (r as Record<string, unknown>).warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((w): w is string => typeof w === "string");
}

function calcSecondsElapsed(startedAt: string): number {
  return Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
}

// Fallback estimate used before the first pipeline step reports progress.
// When sheet count is available it is multiplied by the per-sheet rate from
// job metadata instead; 120 s is the floor and the no-sheet-data fallback.
const PLACEHOLDER_ESTIMATED_SECONDS = 120;

const JOB_DETAIL_VALID_TABS = [
  "overview", "rooms", "floor-plan", "sign-schedule",
  "sign-type-summary", "confidence", "ai-scans", "validation",
  "export", "files", "sheets", "settings",
];


function PipelineCountdown({ serverRemaining }: { serverRemaining: number }) {
  const [count, setCount] = useState(serverRemaining);

  useEffect(() => {
    setCount(serverRemaining);
    const id = setInterval(() => {
      setCount((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [serverRemaining]);

  if (count <= 0) return null;
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      ~{count}s remaining
    </span>
  );
}

function saveTabWithLru(jobId: string, tab: string): void {
  try {
    localStorage.setItem(`${JOB_DETAIL_TAB_PREFIX}${jobId}.activeTab`, tab);
    const lru = readLru().filter((id) => id !== jobId);
    lru.unshift(jobId);
    if (lru.length > JOB_DETAIL_LRU_MAX) {
      const evicted = lru.splice(JOB_DETAIL_LRU_MAX);
      for (const evictedId of evicted) {
        localStorage.removeItem(`${JOB_DETAIL_TAB_PREFIX}${evictedId}.activeTab`);
      }
    }
    localStorage.setItem(JOB_DETAIL_LRU_KEY, JSON.stringify(lru));
  } catch {
    // ignore storage errors
  }
}

migrateJobDetailTabKeys();

function getVisionThresholdLabel(threshold: number | null | undefined): string {
  if (threshold === null || threshold === undefined) return "AI Vision: default (3)";
  if (threshold === 0) return "AI Vision: disabled";
  return `AI Vision: threshold ${threshold}`;
}

function formatErrorType(errorType: string): string {
  switch (errorType) {
    case "rate_limit": return "Rate limit";
    case "overload": return "API overload";
    case "timeout": return "Request timeout";
    case "network": return "Network error";
    case "server_error": return "Server error";
    default: return "API error";
  }
}

function formatRelativeTime(timestamp: string): string {
  const seconds = Math.round((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function DirtyDot({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span
      className="h-1.5 w-1.5 rounded-full bg-orange-500 shrink-0"
      aria-label="Unsaved changes"
    />
  );
}


function getRoomTypeLabel(room: {
  isRestroom?: boolean | null;
  isStair?: boolean | null;
  isElevator?: boolean | null;
  isVestibule?: boolean | null;
  isCorridorOrHall?: boolean | null;
  isVehicleBay?: boolean | null;
  isMepUnoccupied?: boolean | null;
  isResidentialUnit?: boolean | null;
  isAssembly?: boolean | null;
  isPublicFacing?: boolean | null;
}): { label: string; color: string } | null {
  if (room.isRestroom) return { label: "Restroom", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300" };
  if (room.isStair) return { label: "Stair", color: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300" };
  if (room.isElevator) return { label: "Elevator", color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300" };
  if (room.isVestibule) return { label: "Vestibule", color: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300" };
  if (room.isCorridorOrHall) return { label: "Corridor", color: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" };
  if (room.isVehicleBay) return { label: "Vehicle Bay", color: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" };
  if (room.isMepUnoccupied) return { label: "MEP", color: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" };
  if (room.isResidentialUnit) return { label: "Residential", color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" };
  if (room.isAssembly) return { label: "Assembly", color: "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300" };
  if (room.isPublicFacing) return { label: "Public", color: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300" };
  return null;
}

function SignSchedulePdfViewer({ pdfUrl, authFetch }: { pdfUrl: string; authFetch: (url: string, init?: RequestInit) => Promise<Response> }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBlobUrl(null);
    authFetch(pdfUrl)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
      .then(async blob => {
        if (!cancelled) {
          const pdfBlob = new Blob([await blob.arrayBuffer()], { type: "application/pdf" });
          objectUrl = URL.createObjectURL(pdfBlob);
          setBlobUrl(objectUrl);
          setLoading(false);
        }
      })
      .catch(e => {
        if (!cancelled) { setError(String(e)); setLoading(false); }
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pdfUrl, authFetch]);
  if (loading) return <div className="flex items-center justify-center h-32 gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /><span className="text-sm">Loading PDF…</span></div>;
  if (error) return <div className="flex items-center justify-center h-32 text-destructive text-sm">{error}</div>;
  if (!blobUrl) return null;
  return <iframe src={blobUrl} className="w-full h-[700px] border-0" title="PDF preview" />;
}

// ---------------------------------------------------------------------------
// Collapsible banner — shown when the AI vision cap was hit and some sheets
// were not scanned. Collapsed by default so it doesn't bury the results.
// ---------------------------------------------------------------------------
function SkippedSheetsWarning({
  skipped,
  skippedTitles,
  canReprocess,
  canAct,
  onReprocess,
  onSheetClick,
  reprocessPending,
}: {
  skipped: number;
  skippedTitles: string[];
  canReprocess?: boolean;
  canAct?: boolean;
  onReprocess?: () => void;
  onSheetClick?: (title: string) => void;
  reprocessPending?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (skipped === 0) return null;

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-4 py-3 flex items-start gap-3 text-amber-800 dark:text-amber-300">
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="flex-1 text-sm">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              className="inline-flex items-center gap-1 font-semibold hover:underline underline-offset-2 focus:outline-none"
              onClick={() => skippedTitles.length > 0 && setExpanded((v) => !v)}
              title={skippedTitles.length > 0 ? (expanded ? "Collapse list" : "Expand list") : undefined}
            >
              {skipped} sheet{skipped !== 1 ? "s" : ""} skipped (AI vision cap reached)
              {skippedTitles.length > 0 && (
                <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`} />
              )}
            </button>
            <span className="font-normal opacity-80">— some sheets did not receive an AI vision scan because the per-run call limit was hit.</span>
          </div>
          {canReprocess && onReprocess && (
            <button
              className="inline-flex items-center gap-1.5 shrink-0 rounded-md border border-amber-400 dark:border-amber-600 bg-amber-100 dark:bg-amber-900/40 px-2.5 py-1 text-xs font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={onReprocess}
              disabled={reprocessPending}
              title="Reprocess this job to scan the sheets that were skipped"
            >
              {reprocessPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Reprocess now
            </button>
          )}
        </div>
        {expanded && skippedTitles.length > 0 && (
          <ul className="mt-1.5 list-disc list-inside space-y-0.5 text-amber-700 dark:text-amber-400">
            {skippedTitles.map((title, i) => (
              <li key={i}>
                {canAct && onSheetClick ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:no-underline cursor-pointer font-medium"
                        onClick={() => onSheetClick(title)}
                      >
                        {title}
                        <ChevronRight className="h-3 w-3 shrink-0" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Pre-select for Force Full Re-process</TooltipContent>
                  </Tooltip>
                ) : title}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}


interface PricingConfigProps {
  jobId: string;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  signs: Array<{ isDeleted?: boolean | null; signType?: string | null }> | undefined;
  pricingOverrides: Record<string, number> | null | undefined;
}

const DEFAULT_PRICES_PRICING_CONFIG: Record<string, number> = {
  "Typical Toilet Room Sign": 185,
  "Room Sign with Insert": 195,
  "Emergency Exit": 145,
  "Fire Extinguisher": 95,
  "Room Sign with No Storage": 185,
  "Occupancy Sign": 95,
  "Typical Room Sign": 165,
  "Egress Map": 285,
  "Egress Stair Sign at Corridor": 165,
  "Typical Stair Sign at Landing": 195,
  "Sign at Elevator": 165,
  "Sign at Unit": 95,
  "Elevator Machine Room Sign": 145,
  "Sign at Corridor": 245,
  "Elevator Control Room Location Sign": 145,
};

function PricingConfig({ jobId, authFetch, signs, pricingOverrides }: PricingConfigProps) {
  const queryClient = useQueryClient();
  const distinctSignTypes = useMemo(() =>
    Array.from(new Set(
      (signs ?? []).filter(s => !s.isDeleted && s.signType).map(s => s.signType!),
    )).sort()
  , [signs]);

  const getDefaultPrice = useCallback((signType: string): number => {
    const ov = pricingOverrides ?? {};
    if (ov[signType] != null) return ov[signType];
    const matchKey = Object.keys(DEFAULT_PRICES_PRICING_CONFIG).find(k =>
      signType.toLowerCase().includes(k.toLowerCase()),
    );
    return matchKey ? DEFAULT_PRICES_PRICING_CONFIG[matchKey] : 150;
  }, [pricingOverrides]);

  const [pricingDraft, setPricingDraft] = useState<Record<string, string>>({});
  const [pricingSaving, setPricingSaving] = useState(false);
  const [pricingSaved, setPricingSaved] = useState(false);

  if (distinctSignTypes.length === 0) return null;

  const handleSavePricing = async () => {
    setPricingSaving(true);
    const overrides: Record<string, number> = {};
    for (const st of distinctSignTypes) {
      const raw = pricingDraft[st];
      const val = raw != null ? parseFloat(raw) : getDefaultPrice(st);
      if (!isNaN(val) && val >= 0) overrides[st] = val;
    }
    try {
      await authFetch(`/api/jobs/${jobId}/pricing-overrides`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides }),
      });
      setPricingSaved(true);
      setTimeout(() => setPricingSaved(false), 2500);
      queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
    } catch {
      toast.error("Failed to save pricing");
    } finally {
      setPricingSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-5">
      <div>
        <h4 className="text-sm font-semibold text-foreground">Pricing Config</h4>
        <p className="text-xs text-muted-foreground mt-0.5">
          Set a flat price per sign type. These overrides are saved with the job and used in the XLSX Pricing Detail tab.
        </p>
      </div>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/50">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Sign Type</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Count</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Unit Price ($)</th>
            </tr>
          </thead>
          <tbody>
            {distinctSignTypes.map((st, idx) => {
              const count = (signs ?? []).filter(s => !s.isDeleted && s.signType === st).length;
              const currentVal = pricingDraft[st] ?? String(getDefaultPrice(st));
              return (
                <tr key={st} className={idx % 2 === 0 ? "bg-background" : "bg-muted/20"}>
                  <td className="px-3 py-2 text-foreground">{st}</td>
                  <td className="px-3 py-2 text-muted-foreground">{count}</td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min="0"
                      step="5"
                      value={currentVal}
                      onChange={e => setPricingDraft(prev => ({ ...prev, [st]: e.target.value }))}
                      className="w-24 rounded border border-input bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          onClick={handleSavePricing}
          disabled={pricingSaving}
          className="gap-2"
        >
          {pricingSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {pricingSaving ? "Saving…" : "Save Pricing"}
        </Button>
        {pricingSaved && (
          <span className="text-xs text-green-600 dark:text-green-400">Pricing saved</span>
        )}
      </div>
    </div>
  );
}

export default function JobDetail() {
  const params = useParams();
  const jobId = params.jobId!;
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { isMember, isGuest, isAdmin } = useCurrentUser();
  const canAct = isMember || isGuest;
  const authFetch = useAuthFetch();
  const [activeTab, _baseTabChange] = usePersistedTab(`job-detail.${jobId}.activeTab`, JOB_DETAIL_VALID_TABS, "overview", "tab");
  const prevStatusRef = useRef<string | null>(null);
  const userSwitchedTabDuringProcessingRef = useRef(false);
  const errorBannerRef = useRef<HTMLDivElement>(null);
  const [highlightBanner, setHighlightBanner] = useState(false);
  const hasHighlightedOnMount = useRef(false);

  const { data: job, isLoading: loadingJob } = useGetJob(jobId, {
    query: {
      enabled: !!jobId,
      queryKey: getGetJobQueryKey(jobId),
      refetchInterval: (query): number | false => {
        const data = query.state.data as { status?: string } | undefined;
        return data?.status === "processing" ? 2500 : false;
      },
    },
  });

  const { data: tenant } = useGetTenant();
  const tenantSettings = (tenant?.settings ?? {}) as Record<string, unknown>;
  const lowConfidenceThreshold = typeof tenantSettings.lowConfidenceThreshold === "number" ? tenantSettings.lowConfidenceThreshold : 70;

  useEffect(() => {
    if (!job) return;
    const prev = prevStatusRef.current;
    if (prev !== null && prev !== "processing" && job.status === "processing" && !userSwitchedTabDuringProcessingRef.current) {
      saveTabWithLru(jobId, "overview");
      _baseTabChange("overview");
    }
    if (prev === "processing" && job.status !== "processing") {
      userSwitchedTabDuringProcessingRef.current = false;
      queryClient.invalidateQueries();
      void fetchAndUpdateSignCount();
      if (job.status === "error") {
        const meta = job.metadata as Record<string, unknown>;
        const errMsg = getErrorMessage(meta);
        const failedAt = getProgress(meta);
        const stepInfo = failedAt
          ? `Failed at step ${failedAt.step} of ${failedAt.totalSteps}: ${failedAt.label}`
          : null;
        const description = [stepInfo, errMsg ?? "An unexpected error occurred. Use the Retry button to try again."]
          .filter(Boolean)
          .join("\n");
        toast.error("Processing failed", {
          description,
          duration: 8000,
          action: {
            label: "View details",
            onClick: () => {
              errorBannerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
              setHighlightBanner(false);
              requestAnimationFrame(() => {
                setHighlightBanner(true);
                setTimeout(() => setHighlightBanner(false), 1300);
              });
            },
          },
        });
      }
    }
    prevStatusRef.current = job.status;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, queryClient]);

  useEffect(() => {
    if (!job || hasHighlightedOnMount.current) return;
    hasHighlightedOnMount.current = true;
    if (job.status === "error") {
      errorBannerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      setHighlightBanner(false);
      requestAnimationFrame(() => {
        setHighlightBanner(true);
        setTimeout(() => setHighlightBanner(false), 1300);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  useEffect(() => {
    if (activeTab !== "rooms" || !scrollToDismissedRef.current) return;
    scrollToDismissedRef.current = false;
    const el = firstDismissedRoomRef.current;
    if (!el) return;
    setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  }, [activeTab]);

  const { data: rooms, isLoading: loadingRooms } = useListRooms(jobId, undefined, { query: { enabled: !!jobId, queryKey: apiListRoomsQueryKey(jobId) } });
  const { data: signs } = useListSigns(jobId, undefined, { query: { enabled: !!jobId, queryKey: getListSignsQueryKey(jobId) } });

  // Rooms that are AI-vision sourced and still pending review
  const pendingAiRooms = useMemo(
    () => (rooms ?? []).filter(r => r.source === "ai_vision" && r.reviewStatus === "pending"),
    [rooms],
  );
  // Signs (sum of qty) belonging to those pending AI rooms — used in the dismiss-all dialog
  const pendingAiSignCount = useMemo(() => {
    const ids = new Set(pendingAiRooms.map(r => r.id));
    return (signs ?? [])
      .filter(s => s.roomId && ids.has(s.roomId) && !s.isDeleted)
      .reduce((sum, s) => sum + (s.qty ?? 1), 0);
  }, [pendingAiRooms, signs]);

  // Live sign counts fetched directly from the server after any dismiss — never served from cache
  const [liveSignCount, setLiveSignCount] = useState<{
    totalSigns: number;
    highConfidence: number;
    needsReview: number;
  } | null>(null);
  const { data: jobFiles, refetch: refetchJobFiles } = useListJobFiles(jobId, { query: { enabled: !!jobId, queryKey: getListJobFilesQueryKey(jobId) } });
  const { data: aiScans } = useGetAiScans(jobId, { query: { enabled: !!jobId, queryKey: getGetAiScansQueryKey(jobId) } });
  const jobDone = !!job && job.status !== "processing";
  const [rawLogOpen, setRawLogOpen] = useState(false);
  const { data: rawLogData, isLoading: rawLogLoading } = useQuery({
    queryKey: ["jobs", jobId, "logs"],
    queryFn: async () => {
      const res = await authFetch(`/api/jobs/${jobId}/logs`);
      return res.json() as Promise<{ lines: string[] }>;
    },
    enabled: !!jobId && rawLogOpen && jobDone,
    staleTime: 60_000,
  });
  const { data: validationResults, isLoading: loadingValidation } = useGetValidationResults(jobId, { query: { enabled: !!jobId, queryKey: getGetValidationResultsQueryKey(jobId) } });
  const [exportingXlsx, setExportingXlsx] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [dismissedDownloadDialog, setDismissedDownloadDialog] = useState<{ type: "xlsx" | "pdf"; count: number } | null>(null);
  const [_includePending, _setIncludePending] = usePersistedState("sign-takeoff-export-include-pending", true);
  const [showAiVisionOnly, setShowAiVisionOnlyBase] = useState<boolean>(() => {
    const param = new URLSearchParams(window.location.search).get("showAiVisionOnly");
    if (param !== null) return param === "true";
    try {
      const stored = localStorage.getItem(`job-detail.${jobId}.showAiVisionOnly`);
      if (stored !== null) return JSON.parse(stored) as boolean;
    } catch {}
    return false;
  });
  const setShowAiVisionOnly = useCallback((value: boolean) => {
    try { localStorage.setItem(`job-detail.${jobId}.showAiVisionOnly`, JSON.stringify(value)); } catch {}
    const url = new URL(window.location.href);
    url.searchParams.set("showAiVisionOnly", String(value));
    window.history.replaceState(null, "", url.toString());
    setShowAiVisionOnlyBase(value);
    try {
      const bc = new BroadcastChannel(`job-detail-filters-${jobId}`);
      bc.postMessage({ type: "showAiVisionOnly", value });
      bc.close();
    } catch {}
  }, [jobId]);

  const [exteriorOpen, setExteriorOpen] = useState(true);
  const [egressSectionOpen, setEgressSectionOpen] = useState(true);
  const [specialtySigns, setSpecialtySigns] = useState<Array<{
    id: string; signCode: string | null; description: string;
    dimensions: string | null; material: string | null; finish: string | null;
    qty: number | null; notes: string | null; sourceSheetNumber: string | null;
  }>>([]);

  const [showDismissed, setShowDismissedBase] = useState<boolean>(() => {
    const param = new URLSearchParams(window.location.search).get("showDismissed");
    if (param !== null) return param === "true";
    try {
      const stored = localStorage.getItem(`job-detail.${jobId}.showDismissed`);
      if (stored !== null) return JSON.parse(stored) as boolean;
    } catch {}
    return false;
  });
  const setShowDismissed = useCallback((value: boolean) => {
    try { localStorage.setItem(`job-detail.${jobId}.showDismissed`, JSON.stringify(value)); } catch {}
    const url = new URL(window.location.href);
    url.searchParams.set("showDismissed", String(value));
    window.history.replaceState(null, "", url.toString());
    setShowDismissedBase(value);
    try {
      const bc = new BroadcastChannel(`job-detail-filters-${jobId}`);
      bc.postMessage({ type: "showDismissed", value });
      bc.close();
    } catch {}
  }, [jobId]);

  useEffect(() => {
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel(`job-detail-filters-${jobId}`);
      bc.onmessage = (event: MessageEvent<{ type: string; value: boolean }>) => {
        const { type, value } = event.data;
        if (type === "showAiVisionOnly") {
          setShowAiVisionOnlyBase(value);
          const url = new URL(window.location.href);
          url.searchParams.set("showAiVisionOnly", String(value));
          window.history.replaceState(null, "", url.toString());
        } else if (type === "showDismissed") {
          setShowDismissedBase(value);
          const url = new URL(window.location.href);
          url.searchParams.set("showDismissed", String(value));
          window.history.replaceState(null, "", url.toString());
        }
      };
    } catch {}
    return () => {
      try { bc?.close(); } catch {}
    };
  }, [jobId]);
  const [showDismissedOnly, setShowDismissedOnly] = useState(false);
  const [collapsedFloors, setCollapsedFloors] = useState<Set<string>>(new Set());
  const [showPendingOnly, setShowPendingOnly] = useState(false);
  const [signTableVerifiedFilter] = useState(false);
  const _updateSign = useUpdateSign();
  const [_pendingRoomsExpanded, _setPendingRoomsExpanded] = useState(false);
  const [showLowConfidenceOnly, setShowLowConfidenceOnlyBase] = useState<boolean>(() => {
    const param = new URLSearchParams(window.location.search).get("showLowConfidenceOnly");
    if (param !== null) return param === "true";
    try {
      const stored = localStorage.getItem(`job-detail.${jobId}.showLowConfidenceOnly`);
      if (stored !== null) return JSON.parse(stored) as boolean;
    } catch {}
    return false;
  });
  const _setShowLowConfidenceOnly = useCallback((value: boolean) => {
    try { localStorage.setItem(`job-detail.${jobId}.showLowConfidenceOnly`, JSON.stringify(value)); } catch {}
    const url = new URL(window.location.href);
    url.searchParams.set("showLowConfidenceOnly", String(value));
    window.history.replaceState(null, "", url.toString());
    setShowLowConfidenceOnlyBase(value);
  }, [jobId]);

  const [confidenceSortDir, setConfidenceSortDirBase] = useState<"asc" | "desc" | null>(() => {
    const param = new URLSearchParams(window.location.search).get("confidenceSortDir");
    if (param === "asc" || param === "desc") return param;
    if (param === "null") return null;
    try {
      const stored = localStorage.getItem(`job-detail.${jobId}.confidenceSortDir`);
      if (stored !== null) return JSON.parse(stored) as "asc" | "desc" | null;
    } catch {}
    return null;
  });
  const _setConfidenceSortDir = useCallback((value: "asc" | "desc" | null) => {
    try { localStorage.setItem(`job-detail.${jobId}.confidenceSortDir`, JSON.stringify(value)); } catch {}
    const url = new URL(window.location.href);
    if (value === null) {
      url.searchParams.delete("confidenceSortDir");
    } else {
      url.searchParams.set("confidenceSortDir", value);
    }
    window.history.replaceState(null, "", url.toString());
    setConfidenceSortDirBase(value);
  }, [jobId]);

  const [confidenceBracketFilter, setConfidenceBracketFilterBase] = useState<ConfidenceBracket | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const minParam = params.get("bracketMin");
    const maxParam = params.get("bracketMax");
    if (minParam !== null && maxParam !== null) {
      const minVal = parseFloat(minParam);
      const maxVal = parseFloat(maxParam);
      if (!isNaN(minVal) && !isNaN(maxVal)) {
        const labelParam = params.get("bracketLabel");
        const derivedLabel = labelParam ?? (
          minVal === 0 ? `< ${Math.round(maxVal * 100)}%`
          : maxVal >= 1 ? `${Math.round(minVal * 100)}–100%`
          : `${Math.round(minVal * 100)}–${Math.round(maxVal * 100)}%`
        );
        return { label: derivedLabel, minConfidence: minVal, maxConfidence: maxVal };
      }
    }
    try {
      const stored = localStorage.getItem(`job-detail.${jobId}.confidenceBracketFilter`);
      if (stored !== null) return JSON.parse(stored) as ConfidenceBracket;
    } catch {}
    return null;
  });
  const setConfidenceBracketFilter = useCallback((value: ConfidenceBracket | null) => {
    try {
      if (value === null) {
        localStorage.removeItem(`job-detail.${jobId}.confidenceBracketFilter`);
      } else {
        localStorage.setItem(`job-detail.${jobId}.confidenceBracketFilter`, JSON.stringify(value));
      }
    } catch {}
    const url = new URL(window.location.href);
    if (value === null) {
      url.searchParams.delete("bracketMin");
      url.searchParams.delete("bracketMax");
      url.searchParams.delete("bracketLabel");
    } else {
      url.searchParams.set("bracketMin", String(value.minConfidence));
      url.searchParams.set("bracketMax", String(value.maxConfidence));
      url.searchParams.set("bracketLabel", value.label);
    }
    window.history.replaceState(null, "", url.toString());
    setConfidenceBracketFilterBase(value);
  }, [jobId]);

  const [showUnspecifiedOnly, setShowUnspecifiedOnly] = useState(false);
  const filtersAreDefault = !showAiVisionOnly && !showDismissed && !showLowConfidenceOnly && !showUnspecifiedOnly && confidenceSortDir === null && confidenceBracketFilter === null;

  const resetFilters = useCallback(() => {
    setShowAiVisionOnlyBase(false);
    setShowDismissedBase(false);
    setShowLowConfidenceOnlyBase(false);
    setShowUnspecifiedOnly(false);
    setConfidenceSortDirBase(null);
    setConfidenceBracketFilterBase(null);
    try {
      localStorage.removeItem(`job-detail.${jobId}.showAiVisionOnly`);
      localStorage.removeItem(`job-detail.${jobId}.showDismissed`);
      localStorage.removeItem(`job-detail.${jobId}.showLowConfidenceOnly`);
      localStorage.removeItem(`job-detail.${jobId}.confidenceSortDir`);
      localStorage.removeItem(`job-detail.${jobId}.confidenceBracketFilter`);
    } catch {}
    const url = new URL(window.location.href);
    url.searchParams.delete("showAiVisionOnly");
    url.searchParams.delete("showDismissed");
    url.searchParams.delete("showLowConfidenceOnly");
    url.searchParams.delete("confidenceSortDir");
    url.searchParams.delete("bracketMin");
    url.searchParams.delete("bracketMax");
    url.searchParams.delete("bracketLabel");
    window.history.replaceState(null, "", url.toString());
  }, [jobId]);
  const [errorStepLogOpen, setErrorStepLogOpen] = usePersistedState(`error-step-log-open-${jobId}`, true);
  const [processingStepLogOpen, setProcessingStepLogOpen] = useState(true);
  const [completedStepLogOpen, setCompletedStepLogOpen] = useState(false);
  const [showAdvancedTabs, setShowAdvancedTabs] = useState(false);

  const lsKey = `conf-warning-dismissed-${jobId}`;
  const lsKeyVal = `val-warning-dismissed-${jobId}`;

  const dismissRoomWarningsMutation = useDismissRoomWarnings();

  const getDismissedValIds = useCallback((): string[] => {
    try {
      const raw = localStorage.getItem(lsKeyVal);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  }, [lsKeyVal]);

  const pendingRoomIds = rooms
    ? new Set(rooms.filter(r => r.reviewStatus === "pending").map(r => r.id))
    : new Set<string>();

  const _pendingSignCount = signs
    ? signs.filter(s => s.roomId != null && pendingRoomIds.has(s.roomId)).length
    : null;

  const _pendingRoomsWithSigns = (() => {
    if (!rooms || !signs) return [];
    const roomIdsWithSigns = new Set(
      signs
        .filter(s => s.roomId != null && pendingRoomIds.has(s.roomId))
        .map(s => s.roomId as string)
    );
    return rooms.filter(r => roomIdsWithSigns.has(r.id));
  })();

  const lowConfidenceAiRooms = rooms
    ? rooms.filter(r => r.source === "ai_vision" && Math.round(parseFloat(String(r.confidence ?? "1")) * 100) < lowConfidenceThreshold)
    : [];

  const lowConfidenceIds = lowConfidenceAiRooms.map(r => String(r.id));

  const [dismissedValIds, setDismissedValIds] = useState<string[]>(() => getDismissedValIds());
  const [confidenceWarningLocallyDismissed, setConfidenceWarningLocallyDismissed] = useState(false);
  const [dismissingValIds, setDismissingValIds] = useState<Set<string>>(new Set());
  const dismissValTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    setDismissedValIds(getDismissedValIds());
  }, [jobId, getDismissedValIds]);

  useEffect(() => {
    if (!rooms || !jobId || lowConfidenceIds.length === 0) return;
    try {
      const raw = localStorage.getItem(lsKey);
      if (!raw) return;
      const storedIds: string[] = JSON.parse(raw) as string[];
      if (!storedIds.length) return;
      const needsSeeding = storedIds.filter(id =>
        lowConfidenceIds.includes(id) &&
        rooms.find(r => String(r.id) === id && !r.warningDismissed)
      );
      if (needsSeeding.length > 0) {
        dismissRoomWarningsMutation.mutate(
          { jobId, data: { roomIds: needsSeeding } },
          {
            onSuccess: () => {
              localStorage.removeItem(lsKey);
              queryClient.invalidateQueries({ queryKey: ["listRooms", jobId] });
            },
          },
        );
      } else {
        localStorage.removeItem(lsKey);
      }
    } catch {
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, rooms !== undefined]);

  const reviewedLowConfidenceCount = lowConfidenceAiRooms.filter(r => {
    const backendReviewed = r.reviewStatus === "confirmed" || r.reviewStatus === "dismissed";
    return backendReviewed || r.warningDismissed;
  }).length;

  const showConfidenceWarning =
    !loadingRooms &&
    lowConfidenceAiRooms.some(r => {
      const backendReviewed = r.reviewStatus === "confirmed" || r.reviewStatus === "dismissed";
      return !backendReviewed && !r.warningDismissed;
    });

  const allLowConfidenceReviewed =
    !loadingRooms &&
    lowConfidenceIds.length > 0 &&
    lowConfidenceAiRooms.every(r => {
      const backendReviewed = r.reviewStatus === "confirmed" || r.reviewStatus === "dismissed";
      return backendReviewed || r.warningDismissed;
    });

  const allConfidenceAcknowledged =
    !loadingRooms &&
    lowConfidenceIds.length > 0 &&
    !showConfidenceWarning;

  const validationWarnings = validationResults
    ? validationResults.filter(r => r.status !== "pass")
    : [];

  const allValidationReviewed =
    !loadingValidation &&
    validationResults != null &&
    validationResults.length > 0 &&
    validationWarnings.every(r => dismissedValIds.includes(r.id));

  const handleDismissWarning = () => {
    const undismissedIds = lowConfidenceAiRooms
      .filter(r => !r.warningDismissed)
      .map(r => String(r.id));
    if (undismissedIds.length === 0) return;
    setConfidenceWarningLocallyDismissed(true);
    dismissRoomWarningsMutation.mutate(
      { jobId: jobId!, data: { roomIds: undismissedIds } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["listRooms", jobId] });
        },
        onError: () => {
          setConfidenceWarningLocallyDismissed(false);
        },
      },
    );
  };

  useEffect(() => {
    if (!showConfidenceWarning) {
      setConfidenceWarningLocallyDismissed(false);
    }
  }, [showConfidenceWarning]);

  useEffect(() => {
    const timers = dismissValTimersRef.current;
    return () => {
      timers.forEach(t => clearTimeout(t));
      timers.clear();
    };
  }, [jobId]);

  const handleDismissValidationWarning = (id: string) => {
    if (dismissingValIds.has(id)) return;
    setDismissingValIds(prev => new Set([...prev, id]));
    const existing = dismissValTimersRef.current.get(id);
    if (existing !== undefined) clearTimeout(existing);
    dismissValTimersRef.current.set(
      id,
      setTimeout(() => {
        setDismissedValIds(prev => {
          const next = Array.from(new Set([...prev, id]));
          try { localStorage.setItem(lsKeyVal, JSON.stringify(next)); } catch {}
          return next;
        });
        setDismissingValIds(prev => {
          const s = new Set(prev);
          s.delete(id);
          return s;
        });
        dismissValTimersRef.current.delete(id);
      }, 250),
    );
  };

  const handleDismissAllValidationWarnings = () => {
    const ids = validationWarnings.map(r => r.id).filter(id => !dismissedValIds.includes(id));
    if (ids.length === 0) return;
    setDismissingValIds(prev => new Set([...prev, ...ids]));
    ids.forEach(id => {
      const existing = dismissValTimersRef.current.get(id);
      if (existing !== undefined) clearTimeout(existing);
    });
    const allIds = validationWarnings.map(r => r.id);
    const timer = setTimeout(() => {
      setDismissedValIds(prev => {
        const next = Array.from(new Set([...prev, ...allIds]));
        try { localStorage.setItem(lsKeyVal, JSON.stringify(next)); } catch {}
        return next;
      });
      setDismissingValIds(new Set());
      ids.forEach(id => dismissValTimersRef.current.delete(id));
    }, 250);
    ids.forEach(id => dismissValTimersRef.current.set(id, timer));
  };

  const [thresholdInput, setThresholdInput] = useState<string>("");
  const [thresholdError, setThresholdError] = useState<string | null>(null);

  const [forceAiRescan, setForceAiRescan] = useState(false);
  const [selectedSheetIds, setSelectedSheetIds] = useState<Set<string>>(new Set());

  const [showForceScanDialog, setShowForceScanDialog] = useState(false);
  const [pendingSkippedTitle, setPendingSkippedTitle] = useState<string | null>(null);
  const rescanAreaRef = useRef<HTMLDivElement>(null);

  // Train from this job modal
  const [trainModalOpen, setTrainModalOpen] = useState(false);
  const [trainBatchLabel, setTrainBatchLabel] = useState("");
  const [trainXlsxFile, setTrainXlsxFile] = useState<File | null>(null);
  const [trainIsAnalyzing, setTrainIsAnalyzing] = useState(false);
  const [trainError, setTrainError] = useState<string | null>(null);
  const trainXlsxInputRef = useRef<HTMLInputElement>(null);
  const firstDismissedRoomRef = useRef<HTMLTableRowElement>(null);
  const scrollToDismissedRef = useRef(false);

  const { data: jobSheets, isLoading: loadingSheets } = useListJobSheets(jobId, {
    query: { enabled: !!jobId, queryKey: getListJobSheetsQueryKey(jobId) },
  });

  useEffect(() => {
    if (!pendingSkippedTitle || !jobSheets) return;
    const match = jobSheets.find(s => (s.sheetTitle ?? `Page ${s.pdfPage}`) === pendingSkippedTitle);
    if (match) {
      setSelectedSheetIds(prev => new Set([...prev, match.id]));
    }
    setPendingSkippedTitle(null);
  }, [jobSheets, pendingSkippedTitle]);

  const handleSkippedSheetClick = (title: string) => {
    setForceAiRescan(true);
    setPendingSkippedTitle(title);
    rescanAreaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const [dismissDialogRoomId, setDismissDialogRoomId] = useState<string | null>(null);
  const [dismissReason, setDismissReason] = useState("");
  const [bulkDismissDialogOpen, setBulkDismissDialogOpen] = useState(false);
  const [bulkDismissReason, setBulkDismissReason] = useState("");
  const [bulkResetConfirmedDialogOpen, setBulkResetConfirmedDialogOpen] = useState(false);
  const [bulkConfirmDialog, setBulkConfirmDialog] = useState<{ action: "confirmed" | "pending"; count: number; level?: string } | null>(null);

  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [buildingTypeUpdatedLabel, setBuildingTypeUpdatedLabel] = useState<string | null>(null);

  const processJob = useProcessJob();
  const rescanJob = useRescanJob();
  const reRuleJob = useReRuleJob();
  const cancelJob = useCancelJob();
  const updateJob = useUpdateJob();
  const updateRoomReviewStatus = useUpdateRoomReviewStatus();
  const bulkReviewRooms = useBulkReviewRooms();

  const getListRoomsQueryKey = () => ["listRooms", jobId];

  const [thresholdDirty, setThresholdDirty] = useState(false);

  const [floorPlanDirty, setFloorPlanDirty] = useState(false);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [fpFocusRoomId, setFpFocusRoomId] = useState<string | null>(null);
  const [fpEditRoomId, setFpEditRoomId] = useState<string | null>(null);

  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [editingRoomName, setEditingRoomName] = useState("");
  const [savingRoomId, setSavingRoomId] = useState<string | null>(null);

  const [_editingDoorCountRoomId, setEditingDoorCountRoomId] = useState<string | null>(null);
  const [_editingDoorCountValue, setEditingDoorCountValue] = useState("");
  const [_savingDoorCountRoomId, setSavingDoorCountRoomId] = useState<string | null>(null);

  // Flag override popover state
  const [openFlagRoomId, setOpenFlagRoomId] = useState<string | null>(null);
  const [savingFlagRoomId, setSavingFlagRoomId] = useState<string | null>(null);
  const [editingQtyRoomId, setEditingQtyRoomId] = useState<string | null>(null);
  const [editingQtyValue, setEditingQtyValue] = useState<string>("");
  const [aiTypeBannerDismissed, setAiTypeBannerDismissed] = useState(false);

  const handleViewOnFloorPlan = (roomId: string) => {
    setFpFocusRoomId(roomId);
    handleTabChange("floor-plan");
  };

  const handleEditOnFloorPlan = (roomId: string) => {
    setFpFocusRoomId(roomId);
    setFpEditRoomId(roomId);
    handleTabChange("floor-plan");
  };

  const handleSaveRoomName = async (roomId: string, name: string) => {
    if (!jobId) return;
    setSavingRoomId(roomId);
    try {
      await authFetch(`/api/jobs/${jobId}/rooms/${roomId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName: name }),
      });
      queryClient.invalidateQueries({ queryKey: getListRoomsQueryKey() });
      setEditingRoomId(null);
    } catch {
      toast.error("Failed to save room name");
    } finally {
      setSavingRoomId(null);
    }
  };

  const handleCancelEditRoom = () => {
    setEditingRoomId(null);
    setEditingRoomName("");
  };

  const _handleStartEditDoorCount = (roomId: string, current: number | null | undefined) => {
    setEditingDoorCountRoomId(roomId);
    setEditingDoorCountValue(current != null && current > 0 ? String(current) : "");
  };

  const _handleCancelEditDoorCount = () => {
    setEditingDoorCountRoomId(null);
    setEditingDoorCountValue("");
  };

  const _handleSaveDoorCount = async (roomId: string, raw: string) => {
    if (!jobId) return;
    const parsed = raw.trim() === "" ? null : parseInt(raw, 10);
    if (parsed !== null && (isNaN(parsed) || parsed < 0)) return;
    setSavingDoorCountRoomId(roomId);
    try {
      await authFetch(`/api/jobs/${jobId}/rooms/${roomId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicDoorCount: parsed }),
      });
      queryClient.invalidateQueries({ queryKey: getListRoomsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
      queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
      setEditingDoorCountRoomId(null);
    } catch {
      toast.error("Failed to save door count");
    } finally {
      setSavingDoorCountRoomId(null);
    }
  };

  const handleFlagOverride = async (roomId: string, flag: string, value: boolean) => {
    if (!jobId) return;
    setSavingFlagRoomId(roomId);
    try {
      await authFetch(`/api/jobs/${jobId}/rooms/${roomId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagOverrides: { [flag]: value } }),
      });
      queryClient.invalidateQueries({ queryKey: getListRoomsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
      queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
    } catch {
      toast.error("Failed to save flag override");
    } finally {
      setSavingFlagRoomId(null);
    }
  };

  const handleSaveQty = async (roomId: string) => {
    const parsed = parseInt(editingQtyValue, 10);
    setEditingQtyRoomId(null);
    if (isNaN(parsed) || parsed < 0) return;
    try {
      await authFetch(`/api/jobs/${jobId}/rooms/${roomId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qtyOverride: parsed }),
      });
      queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
      queryClient.invalidateQueries({ queryKey: getListRoomsQueryKey() });
      setReviewDirty(true);
    } catch {
      toast.error("Failed to save quantity override");
    }
  };

  const [detailsForm, setDetailsForm] = useState({ name: "", location: "", buildingType: "" });
  const [detailsDirty, setDetailsDirty] = useState(false);
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<{ type: "tab"; tab: string } | { type: "back" } | null>(null);

  const _stepLogOpen = job?.status === "processing" ? processingStepLogOpen : job?.status === "error" ? errorStepLogOpen : completedStepLogOpen;
  const _setStepLogOpen = job?.status === "processing" ? setProcessingStepLogOpen : job?.status === "error" ? setErrorStepLogOpen : setCompletedStepLogOpen;

  // Reset threshold state when navigating to a different job
  useEffect(() => {
    setThresholdDirty(false);
    setThresholdError(null);
    setThresholdInput(job?.visionThreshold != null ? String(job.visionThreshold) : "");
    setDetailsDirty(false);
    setDetailsForm({
      name: job?.name ?? "",
      location: job?.location ?? "",
      buildingType: job?.buildingType ?? "",
    });
    setSelectedSheetIds(new Set());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const serverThreshold = job?.visionThreshold;

  // Sync threshold input from server value when the user hasn't made local edits
  useEffect(() => {
    if (!thresholdDirty) {
      setThresholdInput(serverThreshold != null ? String(serverThreshold) : "");
    }
  }, [serverThreshold, thresholdDirty]);

  useEffect(() => {
    if (job && !detailsDirty) {
      setDetailsForm({
        name: job.name ?? "",
        location: job.location ?? "",
        buildingType: job.buildingType ?? "",
      });
    }
  }, [job?.name, job?.location, job?.buildingType, detailsDirty, job]);

  useEffect(() => {
    if (!detailsDirty && !thresholdDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [detailsDirty, thresholdDirty]);

  const handleTabChange = (tab: string) => {
    if (job?.status === "processing") {
      userSwitchedTabDuringProcessingRef.current = true;
    }
    if (detailsDirty || thresholdDirty) {
      setPendingNavigation({ type: "tab", tab });
      return;
    }
    if (activeTab === "rooms" && tab !== "rooms") {
      setShowPendingOnly(false);
      setShowDismissedOnly(false);
      setConfidenceBracketFilter(null);
    }
    saveTabWithLru(jobId, tab);
    _baseTabChange(tab);
  };

  const handleConfirmNavigation = () => {
    if (!pendingNavigation) return;
    setDetailsDirty(false);
    setThresholdDirty(false);
    if (pendingNavigation.type === "back") {
      setPendingNavigation(null);
      setLocation("/jobs");
    } else {
      const tab = pendingNavigation.tab;
      if (activeTab === "rooms" && tab !== "rooms") {
        setShowPendingOnly(false);
        setShowDismissedOnly(false);
        setConfidenceBracketFilter(null);
      }
      setPendingNavigation(null);
      saveTabWithLru(jobId, tab);
      _baseTabChange(tab);
    }
  };

  const handleCancelNavigation = () => {
    setPendingNavigation(null);
  };

  /**
   * Calls the /counts endpoint directly (no cache) and writes the result
   * into liveSignCount state so the Overview stats update immediately.
   */
  const fetchAndUpdateSignCount = useCallback(async () => {
    try {
      const res = await authFetch(`/api/jobs/${jobId}/counts`);
      if (res.ok) {
        const data = await res.json() as { totalSigns: number; highConfidence: number; needsReview: number };
        setLiveSignCount(data);
      }
    } catch {
      // Non-fatal — React Query refetch will catch up on next render
    }
  }, [authFetch, jobId]);

  /**
   * Ref that holds the active polling interval started after a dismiss action.
   * The interval fires fetchAndUpdateSignCount every 2 s for up to 5 s then self-cancels.
   */
  const pollCountsRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startCountsPolling = useCallback(() => {
    if (pollCountsRef.current) clearInterval(pollCountsRef.current);
    const deadline = Date.now() + 5000;
    pollCountsRef.current = setInterval(() => {
      if (Date.now() >= deadline) {
        clearInterval(pollCountsRef.current!);
        pollCountsRef.current = null;
        return;
      }
      void fetchAndUpdateSignCount();
    }, 2000);
  }, [fetchAndUpdateSignCount]);

  // Cleanup polling interval on unmount
  useEffect(() => {
    return () => {
      if (pollCountsRef.current) clearInterval(pollCountsRef.current);
    };
  }, []);

  // Fetch specialty signs when job is completed
  useEffect(() => {
    if (!job || job.status !== "completed" || !jobId) return;
    authFetch(`/api/jobs/${jobId}/specialty-signs`)
      .then((res) => res.ok ? res.json() : [])
      .then((data: unknown) => {
        if (Array.isArray(data)) {
          setSpecialtySigns(data as typeof specialtySigns);
        }
      })
      .catch(() => { /* non-fatal */ });
  }, [job, jobId, authFetch]);

  // Fetch live counts immediately on mount so Overview never flashes 0.
  useEffect(() => {
    void fetchAndUpdateSignCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const handleRoomAction = (roomId: string, reviewStatus: "confirmed" | "dismissed" | "pending", dismissalReason?: string) => {
    if (!canAct) return;
    updateRoomReviewStatus.mutate(
      { jobId, roomId, data: { reviewStatus, dismissalReason: dismissalReason ?? null } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListRoomsQueryKey() });
          if (reviewStatus === "dismissed") {
            // Signs were deleted server-side; refresh job totals and sign table
            queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
            queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
            // Force immediate re-fetch so totalSigns on Overview is never stale
            queryClient.refetchQueries({ queryKey: getGetJobQueryKey(jobId) });
            // Immediate live-count pull + short polling window to catch any write lag
            void fetchAndUpdateSignCount();
            startCountsPolling();
            toast.success("Room dismissed and signs removed from count");
          } else if (reviewStatus === "confirmed") {
            toast.success("Room accepted");
          } else {
            // Restore: signs are un-deleted server-side; refresh sign table + counts
            queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
            queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
            void fetchAndUpdateSignCount();
            startCountsPolling();
            toast.success("Room restored");
          }
        },
      },
    );
  };

  const handleDismissConfirm = () => {
    if (!dismissDialogRoomId) return;
    handleRoomAction(dismissDialogRoomId, "dismissed", dismissReason.trim() || undefined);
    setDismissDialogRoomId(null);
    setDismissReason("");
  };

  const handleBulkRoomAction = (reviewStatus: "confirmed" | "dismissed" | "pending", fromStatus?: "confirmed" | "dismissed", level?: string) => {
    if (!canAct) return;
    bulkReviewRooms.mutate(
      { jobId, data: { reviewStatus, ...(fromStatus !== undefined ? { fromStatus } : {}), ...(level !== undefined ? { level } : {}) } },
      {
        onSuccess: (data) => {
          queryClient.invalidateQueries({ queryKey: getListRoomsQueryKey() });
          const count = data.updated;
          if (reviewStatus === "dismissed") {
            queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
            queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
            queryClient.refetchQueries({ queryKey: getGetJobQueryKey(jobId) });
            void fetchAndUpdateSignCount();
            startCountsPolling();
            toast.success(`${count} ${count === 1 ? "room" : "rooms"} dismissed`);
          } else if (reviewStatus === "confirmed") {
            toast.success(`${count} ${count === 1 ? "room" : "rooms"} accepted`);
          } else {
            // Bulk restore: signs are un-deleted server-side; refresh sign table + counts
            queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
            queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
            void fetchAndUpdateSignCount();
            startCountsPolling();
            toast.success(`${count} ${count === 1 ? "room" : "rooms"} restored`);
          }
        },
      },
    );
  };

  const handleBulkDismissConfirm = () => {
    bulkReviewRooms.mutate(
      { jobId, data: { reviewStatus: "dismissed", dismissalReason: bulkDismissReason.trim() || undefined } },
      {
        onSuccess: (data) => {
          // Invalidate all job-related queries so nothing is served from stale cache
          queryClient.invalidateQueries({ queryKey: getListRoomsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
          queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
          // Force an immediate re-fetch of job overview so totalSigns reflects the new value
          queryClient.refetchQueries({ queryKey: getGetJobQueryKey(jobId) });
          // Immediate live-count pull + short polling window to catch any write lag
          void fetchAndUpdateSignCount();
          startCountsPolling();
          setBulkDismissDialogOpen(false);
          setBulkDismissReason("");
          const count = data.updated;
          toast.success(`${count} ${count === 1 ? "room" : "rooms"} dismissed and signs removed from count`);
        },
      },
    );
  };

  const THRESHOLD_MAX = 50;

  const handleSaveThreshold = () => {
    const raw = thresholdInput.trim();
    if (raw === "") {
      setThresholdError(null);
      updateJob.mutate(
        { jobId, data: { visionThreshold: null } },
        {
          onSuccess: () => {
            setThresholdDirty(false);
            queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
            toast.success("Settings saved", { description: "AI vision threshold updated." });
          },
          onError: () => {
            toast.error("Save failed", { description: "Could not update the threshold. Please try again." });
          },
        }
      );
      return;
    }
    const num = Number(raw);
    if (!Number.isInteger(num) || num < 0) {
      setThresholdError("Enter a whole number between 0 and 50, or leave blank to use the default (3).");
      return;
    }
    if (num > THRESHOLD_MAX) {
      setThresholdError(`Maximum allowed value is ${THRESHOLD_MAX}. Values above this rarely improve results.`);
      return;
    }
    setThresholdError(null);
    updateJob.mutate(
      { jobId, data: { visionThreshold: num } },
      {
        onSuccess: () => {
          setThresholdDirty(false);
          queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
          toast.success("Settings saved", { description: "AI vision threshold updated." });
        },
        onError: () => {
          toast.error("Save failed", { description: "Could not update the threshold. Please try again." });
        },
      }
    );
  };

  const handleSaveJobDetails = () => {
    if (!canAct) return;
    const name = detailsForm.name.trim();
    if (!name) {
      toast.error("Name required", { description: "Job name cannot be empty." });
      return;
    }
    setDetailsSaving(true);
    updateJob.mutate(
      {
        jobId,
        data: {
          name,
          location: detailsForm.location.trim(),
          buildingType: detailsForm.buildingType.trim(),
        },
      },
      {
        onSuccess: () => {
          setDetailsDirty(false);
          setDetailsSaving(false);
          queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
          toast.success("Job details saved", { description: "Name, location, and building type updated." });
        },
        onError: () => {
          setDetailsSaving(false);
          toast.error("Save failed", { description: "Could not update job details. Please try again." });
        },
      }
    );
  };

  const handleProcess = () => {
    processJob.mutate({ jobId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
      }
    });
  };

  const handleReRule = () => {
    reRuleJob.mutate({ jobId }, {
      onSuccess: (data) => {
        toast.success(`Keywords re-applied — ${data.totalSignQty} sign${data.totalSignQty === 1 ? "" : "s"} updated`);
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
        queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
        queryClient.invalidateQueries({ queryKey: getGetValidationResultsQueryKey(jobId) });
        queryClient.invalidateQueries({ queryKey: [`/api/jobs/${jobId}/sign-type-distribution`] });
        queryClient.invalidateQueries({ queryKey: [`/api/jobs/${jobId}/confidence-histogram`] });
      },
      onError: (err: unknown) => {
        const msg = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : "Failed to re-apply keywords";
        toast.error(msg);
      },
    });
  };

  const handleRescan = () => {
    if (forceAiRescan) {
      setShowForceScanDialog(true);
      return;
    }
    doRescan();
  };

  const doRescan = () => {
    // Force full re-process always clears ALL cached state — the pipeline
    // runs from scratch across all sheets.
    // Send both forceReprocess and forceAiRescan so the route handler accepts
    // either field name regardless of which alias it checks first.
    const payload = { forceAiRescan: forceAiRescan, forceReprocess: forceAiRescan, forceRescanSheetIds: [] };
    console.log('[RESCAN-FRONTEND] Force checkbox state:', forceAiRescan);
    console.log('[RESCAN-FRONTEND] Payload being sent:', JSON.stringify(payload));
    console.log('[RESCAN-FRONTEND] API endpoint:', `/api/jobs/${jobId}/rescan`);
    rescanJob.mutate({ jobId, data: payload }, {
      onSuccess: () => {
        setForceAiRescan(false);
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
      }
    });
  };

  const handleTrainAnalyze = async () => {
    if (!trainXlsxFile || !job) return;
    setTrainIsAnalyzing(true);
    setTrainError(null);
    try {
      const XLSX_MAX = 5 * 1024 * 1024;
      if (trainXlsxFile.size > XLSX_MAX) {
        throw new Error("Takeoff spreadsheet exceeds 5MB limit");
      }
      const contentType = trainXlsxFile.name.toLowerCase().endsWith(".xlsx")
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : trainXlsxFile.name.toLowerCase().endsWith(".xls")
        ? "application/vnd.ms-excel"
        : "text/csv";
      const urlRes = await authFetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trainXlsxFile.name, size: trainXlsxFile.size, contentType }),
      });
      if (!urlRes.ok) throw new Error("Failed to get upload URL");
      const { uploadURL, objectPath } = await urlRes.json() as { uploadURL: string; objectPath: string };
      const putRes = await fetch(uploadURL, { method: "PUT", body: trainXlsxFile, headers: { "Content-Type": contentType } });
      if (!putRes.ok) throw new Error("Failed to upload spreadsheet");
      const xlsxStoragePath = objectPath;

      const planFile = (jobFiles ?? []).find(f => !f.fileCategory || f.fileCategory === "floor_plan");
      const pdfStoragePath = (planFile as { storagePath?: string } | undefined)?.storagePath;

      const importRes = await authFetch("/api/training/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          xlsxStoragePath,
          xlsxFileName: trainXlsxFile.name,
          ...(pdfStoragePath ? { pdfStoragePath } : {}),
          sourceJobId: jobId,
        }),
      });
      if (!importRes.ok) {
        const data = await importRes.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Server error ${importRes.status}`);
      }
      const analyzeResult = await importRes.json();

      sessionStorage.setItem("training_pending_import", JSON.stringify({
        analyzeResult,
        xlsxStoragePath,
        pdfStoragePath,
        batchLabel: trainBatchLabel.trim() || job.name,
        sourceJobId: jobId,
      }));

      setTrainModalOpen(false);
      setLocation("/training?tab=import");
    } catch (err: unknown) {
      setTrainError(err instanceof Error ? err.message : "Failed to analyze");
    } finally {
      setTrainIsAnalyzing(false);
    }
  };

  const xlsxFileName = job
    ? `${(job.name ?? "Takeoff").replace(/[^a-zA-Z0-9_\- ]/g, "").replace(/\s+/g, "_")}_Takeoff_${new Date().toISOString().split("T")[0]}.xlsx`
    : "Takeoff.xlsx";

  const executeDownloadXlsx = async () => {
    setExportingXlsx(true);
    try {
      const res = await authFetch(`/api/jobs/${jobId}/export/xlsx`);
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = xlsxFileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("XLSX export failed:", err);
    } finally {
      setExportingXlsx(false);
    }
  };

  const executeDownloadPdf = async () => {
    setExportingPdf(true);
    try {
      const res = await authFetch(`/api/jobs/${jobId}/export/pdf`);
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${job?.name ?? "takeoff"}-marked-up.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("PDF export failed:", err);
    } finally {
      setExportingPdf(false);
    }
  };

  const handleDownloadXlsx = () => {
    const dismissedCount = (rooms ?? []).filter(r => r.reviewStatus === "dismissed").length;
    if (dismissedCount > 0) {
      setDismissedDownloadDialog({ type: "xlsx", count: dismissedCount });
    } else {
      executeDownloadXlsx();
    }
  };

  const handleDownloadPdf = () => {
    const dismissedCount = (rooms ?? []).filter(r => r.reviewStatus === "dismissed").length;
    if (dismissedCount > 0) {
      setDismissedDownloadDialog({ type: "pdf", count: dismissedCount });
    } else {
      executeDownloadPdf();
    }
  };

  if (loadingJob) {
    return <div className="p-8 flex justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  if (!job) {
    return <div className="p-8 text-center text-muted-foreground">Job not found</div>;
  }

  const floorPlanSheets = (jobSheets ?? []).filter((s) => s.sheetType === "floor_plan");
  const sheetsBeingScanned = selectedSheetIds.size > 0
    ? floorPlanSheets.filter((s) => selectedSheetIds.has(s.id))
    : floorPlanSheets;
  const freshScanSheetCount = sheetsBeingScanned.length;
  const freshScanSheetLabel = `${freshScanSheetCount} sheet${freshScanSheetCount === 1 ? "" : "s"}`;

  const cachedSheetCount = sheetsBeingScanned.filter((s) => s.hasCachedResult).length;

  const roomVerificationScans = (aiScans ?? []).filter((s) => s.callType === "room_verification");
  const FALLBACK_COST_PER_SHEET = 0.09;
  const avgCostPerSheet =
    roomVerificationScans.length > 0
      ? roomVerificationScans.reduce((sum, s) => sum + parseFloat((s.cost as unknown as string) ?? "0"), 0) /
        roomVerificationScans.length
      : null;
  const costPerSheetForEstimate = avgCostPerSheet ?? FALLBACK_COST_PER_SHEET;
  const estimatedCacheSavings =
    cachedSheetCount > 0 ? costPerSheetForEstimate * cachedSheetCount : null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-shrink-0 overflow-y-auto max-h-[60vh] border-b px-4 sm:px-6 py-3 flex flex-col gap-3">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <Button 
            variant="ghost" 
            className="mb-4 -ml-4 text-muted-foreground hover:text-foreground"
            onClick={() => {
              if (detailsDirty || thresholdDirty) {
                setPendingNavigation({ type: "back" });
              } else {
                setLocation("/jobs");
              }
            }}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Jobs
          </Button>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{job.name}</h1>
            <Badge variant={
              job.status === 'completed' ? 'default' :
              job.status === 'processing' ? 'secondary' :
              job.status === 'error' ? 'destructive' : 'outline'
            } className="capitalize">
              {job.status === 'processing' && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              {job.status}
            </Badge>
            {job.status === 'processing' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-red-500 hover:text-red-400 hover:bg-red-500/10"
                    onClick={() => setCancelConfirmOpen(true)}
                    disabled={cancelJob.isPending}
                  >
                    {cancelJob.isPending
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <XCircle className="h-4 w-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Hard-kill processing</TooltipContent>
              </Tooltip>
            )}
          </div>
          {(job.location || job.buildingType || job.visionThreshold != null) && (
            <p className="text-muted-foreground mt-1">
              {[
                job.location,
                job.buildingType,
                job.visionThreshold != null ? getVisionThresholdLabel(job.visionThreshold) : null,
              ]
                .filter(Boolean)
                .join(" • ")}
            </p>
          )}
          {/* AI Building Type Detection Banner */}
          {(() => {
            const aiType = (job as unknown as Record<string, unknown>).aiDetectedBuildingType as string | null | undefined;
            const aiConf = parseFloat(String((job as unknown as Record<string, unknown>).aiDetectedTypeConfidence ?? "0"));
            if (!aiType || (job.buildingType && job.buildingType !== "unknown") || aiTypeBannerDismissed) return null;
            const isHighConf = aiConf >= 0.8;
            const isMidConf = aiConf >= 0.5 && aiConf < 0.8;
            if (!isHighConf && !isMidConf) return null;
            return (
              <div className={`mt-2 flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                isHighConf
                  ? "bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200"
                  : "bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200"
              }`}>
                <Sparkles className="h-3.5 w-3.5 shrink-0" />
                <span>AI detected building type: <strong className="capitalize">{aiType}</strong> ({Math.round(aiConf * 100)}% confidence)</span>
                <button
                  type="button"
                  className="ml-auto text-xs underline hover:no-underline"
                  onClick={() => {
                    updateJob.mutate({ jobId, data: { buildingType: aiType as string } });
                    setAiTypeBannerDismissed(true);
                  }}
                >
                  Use this type
                </button>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setAiTypeBannerDismissed(true)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })()}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="bg-amber-500 hover:bg-amber-600 text-white"
            onClick={handleDownloadXlsx}
            disabled={exportingXlsx}
            title="Download XLSX takeoff"
          >
            {exportingXlsx ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            <span className="ml-1">Download XLSX</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownloadPdf}
            disabled={exportingPdf}
            title="Download marked-up PDF"
          >
            {exportingPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            <span className="ml-1 hidden sm:inline">PDF</span>
          </Button>
          <div className="flex items-center gap-0">
            <Button
              variant="outline"
              size="sm"
              className="rounded-r-none border-r-0"
              onClick={() => { window.open(`/api/jobs/${jobId}/export/handoff-pdf`, '_blank'); }}
              title="Download handoff report PDF"
            >
              <FileDown className="h-4 w-4" />
              <span className="ml-1 hidden sm:inline">Handoff Report</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="rounded-l-none px-2">
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => { window.open(`/api/jobs/${jobId}/export/handoff-pdf`, '_blank'); }}>
                  Download without pricing
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { window.open(`/api/jobs/${jobId}/export/handoff-pdf?includePricing=true`, '_blank'); }}>
                  Download with pricing
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {canAct && (
            <>
              <div ref={rescanAreaRef} className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none" title="Clear all cached results and re-run the complete pipeline from scratch">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-primary"
                    checked={forceAiRescan}
                    onChange={e => {
                      setForceAiRescan(e.target.checked);
                      if (!e.target.checked) setSelectedSheetIds(new Set());
                    }}
                    disabled={rescanJob.isPending || processJob.isPending || job.status === 'processing'}
                  />
                  Force full re-process
                </label>
                {estimatedCacheSavings != null && !forceAiRescan && (
                  <span className="text-xs text-green-600 dark:text-green-400 font-medium whitespace-nowrap">
                    ~${estimatedCacheSavings.toFixed(2)} saved by reusing {cachedSheetCount} cached {cachedSheetCount === 1 ? "sheet" : "sheets"}
                  </span>
                )}
                <Button 
                  variant={job.status === "completed" ? "default" : "outline"}
                  className={job.status === "completed" ? "bg-blue-600 hover:bg-blue-700 text-white" : ""}
                  onClick={handleRescan} 
                  disabled={rescanJob.isPending || processJob.isPending || reRuleJob.isPending || job.status === 'processing'}
                >
                  {rescanJob.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                  Rescan
                </Button>
                {isAdmin && job.status === "completed" && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setTrainBatchLabel(job.name ?? "");
                      setTrainXlsxFile(null);
                      setTrainError(null);
                      setTrainModalOpen(true);
                    }}
                    disabled={rescanJob.isPending || processJob.isPending}
                  >
                    <GraduationCap className="h-4 w-4 mr-2" />
                    Train
                  </Button>
                )}
              </div>
              {isAdmin && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    onClick={handleReRule}
                    disabled={rescanJob.isPending || processJob.isPending || reRuleJob.isPending || job.status === 'processing' || job.status === 'pending'}
                  >
                    {reRuleJob.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Wand2 className="h-4 w-4 mr-2" />}
                    Re-apply Keywords
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs text-center">
                  Re-run the rules engine on existing rooms using the latest custom keywords — no AI calls, completes instantly
                </TooltipContent>
              </Tooltip>
              )}
              {job.status !== "completed" && (
                <Button 
                  onClick={handleProcess} 
                  disabled={rescanJob.isPending || processJob.isPending || reRuleJob.isPending || job.status === 'processing'}
                >
                  {processJob.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
                  Process
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {job.status === "error" && (() => {
        const meta = job.metadata as Record<string, unknown>;
        const errMsg = getErrorMessage(meta);
        const failedAt = getProgress(meta);
        const failedAtTs = getFailedAt(meta);
        const failedAtDate = failedAtTs ? new Date(failedAtTs) : null;
        const failedAtTime =
          failedAtDate && !Number.isNaN(failedAtDate.getTime())
            ? failedAtDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
            : null;
        const steps = getSteps(meta);
        const jobStartedAt =
          typeof meta.processingStartedAt === "string" ? meta.processingStartedAt
          : typeof meta.startedAt === "string" ? meta.startedAt
          : typeof (meta.progress as Record<string, unknown> | undefined)?.startedAt === "string"
            ? (meta.progress as Record<string, unknown>).startedAt as string
            : steps[0]?.startedAt ?? null;
        const elapsedMs =
          failedAtTs && jobStartedAt
            ? new Date(failedAtTs).getTime() - new Date(jobStartedAt).getTime()
            : null;
        const elapsedLabel = elapsedMs != null && elapsedMs > 0 ? formatElapsed(elapsedMs) : null;
        return (
          <div ref={errorBannerRef} className={`rounded-lg border border-destructive/50 bg-destructive/10 p-5 space-y-3${highlightBanner ? " banner-highlight" : ""}`}>
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-destructive">
                  Processing failed{failedAtTime ? ` at ${failedAtTime}` : ""}{elapsedLabel ? ` after ${elapsedLabel}` : ""}
                </p>
                {failedAt && (
                  <p className="mt-1 text-xs font-medium text-red-400">
                    Failed at step {failedAt.step} of {failedAt.totalSteps}: {failedAt.label}
                  </p>
                )}
                {errMsg ? (
                  <p className="mt-1 text-sm text-red-400 whitespace-pre-wrap break-words">{errMsg}</p>
                ) : (
                  <p className="mt-1 text-sm text-red-400">
                    An unexpected error occurred during processing. Check the logs or retry below.
                  </p>
                )}
                {failedAt?.retryLog && failedAt.retryLog.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-red-400 flex items-center gap-1">
                      <RotateCcw className="h-3 w-3 shrink-0" />
                      The AI retried {failedAt.retryLog.length} time{failedAt.retryLog.length !== 1 ? "s" : ""} before giving up:
                    </p>
                    {failedAt.retryLog.map((event, idx) => (
                      <div key={idx} className="text-xs text-red-400 flex items-start gap-2 pl-4">
                        <span className="shrink-0 font-medium">Attempt {event.attempt + 1}:</span>
                        <span className="text-red-300 font-medium">{formatErrorType(event.errorType)}</span>
                        <span className="text-red-400/80">during &quot;{event.stepLabel}&quot;</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {canAct && (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={handleProcess}
                  disabled={processJob.isPending || rescanJob.isPending}
                  className="shrink-0"
                >
                  {processJob.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  Retry
                </Button>
              )}
            </div>
            {steps.length > 0 && (
              <div className="border-t border-destructive/20 pt-3">
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-xs font-medium text-destructive/60 hover:text-destructive transition-colors"
                  onClick={() => _setStepLogOpen((v) => !v)}
                >
                  {_stepLogOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  {_stepLogOpen ? "Hide" : "Show"} step log ({steps.length} step{steps.length !== 1 ? "s" : ""})
                </button>
                {_stepLogOpen && (
                  <ol className="mt-2 space-y-1">
                    {steps.map((s, i) => (
                      <li
                        key={`${s.startedAt}-${s.step}-${i}`}
                        className={[
                          "rounded px-2 py-1 text-xs",
                          s.status === "failed" ? "bg-destructive/10 text-destructive font-medium" : "",
                        ].join(" ")}
                      >
                        <div className="flex items-center gap-2">
                          {s.status === "failed" ? (
                            <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                          ) : s.status === "running" ? (
                            <Clock className="h-3.5 w-3.5 shrink-0 text-destructive/60" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                          )}
                          <span className={["tabular-nums w-12 shrink-0", s.status === "failed" ? "text-destructive/70" : "text-destructive/40"].join(" ")}>
                            Step {s.step}
                          </span>
                          <span className={["flex-1 truncate", s.status === "failed" ? "text-destructive" : "text-destructive/60"].join(" ")}>
                            {s.label}
                          </span>
                          {s.durationMs !== undefined ? (
                            <span className={["tabular-nums shrink-0", s.status === "failed" ? "text-destructive/60" : "text-destructive/40"].join(" ")}>
                              {formatDuration(s.durationMs)}
                            </span>
                          ) : s.startedAt ? (
                            <span className="tabular-nums shrink-0 text-destructive/50">
                              {formatDuration(Date.now() - new Date(s.startedAt).getTime())}
                            </span>
                          ) : null}
                        </div>
                        {s.step === 6 && s.sheetResults && s.sheetResults.length > 0 && (
                          <Step6SheetResultsList results={s.sheetResults} />
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {job.status === "processing" && (() => {
        const meta = job.metadata as Record<string, unknown>;
        const progress = getProgress(meta);
        const pct = progress ? Math.round(((progress.step - 1) / progress.totalSteps) * 100) : 0;
        const elapsed = progress ? calcSecondsElapsed(progress.startedAt) : 0;
        // Before the first step reports progress, fall back to a sheet-scaled
        // estimate derived from the per-sheet value the server wrote to metadata.
        // If sheet count or per-sheet rate is unavailable, use the fixed fallback.
        // Also subtract elapsed time from processingStartedAt so users who refresh
        // mid-startup see an accurate remaining countdown.
        const perSheetEstimate = typeof meta.estimatedSecondsPerSheet === "number"
          ? meta.estimatedSecondsPerSheet
          : 30;
        const sheetCount = jobSheets?.length ?? 0;
        const scaledPlaceholder = sheetCount > 0
          ? Math.max(PLACEHOLDER_ESTIMATED_SECONDS, sheetCount * perSheetEstimate)
          : PLACEHOLDER_ESTIMATED_SECONDS;
        const elapsedSinceStart = (() => {
          const startedAt = typeof meta?.processingStartedAt === "string" ? meta.processingStartedAt : null;
          if (!startedAt) return 0;
          return calcSecondsElapsed(startedAt);
        })();
        const remaining = progress
          ? Math.max(0, progress.estimatedTotalSeconds - elapsed)
          : Math.max(0, scaledPlaceholder - elapsedSinceStart);

        return (
          <div className="rounded-lg border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span>
                  {progress
                    ? `Step ${progress.step} of ${progress.totalSteps}: ${progress.label}`
                    : "Starting pipeline…"}
                </span>
              </div>
              {remaining !== null && remaining > 0 && (
                <PipelineCountdown serverRemaining={remaining} />
              )}
            </div>
            <Progress value={pct} className="h-2" />
            {progress && (
              <div className="flex flex-wrap gap-1.5">
                {Array.from({ length: progress.totalSteps }, (_, i) => {
                  const done = i < progress.step - 1;
                  const active = i === progress.step - 1;
                  return (
                    <div
                      key={i}
                      className={[
                        "h-2 flex-1 min-w-[20px] rounded-full transition-colors",
                        done
                          ? "bg-primary"
                          : active
                          ? "bg-primary/50 animate-pulse"
                          : "bg-muted",
                      ].join(" ")}
                      title={`Step ${i + 1}`}
                    />
                  );
                })}
              </div>
            )}
            <div className="text-xs text-muted-foreground text-center">
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground transition-colors"
                onClick={() => {
                  handleTabChange("overview");
                  setTimeout(() => {
                    document.getElementById("pipeline-log")?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }, 50);
                }}
              >
                See step details in Overview
              </button>
            </div>
            {progress?.retryLog && progress.retryLog.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 p-3 space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                  <RotateCcw className="h-3.5 w-3.5" />
                  AI retried {progress.retryLog.length} time{progress.retryLog.length !== 1 ? "s" : ""} — {(job.status as string) === "error" ? "job still failed" : "recovered successfully"}
                </div>
                {progress.retryLog.map((event, idx) => (
                  <div key={idx} className="text-xs text-amber-600 dark:text-amber-500 flex items-start gap-2 pl-5">
                    <span className="shrink-0 font-medium">Attempt {event.attempt + 1}:</span>
                    <span className="text-amber-700 dark:text-amber-400 font-medium">{formatErrorType(event.errorType)}</span>
                    <span className="text-muted-foreground">during &quot;{event.stepLabel}&quot;</span>
                    <span className="shrink-0 text-muted-foreground ml-auto">{formatRelativeTime(event.timestamp)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {(job.status === "completed" || job.status === "error") && (() => {
        const meta = job.metadata as Record<string, unknown>;
        const steps = getSteps(meta);
        if (steps.length === 0) return null;
        const totalMs = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
        return (
          <div className="rounded-lg border bg-card p-5">
            <button
              type="button"
              className="flex items-center gap-2 w-full text-left"
              onClick={() => setCompletedStepLogOpen((v) => !v)}
            >
              {job.status === "error" ? (
                <XCircle className="h-4 w-4 text-destructive shrink-0" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
              )}
              <span className="flex-1 text-sm font-medium">
                {job.status === "error" ? "Processing failed" : "Processing complete"}
              </span>
              {totalMs > 0 && (
                <span className="text-xs text-muted-foreground">{formatDuration(totalMs)} total</span>
              )}
              <span className="text-xs text-muted-foreground mr-1">
                {steps.length} step{steps.length !== 1 ? "s" : ""}
              </span>
              {completedStepLogOpen ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
            {completedStepLogOpen && (
              <ol className="mt-3 space-y-1 border-t pt-3">
                {steps.map((s) => (
                  <li
                    key={s.step}
                    className="rounded px-2 py-1 text-xs text-muted-foreground"
                  >
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      <span className="tabular-nums text-muted-foreground/60 w-12 shrink-0">
                        Step {s.step}
                      </span>
                      <span className="flex-1 truncate">{s.label}</span>
                      {s.durationMs !== undefined && (
                        <span className="tabular-nums shrink-0 text-muted-foreground/50">
                          {formatDuration(s.durationMs)}
                        </span>
                      )}
                    </div>
                    {s.step === 6 && s.sheetResults && s.sheetResults.length > 0 && (
                      <Step6SheetResultsList results={s.sheetResults} />
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        );
      })()}

      {(() => {
        const { count: skipped, titles: skippedTitles } = getAiVisionSheetsSkipped(job.metadata as Record<string, unknown>);
        if (skipped === 0 || job.status === "processing") return null;
        const canReprocess = canAct && (job.status === "completed" || job.status === "error");
        return (
          <div className="mb-6">
            <SkippedSheetsWarning
              skipped={skipped}
              skippedTitles={skippedTitles}
              canReprocess={canReprocess}
              canAct={canAct}
              onReprocess={handleRescan}
              onSheetClick={handleSkippedSheetClick}
              reprocessPending={rescanJob.isPending || processJob.isPending}
            />
          </div>
        );
      })()}

      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="flex-shrink-0 px-4 sm:px-6 flex items-end border-b border-border overflow-x-auto">
          <TabsList className="flex-1 [border-bottom:none] min-w-0">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="rooms">
              <span className="flex items-center gap-1.5">
                Review
                <DirtyDot show={reviewDirty} />
                {signTableVerifiedFilter && (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-green-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-green-600 dark:text-green-400">
                    Verified
                  </span>
                )}
              </span>
            </TabsTrigger>
            <TabsTrigger value="egress">Egress</TabsTrigger>
            <TabsTrigger value="specialty">Specialty</TabsTrigger>
            <TabsTrigger value="floor-plan">
              <span className="flex items-center gap-1.5">
                Plans
                <DirtyDot show={floorPlanDirty} />
              </span>
            </TabsTrigger>
            <TabsTrigger value="sign-schedule">Schedule</TabsTrigger>
            <TabsTrigger value="export">Export</TabsTrigger>
            {showAdvancedTabs && (
              <>
                <TabsTrigger value="sign-type-summary">
                  <span className="flex items-center gap-1.5">
                    <BarChart3 className="h-3.5 w-3.5" />
                    Summary
                  </span>
                </TabsTrigger>
                <TabsTrigger value="confidence">
                  <span className="flex items-center gap-1">
                    Quality
                    {confidenceBracketFilter !== null && (
                      <span className="inline-block w-2 h-2 rounded-full bg-blue-500" aria-label="Bracket filter active" />
                    )}
                    {allConfidenceAcknowledged && (
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-500" aria-label="All flagged confidence items reviewed" />
                    )}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="ai-scans">AI Scans</TabsTrigger>
                <TabsTrigger value="validation">
                  <span className="flex items-center gap-1">
                    Validation
                    {allValidationReviewed && (
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-500" aria-label="All validation warnings reviewed" />
                    )}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="files">Files</TabsTrigger>
                <TabsTrigger value="sheets">Sheets</TabsTrigger>
                <TabsTrigger value="settings">
                  <span className="flex items-center gap-1.5">
                    Settings
                    <DirtyDot show={detailsDirty || thresholdDirty} />
                  </span>
                </TabsTrigger>
              </>
            )}
          </TabsList>
          <button
            type="button"
            onClick={() => setShowAdvancedTabs(v => !v)}
            className="shrink-0 ml-2 mb-2 flex items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground border border-border rounded-md transition-colors whitespace-nowrap"
          >
            Advanced {showAdvancedTabs ? '▲' : '▾'}
          </button>
        </div>

        <div className="mt-2 border rounded-lg bg-card flex-1 min-h-0 overflow-hidden flex flex-col mx-4 sm:mx-6 mb-4">
          <TabsContent value="overview" className="mt-0 p-6 overflow-y-auto">
            {(() => {
              const reconcileWarnings = getReconciliationWarnings(job.metadata as Record<string, unknown>);
              if (reconcileWarnings.length === 0) return null;
              return (
                <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-700 px-4 py-3 flex items-start gap-3 text-red-800 dark:text-red-300 mb-4">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div className="flex-1 text-sm">
                    <p className="font-semibold mb-1">Reconciliation {reconcileWarnings.length === 1 ? "Warning" : "Warnings"}</p>
                    <ul className="space-y-0.5 list-disc list-inside">
                      {reconcileWarnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                      Review the sign schedule and floor plans to confirm coverage before submitting.
                    </p>
                  </div>
                </div>
              );
            })()}
            <Card className="mb-6">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Job Details</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground text-xs mb-0.5">Location</dt>
                    <dd className="font-medium">{job.location || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs mb-0.5">Building Type</dt>
                    <dd>
                      {canAct ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-sm font-medium hover:bg-accent transition-colors">
                              {job.buildingType ? (
                                <>
                                  <span>{getBuildingTypeOption(job.buildingType)?.icon ?? "🏢"}</span>
                                  <span>{getBuildingTypeLabel(job.buildingType)}</span>
                                </>
                              ) : (
                                <span className="text-muted-foreground">Set type</span>
                              )}
                              <ChevronDown className="h-3 w-3 opacity-50 ml-0.5" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="w-48">
                            {CANONICAL_BUILDING_TYPES.map((bt) => (
                              <DropdownMenuItem
                                key={bt.value}
                                className="gap-2"
                                onSelect={() => {
                                  if (bt.value === job.buildingType) return;
                                  updateJob.mutate(
                                    { jobId, data: { buildingType: bt.value } },
                                    {
                                      onSuccess: () => {
                                        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
                                        setBuildingTypeUpdatedLabel(bt.label);
                                      },
                                    }
                                  );
                                }}
                              >
                                <span>{bt.icon}</span>
                                <span>{bt.label}</span>
                                {job.buildingType === bt.value && <Check className="h-3.5 w-3.5 ml-auto" />}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <span className="font-medium">
                          {job.buildingType ? (
                            <>{getBuildingTypeOption(job.buildingType)?.icon ?? ""} {getBuildingTypeLabel(job.buildingType)}</>
                          ) : (
                            <span className="text-muted-foreground font-normal">Not set</span>
                          )}
                        </span>
                      )}
                    </dd>
                    {buildingTypeUpdatedLabel && (
                      <div className="mt-2 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 flex flex-col gap-1.5">
                        <p>Building type updated to <strong>{buildingTypeUpdatedLabel}</strong>. Re-process to apply updated sign rules?</p>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-xs px-2 border-amber-400 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20"
                            onClick={() => {
                              setBuildingTypeUpdatedLabel(null);
                              handleReRule();
                            }}
                            disabled={reRuleJob.isPending || job.status === "processing"}
                          >
                            Re-process Now
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 text-xs px-2"
                            onClick={() => setBuildingTypeUpdatedLabel(null)}
                          >
                            Later
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs mb-0.5">Scope</dt>
                    <dd className="font-medium">
                      {job.scopeFlag === "restroom_only"
                        ? <span className="inline-flex items-center gap-1 text-amber-400 font-semibold text-xs uppercase tracking-wide">Restroom Only</span>
                        : <span className="text-muted-foreground font-normal">Full building</span>}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4 mb-6">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Total Signs</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {liveSignCount?.totalSigns ?? job.totalSigns}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">High Confidence</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-emerald-500">
                    {liveSignCount?.highConfidence ?? job.highConfidence}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Needs Review</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-amber-500">
                    {liveSignCount?.needsReview ?? job.needsReview}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">AI Cost</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">${job.aiTokenCost?.toFixed(2)}</div>
                </CardContent>
              </Card>
            </div>
            
            {(job.status === "completed" || job.status === "error") && (() => {
              const meta = job.metadata as Record<string, unknown>;
              const retryLog = getProgress(meta)?.retryLog;
              if (!retryLog || retryLog.length === 0) return null;
              return (
                <Card className="mb-6 border-amber-200 dark:border-amber-900/50 bg-amber-50/60 dark:bg-amber-950/20">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2 text-amber-700 dark:text-amber-400">
                      <RotateCcw className="h-4 w-4" />
                      AI retried {retryLog.length} time{retryLog.length !== 1 ? "s" : ""} during this run
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-1">
                    {retryLog.map((event, idx) => (
                      <div key={idx} className="text-xs text-amber-600 dark:text-amber-500 flex items-start gap-2 pl-1">
                        <span className="shrink-0 font-medium">Attempt {event.attempt + 1}:</span>
                        <span className="text-amber-700 dark:text-amber-400 font-medium">{formatErrorType(event.errorType)}</span>
                        <span className="text-muted-foreground">during &quot;{event.stepLabel}&quot;</span>
                        <span className="shrink-0 text-muted-foreground ml-auto">
                          {new Date(event.timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                        </span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              );
            })()}

            {(job.status === "completed" || job.status === "error" || job.status === "processing") && (() => {
              const meta = job.metadata as Record<string, unknown>;
              const steps = getSteps(meta);
              const progressData = getProgress(meta);
              const progress = job.status === "processing" ? progressData : null;
              const failedAtTs = job.status === "error" ? getFailedAt(meta) : null;
              const aiRetryMax = progressData?.aiRetryMax;
              const effectiveBaseDelayMs = progressData?.effectiveBaseDelayMs;
              if (steps.length === 0 && !progress) return null;
              const completedSteps = steps.filter((s) => s.status === "completed");
              const failedStep = steps.find((s) => s.status === "failed");
              const totalMs = steps.reduce((acc, s) => acc + (s.durationMs ?? 0), 0);
              const firstStepDate = steps[0]?.startedAt ? new Date(steps[0].startedAt) : null;
              const firstStepStartedAt =
                firstStepDate && !isNaN(firstStepDate.getTime())
                  ? `${firstStepDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} at ${firstStepDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
                  : null;
              const totalSteps = progress?.totalSteps ?? steps.length;
              const pendingCount = progress ? Math.max(0, totalSteps - steps.length) : 0;
              return (
                <Card id="pipeline-log">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-base">Pipeline log</CardTitle>
                        <CardDescription className="mt-0.5">
                          {firstStepStartedAt && job.status !== "processing" && (
                            <span className="block text-xs">Last run: {firstStepStartedAt}</span>
                          )}
                          {job.status === "processing"
                            ? progress
                              ? `Step ${progress.step} of ${progress.totalSteps}: ${progress.label}`
                              : "Starting pipeline…"
                            : job.status === "error"
                            ? `${completedSteps.length} of ${steps.length} step${steps.length !== 1 ? "s" : ""} completed · failed at step ${failedStep?.step ?? "?"}`
                            : `${steps.length} step${steps.length !== 1 ? "s" : ""} completed`}
                          {totalMs > 0 && ` · ${formatDuration(totalMs)} total`}
                          {(aiRetryMax !== undefined || effectiveBaseDelayMs !== undefined) && (
                            <span className="block text-xs text-muted-foreground/70 mt-0.5">
                              AI retry settings for this run:
                              {aiRetryMax !== undefined && ` max ${aiRetryMax} attempt${aiRetryMax !== 1 ? "s" : ""}`}
                              {aiRetryMax !== undefined && effectiveBaseDelayMs !== undefined && ","}
                              {effectiveBaseDelayMs !== undefined && ` ${effectiveBaseDelayMs.toLocaleString()} ms base delay`}
                            </span>
                          )}
                        </CardDescription>
                      </div>
                      <button
                        type="button"
                        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => _setStepLogOpen((v) => !v)}
                      >
                        {_stepLogOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        {_stepLogOpen ? "Hide" : "Show"}
                      </button>
                    </div>
                  </CardHeader>
                  {_stepLogOpen && (
                    <CardContent className="pt-0">
                      <ol className="space-y-1">
                        {steps.map((s, i) => (
                          <li
                            key={`${s.startedAt}-${s.step}-${i}`}
                            className={[
                              "rounded px-2 py-1 text-xs",
                              s.status === "failed" ? "bg-destructive/10 text-destructive font-medium" : "",
                              s.status === "running" ? "bg-primary/5" : "",
                            ].join(" ")}
                          >
                            <div className="flex items-center gap-2">
                              {s.status === "failed" ? (
                                <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                              ) : s.status === "running" ? (
                                <Loader2 className="h-3.5 w-3.5 shrink-0 text-primary animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                              )}
                              <span className={["tabular-nums w-12 shrink-0", s.status === "failed" ? "text-destructive/70" : "text-muted-foreground/60"].join(" ")}>
                                Step {s.step}
                              </span>
                              <span className={[
                                "flex-1 truncate",
                                s.status === "failed" ? "text-destructive" : s.status === "running" ? "text-foreground font-medium" : "text-foreground/80",
                              ].join(" ")}>
                                {s.label}
                              </span>
                              {s.durationMs !== undefined ? (
                                <span className={["tabular-nums shrink-0", s.status === "failed" ? "text-destructive/60" : "text-muted-foreground/50"].join(" ")}>
                                  {formatDuration(s.durationMs)}
                                </span>
                              ) : s.status === "running" && s.startedAt && failedAtTs ? (
                                <span className="tabular-nums shrink-0 text-destructive/60 text-xs">
                                  {formatDuration(new Date(failedAtTs).getTime() - new Date(s.startedAt).getTime())}
                                </span>
                              ) : s.status === "running" && s.startedAt ? (
                                <span className="tabular-nums shrink-0 text-primary/60 animate-pulse text-xs">
                                  running…
                                </span>
                              ) : null}
                            </div>
                            {s.step === 6 && s.sheetResults && s.sheetResults.length > 0 && (
                              <Step6SheetResultsList results={s.sheetResults} />
                            )}
                          </li>
                        ))}
                        {Array.from({ length: pendingCount }, (_, i) => {
                          const stepNum = steps.length + i + 1;
                          return (
                            <li
                              key={`pending-${stepNum}`}
                              className="flex items-center gap-2 rounded px-2 py-1 text-xs opacity-40"
                            >
                              <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <span className="tabular-nums w-12 shrink-0 text-muted-foreground/60">
                                Step {stepNum}
                              </span>
                              <span className="flex-1 truncate text-muted-foreground">
                                Pending
                              </span>
                            </li>
                          );
                        })}
                      </ol>
                    </CardContent>
                  )}
                </Card>
              );
            })()}

            {jobDone && (
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">Raw output</CardTitle>
                      <CardDescription className="mt-0.5 text-xs">
                        Full pipeline console log — exactly what was saved to the log file
                      </CardDescription>
                    </div>
                    <button
                      type="button"
                      className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setRawLogOpen((v) => !v)}
                    >
                      {rawLogOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      {rawLogOpen ? "Hide" : "Show"}
                    </button>
                  </div>
                </CardHeader>
                {rawLogOpen && (
                  <CardContent className="pt-0">
                    {rawLogLoading ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Loading…
                      </div>
                    ) : !rawLogData?.lines?.length ? (
                      <p className="text-xs text-muted-foreground py-2">
                        No log available — run the pipeline to generate output.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(rawLogData.lines.join("\n"));
                            toast.success("Log copied to clipboard");
                          }}
                          className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          Copy
                        </button>
                        <pre className="text-xs font-mono bg-muted/40 rounded p-3 overflow-x-auto whitespace-pre-wrap break-words max-h-[500px] overflow-y-auto leading-relaxed">
                          {rawLogData.lines.join("\n")}
                        </pre>
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            )}

            <Card>
              <CardContent className="pt-6">
                <StructuredUploader
                  jobId={jobId}
                  authFetch={authFetch}
                  files={(jobFiles ?? []).map(f => ({ ...f, fileCategory: (f as { fileCategory?: string | null }).fileCategory }))}
                  canAct={canAct}
                  onRefresh={() => {
                    queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
                    refetchJobFiles();
                  }}
                  buildingType={job.buildingType ?? ""}
                />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="floor-plan" className="mt-0 flex-1 min-h-0 overflow-hidden flex flex-col">
            <FloorPlanTab
              jobId={jobId}
              onDirtyChange={setFloorPlanDirty}
              focusRoomId={fpFocusRoomId}
              onFocusRoomConsumed={() => setFpFocusRoomId(null)}
              editRoomId={fpEditRoomId}
              onEditRoomClose={() => setFpEditRoomId(null)}
              onSaveRoomName={handleSaveRoomName}
            />
          </TabsContent>

          <TabsContent value="sign-schedule" className="mt-0 p-6 overflow-y-auto">
            {(() => {
              const scheduleFiles = (jobFiles ?? []).filter(f => f.fileCategory === "sign_schedule");
              if (scheduleFiles.length === 0) {
                return (
                  <div className="flex flex-col items-center justify-center p-16 border border-dashed rounded-md gap-4 text-muted-foreground">
                    <FileText className="h-10 w-10 opacity-30" />
                    <div className="text-center">
                      <p className="font-medium text-foreground">No sign schedule uploaded</p>
                      <p className="text-sm mt-1">Upload a PDF and tag it as "Sign Schedule / Specs" to view it here.</p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleTabChange("files")}
                    >
                      Go to Files tab
                    </Button>
                  </div>
                );
              }
              return (
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-medium">Sign Schedule / Specs</h3>
                    <span className="text-sm text-muted-foreground">{scheduleFiles.length} document{scheduleFiles.length !== 1 ? "s" : ""}</span>
                  </div>
                  {scheduleFiles.map(f => {
                    const storagePath = f.storagePath.startsWith("/objects/") ? f.storagePath.slice("/objects/".length) : f.storagePath.replace(/^\//, "");
                    const pdfUrl = `/api/storage/objects/${storagePath}`;
                    return (
                      <div key={f.id} className="border rounded-lg overflow-hidden">
                        <div className="flex items-center justify-between px-4 py-2 bg-muted/40 border-b">
                          <span className="text-sm font-medium truncate flex items-center gap-2">
                            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                            {f.filename}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0 h-7 text-xs gap-1.5"
                            onClick={async () => {
                              try {
                                const res = await authFetch(pdfUrl);
                                const blob = await res.blob();
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = f.filename;
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                                URL.revokeObjectURL(url);
                              } catch { toast.error("Download failed"); }
                            }}
                          >
                            <Download className="h-3.5 w-3.5" />
                            Download
                          </Button>
                        </div>
                        <SignSchedulePdfViewer pdfUrl={pdfUrl} authFetch={authFetch} />
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </TabsContent>
          
          <TabsContent value="rooms" className="mt-0 p-6 overflow-y-auto">
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <h3 className="text-lg font-medium">Sign Table</h3>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {rooms ? `${rooms.length} room${rooms.length !== 1 ? "s" : ""}` : "Loading rooms…"}
                    {rooms && (
                      <>
                        <span className="mx-1">·</span>
                        <span>{liveSignCount?.totalSigns ?? job.totalSigns} sign{(liveSignCount?.totalSigns ?? job.totalSigns) !== 1 ? "s" : ""}</span>
                        {rooms.filter(r => r.source === "ai_vision" && r.reviewStatus === "pending").length > 0 && (
                          <span className="ml-1 text-amber-600 dark:text-amber-400">
                            · {rooms.filter(r => r.source === "ai_vision" && r.reviewStatus === "pending").length} pending review
                          </span>
                        )}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {canAct && rooms && rooms.filter(r => r.source === "ai_vision" && r.reviewStatus === "pending").length > 0 && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-emerald-400 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40 gap-1.5"
                        onClick={() => setBulkConfirmDialog({ action: "confirmed", count: rooms.filter(r => r.source === "ai_vision" && r.reviewStatus === "pending").length })}
                        disabled={bulkReviewRooms.isPending}
                      >
                        {bulkReviewRooms.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        Accept All AI Rooms
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-red-400 text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 gap-1.5"
                        onClick={() => { setBulkDismissDialogOpen(true); setBulkDismissReason(""); }}
                        disabled={bulkReviewRooms.isPending}
                      >
                        {bulkReviewRooms.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                        Dismiss All AI Rooms
                      </Button>
                    </>
                  )}
                  {canAct && rooms && rooms.some(r => r.source === "ai_vision" && r.reviewStatus === "confirmed") && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-amber-400 text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40 gap-1.5"
                      onClick={() => setBulkResetConfirmedDialogOpen(true)}
                      disabled={bulkReviewRooms.isPending}
                    >
                      {bulkReviewRooms.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      Reset All Confirmed
                    </Button>
                  )}
                  {rooms && rooms.some(r => r.source === "ai_vision" && r.reviewStatus === "dismissed") && (
                    <>
                      <Switch
                        id="show-dismissed-filter"
                        checked={showDismissed}
                        onCheckedChange={setShowDismissed}
                      />
                      <Label htmlFor="show-dismissed-filter" className="text-sm cursor-pointer flex items-center gap-1.5">
                        <X className="h-3.5 w-3.5 text-muted-foreground" />
                        Show dismissed
                        <Badge variant="secondary" className="text-xs px-1.5 py-0 h-4">
                          {rooms.filter(r => r.source === "ai_vision" && r.reviewStatus === "dismissed").length}
                        </Badge>
                      </Label>
                      {showDismissed && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-amber-400 text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40 gap-1.5"
                          onClick={() => setBulkConfirmDialog({ action: "pending", count: rooms.filter(r => r.source === "ai_vision" && r.reviewStatus === "dismissed").length })}
                          disabled={bulkReviewRooms.isPending}
                        >
                          {bulkReviewRooms.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                          Restore All Dismissed
                        </Button>
                      )}
                    </>
                  )}
                  {!filtersAreDefault && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-2 text-muted-foreground hover:text-foreground gap-1.5"
                      onClick={resetFilters}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Reset filters
                    </Button>
                  )}
                </div>
              </div>

              {showDismissedOnly && (
                <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800/40 dark:bg-amber-900/20 px-3 py-2 text-sm text-amber-800 dark:text-amber-400">
                  <XCircle className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">Showing dismissed rooms only</span>
                  <button
                    type="button"
                    onClick={() => setShowDismissedOnly(false)}
                    className="text-xs underline hover:text-amber-900 dark:hover:text-amber-300 focus:outline-none"
                  >
                    Clear
                  </button>
                </div>
              )}

              {showPendingOnly && (
                <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800/40 dark:bg-amber-900/20 px-3 py-2 text-sm text-amber-800 dark:text-amber-400">
                  <XCircle className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">Showing pending rooms only</span>
                  <button
                    type="button"
                    onClick={() => setShowPendingOnly(false)}
                    className="text-xs underline hover:text-amber-900 dark:hover:text-amber-300 focus:outline-none"
                  >
                    Clear
                  </button>
                </div>
              )}

              {confidenceBracketFilter !== null && (
                <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 dark:border-blue-800/40 dark:bg-blue-900/20 px-3 py-2 text-sm text-blue-800 dark:text-blue-300">
                  <Filter className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">
                    Showing rooms with <span className="font-semibold">{confidenceBracketFilter.label}</span> confidence
                  </span>
                  <button
                    type="button"
                    onClick={() => handleTabChange("confidence")}
                    className="text-xs underline hover:text-blue-900 dark:hover:text-blue-200 focus:outline-none shrink-0"
                  >
                    Back to Confidence
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfidenceBracketFilter(null)}
                    className="text-xs underline hover:text-blue-900 dark:hover:text-blue-200 focus:outline-none shrink-0"
                  >
                    Clear
                  </button>
                </div>
              )}

              <DismissibleBanner show={showConfidenceWarning && !confidenceWarningLocallyDismissed}>
                <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-4 py-3 text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <button
                    type="button"
                    onClick={() => setShowAiVisionOnly(true)}
                    className="flex-1 text-left text-sm hover:underline focus:outline-none"
                  >
                    <span className="font-semibold">
                      {reviewedLowConfidenceCount} of {lowConfidenceAiRooms.length} low-confidence room{lowConfidenceAiRooms.length !== 1 ? "s" : ""} reviewed
                    </span>
                    <span className="ml-1 text-amber-700 dark:text-amber-400">
                      — confidence below {lowConfidenceThreshold}%. Click to filter and review.
                    </span>
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-amber-200 dark:bg-amber-800/50 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-amber-500 dark:bg-amber-400 transition-all duration-300"
                          style={{ width: `${lowConfidenceAiRooms.length > 0 ? (reviewedLowConfidenceCount / lowConfidenceAiRooms.length) * 100 : 0}%` }}
                        />
                      </div>
                      <span className="shrink-0 text-xs font-medium text-amber-700 dark:text-amber-400 tabular-nums">
                        {lowConfidenceAiRooms.length > 0 ? Math.round((reviewedLowConfidenceCount / lowConfidenceAiRooms.length) * 100) : 0}%
                      </span>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={handleDismissWarning}
                    aria-label="Dismiss warning"
                    className="shrink-0 rounded p-0.5 hover:bg-amber-200 dark:hover:bg-amber-800/60 transition-colors focus:outline-none"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </DismissibleBanner>

              {loadingRooms ? (
                <div className="space-y-2">
                  {[...Array(4)].map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full rounded-md" />
                  ))}
                </div>
              ) : !rooms || rooms.length === 0 ? (
                <div className="flex items-center justify-center p-12 border border-dashed rounded-md text-muted-foreground">
                  No rooms found for this job
                </div>
              ) : (
                (() => {
                  const _dismissedCount = (rooms ?? []).filter(r => r.source === "ai_vision" && r.reviewStatus === "dismissed").length;
                  const adaSuggestedRoomIds = showUnspecifiedOnly
                    ? new Set((signs ?? [])
                        .filter(s => s.dimSource === "ada_suggested" && !s.isDeleted && s.roomId)
                        .map(s => s.roomId!))
                    : null;

                  let filtered = rooms.filter(r => {
                    if (showAiVisionOnly && r.source !== "ai_vision") return false;
                    if (!showDismissed && r.source === "ai_vision" && r.reviewStatus === "dismissed") return false;
                    if (showDismissedOnly && r.reviewStatus !== "dismissed") return false;
                    if (showPendingOnly && r.reviewStatus !== "pending") return false;
                    if (adaSuggestedRoomIds && !adaSuggestedRoomIds.has(r.id)) return false;
                    return true;
                  });

                  if (showLowConfidenceOnly) {
                    filtered = filtered.filter(r => Math.round(parseFloat(String(r.confidence ?? "1")) * 100) < lowConfidenceThreshold);
                  }

                  if (confidenceBracketFilter !== null) {
                    filtered = filtered.filter(r => {
                      const pct = Math.round(parseFloat(String(r.confidence ?? "1")) * 100);
                      const minPct = Math.round(confidenceBracketFilter.minConfidence * 100);
                      const maxPct = Math.round(confidenceBracketFilter.maxConfidence * 100);
                      return pct >= minPct && (maxPct >= 100 ? pct <= 100 : pct < maxPct);
                    });
                  }

                  if (confidenceSortDir !== null) {
                    filtered = [...filtered].sort((a, b) => {
                      const ca = Math.round(parseFloat(String(a.confidence ?? "1")) * 100);
                      const cb = Math.round(parseFloat(String(b.confidence ?? "1")) * 100);
                      const dir = confidenceSortDir === "asc" ? 1 : -1;
                      if (ca !== cb) return (ca - cb) * dir;
                      
                      const numA = String(a.roomNumber ?? "");
                      const numB = String(b.roomNumber ?? "");
                      return numA.localeCompare(numB, undefined, { numeric: true });
                    });
                  } else {
                    // Default sort by room number
                    filtered = [...filtered].sort((a, b) => {
                      const numA = String(a.roomNumber ?? "");
                      const numB = String(b.roomNumber ?? "");
                      return numA.localeCompare(numB, undefined, { numeric: true });
                    });
                  }
                  if (filtered.length === 0) {
                    return (
                      <div className="flex items-center justify-center p-12 border border-dashed rounded-md text-muted-foreground">
                        No rooms match the current filters
                      </div>
                    );
                  }
                  const hasAiVisionRows = filtered.some(r => r.source === "ai_vision");
                  const isFiltered = filtered.length !== rooms.length;

                  const dismissedRooms = (rooms ?? []).filter(r => r.source === "ai_vision" && r.reviewStatus === "dismissed");
                  const dismissalReasonGroups: Record<string, number> = {};
                  for (const r of dismissedRooms) {
                    const key = (r.dismissalReason ?? "").trim() || "No reason given";
                    dismissalReasonGroups[key] = (dismissalReasonGroups[key] ?? 0) + 1;
                  }
                  const dismissalReasonEntries = Object.entries(dismissalReasonGroups).sort((a, b) => b[1] - a[1]);

                  return (
                    <div className="space-y-2">
                    {isFiltered && (
                      <p className="text-xs text-muted-foreground">
                        Showing {filtered.length} of {rooms.length} room{rooms.length !== 1 ? "s" : ""}
                      </p>
                    )}
                    {showDismissed && dismissalReasonEntries.length > 0 && (
                      <div className="rounded-md border border-muted bg-muted/30 px-4 py-3 space-y-2">
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Dismissal Reason Summary</p>
                        <div className="flex flex-wrap gap-2">
                          {dismissalReasonEntries.map(([reason, count]) => (
                            <span
                              key={reason}
                              className="inline-flex items-center gap-1.5 rounded-full border border-muted-foreground/20 bg-background px-3 py-0.5 text-xs text-muted-foreground"
                            >
                              <X className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                              <span className="font-medium text-foreground/80">{reason}</span>
                              <Badge variant="secondary" className="h-4 px-1.5 text-xs ml-0.5">{count}</Badge>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="rounded-md border overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/40">
                            <TableHead className="w-[100px]">Room #</TableHead>
                            <TableHead>Name</TableHead>
                            <TableHead className="w-[110px]">Type</TableHead>
                            <TableHead className="w-[70px]">Signs</TableHead>
                            <TableHead className="w-[70px]">Level</TableHead>
                            <TableHead className="w-[90px] text-right">Actions</TableHead>
                            {hasAiVisionRows && <TableHead className="w-[140px] text-right">Review</TableHead>}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(() => {
                            const levelMap = new Map<string, typeof filtered>();
                            for (const room of filtered) {
                              const key = String(room.level ?? "Other");
                              if (!levelMap.has(key)) levelMap.set(key, []);
                              levelMap.get(key)!.push(room);
                            }
                            const sortedLevels = Array.from(levelMap.keys()).sort((a, b) => {
                              if (a === "Other") return 1;
                              if (b === "Other") return -1;
                              return a.localeCompare(b, undefined, { numeric: true });
                            });
                            const colCount = 6 + (hasAiVisionRows ? 1 : 0);
                            return sortedLevels.flatMap(levelKey => {
                              const groupRooms = levelMap.get(levelKey)!;
                              const isGroupCollapsed = collapsedFloors.has(levelKey);
                              const aiRoomsInGroup = groupRooms.filter(r => r.source === "ai_vision");
                              const pendingAiInGroup = aiRoomsInGroup.filter(r => r.reviewStatus === "pending").length;
                              const reviewedAiInGroup = aiRoomsInGroup.filter(r => r.reviewStatus !== "pending").length;
                              const totalAiInGroup = aiRoomsInGroup.length;
                              const headerRow = (
                                <TableRow key={`floor-${levelKey}`} className="bg-muted/60 hover:bg-muted/60 border-b-2 border-border">
                                  <TableCell colSpan={colCount} className="py-1.5 px-3">
                                    <div className="flex items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={() => setCollapsedFloors(prev => { const next = new Set(prev); if (next.has(levelKey)) next.delete(levelKey); else next.add(levelKey); return next; })}
                                        className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
                                      >
                                        {isGroupCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                                      </button>
                                      <span className="font-semibold text-sm">{levelKey === "Other" ? "Unassigned" : `Level ${levelKey}`}</span>
                                      <Badge variant="secondary" className="text-xs px-1.5 py-0 h-4">{groupRooms.length}</Badge>
                                      {totalAiInGroup > 0 && (
                                        <span className="text-xs ml-1 flex items-center gap-1.5">
                                          {pendingAiInGroup > 0
                                            ? <span className="text-amber-500">{pendingAiInGroup} AI pending</span>
                                            : <span className="text-emerald-500 flex items-center gap-0.5"><CheckCircle2 className="h-3 w-3 mr-0.5" />{reviewedAiInGroup} AI reviewed</span>
                                          }
                                          {pendingAiInGroup > 0 && hasAiVisionRows && (
                                            <button
                                              className="ml-2 text-xs px-2 py-0.5 rounded border border-amber-400 text-amber-600 hover:bg-amber-50 transition-colors"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setBulkConfirmDialog({
                                                  action: "confirmed",
                                                  count: pendingAiInGroup,
                                                  level: levelKey,
                                                });
                                              }}
                                            >
                                              Accept All Level {levelKey}
                                            </button>
                                          )}
                                        </span>
                                      )}
                                    </div>
                                  </TableCell>
                                </TableRow>
                              );
                              if (isGroupCollapsed) return [headerRow];
                              return [headerRow, ...groupRooms.map(room => {
                            const isAiVision = room.source === "ai_vision";
                            const isPending = isAiVision && room.reviewStatus === "pending";
                            const isConfirmed = isAiVision && room.reviewStatus === "confirmed";
                            const isDismissed = isAiVision && room.reviewStatus === "dismissed";
                            const confidencePct = Math.round(parseFloat(String(room.confidence ?? "1")) * 100);
                            const isLowConfidence = isAiVision && confidencePct < lowConfidenceThreshold;
                            const rowUpdating = updateRoomReviewStatus.isPending && updateRoomReviewStatus.variables?.roomId === room.id;
                            const roomSignCount = (signs ?? []).filter(s => s.roomId === room.id && !s.isDeleted).length;
                            return (
                              <TableRow
                                key={room.id}
                                className={
                                  isDismissed
                                    ? "opacity-50 bg-muted/30"
                                    : isConfirmed && isAiVision
                                    ? "bg-emerald-50/40 dark:bg-emerald-950/10"
                                    : isPending && confidencePct < lowConfidenceThreshold
                                    ? "bg-red-50/30 dark:bg-red-950/20"
                                    : isPending
                                    ? "bg-purple-50/40 dark:bg-purple-950/20"
                                    : undefined
                                }
                              >
                                <TableCell className="font-mono font-medium">
                                  <span className="inline-flex items-center gap-1.5">
                                    {isAiVision && (
                                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isDismissed ? "bg-muted-foreground/40" : isConfirmed ? "bg-emerald-500" : "bg-amber-500"}`} />
                                    )}
                                    {room.roomNumber}
                                    {room.coordX == null && (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <span className="inline-flex items-center gap-0.5 text-[10px] font-sans text-amber-500 cursor-help">
                                            <MapPin className="h-2.5 w-2.5" />?
                                          </span>
                                        </TooltipTrigger>
                                        <TooltipContent side="top" className="text-xs">
                                          No map location — AI could not find coordinates for this room
                                        </TooltipContent>
                                      </Tooltip>
                                    )}
                                  </span>
                                </TableCell>
                                <TableCell>
                                  {editingRoomId === room.id ? (
                                    <div className="flex items-center gap-1.5">
                                      <Input
                                        className="h-7 text-sm py-0 px-2 min-w-[140px]"
                                        value={editingRoomName}
                                        autoFocus
                                        onChange={(e) => setEditingRoomName(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") handleSaveRoomName(room.id, editingRoomName);
                                          if (e.key === "Escape") handleCancelEditRoom();
                                        }}
                                      />
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 w-7 p-0 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
                                        disabled={savingRoomId === room.id}
                                        onClick={() => handleSaveRoomName(room.id, editingRoomName)}
                                        title="Save"
                                      >
                                        {savingRoomId === room.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                        onClick={handleCancelEditRoom}
                                        title="Cancel"
                                      >
                                        <X className="h-3.5 w-3.5" />
                                      </Button>
                                    </div>
                                  ) : (
                                    <span className="text-sm">{room.roomName}</span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  {(() => {
                                    const typeInfo = getRoomTypeLabel(room);
                                    return typeInfo ? (
                                      <Badge variant="secondary" className={`text-xs ${typeInfo.color}`}>
                                        {typeInfo.label}
                                      </Badge>
                                    ) : (
                                      <span className="text-xs text-muted-foreground">—</span>
                                    );
                                  })()}
                                </TableCell>
                                <TableCell className="text-sm font-medium">
                                  {editingQtyRoomId === room.id ? (
                                    <div className="flex items-center gap-1">
                                      <Input
                                        type="number"
                                        min={0}
                                        className="w-16 h-7 text-sm px-2"
                                        value={editingQtyValue}
                                        autoFocus
                                        onChange={e => setEditingQtyValue(e.target.value)}
                                        onKeyDown={e => {
                                          if (e.key === "Enter") handleSaveQty(room.id);
                                          if (e.key === "Escape") setEditingQtyRoomId(null);
                                        }}
                                        onBlur={() => handleSaveQty(room.id)}
                                      />
                                    </div>
                                  ) : (
                                    <span
                                      className="cursor-pointer hover:underline hover:text-amber-400 transition-colors"
                                      title="Click to override quantity"
                                      onClick={() => {
                                        setEditingQtyRoomId(room.id);
                                        setEditingQtyValue(String(roomSignCount));
                                      }}
                                    >
                                      {roomSignCount > 0 ? roomSignCount : <span className="text-muted-foreground text-xs">—</span>}
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground">{room.level ?? "—"}</TableCell>
                                <TableCell className="text-right">
                                  <div className="flex items-center justify-end gap-1">
                                    {canAct && (
                                      <Popover
                                        open={openFlagRoomId === room.id}
                                        onOpenChange={(open) => setOpenFlagRoomId(open ? room.id : null)}
                                      >
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <PopoverTrigger asChild>
                                              <Button
                                                size="sm"
                                                variant="ghost"
                                                className={`h-7 w-7 p-0 ${
                                                  (room as unknown as Record<string, unknown>).flagOverrides &&
                                                  Object.keys((room as unknown as Record<string, unknown>).flagOverrides as Record<string, unknown>).length > 0
                                                    ? "text-violet-600 dark:text-violet-400 hover:text-violet-700"
                                                    : "text-muted-foreground hover:text-foreground"
                                                }`}
                                                disabled={isDismissed}
                                              >
                                                <SlidersHorizontal className="h-3.5 w-3.5" />
                                              </Button>
                                            </PopoverTrigger>
                                          </TooltipTrigger>
                                          <TooltipContent>Override room flags</TooltipContent>
                                        </Tooltip>
                                        <PopoverContent side="left" className="w-56 p-3" align="end">
                                          <p className="text-xs font-medium text-muted-foreground mb-2">Room classification flags</p>
                                          {savingFlagRoomId === room.id && (
                                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                                              <Loader2 className="h-3 w-3 animate-spin" />
                                              Saving…
                                            </div>
                                          )}
                                          {([
                                            { flag: "isVariableUse", label: "Variable use (Room ID w/Insert)" },
                                            { flag: "isAssembly", label: "Assembly" },
                                            { flag: "isMepUnoccupied", label: "MEP / Unoccupied" },
                                            { flag: "isRestroom", label: "Restroom" },
                                            { flag: "isCorridorOrHall", label: "Corridor / Hall" },
                                            { flag: "isPublicFacing", label: "Public facing" },
                                          ] as { flag: string; label: string }[]).map(({ flag, label }) => {
                                            const current = (room as unknown as Record<string, boolean | unknown>)[flag] as boolean;
                                            const overrides = ((room as unknown as Record<string, unknown>).flagOverrides ?? {}) as Record<string, boolean>;
                                            const isOverridden = flag in overrides;
                                            return (
                                              <div key={flag} className="flex items-center gap-2 py-0.5">
                                                <Checkbox
                                                  id={`${room.id}-${flag}`}
                                                  checked={current}
                                                  disabled={savingFlagRoomId === room.id}
                                                  onCheckedChange={(checked) => handleFlagOverride(room.id, flag, !!checked)}
                                                />
                                                <label
                                                  htmlFor={`${room.id}-${flag}`}
                                                  className={`text-xs cursor-pointer flex-1 ${isOverridden ? "text-violet-700 dark:text-violet-300 font-medium" : ""}`}
                                                >
                                                  {label}
                                                  {isOverridden && <span className="ml-1 text-[10px] opacity-60">(overridden)</span>}
                                                </label>
                                              </div>
                                            );
                                          })}
                                        </PopoverContent>
                                      </Popover>
                                    )}
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                          onClick={() => handleEditOnFloorPlan(room.id)}
                                        >
                                          <Pencil className="h-3.5 w-3.5" />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>Edit on floor plan</TooltipContent>
                                    </Tooltip>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          className="h-7 w-7 p-0 text-muted-foreground hover:text-blue-600 dark:hover:text-blue-400"
                                          onClick={() => handleViewOnFloorPlan(room.id)}
                                        >
                                          <MapPin className="h-3.5 w-3.5" />
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>View on floor plan</TooltipContent>
                                    </Tooltip>
                                  </div>
                                </TableCell>
                                {hasAiVisionRows && (
                                  <TableCell className="text-right">
                                    {isAiVision ? (
                                      <div className="flex items-center justify-end gap-1.5">
                                        {isDismissed ? (
                                          <div className="flex flex-col items-end gap-0.5">
                                            <Badge
                                              variant="outline"
                                              className="text-muted-foreground text-xs gap-1"
                                            >
                                              <X className="h-3 w-3" />
                                              Dismissed
                                            </Badge>
                                            {room.dismissalReason && (
                                              <Tooltip>
                                                <TooltipTrigger asChild>
                                                  <span className="max-w-[160px] truncate text-xs text-muted-foreground/70 italic cursor-help">
                                                    {room.dismissalReason}
                                                  </span>
                                                </TooltipTrigger>
                                                <TooltipContent side="left" className="max-w-xs whitespace-normal">
                                                  <p className="font-medium text-xs mb-0.5">Dismissal reason</p>
                                                  <p className="text-xs">{room.dismissalReason}</p>
                                                </TooltipContent>
                                              </Tooltip>
                                            )}
                                          </div>
                                        ) : isConfirmed ? (
                                          <>
                                            <Badge variant="outline" className="border-emerald-400 text-emerald-700 dark:text-emerald-400 text-xs gap-1">
                                              <CheckCircle2 className="h-3 w-3" />
                                              Reviewed
                                            </Badge>
                                            <Button
                                              size="sm"
                                              variant="ghost"
                                              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                                              title="Undo — reset back to pending review"
                                              onClick={() => handleRoomAction(room.id, "pending")}
                                              disabled={rowUpdating}
                                            >
                                              {rowUpdating ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                                              Undo
                                            </Button>
                                          </>
                                        ) : null}
                                        {canAct && isPending && isLowConfidence && (
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-7 px-2 text-xs gap-1 border-emerald-400 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
                                            title="Mark this room as reviewed"
                                            onClick={() => handleRoomAction(room.id, "confirmed")}
                                            disabled={rowUpdating}
                                          >
                                            {rowUpdating ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                                            Mark reviewed
                                          </Button>
                                        )}
                                        {canAct && isPending && !isLowConfidence && (
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-7 w-7 p-0 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
                                            title="Accept room"
                                            onClick={() => handleRoomAction(room.id, "confirmed")}
                                            disabled={rowUpdating}
                                          >
                                            {rowUpdating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                          </Button>
                                        )}
                                        {canAct && !isDismissed && (
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-7 w-7 p-0 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40"
                                            title="Dismiss room"
                                            onClick={() => { setDismissDialogRoomId(room.id); setDismissReason(""); }}
                                            disabled={rowUpdating}
                                          >
                                            {rowUpdating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                                          </Button>
                                        )}
                                        {canAct && isDismissed && (
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                                            title="Accept this room"
                                            onClick={() => handleRoomAction(room.id, "confirmed")}
                                            disabled={rowUpdating}
                                          >
                                            Undo
                                          </Button>
                                        )}
                                      </div>
                                    ) : null}
                                  </TableCell>
                                )}
                              </TableRow>
                            );
                          })];
                            });
                          })()}
                        </TableBody>
                      </Table>
                    </div>
                    </div>
                  );
                })()
              )}

              {/* ── EGRESS & CODE SIGNS ──────────────────────────────────── */}
              {(() => {
                const EGRESS_REVIEW_TYPES = new Set([
                  "Stair (Corridor)", "Stair(Corridor)", "Stair (Landing)", "Stair(Landing)",
                  "Exit", "Exit(Tactile)", "Area of Rescue", "Evacuation Map",
                  "Max Occupancy", "In Case of Fire", "Elevator",
                ]);
                const egressReviewSigns = (signs ?? []).filter(s =>
                  !s.isDeleted && s.source === "rules_engine" &&
                  (EGRESS_REVIEW_TYPES.has(s.signType ?? "") || s.roomNumber?.startsWith("STAIR-") || s.roomNumber?.startsWith("EXIT-") || s.roomNumber?.startsWith("AOR-") || s.roomNumber?.startsWith("EVAC-"))
                );
                if (egressReviewSigns.length === 0) return null;
                const totalEgressQty = egressReviewSigns.reduce((a, s) => a + (s.qty ?? 1), 0);
                return (
                  <div className="mt-6 border border-amber-200 dark:border-amber-800 rounded-lg overflow-hidden">
                    <button
                      type="button"
                      className="w-full flex items-center justify-between px-4 py-3 bg-amber-50 dark:bg-amber-950/40 hover:bg-amber-100 dark:hover:bg-amber-950/60 transition-colors"
                      onClick={() => setEgressSectionOpen(v => !v)}
                    >
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
                        <span className="font-semibold text-sm text-amber-900 dark:text-amber-100 tracking-wide uppercase">
                          Egress &amp; Code Signs
                        </span>
                        <span className="ml-1 text-xs font-normal text-amber-600 dark:text-amber-400">
                          {totalEgressQty} sign{totalEgressQty !== 1 ? "s" : ""} · {egressReviewSigns.length} entr{egressReviewSigns.length !== 1 ? "ies" : "y"} · rule-generated
                        </span>
                      </div>
                      {egressSectionOpen
                        ? <ChevronUp className="h-4 w-4 text-amber-500" />
                        : <ChevronDown className="h-4 w-4 text-amber-500" />}
                    </button>
                    {egressSectionOpen && (
                      <div className="overflow-auto">
                        <Table>
                          <TableHeader>
                            <TableRow className="bg-amber-50/50 dark:bg-amber-950/20">
                              <TableHead className="w-44">Sign Type</TableHead>
                              <TableHead className="w-28">Room #</TableHead>
                              <TableHead>Room Name</TableHead>
                              <TableHead className="w-24">Floor</TableHead>
                              <TableHead className="w-14 text-right">Qty</TableHead>
                              <TableHead className="w-14 text-center">ADA?</TableHead>
                              <TableHead>Notes</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {egressReviewSigns.map(s => {
                              const isEstimated = parseFloat(String(s.confidence ?? "1")) < 1.0;
                              return (
                                <TableRow key={s.id} className="text-sm">
                                  <TableCell>
                                    <Badge variant="outline" className="text-xs font-mono border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300">
                                      {s.signType ?? "Unknown"}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="font-mono text-xs text-muted-foreground">
                                    {s.roomNumber ?? "—"}
                                  </TableCell>
                                  <TableCell className="text-sm">
                                    {s.roomName ?? "—"}
                                  </TableCell>
                                  <TableCell className="text-xs text-muted-foreground">
                                    {s.floorLabel ?? "—"}
                                  </TableCell>
                                  <TableCell className="text-right font-mono font-semibold">{s.qty ?? 1}</TableCell>
                                  <TableCell className="text-center">
                                    {s.adaRequired
                                      ? <span className="text-xs font-semibold text-amber-700 dark:text-amber-300">Yes</span>
                                      : <span className="text-xs text-muted-foreground">—</span>}
                                  </TableCell>
                                  <TableCell className="text-xs text-muted-foreground">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-900/40 text-amber-400 border border-amber-700">⚡ Rules</span>
                                      {isEstimated && (
                                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground border border-border">Estimated</span>
                                      )}
                                      {s.notes && <span>{s.notes}</span>}
                                    </div>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ── EXTERIOR & SITE SIGNS ─────────────────────────────────── */}
              {(() => {
                const extSigns = (signs ?? []).filter(s => !s.isDeleted && s.source === "exterior");
                if (extSigns.length === 0) return null;
                return (
                  <div className="mt-6 border border-purple-200 dark:border-purple-800 rounded-lg overflow-hidden">
                    <button
                      type="button"
                      className="w-full flex items-center justify-between px-4 py-3 bg-purple-50 dark:bg-purple-950/40 hover:bg-purple-100 dark:hover:bg-purple-950/60 transition-colors"
                      onClick={() => setExteriorOpen(v => !v)}
                    >
                      <div className="flex items-center gap-2">
                        <MapPin className="h-4 w-4 text-purple-600 dark:text-purple-400 shrink-0" />
                        <span className="font-semibold text-sm text-purple-900 dark:text-purple-100 tracking-wide uppercase">
                          Exterior &amp; Site Signs
                        </span>
                        <span className="ml-1 text-xs font-normal text-purple-600 dark:text-purple-400">
                          {extSigns.reduce((a, s) => a + (s.qty ?? 1), 0)} sign{extSigns.reduce((a, s) => a + (s.qty ?? 1), 0) !== 1 ? "s" : ""} · {extSigns.length} entr{extSigns.length !== 1 ? "ies" : "y"}
                        </span>
                      </div>
                      {exteriorOpen
                        ? <ChevronUp className="h-4 w-4 text-purple-500" />
                        : <ChevronDown className="h-4 w-4 text-purple-500" />}
                    </button>
                    {exteriorOpen && (
                      <div className="overflow-auto">
                        <Table>
                          <TableHeader>
                            <TableRow className="bg-purple-50/50 dark:bg-purple-950/20">
                              <TableHead className="w-40">Sign Type</TableHead>
                              <TableHead>Location</TableHead>
                              <TableHead className="w-14 text-right">Qty</TableHead>
                              <TableHead className="w-32">Est. Size</TableHead>
                              <TableHead className="w-12 text-center">ADA?</TableHead>
                              <TableHead>Notes</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {extSigns.map(s => {
                              const isAda = /\bada\b/i.test(s.signType ?? "") ||
                                (s.message ?? "").toLowerCase().startsWith("ada: yes");
                              const notes = (s.message ?? "").replace(/^ADA: yes\s*\|\s*/i, "");
                              return (
                                <TableRow key={s.id}>
                                  <TableCell>
                                    <Badge
                                      variant="outline"
                                      className="text-xs font-mono border-purple-300 text-purple-700 dark:border-purple-700 dark:text-purple-300"
                                    >
                                      {s.signType ?? "Unknown"}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="text-sm text-muted-foreground">
                                    {s.ruleRef && s.ruleRef !== "Exterior" ? s.ruleRef : "—"}
                                  </TableCell>
                                  <TableCell className="text-right font-mono font-semibold">{s.qty ?? 1}</TableCell>
                                  <TableCell className="text-sm text-muted-foreground">{s.dimensions || "—"}</TableCell>
                                  <TableCell className="text-center">
                                    {isAda
                                      ? <span className="text-xs font-semibold text-purple-700 dark:text-purple-300">Yes</span>
                                      : <span className="text-xs text-muted-foreground">—</span>}
                                  </TableCell>
                                  <TableCell className="text-sm text-muted-foreground">{notes || "—"}</TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </TabsContent>
          {/* ── Egress Tab ─────────────────────────────────────────── */}
          <TabsContent value="egress" className="mt-0 p-6 overflow-y-auto">
            <div className="max-w-4xl space-y-6">
              <div>
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  Egress &amp; Code Signs
                  <span className="text-xs font-normal px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">Rule-generated</span>
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Rule-generated from building code. Verify all counts against construction plans before bidding.
                </p>
              </div>
              {(() => {
                const EGRESS_TYPES = new Set(["Stair (Corridor)", "Stair(Corridor)", "Stair (Landing)", "Stair(Landing)", "Exit", "Area of Rescue", "Evacuation Map"]);
                const egressSigns = (signs ?? []).filter(s => EGRESS_TYPES.has(s.signType) && s.source === "rules_engine");

                if (egressSigns.length === 0) {
                  return (
                    <div className="flex flex-col items-center justify-center p-16 border border-dashed rounded-md gap-3 text-muted-foreground">
                      <p className="text-sm">No egress signs found. Run a scan to generate egress signs from building code.</p>
                    </div>
                  );
                }

                const count = (type: string) => egressSigns.filter(s => s.signType === type || s.signType === type.replace(" ", "")).length;
                const stairCorridorCount = count("Stair (Corridor)");
                const stairLandingCount = count("Stair (Landing)");
                const exitCount = count("Exit");
                const evacCount = count("Evacuation Map");
                const rescueCount = count("Area of Rescue");

                const floors = new Set(egressSigns.map(s => s.floorLabel).filter(Boolean));
                const floorCount = Math.max(floors.size, 1);
                const stairCount = floorCount > 0 ? Math.round(stairCorridorCount / floorCount) : 0;

                const minExterior: Record<string, number> = { education: 4, healthcare: 4, commercial: 2, government: 3, hotel: 2, residential: 2, assembly: 4, unknown: 2 };
                const buildingTypeKey = job?.buildingType ?? "unknown";
                const exitMinimum = stairCount * floorCount + (minExterior[buildingTypeKey] ?? 2);
                const exitOk = exitCount >= exitMinimum;
                const stairOk = stairCorridorCount > 0 && stairCorridorCount === stairLandingCount;

                const sortedEgress = [...egressSigns].sort((a, b) => {
                  const fl = (a.floorLabel ?? "").localeCompare(b.floorLabel ?? "");
                  return fl !== 0 ? fl : (a.signType ?? "").localeCompare(b.signType ?? "");
                });

                return (
                  <>
                    {/* Verification checks */}
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-medium">Verification Checks</CardTitle>
                      </CardHeader>
                      <CardContent className="pt-0">
                        <div className="rounded-md border divide-y text-sm">
                          <div className="grid grid-cols-[1fr_auto] gap-4 px-3 py-2 text-xs text-muted-foreground font-medium uppercase tracking-wide">
                            <span>Check</span><span>Status</span>
                          </div>
                          <div className="grid grid-cols-[1fr_auto] gap-4 px-3 py-2">
                            <span>Stair sets: {stairCount} stair{stairCount !== 1 ? "s" : ""} × {floorCount} floor{floorCount !== 1 ? "s" : ""} = {stairCorridorCount} Corridor + {stairLandingCount} Landing</span>
                            <span className={stairOk ? "text-emerald-600 dark:text-emerald-400 font-medium" : "text-amber-600 dark:text-amber-400 font-medium"}>{stairOk ? "✓" : "!"}</span>
                          </div>
                          <div className="grid grid-cols-[1fr_auto] gap-4 px-3 py-2">
                            <span>Exit signs: minimum {exitMinimum} ({stairCount} stairs × {floorCount} floors + exterior) — current {exitCount}</span>
                            <span className={exitOk ? "text-emerald-600 dark:text-emerald-400 font-medium" : "text-amber-600 dark:text-amber-400 font-medium"}>{exitOk ? "✓" : "!"}</span>
                          </div>
                          <div className="grid grid-cols-[1fr_auto] gap-4 px-3 py-2">
                            <span>Evacuation maps: {evacCount} map{evacCount !== 1 ? "s" : ""} across {floorCount} floor{floorCount !== 1 ? "s" : ""}</span>
                            <span className="text-emerald-600 dark:text-emerald-400 font-medium">✓</span>
                          </div>
                          {rescueCount > 0 && (
                            <div className="grid grid-cols-[1fr_auto] gap-4 px-3 py-2">
                              <span>Area of Rescue: {rescueCount} sign{rescueCount !== 1 ? "s" : ""} ({stairCount} stair{stairCount !== 1 ? "s" : ""} × {floorCount} floor{floorCount !== 1 ? "s" : ""} × 2)</span>
                              <span className="text-emerald-600 dark:text-emerald-400 font-medium">✓</span>
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>

                    {/* Full sign table */}
                    <Card>
                      <CardHeader className="pb-3">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-sm font-medium">Sign List</CardTitle>
                          <span className="text-xs text-muted-foreground">{egressSigns.length} signs</span>
                        </div>
                      </CardHeader>
                      <CardContent className="pt-0">
                        <div className="rounded-md border overflow-hidden">
                          <table className="w-full text-xs">
                            <thead className="bg-muted/50">
                              <tr>
                                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Sign Type</th>
                                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Floor</th>
                                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Qty</th>
                                <th className="text-left px-3 py-2 font-medium text-muted-foreground">ADA</th>
                                <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden md:table-cell">Notes</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y">
                              {sortedEgress.map((s) => (
                                <tr key={s.id} className="hover:bg-muted/30">
                                  <td className="px-3 py-1.5 font-medium">{s.signType}</td>
                                  <td className="px-3 py-1.5 text-muted-foreground">{s.floorLabel ?? s.level ?? "—"}</td>
                                  <td className="px-3 py-1.5">{s.qty}</td>
                                  <td className="px-3 py-1.5">
                                    {s.adaRequired ? (
                                      <span className="inline-flex items-center rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-1.5 py-0.5 text-xs font-medium">ADA</span>
                                    ) : <span className="text-muted-foreground">—</span>}
                                  </td>
                                  <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[200px] hidden md:table-cell" title={s.notes ?? undefined}>{s.notes ?? "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </CardContent>
                    </Card>
                  </>
                );
              })()}
            </div>
          </TabsContent>

          {/* ── Specialty Tab ───────────────────────────────────────── */}
          <TabsContent value="specialty" className="mt-0 p-6 overflow-y-auto">
            <div className="max-w-4xl space-y-6">
              <div>
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  Specialty &amp; Exterior Signs
                  <span className="text-xs font-normal px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">Detail sheets</span>
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Extracted from detail sheets. Quantities require field verification. No standard pricing — obtain custom quotes.
                </p>
              </div>
              {specialtySigns.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-16 border border-dashed rounded-md gap-3 text-muted-foreground">
                  <p className="text-sm">No specialty items found. This is correct for plans without detail sheets.</p>
                </div>
              ) : (
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm font-medium">Specialty Items</CardTitle>
                      <span className="text-xs text-muted-foreground">{specialtySigns.length} items</span>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-4">
                    <div className="rounded-md border overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="text-left px-3 py-2 font-medium text-muted-foreground">Code</th>
                            <th className="text-left px-3 py-2 font-medium text-muted-foreground">Description</th>
                            <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden md:table-cell">Dimensions</th>
                            <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden md:table-cell">Material</th>
                            <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden lg:table-cell">Finish</th>
                            <th className="text-left px-3 py-2 font-medium text-muted-foreground">Qty</th>
                            <th className="text-left px-3 py-2 font-medium text-muted-foreground hidden lg:table-cell">Sheet</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {specialtySigns.map((s) => (
                            <tr key={s.id} className="hover:bg-muted/30">
                              <td className="px-3 py-1.5 font-mono font-medium text-blue-700 dark:text-blue-400">{s.signCode ?? "—"}</td>
                              <td className="px-3 py-1.5">{s.description}</td>
                              <td className="px-3 py-1.5 text-muted-foreground hidden md:table-cell">{s.dimensions ?? "—"}</td>
                              <td className="px-3 py-1.5 text-muted-foreground hidden md:table-cell">{s.material ?? "—"}</td>
                              <td className="px-3 py-1.5 text-muted-foreground hidden lg:table-cell">{s.finish ?? "—"}</td>
                              <td className="px-3 py-1.5">
                                <input
                                  type="number"
                                  min={0}
                                  defaultValue={s.qty ?? 1}
                                  className="w-14 rounded border border-input bg-background px-1.5 py-0.5 text-xs text-center focus:outline-none focus:ring-1 focus:ring-ring"
                                  onBlur={(e) => {
                                    const newQty = parseInt(e.currentTarget.value, 10);
                                    if (!isNaN(newQty) && newQty >= 0 && newQty !== s.qty) {
                                      setSpecialtySigns(prev => prev.map(x => x.id === s.id ? { ...x, qty: newQty } : x));
                                      void authFetch(`/api/jobs/${jobId}/specialty-signs/${s.id}`, {
                                        method: "PATCH",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ qty: newQty }),
                                      });
                                    }
                                  }}
                                />
                              </td>
                              <td className="px-3 py-1.5 text-muted-foreground font-mono hidden lg:table-cell">{s.sourceSheetNumber ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Specialty signs are not included in the standard Takeoff or Pricing tabs. They appear in the Specialty Signs tab of the XLSX export for separate quoting.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="sign-type-summary" className="mt-0 p-6 overflow-y-auto">
            {(() => {
              const activeSigns = (signs ?? []).filter(s => !s.isDeleted && s.status !== "rejected");
              if (activeSigns.length === 0) {
                return (
                  <div className="flex flex-col items-center justify-center p-16 border border-dashed rounded-md gap-3 text-muted-foreground">
                    <BarChart3 className="h-10 w-10 opacity-30" />
                    <p className="font-medium text-foreground">No sign data yet</p>
                    <p className="text-sm">Run processing to generate sign type totals.</p>
                  </div>
                );
              }
              type TypeRow = { signType: string; count: number; color: string | null | undefined; levels: Set<string>; rules: Set<string>; };
              const byType = new Map<string, TypeRow>();
              for (const s of activeSigns) {
                const key = s.signType ?? "Unknown";
                if (!byType.has(key)) byType.set(key, { signType: key, count: 0, color: s.color ?? null, levels: new Set(), rules: new Set() });
                const row = byType.get(key)!;
                row.count += s.qty ?? 1;
                if (s.level) row.levels.add(s.level);
                if (s.ruleRef) row.rules.add(s.ruleRef);
              }
              const rows = Array.from(byType.values()).sort((a, b) => b.count - a.count);
              const total = rows.reduce((sum, r) => sum + r.count, 0);
              return (
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-medium">Sign Type Summary</h3>
                      <p className="text-sm text-muted-foreground mt-0.5">{rows.length} sign types · {total} total signs</p>
                    </div>
                  </div>
                  <div className="border rounded-md overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-8"></TableHead>
                          <TableHead>Sign Type</TableHead>
                          <TableHead className="w-20 text-right">Qty</TableHead>
                          <TableHead className="w-24 text-right">% of Total</TableHead>
                          <TableHead>Levels</TableHead>
                          <TableHead>Rules Applied</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map(row => {
                          const pct = total > 0 ? ((row.count / total) * 100).toFixed(1) : "0.0";
                          return (
                            <TableRow key={row.signType}>
                              <TableCell>
                                {row.color && (
                                  <span
                                    className="inline-block h-3 w-3 rounded-full border border-white/20"
                                    style={{ backgroundColor: row.color }}
                                  />
                                )}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className="font-mono text-xs"
                                  style={{ borderColor: row.color ?? undefined, color: row.color ?? undefined }}
                                >
                                  {row.signType}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right font-mono font-semibold">{row.count}</TableCell>
                              <TableCell className="text-right">
                                <div className="flex items-center justify-end gap-2">
                                  <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                                    <div
                                      className="h-full rounded-full bg-primary/70"
                                      style={{ width: `${pct}%` }}
                                    />
                                  </div>
                                  <span className="text-xs text-muted-foreground tabular-nums w-10 text-right">{pct}%</span>
                                </div>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {row.levels.size > 0 ? Array.from(row.levels).sort().join(", ") : "—"}
                              </TableCell>
                              <TableCell className="text-xs font-mono text-muted-foreground">
                                {row.rules.size > 0 ? Array.from(row.rules).sort().join(", ") : "—"}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                  <div className="text-xs text-muted-foreground text-right">
                    {total} sign{total !== 1 ? "s" : ""} across {rows.length} type{rows.length !== 1 ? "s" : ""}
                  </div>
                </div>
              );
            })()}
          </TabsContent>
          <TabsContent value="confidence" className="mt-0 p-6 overflow-y-auto">
            <ConfidenceHistogram
              jobId={jobId!}
              lowConfidenceCount={lowConfidenceIds.length}
              reviewedLowConfidenceCount={reviewedLowConfidenceCount}
              allLowConfidenceReviewed={allLowConfidenceReviewed}
              confidenceThreshold={lowConfidenceThreshold / 100}
              activeBracketMin={confidenceBracketFilter?.minConfidence}
              activeBracketMax={confidenceBracketFilter?.maxConfidence}
              onBracketClick={(bracket) => {
                setConfidenceBracketFilter(bracket);
                handleTabChange("rooms");
              }}
              onClearBracket={() => setConfidenceBracketFilter(null)}
            />
          </TabsContent>
          <TabsContent value="ai-scans" className="mt-0 p-6 space-y-6 overflow-y-auto">
            {(() => {
              const { count: skipped, titles: skippedTitles } = getAiVisionSheetsSkipped(job.metadata as Record<string, unknown>);
              const canReprocess = canAct && (job.status === "completed" || job.status === "error");
              return (
                <SkippedSheetsWarning
                  skipped={skipped}
                  skippedTitles={skippedTitles}
                  canReprocess={canReprocess}
                  canAct={canAct}
                  onReprocess={handleRescan}
                  onSheetClick={handleSkippedSheetClick}
                  reprocessPending={rescanJob.isPending || processJob.isPending}
                />
              );
            })()}
            {(() => {
              const summary = getAiScanSummary(job?.metadata as Record<string, unknown>);
              const totalScanned = (summary?.cacheHits ?? 0) + (summary?.freshScans ?? 0);
              return (
                <div className="space-y-6">
                  {summary && (
                    <div>
                      <h3 className="text-base font-semibold mb-3">AI Scan Summary</h3>
                      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
                        <Card>
                          <CardHeader className="pb-2">
                            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Cache Hits</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="text-2xl font-bold text-emerald-500">{summary.cacheHits}</div>
                            {totalScanned > 0 && (
                              <p className="text-xs text-muted-foreground mt-1">
                                {Math.round((summary.cacheHits / totalScanned) * 100)}% of eligible sheets
                              </p>
                            )}
                          </CardContent>
                        </Card>
                        <Card>
                          <CardHeader className="pb-2">
                            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Fresh Scans</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="text-2xl font-bold">{summary.freshScans}</div>
                            <p className="text-xs text-muted-foreground mt-1">New Claude calls made</p>
                          </CardContent>
                        </Card>
                        <Card>
                          <CardHeader className="pb-2">
                            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Skipped</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="text-2xl font-bold text-muted-foreground">{summary.skippedAboveThreshold}</div>
                            <p className="text-xs text-muted-foreground mt-1">Above room threshold</p>
                          </CardContent>
                        </Card>
                        <Card>
                          <CardHeader className="pb-2">
                            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Est. Savings</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="text-2xl font-bold text-emerald-500">${summary.estimatedSavings.toFixed(4)}</div>
                            <p className="text-xs text-muted-foreground mt-1">From cached results</p>
                          </CardContent>
                        </Card>
                      </div>
                    </div>
                  )}
                  <div>
                    <h3 className="text-base font-semibold mb-3">Individual AI Calls</h3>
                    {!aiScans || aiScans.length === 0 ? (
                      <div className="flex items-center justify-center p-12 border border-dashed rounded-md text-muted-foreground">
                        No AI scan records for this job.
                      </div>
                    ) : (
                      <div className="rounded-md border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Call Type</TableHead>
                              <TableHead>Model</TableHead>
                              <TableHead className="text-right">Input Tokens</TableHead>
                              <TableHead className="text-right">Output Tokens</TableHead>
                              <TableHead className="text-right">Cost</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {aiScans.map((scan) => (
                              <TableRow key={scan.id}>
                                <TableCell className="font-mono text-sm">{scan.callType}</TableCell>
                                <TableCell className="text-muted-foreground text-sm">{scan.model}</TableCell>
                                <TableCell className="text-right tabular-nums">{scan.inputTokens?.toLocaleString() ?? "—"}</TableCell>
                                <TableCell className="text-right tabular-nums">{scan.outputTokens?.toLocaleString() ?? "—"}</TableCell>
                                <TableCell className="text-right tabular-nums font-medium">${(scan.cost as number)?.toFixed(4) ?? "—"}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
          </TabsContent>
          <TabsContent value="validation" className="mt-0 p-6 space-y-4 overflow-y-auto">
            {loadingValidation ? (
              <div className="flex items-center justify-center p-12 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : (() => {
              const unreviewed = validationWarnings.filter(r => !dismissedValIds.includes(r.id));
              const reviewed = validationWarnings.filter(r => dismissedValIds.includes(r.id));
              const passes = (validationResults ?? []).filter(r => r.status === "pass");
              if ((validationResults ?? []).length === 0) {
                return (
                  <div className="flex items-center justify-center p-12 border border-dashed rounded-md text-muted-foreground">
                    No validation results yet. Process the job to run checks.
                  </div>
                );
              }
              return (
                <div className="space-y-4">
                  {unreviewed.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-medium">Warnings requiring review ({unreviewed.length})</h3>
                        <Button size="sm" variant="outline" onClick={handleDismissAllValidationWarnings}>
                          <Check className="h-3.5 w-3.5 mr-1.5" />
                          Acknowledge all
                        </Button>
                      </div>
                      <div className="space-y-2">
                        {unreviewed.map(r => (
                          <DismissibleBanner key={r.id} show={!dismissingValIds.has(r.id)}>
                            <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-4 py-3">
                              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-amber-800 dark:text-amber-300 capitalize">{r.checkName.replace(/_/g, " ")}</p>
                                {r.details && <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">{r.details}</p>}
                              </div>
                              <Button size="sm" variant="ghost" className="shrink-0 h-7 px-2 text-xs" onClick={() => handleDismissValidationWarning(r.id)}>
                                <Check className="h-3.5 w-3.5 mr-1" />
                                Acknowledge
                              </Button>
                            </div>
                          </DismissibleBanner>
                        ))}
                      </div>
                    </div>
                  )}
                  {reviewed.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-sm font-medium text-muted-foreground">Acknowledged ({reviewed.length})</h3>
                      <div className="space-y-1.5">
                        {reviewed.map(r => (
                          <div key={r.id} className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-2.5 text-muted-foreground">
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                            <span className="text-sm capitalize">{r.checkName.replace(/_/g, " ")}</span>
                            {r.details && <span className="text-xs ml-1 truncate">{r.details}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {passes.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-sm font-medium text-muted-foreground">Passed ({passes.length})</h3>
                      <div className="space-y-1.5">
                        {passes.map(r => (
                          <div key={r.id} className="flex items-center gap-3 rounded-lg border bg-muted/20 px-4 py-2.5 text-muted-foreground">
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-green-400" />
                            <span className="text-sm capitalize">{r.checkName.replace(/_/g, " ")}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </TabsContent>
          <TabsContent value="export" className="mt-0 p-6 space-y-6 overflow-y-auto">
             <div>
               <h3 className="text-lg font-medium">Export Job Data</h3>
               <p className="text-sm text-muted-foreground mt-1">
                 Download the full sign takeoff as a formatted Excel workbook or a marked-up PDF with sign markers overlaid on the floor plans.
               </p>
             </div>
             {(() => {
               const dismissedRoomsList = rooms ? rooms.filter(r => r.reviewStatus === "dismissed") : [];
               const dismissedRoomCount = dismissedRoomsList.length;
               if (dismissedRoomCount === 0) return null;
               const MAX_SHOWN = 3;
               const shownRooms = dismissedRoomsList.slice(0, MAX_SHOWN);
               const extraCount = dismissedRoomCount - MAX_SHOWN;
               const roomLabels = shownRooms.map(r => r.roomNumber || r.roomName || r.id);
               return (
                 <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-400">
                   <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                   <span>
                     <strong>{dismissedRoomCount} dismissed room{dismissedRoomCount !== 1 ? "s" : ""}</strong> will be excluded from this export
                     {roomLabels.length > 0 && (
                       <>
                         {": "}
                         <strong>{roomLabels.join(", ")}</strong>
                         {extraCount > 0 && <span className="font-normal"> +{extraCount} more</span>}
                       </>
                     )}
                     {". "}
                     <button
                       type="button"
                       onClick={() => {
                         setShowDismissed(true);
                         setShowDismissedOnly(true);
                         scrollToDismissedRef.current = true;
                         handleTabChange("rooms");
                       }}
                       className="underline font-medium hover:text-amber-900 dark:hover:text-amber-300 focus:outline-none"
                     >
                       Review dismissed rooms
                     </button>
                   </span>
                 </div>
               );
             })()}
             <div className="flex flex-col gap-3">
               <p className="text-xs text-muted-foreground font-mono bg-muted/40 px-3 py-1.5 rounded w-fit border">
                 {xlsxFileName}
               </p>
               <div className="flex flex-wrap gap-3">
                 <Button
                   className="bg-amber-500 hover:bg-amber-600 text-white gap-2"
                   onClick={handleDownloadXlsx}
                   disabled={exportingXlsx}
                 >
                   {exportingXlsx ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                   {exportingXlsx ? "Generating…" : "Download XLSX"}
                 </Button>
                 <Button
                   variant="outline"
                   onClick={handleDownloadPdf}
                   disabled={exportingPdf}
                   className="gap-2"
                 >
                   {exportingPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                   {exportingPdf ? "Generating…" : "Download PDF"}
                 </Button>
               </div>
               <p className="text-xs text-muted-foreground">
                 XLSX includes Takeoff, Summary, and Pricing Detail tabs. PDF overlays sign markers on your floor plans.
               </p>
             </div>

             {/* ── Pricing Config ──────────────────────────────────────────────── */}
             <PricingConfig
               jobId={jobId}
               authFetch={authFetch}
               signs={signs}
               pricingOverrides={(job as { pricingOverrides?: Record<string, number> | null }).pricingOverrides}
             />
          </TabsContent>
          <TabsContent value="files" className="mt-0 p-6 overflow-y-auto">
            <div className="flex flex-col gap-6 max-w-3xl">
              <div>
                <h3 className="text-lg font-medium">Job Files</h3>
                <p className="text-sm text-muted-foreground mt-0.5">Upload construction documents — all pages are automatically classified as floor plans, sign schedules, or specs.</p>
              </div>

              {(() => {
                const typedFiles = (jobFiles ?? []).map(f => ({ ...f, fileCategory: (f as { fileCategory?: string | null }).fileCategory }));
                const otherFiles = typedFiles.filter(f => f.fileCategory === "plaque_schedule" || f.fileCategory === "other");
                return (
                  <>
                    <DualZoneUploader
                      jobId={jobId}
                      authFetch={authFetch}
                      files={typedFiles}
                      canAct={canAct}
                      onRefresh={() => {
                        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
                        refetchJobFiles();
                      }}
                    />

                    {otherFiles.length > 0 && (
                      <Card>
                        <CardHeader className="pb-3">
                          <CardTitle className="text-base">Other Files</CardTitle>
                          <CardDescription>Plaque schedules and reference documents — stored for reference, not processed.</CardDescription>
                        </CardHeader>
                        <CardContent className="p-0">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>File</TableHead>
                                <TableHead className="w-52">Category</TableHead>
                                <TableHead className="w-28 text-right">Size</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {otherFiles.map(f => (
                                <TableRow key={f.id}>
                                  <TableCell>
                                    <span className="flex items-center gap-2 text-sm font-medium truncate max-w-[320px]">
                                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                                      {f.filename}
                                    </span>
                                    <span className="text-xs text-muted-foreground ml-6">
                                      {new Date(f.createdAt).toLocaleDateString()}
                                    </span>
                                  </TableCell>
                                  <TableCell>
                                    <Select
                                      value={f.fileCategory ?? "other"}
                                      onValueChange={async (val) => {
                                        try {
                                          await authFetch(`/api/jobs/${jobId}/files/${f.id}`, {
                                            method: "PATCH",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({ fileCategory: val }),
                                          });
                                          refetchJobFiles();
                                          toast.success("Category updated");
                                        } catch { toast.error("Failed to update category"); }
                                      }}
                                    >
                                      <SelectTrigger className="h-8 text-sm">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="floor_plan">Floor Plan</SelectItem>
                                        <SelectItem value="room_schedule">Room / Finish Schedule</SelectItem>
                                        <SelectItem value="sign_schedule">Sign Schedule / Specs</SelectItem>
                                        <SelectItem value="plaque_schedule">Plaque Schedule</SelectItem>
                                        <SelectItem value="other">Other</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </TableCell>
                                  <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                                    {f.fileSizeBytes != null ? `${(f.fileSizeBytes / 1024 / 1024).toFixed(1)} MB` : "—"}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </CardContent>
                      </Card>
                    )}
                  </>
                );
              })()}
            </div>
          </TabsContent>
          <TabsContent value="sheets" className="mt-0 p-6 overflow-y-auto">
             <div className="flex items-center justify-center p-12 border border-dashed rounded-md text-muted-foreground">Identified Sheets</div>
          </TabsContent>
          <TabsContent value="settings" className="mt-0 p-6 overflow-y-auto">
            <div className="max-w-xl space-y-6">
              <div>
                <h3 className="text-lg font-medium">Job Settings</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Adjust settings that affect how this job is processed.
                </p>
              </div>
              {canAct && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Job Details</CardTitle>
                    <CardDescription>
                      Edit the core details for this job. Changes are reflected immediately across the job detail page.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="job-name">Name</Label>
                      <Input
                        id="job-name"
                        placeholder="Job name"
                        value={detailsForm.name}
                        onChange={(e) => { setDetailsForm(f => ({ ...f, name: e.target.value })); setDetailsDirty(true); }}
                        disabled={detailsSaving}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="job-location">Location</Label>
                      <Input
                        id="job-location"
                        placeholder="e.g. 123 Main St, Springfield"
                        value={detailsForm.location}
                        onChange={(e) => { setDetailsForm(f => ({ ...f, location: e.target.value })); setDetailsDirty(true); }}
                        disabled={detailsSaving}
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Label htmlFor="job-building-type">Building Type</Label>
                        {detailsForm.buildingType && (() => {
                          const guide = getBuildingTypeOption(detailsForm.buildingType)?.uploadGuide;
                          if (!guide) return null;
                          return (
                            <Popover>
                              <PopoverTrigger asChild>
                                <button type="button" className="rounded-full p-0.5 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" aria-label="Upload tips">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                                </button>
                              </PopoverTrigger>
                              <PopoverContent className="w-80 p-4" side="right" align="start">
                                <div className="flex flex-col gap-3 text-xs">
                                  <p className="font-semibold text-sm text-foreground">Upload Guide</p>
                                  <div>
                                    <p className="font-medium text-foreground mb-1">Look for:</p>
                                    <ul className="space-y-0.5 text-muted-foreground">
                                      {guide.lookFor.map((item, i) => <li key={i} className="flex gap-1.5"><span className="text-emerald-500 shrink-0">✓</span>{item}</li>)}
                                    </ul>
                                  </div>
                                  <div>
                                    <p className="font-medium text-foreground mb-1">Avoid:</p>
                                    <ul className="space-y-0.5 text-muted-foreground">
                                      {guide.avoid.map((item, i) => <li key={i} className="flex gap-1.5"><span className="text-red-500 shrink-0">✕</span>{item}</li>)}
                                    </ul>
                                  </div>
                                  {guide.roomScheduleHint && (
                                    <div className="rounded-md bg-muted/50 px-3 py-2">
                                      <p className="font-medium text-foreground mb-0.5">Room schedule:</p>
                                      <p className="text-muted-foreground">{guide.roomScheduleHint}</p>
                                    </div>
                                  )}
                                  {guide.signScheduleHint && (
                                    <div className="rounded-md bg-muted/50 px-3 py-2">
                                      <p className="font-medium text-foreground mb-0.5">Sign schedule:</p>
                                      <p className="text-muted-foreground">{guide.signScheduleHint}</p>
                                    </div>
                                  )}
                                </div>
                              </PopoverContent>
                            </Popover>
                          );
                        })()}
                      </div>
                      <Select
                        value={detailsForm.buildingType === "" ? "__none__" : detailsForm.buildingType}
                        onValueChange={(val) => { setDetailsForm(f => ({ ...f, buildingType: val === "__none__" ? "" : val })); setDetailsDirty(true); }}
                        disabled={detailsSaving}
                      >
                        <SelectTrigger id="job-building-type">
                          <SelectValue placeholder="Select building type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">None / Not specified</SelectItem>
                          {CANONICAL_BUILDING_TYPES.map((bt) => (
                            <SelectItem key={bt.value} value={bt.value}>
                              {bt.icon} {bt.label}
                            </SelectItem>
                          ))}
                          {detailsForm.buildingType && !CANONICAL_BUILDING_TYPES.some(bt => bt.value === detailsForm.buildingType) && (
                            <SelectItem value={detailsForm.buildingType}>{detailsForm.buildingType}</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-3 pt-1">
                      <Button
                        onClick={handleSaveJobDetails}
                        disabled={detailsSaving || !detailsDirty}
                        size="sm"
                      >
                        {detailsSaving ? (
                          <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving…</>
                        ) : (
                          "Save"
                        )}
                      </Button>
                      {!detailsDirty && detailsForm.name !== "" && (
                        <span className="text-sm text-muted-foreground flex items-center gap-1">
                          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                          Saved
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">AI Vision Threshold</CardTitle>
                  <CardDescription>
                    Minimum number of rooms per sheet required to trigger AI vision analysis.
                    Set to 0 to disable AI vision entirely. Leave blank to use the default (3).
                    Takes effect on the next pipeline run.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-3">
                      <Input
                        id="vision-threshold"
                        type="number"
                        min={0}
                        max={THRESHOLD_MAX}
                        step={1}
                        placeholder="Default (3)"
                        className={`w-36${thresholdError ? " border-destructive focus-visible:ring-destructive" : ""}`}
                        aria-invalid={!!thresholdError}
                        aria-describedby={thresholdError ? "threshold-error" : "threshold-hint"}
                        value={thresholdInput}
                        onChange={(e) => {
                          if (!canAct) return;
                          setThresholdInput(e.target.value);
                          setThresholdDirty(true);
                          setThresholdError(null);
                        }}
                        disabled={updateJob.isPending || !canAct}
                        readOnly={!canAct}
                      />
                      {canAct && (
                        <Button
                          onClick={handleSaveThreshold}
                          disabled={updateJob.isPending || !thresholdDirty}
                          size="sm"
                        >
                          {updateJob.isPending ? (
                            <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving…</>
                          ) : (
                            "Save"
                          )}
                        </Button>
                      )}
                      {!thresholdDirty && job.visionThreshold != null && (
                        <span className="text-sm text-muted-foreground flex items-center gap-1">
                          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                          Saved
                        </span>
                      )}
                    </div>
                    {thresholdError ? (
                      <p id="threshold-error" className="text-xs text-destructive flex items-center gap-1">
                        <XCircle className="h-3.5 w-3.5 shrink-0" />
                        {thresholdError}
                      </p>
                    ) : (
                      <p id="threshold-hint" className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">0</span> disables AI vision. {" "}
                        <span className="font-medium text-foreground">3</span> is the default — sheets with fewer rooms are skipped. {" "}
                        Higher values (up to <span className="font-medium text-foreground">{THRESHOLD_MAX}</span>) reduce AI scans on large jobs.{" "}
                        Current:{" "}
                        <span className="font-medium text-foreground">
                          {job.visionThreshold != null ? job.visionThreshold : "system default (3)"}
                        </span>.
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </div>
      </Tabs>

      <Dialog open={showForceScanDialog} onOpenChange={setShowForceScanDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Confirm full re-process
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 pt-1">
                <p>
                  <span className="font-medium text-foreground">Force full re-process</span> will clear all cached
                  results from previous runs and restart the pipeline completely from scratch.
                </p>
                <p className="text-sm">This clears:</p>
                <ul className="text-sm list-disc list-inside space-y-0.5 pl-1">
                  <li>Parsed drawing index (sheet list)</li>
                  <li>Room inventory and AI vision results</li>
                  <li>Sign dictionary extracted from signage notes</li>
                  <li>Previous AI cost records for this job</li>
                </ul>
                {loadingSheets ? (
                  <p className="text-sm text-muted-foreground">
                    <span className="inline-block h-4 w-16 animate-pulse rounded bg-muted align-middle mr-1" />
                    checking sheet count…
                  </p>
                ) : (
                  <p className="text-sm text-amber-600 dark:text-amber-400 font-medium">
                    Fresh AI calls will be made for all {freshScanSheetLabel}. This may incur additional costs.
                  </p>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowForceScanDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="default"
              onClick={() => {
                setShowForceScanDialog(false);
                doRescan();
              }}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Yes, run full re-process
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkDismissDialogOpen} onOpenChange={(open) => { if (!open) { setBulkDismissDialogOpen(false); setBulkDismissReason(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Dismiss All AI Rooms</DialogTitle>
            <DialogDescription>
              Dismiss{" "}
              <span className="font-medium text-foreground">
                {pendingAiRooms.length} AI vision {pendingAiRooms.length === 1 ? "room" : "rooms"}
              </span>
              {pendingAiSignCount > 0 && (
                <>
                  {" "}and remove their{" "}
                  <span className="font-medium text-foreground">
                    {pendingAiSignCount} associated {pendingAiSignCount === 1 ? "sign" : "signs"}
                  </span>
                </>
              )}{" "}
              from the count? Optionally leave a shared note explaining why.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Textarea
              placeholder="Reason for dismissal (optional)"
              value={bulkDismissReason}
              onChange={(e) => setBulkDismissReason(e.target.value)}
              className="resize-none"
              rows={3}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleBulkDismissConfirm(); }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setBulkDismissDialogOpen(false); setBulkDismissReason(""); }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkDismissConfirm}
              disabled={bulkReviewRooms.isPending}
            >
              {bulkReviewRooms.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={cancelConfirmOpen} onOpenChange={setCancelConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hard-kill this job?</AlertDialogTitle>
            <AlertDialogDescription>
              This immediately stops processing and marks the job as failed. Any in-flight work will be abandoned. You can re-run the job afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelJob.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={cancelJob.isPending}
              onClick={(e) => {
                e.preventDefault();
                cancelJob.mutate({ jobId }, {
                  onSuccess: () => {
                    queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
                    setCancelConfirmOpen(false);
                  },
                });
              }}
            >
              {cancelJob.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Hard-kill
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={bulkResetConfirmedDialogOpen} onOpenChange={(open) => { if (!open) setBulkResetConfirmedDialogOpen(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset All Confirmed Rooms</AlertDialogTitle>
            <AlertDialogDescription>
              This will reset{" "}
              <span className="font-semibold">
                {rooms?.filter(r => r.source === "ai_vision" && r.reviewStatus === "confirmed").length ?? 0} confirmed room{(rooms?.filter(r => r.source === "ai_vision" && r.reviewStatus === "confirmed").length ?? 0) !== 1 ? "s" : ""}
              </span>{" "}
              back to pending. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setBulkResetConfirmedDialogOpen(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { setBulkResetConfirmedDialogOpen(false); handleBulkRoomAction("pending", "confirmed"); }}
              disabled={bulkReviewRooms.isPending}
            >
              {bulkReviewRooms.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Reset All Confirmed
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!dismissDialogRoomId} onOpenChange={(open) => { if (!open) { setDismissDialogRoomId(null); setDismissReason(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Dismiss AI Room</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Optionally leave a note explaining why this room is being dismissed. This helps track decisions and improve AI accuracy over time.
            </p>
            <Textarea
              placeholder="Reason for dismissal (optional)"
              value={dismissReason}
              onChange={(e) => setDismissReason(e.target.value)}
              className="resize-none"
              rows={3}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleDismissConfirm(); }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDismissDialogRoomId(null); setDismissReason(""); }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDismissConfirm}
              disabled={updateRoomReviewStatus.isPending}
            >
              {updateRoomReviewStatus.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Dismiss Room
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={bulkConfirmDialog !== null} onOpenChange={(open) => { if (!open) setBulkConfirmDialog(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {bulkConfirmDialog?.action === "confirmed" && "Accept all AI rooms?"}
              {bulkConfirmDialog?.action === "pending" && "Restore all dismissed rooms?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {bulkConfirmDialog?.action === "confirmed" && (
                bulkConfirmDialog.level
                  ? `Accept ${bulkConfirmDialog.count} pending AI room${bulkConfirmDialog.count === 1 ? "" : "s"} on Level ${bulkConfirmDialog.level}? This action cannot be undone.`
                  : `This will accept ${bulkConfirmDialog.count} pending AI room${bulkConfirmDialog.count === 1 ? "" : "s"}. This action cannot be undone.`
              )}
              {bulkConfirmDialog?.action === "pending" && `This will restore ${bulkConfirmDialog?.count} dismissed AI room${bulkConfirmDialog?.count === 1 ? "" : "s"} to pending review.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setBulkConfirmDialog(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (bulkConfirmDialog) {
                  handleBulkRoomAction(bulkConfirmDialog.action, undefined, bulkConfirmDialog.level);
                  setBulkConfirmDialog(null);
                }
              }}
            >
              {bulkConfirmDialog?.action === "confirmed" && "Accept all"}
              {bulkConfirmDialog?.action === "pending" && "Restore all"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pendingNavigation !== null} onOpenChange={(open) => { if (!open) handleCancelNavigation(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes to the job details. If you leave now, your changes will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelNavigation}>Stay</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmNavigation}>Discard changes</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dismissedDownloadDialog !== null} onOpenChange={(open) => { if (!open) setDismissedDownloadDialog(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
              Dismissed rooms will be excluded
            </AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{dismissedDownloadDialog?.count} dismissed room{dismissedDownloadDialog?.count !== 1 ? "s" : ""}</strong> will not appear in this export. Review them first if you want them included.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setDismissedDownloadDialog(null);
                setShowDismissed(true);
                scrollToDismissedRef.current = true;
                handleTabChange("rooms");
              }}
            >
              Review dismissed rooms
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const type = dismissedDownloadDialog?.type;
                setDismissedDownloadDialog(null);
                if (type === "xlsx") executeDownloadXlsx();
                else if (type === "pdf") executeDownloadPdf();
              }}
            >
              Export anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Train from this job modal */}
      <Dialog open={trainModalOpen} onOpenChange={(open) => { if (!open) setTrainModalOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GraduationCap className="h-5 w-5" />
              Train from this job
            </DialogTitle>
            <DialogDescription>
              Upload the completed takeoff spreadsheet for this job to train the sign rules engine.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Batch label</label>
              <Input
                value={trainBatchLabel}
                onChange={e => setTrainBatchLabel(e.target.value)}
                placeholder="e.g. Cambridge Moses Youth Center"
              />
              <p className="text-xs text-muted-foreground">Used to identify this training batch in the history</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Takeoff Spreadsheet <span className="text-destructive">*</span></label>
              <input
                ref={trainXlsxInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0] ?? null; setTrainXlsxFile(f); e.target.value = ""; }}
              />
              {trainXlsxFile ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                  <FileSpreadsheet className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="text-sm truncate flex-1">{trainXlsxFile.name}</span>
                  <button type="button" onClick={() => setTrainXlsxFile(null)} className="text-muted-foreground hover:text-foreground">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => trainXlsxInputRef.current?.click()}
                  className="w-full flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border hover:border-primary/50 hover:bg-muted/30 transition-colors py-5 px-4"
                >
                  <Upload className="h-6 w-6 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Click to browse — XLSX or CSV up to 5MB</span>
                </button>
              )}
            </div>

            {job && (
              <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground space-y-0.5">
                <p><span className="font-medium text-foreground">Job:</span> {job.name}</p>
                {(jobFiles ?? []).find(f => !f.fileCategory || f.fileCategory === "floor_plan") && (
                  <p><span className="font-medium text-foreground">Floor plan PDF:</span> already attached to this job</p>
                )}
              </div>
            )}

            {trainError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                {trainError}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setTrainModalOpen(false)} disabled={trainIsAnalyzing}>
              Cancel
            </Button>
            <Button onClick={handleTrainAnalyze} disabled={!trainXlsxFile || trainIsAnalyzing}>
              {trainIsAnalyzing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Analyzing…
                </>
              ) : (
                <>
                  <GraduationCap className="h-4 w-4 mr-2" />
                  Analyze &amp; Review
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
