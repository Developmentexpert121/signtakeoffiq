import { useState, useRef, useMemo, useEffect, useCallback, Fragment } from "react";
import { useLocation, useSearch } from "wouter";
import { usePersistedTab } from "@/hooks/usePersistedTab";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useGetOverrideImpact, useGetTrainingSnapshots, getTrainingSnapshots, useRequestUploadUrl, useListRuleOverrides, useListCorrections, useUpdateRuleOverride, customFetch, useGetTenant, useUpdateTenant, useListSavedDateRanges, useCreateSavedDateRange, useDeleteSavedDateRange, getListSavedDateRangesQueryKey, useUpdateSnapshot, useDeleteSnapshot, deleteSnapshot, createSavedDateRange, useReorderSavedDateRanges, useListJobs, useInvalidateSnapshotsCache, ApiError } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import type { RuleOverride, TrainingCorrection, GetTrainingSnapshotsParams, TrainingSnapshot, ConfidenceTrendPoint } from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { getListRuleOverridesQueryKey, getGetTrainingSnapshotsQueryKey, getGetOverrideImpactQueryKey } from "@workspace/api-client-react";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { Loader2, Upload, FileSpreadsheet, FileText, CheckCircle2, ArrowRight, AlertCircle, RefreshCw, ExternalLink, ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight, Download, Bookmark, X, Pencil, Check, CalendarDays, TrendingUp, TrendingDown, Trash2, Star, Info, Minus } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import {
  Tooltip as UITooltip,
  TooltipTrigger as UITooltipTrigger,
  TooltipContent as UITooltipContent,
  TooltipProvider as UITooltipProvider,
} from "@/components/ui/tooltip";
import { getBuildingTypeOption, getBuildingTypeLabel } from "@/lib/buildingTypes";

interface ImportDiff {
  id: string;
  roomNumber: string;
  roomName: string;
  level: string;
  qty: number;
  pipelineSignType: string;
  humanSignType: string;
  ruleRef: string;
  existingCorrectedSignType?: string | null;
  diffCategory?: "new" | "conflict" | "duplicate";
  skipOverwrite?: boolean;
}

function getDiffCategory(d: ImportDiff): "new" | "conflict" | "duplicate" {
  if (d.diffCategory) return d.diffCategory;
  if (d.existingCorrectedSignType == null) return "new";
  if (d.existingCorrectedSignType === d.humanSignType) return "duplicate";
  return "conflict";
}

interface AiMissedItem {
  id: string;
  roomNumber: string;
  roomName: string;
  level: string;
  qty: number;
  signType: string;
}

interface AiExtraItem {
  id: string;
  roomId: string;
  roomNumber: string;
  roomName: string;
  level: string;
  signType: string;
  confidence: number;
}

interface CollisionPreview {
  roomNamePattern: string;
  signType: string;
  oldCorrectedValue: string;
  newCorrectedValue: string;
}

type CollisionSortCol = "roomNamePattern" | "oldCorrectedValue" | "newCorrectedValue";

type SourceType = "estimator_verified" | "architect_schedule" | "as_built" | "";

interface ImportAnalysisResult {
  totalDiffs: number;
  totalRows: number;
  collisionCount: number;
  diffs: ImportDiff[];
  collisions: CollisionPreview[];
  matchedCount?: number;
  aiMissedCount?: number;
  aiExtraCount?: number;
  aiMissed?: AiMissedItem[];
  aiExtra?: AiExtraItem[];
}

interface OverrideChange {
  ruleRef: string;
  roomNamePattern: string;
  signType: string;
  pipelineSignType: string;
  confidence: number;
  status: "new" | "updated";
}

interface ConfirmResult {
  saved: number;
  updated: number;
  skipped: number;
  overridesCreatedOrUpdated: number;
  overrideChanges: OverrideChange[];
  prevAvgConfidence: number | null;
  newAvgConfidence: number;
  accuracyScore: number | null;
  impact: {
    totalOverrides: number;
    activeOverrides: number;
    totalCorrections: number;
  };
}

type ImportMode = "skip" | "update";
type SortCol = "roomNamePattern" | "signType" | "pipelineSignType" | "confidence" | "status";
type SortDir = "asc" | "desc";


type ImportStep = "upload" | "review" | "done";

type TrendWindow = 30 | 90 | 365 | "all" | "custom";

interface SavedDateRange {
  id: string;
  name: string;
  start: string;
  end: string;
}

const SNAPSHOTS_DEFAULT_LIMIT = 100;

function trendWindowToParams(window: TrendWindow, customStart?: string, customEnd?: string): GetTrainingSnapshotsParams {
  if (window === "custom") {
    const params: GetTrainingSnapshotsParams = { limit: SNAPSHOTS_DEFAULT_LIMIT };
    if (customStart) params.startDate = new Date(customStart).toISOString();
    if (customEnd) {
      const end = new Date(customEnd);
      end.setHours(23, 59, 59, 999);
      params.endDate = end.toISOString();
    }
    return params;
  }
  if (window === "all") return { limit: SNAPSHOTS_DEFAULT_LIMIT };
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - window);
  return { startDate: startDate.toISOString(), limit: SNAPSHOTS_DEFAULT_LIMIT };
}

const DEFAULT_OVERWRITE_THRESHOLD = 10;

const VALID_TABS = ["overrides", "corrections", "import", "patterns", "settings"];

interface WeekFilter {
  weekStart: Date;
  weekEnd: Date;
  label: string;
}

function getWeekRange(importDate: string): WeekFilter {
  const d = new Date(importDate);
  const day = d.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  const label = monday.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return { weekStart: monday, weekEnd: sunday, label };
}

export default function Training() {
  const { data: impact, isLoading: loadingImpact, refetch: refetchImpact } = useGetOverrideImpact();
  const { data: tenant } = useGetTenant();
  const { data: trainingCount, refetch: refetchCount } = useQuery({
    queryKey: ["training-count"],
    queryFn: () => customFetch<{ totalCorrections: number; totalOverrides: number; lastImportAt: string | null; lastImportCount: number | null }>("/api/training/count"),
    staleTime: 60_000,
  });
  const { data: trainingHealth } = useQuery({
    queryKey: ["training-health"],
    queryFn: () => customFetch<{ validatedJobs: number; avgAccuracy: number; patternsActive: number }>("/api/training/health"),
    staleTime: 60_000,
  });
  const { data: aiCost } = useQuery({
    queryKey: ["training-ai-cost"],
    queryFn: () => customFetch<{ totalScans: number; totalCost: number; avgCostPerScan: number; firstTrainingDate: string | null }>("/api/training/ai-cost"),
    staleTime: 60_000,
  });

  const [activeTab, setActiveTab] = usePersistedTab("training.activeTab", VALID_TABS, "overrides", "tab");
  const [, setLocation] = useLocation();

  const [weekFilter, setWeekFilterState] = useState<WeekFilter | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const weekOf = params.get("weekOf");
    return weekOf ? getWeekRange(weekOf) : null;
  });

  function setWeekFilter(filter: WeekFilter | null) {
    setWeekFilterState(filter);
    const params = new URLSearchParams(window.location.search);
    if (filter) {
      const d = filter.weekStart;
      const weekOfStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      params.set("weekOf", weekOfStr);
    } else {
      params.delete("weekOf");
    }
    const newSearch = params.toString();
    setLocation(window.location.pathname + (newSearch ? "?" + newSearch : ""), { replace: true });
  }

  const overwriteThreshold: number =
    typeof (tenant?.settings as Record<string, unknown> | undefined)?.overwriteThreshold === "number"
      ? ((tenant?.settings as Record<string, unknown>).overwriteThreshold as number)
      : DEFAULT_OVERWRITE_THRESHOLD;

  function handleWeekClick(importDate: string) {
    setWeekFilter(getWeekRange(importDate));
    if (activeTab !== "overrides" && activeTab !== "corrections") {
      setActiveTab("overrides");
    }
  }

  const handleTabChange = (tab: string) => {
    if (tab !== "overrides" && tab !== "corrections") setWeekFilter(null);
    setActiveTab(tab);
  };

  const [pendingThreshold, setPendingThreshold] = useState<number | null>(null);
  const [overviewCollapsed, setOverviewCollapsed] = useState(false);
  const [chartCollapsed, setChartCollapsed] = useState(false);

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8 max-w-[1600px] mx-auto w-full">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Training Center</h1>
        <p className="text-muted-foreground mt-1">Manage global rule overrides and AI corrections.</p>
        {trainingCount && (
          <p className="text-sm text-muted-foreground mt-1 tabular-nums">
            {trainingCount.totalCorrections.toLocaleString()} corrections
            {" · "}
            {trainingCount.totalOverrides.toLocaleString()} overrides
            {trainingCount.lastImportAt && (
              <>
                {" · Last import: "}
                {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(trainingCount.lastImportAt))}
                {trainingCount.lastImportCount != null && ` (${trainingCount.lastImportCount} rows)`}
              </>
            )}
          </p>
        )}
      </div>

      {loadingImpact ? (
        <div className="flex justify-center p-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
      ) : impact ? (
        <div className="flex flex-col gap-4 mb-2">
          <button
            onClick={() => setOverviewCollapsed(c => !c)}
            className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors w-fit"
          >
            {overviewCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            Training Overview
          </button>
          {!overviewCollapsed && (<>
            <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Active Overrides</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{impact.activeOverrides}</div>
                <p className="text-xs text-muted-foreground mt-1">out of {impact.totalOverrides} total</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total Corrections</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{impact.totalCorrections}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Corrections This Month</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{impact.correctionsThisMonth}</div>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground">Training Health</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x">
                <div className="py-3 sm:py-0 sm:pr-6">
                  <p className="text-xs text-muted-foreground mb-1">Validated Jobs</p>
                  <div className="text-2xl font-bold">{trainingHealth?.validatedJobs ?? "—"}</div>
                  <p className="text-xs text-muted-foreground mt-1">imports with accuracy score</p>
                </div>
                <div className="px-6">
                  <p className="text-xs text-muted-foreground mb-1">Avg Accuracy</p>
                  <div className="text-2xl font-bold">
                    {trainingHealth != null
                      ? trainingHealth.validatedJobs > 0
                        ? `${Math.round(trainingHealth.avgAccuracy * 1000) / 10}%`
                        : "—"
                      : "—"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">across validated imports</p>
                </div>
                <div className="pl-6">
                  <p className="text-xs text-muted-foreground mb-1">Patterns Active</p>
                  <div className="text-2xl font-bold">{trainingHealth?.patternsActive ?? "—"}</div>
                  <p className="text-xs text-muted-foreground mt-1">approved patterns</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground">AI Scan Cost Since Training Started</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x">
                <div className="py-3 sm:py-0 sm:pr-6">
                  <p className="text-xs text-muted-foreground mb-1">Total Scans</p>
                  <div className="text-2xl font-bold">{aiCost?.totalScans ?? "—"}</div>
                  <p className="text-xs text-muted-foreground mt-1">distinct jobs processed</p>
                </div>
                <div className="px-6">
                  <p className="text-xs text-muted-foreground mb-1">Total AI Cost</p>
                  <div className="text-2xl font-bold">
                    {aiCost?.totalCost != null ? `$${Number(aiCost.totalCost).toFixed(2)}` : "—"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {aiCost?.firstTrainingDate
                      ? `since ${new Date(aiCost.firstTrainingDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
                      : "post-training"}
                  </p>
                </div>
                <div className="pl-6">
                  <p className="text-xs text-muted-foreground mb-1">Avg Cost / Scan</p>
                  <div className="text-2xl font-bold">
                    {aiCost?.totalScans && aiCost?.avgCostPerScan != null ? `$${Number(aiCost.avgCostPerScan).toFixed(2)}` : "—"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">per job</p>
                </div>
              </div>
            </CardContent>
          </Card>
          </>)}
          <ConfidenceTrendChart onWeekClick={handleWeekClick} collapsed={chartCollapsed} onToggle={() => setChartCollapsed(c => !c)} />
        </div>
      ) : null}

      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="flex w-full max-w-[700px] overflow-x-auto sm:grid sm:grid-cols-5">
          <TabsTrigger value="overrides" className="shrink-0">Rule Overrides</TabsTrigger>
          <TabsTrigger value="corrections" className="shrink-0">Corrections</TabsTrigger>
          <TabsTrigger value="import" className="shrink-0">Import Data</TabsTrigger>
          <TabsTrigger value="patterns" className="shrink-0">Patterns</TabsTrigger>
          <TabsTrigger value="settings" className="relative shrink-0">
            Settings
            {pendingThreshold !== null && (
              <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-orange-400" aria-label="Unsaved changes" />
            )}
          </TabsTrigger>
        </TabsList>
        <div className="mt-6">
          <TabsContent value="overrides" className="mt-0">
            <OverridesTab weekFilter={weekFilter} onClearWeekFilter={() => setWeekFilter(null)} />
          </TabsContent>
          <TabsContent value="corrections" className="mt-0">
            <CorrectionsTab weekFilter={weekFilter} onClearWeekFilter={() => setWeekFilter(null)} />
          </TabsContent>
          <TabsContent value="import" className="mt-0">
            <ImportTab
              onDone={() => { refetchImpact(); void refetchCount(); }}
              onViewOverrides={() => handleTabChange("overrides")}
              onGoToSettings={() => handleTabChange("settings")}
              overwriteThreshold={overwriteThreshold}
              pendingThreshold={pendingThreshold}
            />
          </TabsContent>
          <TabsContent value="patterns" className="mt-0">
            <PatternsTab />
          </TabsContent>
          <TabsContent value="settings" className="mt-0">
            <TrainingSettingsTab
              overwriteThreshold={overwriteThreshold}
              onPendingThresholdChange={setPendingThreshold}
            />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function SortIcon({ col, sortCol, sortDir }: { col: string; sortCol: string; sortDir: SortDir }) {
  if (col !== sortCol) return <ChevronsUpDown className="h-3 w-3 ml-1 inline opacity-40" />;
  return sortDir === "asc"
    ? <ChevronUp className="h-3 w-3 ml-1 inline" />
    : <ChevronDown className="h-3 w-3 ml-1 inline" />;
}

function formatCondition(condition: Record<string, unknown>): string {
  if (condition.roomNamePattern) return `room: "${condition.roomNamePattern}"`;
  return JSON.stringify(condition);
}

function formatAction(action: Record<string, unknown>): string {
  if (action.signType) return `→ ${action.signType}`;
  return JSON.stringify(action);
}

function OverridesTab({ weekFilter, onClearWeekFilter }: { weekFilter: WeekFilter | null; onClearWeekFilter: () => void }) {
  const { data: overrides, isLoading, isError, refetch } = useListRuleOverrides();
  const updateOverride = useUpdateRuleOverride();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState<string>(() => {
    try {
      return localStorage.getItem("training.overridesTab.search") ?? "";
    } catch {
      return "";
    }
  });
  const [minConfidence, setMinConfidence] = useState("");
  const [maxConfidence, setMaxConfidence] = useState("");
  const VALID_OVERRIDES_SORT_COLS: (keyof RuleOverride)[] = ["createdAt", "overrideType", "confidence", "sourceCorrections", "isActive"];
  const [sortCol, setSortCol] = useState<keyof RuleOverride>(() => {
    try {
      const stored = localStorage.getItem("training.overridesTab.sortCol") as keyof RuleOverride;
      return VALID_OVERRIDES_SORT_COLS.includes(stored) ? stored : "createdAt";
    } catch { return "createdAt"; }
  });
  const [sortDir, setSortDir] = useState<SortDir>(() => {
    try {
      const stored = localStorage.getItem("training.overridesTab.sortDir");
      return stored === "asc" || stored === "desc" ? stored : "desc";
    } catch { return "desc"; }
  });
  const [togglingId, setTogglingId] = useState<string | null>(null);

  useEffect(() => {
    try { localStorage.setItem("training.overridesTab.search", search); } catch {}
  }, [search]);
  useEffect(() => {
    try { localStorage.setItem("training.overridesTab.sortCol", sortCol); } catch {}
  }, [sortCol]);
  useEffect(() => {
    try { localStorage.setItem("training.overridesTab.sortDir", sortDir); } catch {}
  }, [sortDir]);

  function handleSort(col: keyof RuleOverride) {
    if (col === sortCol) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  }

  const filtered = useMemo(() => {
    if (!overrides) return [];
    const q = search.toLowerCase();
    const minPct = minConfidence !== "" ? parseFloat(minConfidence) : null;
    const maxPct = maxConfidence !== "" ? parseFloat(maxConfidence) : null;
    return overrides.filter(o => {
      if (weekFilter) {
        const created = new Date(o.createdAt);
        if (created < weekFilter.weekStart || created > weekFilter.weekEnd) return false;
      }
      if (
        !q ||
        o.ruleRef.toLowerCase().includes(q) ||
        o.overrideType.toLowerCase().includes(q) ||
        formatCondition(o.condition as Record<string, unknown>).toLowerCase().includes(q) ||
        formatAction(o.action as Record<string, unknown>).toLowerCase().includes(q)
      ) {
        const pct = Math.round(o.confidence * 100);
        if (minPct !== null && !isNaN(minPct) && pct < minPct) return false;
        if (maxPct !== null && !isNaN(maxPct) && pct > maxPct) return false;
        return true;
      }
      return false;
    });
  }, [overrides, search, weekFilter, minConfidence, maxConfidence]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = a[sortCol] as string | number | boolean;
      const bv = b[sortCol] as string | number | boolean;
      if (av === bv) return 0;
      const lt = av < bv ? -1 : 1;
      return sortDir === "asc" ? lt : -lt;
    });
  }, [filtered, sortCol, sortDir]);

  async function handleToggle(override: RuleOverride) {
    setTogglingId(override.id);
    try {
      await updateOverride.mutateAsync({ overrideId: override.id, data: { isActive: !override.isActive } });
      await queryClient.invalidateQueries({ queryKey: getListRuleOverridesQueryKey() });
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Active Rule Overrides</CardTitle>
            <CardDescription>Global logic overrides applied to all new jobs. Toggle to enable or disable individual rules.</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => refetch()} className="shrink-0">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
        {weekFilter && (
          <div className="flex items-center gap-2 mt-2 px-3 py-2 rounded-md bg-primary/10 border border-primary/20 text-sm w-fit">
            <CalendarDays className="h-4 w-4 text-primary shrink-0" />
            <span className="text-primary font-medium">Filtered to week of {weekFilter.label}</span>
            <button
              onClick={onClearWeekFilter}
              className="ml-1 rounded-full p-0.5 hover:bg-primary/20 transition-colors"
              aria-label="Clear week filter"
            >
              <X className="h-3.5 w-3.5 text-primary" />
            </button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Search by rule ref, type, condition or action…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="max-w-sm"
          />
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-xs text-muted-foreground whitespace-nowrap">Confidence</span>
            <div className="relative">
              <Input
                type="number"
                min={0}
                max={100}
                placeholder="Min %"
                value={minConfidence}
                onChange={e => setMinConfidence(e.target.value)}
                className="h-9 text-xs w-20 pr-5"
                aria-label="Minimum confidence percentage"
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">%</span>
            </div>
            <span className="text-xs text-muted-foreground">–</span>
            <div className="relative">
              <Input
                type="number"
                min={0}
                max={100}
                placeholder="Max %"
                value={maxConfidence}
                onChange={e => setMaxConfidence(e.target.value)}
                className="h-9 text-xs w-20 pr-5"
                aria-label="Maximum confidence percentage"
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">%</span>
            </div>
            {(minConfidence !== "" || maxConfidence !== "") && (
              <button
                onClick={() => { setMinConfidence(""); setMaxConfidence(""); }}
                className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Clear confidence filter"
                aria-label="Clear confidence filter"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="flex justify-center p-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : isError ? (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-md border border-red-200">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Failed to load rule overrides.
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-12 border border-dashed rounded-md text-muted-foreground text-sm">
            {weekFilter
              ? `No overrides were created during the week of ${weekFilter.label}.`
              : (search || minConfidence !== "" || maxConfidence !== "")
                ? "No overrides match the current filters."
                : "No rule overrides yet. Import training data to generate overrides."}
          </div>
        ) : (
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  {(
                    [
                      { key: "ruleRef", label: "Rule Ref" },
                      { key: "overrideType", label: "Type" },
                      { key: null, label: "Condition" },
                      { key: null, label: "Action" },
                      { key: "confidence", label: "Confidence" },
                      { key: "sourceCorrections", label: "Sources" },
                      { key: "isActive", label: "Active" },
                    ] as { key: keyof RuleOverride | null; label: string }[]
                  ).map(({ key, label }) => (
                    <th
                      key={label}
                      className={`p-3 text-left font-medium text-xs uppercase tracking-wide text-muted-foreground ${key ? "cursor-pointer hover:text-foreground select-none" : ""}`}
                      onClick={key ? () => handleSort(key) : undefined}
                    >
                      {label}
                      {key && <SortIcon col={key} sortCol={sortCol as string} sortDir={sortDir} />}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map(override => (
                  <tr key={override.id} className="border-t hover:bg-muted/20 transition-colors">
                    <td className="p-3 font-mono text-xs max-w-[200px] truncate" title={override.ruleRef}>
                      {override.ruleRef}
                    </td>
                    <td className="p-3">
                      <Badge variant="outline" className="text-xs">{override.overrideType}</Badge>
                    </td>
                    <td className="p-3 text-muted-foreground text-xs">
                      {formatCondition(override.condition as Record<string, unknown>)}
                    </td>
                    <td className="p-3 text-xs font-medium">
                      {formatAction(override.action as Record<string, unknown>)}
                    </td>
                    <td className="p-3">
                      <span className={`text-xs font-medium ${override.confidence >= 0.9 ? "text-green-700" : override.confidence >= 0.7 ? "text-yellow-700" : "text-red-700"}`}>
                        {(override.confidence * 100).toFixed(0)}%
                      </span>
                    </td>
                    <td className="p-3 text-center text-muted-foreground text-sm">{override.sourceCorrections}</td>
                    <td className="p-3">
                      {togglingId === override.id ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : (
                        <Switch
                          checked={override.isActive}
                          onCheckedChange={() => handleToggle(override)}
                          aria-label={`Toggle ${override.ruleRef}`}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!isLoading && !isError && sorted.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Showing {sorted.length} of {overrides?.length ?? 0} overrides
            {search ? ` matching "${search}"` : ""}
            {(minConfidence !== "" || maxConfidence !== "") && (
              <> · confidence {minConfidence !== "" ? `≥${minConfidence}%` : ""}{minConfidence !== "" && maxConfidence !== "" ? " " : ""}{maxConfidence !== "" ? `≤${maxConfidence}%` : ""}</>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const CORRECTIONS_PAGE_SIZE = 20;

function formatJsonValue(val: Record<string, unknown> | undefined): string {
  if (!val) return "—";
  if (val.signType) return String(val.signType);
  const entries = Object.entries(val).filter(([, v]) => v !== "" && v !== null && v !== undefined);
  if (entries.length === 0) return "—";
  return entries.map(([k, v]) => `${k}: ${v}`).join(", ");
}

type CorrectionSortCol = "correctionType" | "roomNamePattern" | "reason" | "createdAt";

const VALID_CORRECTIONS_SORT_COLS: CorrectionSortCol[] = ["correctionType", "roomNamePattern", "reason", "createdAt"];

function CorrectionsTab({ weekFilter, onClearWeekFilter }: { weekFilter: WeekFilter | null; onClearWeekFilter: () => void }) {
  const [search, setSearch] = useState<string>(() => {
    try { return localStorage.getItem("training.correctionsTab.search") ?? ""; } catch { return ""; }
  });
  const [page, setPage] = useState(0);

  const [sortCol, setSortCol] = useState<CorrectionSortCol>(() => {
    try {
      const stored = localStorage.getItem("training.correctionsTab.sortCol") as CorrectionSortCol;
      return VALID_CORRECTIONS_SORT_COLS.includes(stored) ? stored : "createdAt";
    } catch { return "createdAt"; }
  });
  const [sortDir, setSortDir] = useState<SortDir>(() => {
    try {
      const stored = localStorage.getItem("training.correctionsTab.sortDir");
      return stored === "asc" || stored === "desc" ? stored : "desc";
    } catch { return "desc"; }
  });

  useEffect(() => {
    try { localStorage.setItem("training.correctionsTab.search", search); } catch {}
  }, [search]);
  useEffect(() => {
    try { localStorage.setItem("training.correctionsTab.sortCol", sortCol); } catch {}
  }, [sortCol]);
  useEffect(() => {
    try { localStorage.setItem("training.correctionsTab.sortDir", sortDir); } catch {}
  }, [sortDir]);

  function handleSort(col: CorrectionSortCol) {
    if (col === sortCol) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  }

  useEffect(() => {
    setPage(0);
  }, [weekFilter]);

  const { data: corrections, isLoading, isError, refetch } = useListCorrections({
    limit: CORRECTIONS_PAGE_SIZE,
    offset: page * CORRECTIONS_PAGE_SIZE,
    ...(weekFilter ? {
      startDate: weekFilter.weekStart.toISOString(),
      endDate: weekFilter.weekEnd.toISOString(),
    } : {}),
  });

  const filtered = useMemo(() => {
    if (!corrections) return [];
    const q = search.toLowerCase();
    const base = !q ? corrections : corrections.filter(c =>
      c.correctionType.toLowerCase().includes(q) ||
      (c.roomNamePattern ?? "").toLowerCase().includes(q) ||
      (c.signType ?? "").toLowerCase().includes(q) ||
      (c.reason ?? "").toLowerCase().includes(q) ||
      formatJsonValue(c.originalValue as Record<string, unknown>).toLowerCase().includes(q) ||
      formatJsonValue(c.correctedValue as Record<string, unknown>).toLowerCase().includes(q)
    );
    return [...base].sort((a, b) => {
      const av = (a[sortCol] ?? "") as string;
      const bv = (b[sortCol] ?? "") as string;
      if (av === bv) return 0;
      const lt = av < bv ? -1 : 1;
      return sortDir === "asc" ? lt : -lt;
    });
  }, [corrections, search, sortCol, sortDir]);

  const hasNextPage = (corrections?.length ?? 0) === CORRECTIONS_PAGE_SIZE;

  function handleExportCsv() {
    const headers = ["Date", "Correction Type", "Room Pattern", "Sign Type", "Original Value", "Corrected Value", "Reason"];
    const escape = (v: string | number | null | undefined) => {
      const s = String(v ?? "");
      return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csvRows = [
      headers.join(","),
      ...filtered.map(c =>
        [
          new Date(c.createdAt).toLocaleDateString(),
          c.correctionType,
          c.roomNamePattern ?? "",
          c.signType ?? "",
          formatJsonValue(c.originalValue as Record<string, unknown>),
          formatJsonValue(c.correctedValue as Record<string, unknown>),
          c.reason ?? "",
        ].map(escape).join(",")
      ),
    ];
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "correction-history.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Correction History</CardTitle>
            <CardDescription>Log of human edits and imports that feed the training engine.</CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!isLoading && filtered.length > 0 && (
              <Button variant="outline" size="sm" onClick={handleExportCsv} className="gap-1.5">
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {weekFilter && (
          <div className="flex items-center gap-2 mt-2 px-3 py-2 rounded-md bg-primary/10 border border-primary/20 text-sm w-fit">
            <CalendarDays className="h-4 w-4 text-primary shrink-0" />
            <span className="text-primary font-medium">Filtered to week of {weekFilter.label}</span>
            <button
              onClick={onClearWeekFilter}
              className="ml-1 rounded-full p-0.5 hover:bg-primary/20 transition-colors"
              aria-label="Clear week filter"
            >
              <X className="h-3.5 w-3.5 text-primary" />
            </button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <Input
          placeholder="Search by type, room pattern, sign type…"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0); }}
          className="max-w-sm"
        />

        {isLoading ? (
          <div className="flex justify-center p-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : isError ? (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-md border border-red-200">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Failed to load corrections.
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-12 border border-dashed rounded-md text-muted-foreground text-sm">
            {weekFilter
              ? `No corrections were made during the week of ${weekFilter.label}.`
              : search ? "No corrections match your search." : "No corrections yet. Import training data to add corrections."}
          </div>
        ) : (
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  {(
                    [
                      { key: "correctionType" as CorrectionSortCol, label: "Type" },
                      { key: null, label: "Original Value" },
                      { key: null, label: "Corrected Value" },
                      { key: "roomNamePattern" as CorrectionSortCol, label: "Room Pattern" },
                      { key: "reason" as CorrectionSortCol, label: "Reason" },
                      { key: "createdAt" as CorrectionSortCol, label: "Date" },
                    ]
                  ).map(({ key, label }) => (
                    <th
                      key={label}
                      className={`p-3 text-left font-medium text-xs uppercase tracking-wide text-muted-foreground ${key ? "cursor-pointer hover:text-foreground select-none" : ""}`}
                      onClick={key ? () => handleSort(key) : undefined}
                    >
                      {label}
                      {key && <SortIcon col={key} sortCol={sortCol} sortDir={sortDir} />}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((c: TrainingCorrection) => (
                  <tr key={c.id} className="border-t hover:bg-muted/20 transition-colors">
                    <td className="p-3">
                      <Badge variant="outline" className="text-xs whitespace-nowrap">{c.correctionType}</Badge>
                    </td>
                    <td className="p-3 text-muted-foreground text-xs max-w-[140px]">
                      <span title={formatJsonValue(c.originalValue as Record<string, unknown>)} className="block truncate">
                        {formatJsonValue(c.originalValue as Record<string, unknown>)}
                      </span>
                    </td>
                    <td className="p-3 text-xs font-medium max-w-[140px]">
                      <span title={formatJsonValue(c.correctedValue as Record<string, unknown>)} className="block truncate">
                        {formatJsonValue(c.correctedValue as Record<string, unknown>)}
                      </span>
                    </td>
                    <td className="p-3 text-xs text-muted-foreground max-w-[160px]">
                      <span title={c.roomNamePattern ?? "—"} className="block truncate">
                        {c.roomNamePattern ?? "—"}
                      </span>
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">{c.reason ?? "—"}</td>
                    <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!isLoading && !isError && (corrections?.length ?? 0) > 0 && (
          <div className="flex items-center justify-between pt-1">
            <p className="text-xs text-muted-foreground">
              Page {page + 1} · {filtered.length} row{filtered.length !== 1 ? "s" : ""}
              {search ? ` matching "${search}"` : ""}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="h-8 w-8 p-0"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => p + 1)}
                disabled={!hasNextPage}
                className="h-8 w-8 p-0"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const TREND_WINDOWS: { label: string; value: TrendWindow }[] = [
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "1y", value: 365 },
  { label: "All", value: "all" },
  { label: "Custom", value: "custom" },
];

const LEGACY_SAVED_RANGES_KEY = "trend-chart-saved-ranges";

function useSavedDateRanges() {
  const queryClient = useQueryClient();
  const { data: savedRanges = [] } = useListSavedDateRanges();
  const createMutation = useCreateSavedDateRange();
  const deleteMutation = useDeleteSavedDateRange();
  const reorderMutation = useReorderSavedDateRanges();
  const isReordering = reorderMutation.isPending;

  useEffect(() => {
    const raw = localStorage.getItem(LEGACY_SAVED_RANGES_KEY);
    if (!raw) return;
    let legacy: Array<{ name: string; start: string; end: string }>;
    try {
      legacy = JSON.parse(raw);
    } catch {
      localStorage.removeItem(LEGACY_SAVED_RANGES_KEY);
      return;
    }
    if (!Array.isArray(legacy) || legacy.length === 0) {
      localStorage.removeItem(LEGACY_SAVED_RANGES_KEY);
      return;
    }
    const validRanges = legacy.filter(
      (r) =>
        r &&
        typeof r.name === "string" &&
        typeof r.start === "string" &&
        typeof r.end === "string"
    );
    if (validRanges.length === 0) {
      localStorage.removeItem(LEGACY_SAVED_RANGES_KEY);
      return;
    }
    Promise.all(
      validRanges.map((range) =>
        createSavedDateRange({ name: range.name, start: range.start, end: range.end })
      )
    ).then(() => {
      localStorage.removeItem(LEGACY_SAVED_RANGES_KEY);
      queryClient.invalidateQueries({ queryKey: getListSavedDateRangesQueryKey() });
    }).catch(() => {
    });
  }, [queryClient]);

  function saveRange(name: string, start: string, end: string) {
    createMutation.mutate(
      { data: { name, start, end } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSavedDateRangesQueryKey() });
        },
      },
    );
  }

  function deleteRange(id: string) {
    deleteMutation.mutate(
      { rangeId: id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSavedDateRangesQueryKey() });
        },
      },
    );
  }

  function reorderRanges(fromId: string, toId: string) {
    if (fromId === toId) return;
    const from = savedRanges.findIndex(r => r.id === fromId);
    const to = savedRanges.findIndex(r => r.id === toId);
    if (from === -1 || to === -1) return;
    const next = [...savedRanges];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const orderedIds = next.map(r => r.id);

    const queryKey = getListSavedDateRangesQueryKey();
    const previous = queryClient.getQueryData(queryKey);
    queryClient.setQueryData(queryKey, next);

    reorderMutation.mutate(
      { data: { orderedIds } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey });
        },
        onError: () => {
          queryClient.setQueryData(queryKey, previous);
          toast.error("Reorder failed", {
            description: "Could not save the new bookmark order. Please try again.",
          });
        },
      },
    );
  }

  return { savedRanges, saveRange, deleteRange, reorderRanges, isReordering };
}

type EditingPoint = {
  snapshotId: string;
  importIndex: string;
  fullDate: string;
  batchLabel: string;
};

function ConfidenceTrendChart({ onWeekClick, collapsed, onToggle }: { onWeekClick?: (importDate: string) => void; collapsed?: boolean; onToggle?: () => void }) {
  const searchString = useSearch();
  const [location, setLocation] = useLocation();

  const [trendWindow, setTrendWindow] = useState<TrendWindow>(() => {
    const params = new URLSearchParams(searchString);
    const tw = params.get("trendWindow");
    if (tw === "30") return 30;
    if (tw === "90") return 90;
    if (tw === "365") return 365;
    if (tw === "custom") return "custom";
    if (tw === "all") return "all";
    return "all";
  });
  const [customStart, setCustomStart] = useState(() => {
    const params = new URLSearchParams(searchString);
    return params.get("trendStart") ?? "";
  });
  const [customEnd, setCustomEnd] = useState(() => {
    const params = new URLSearchParams(searchString);
    return params.get("trendEnd") ?? "";
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set("trendWindow", String(trendWindow));
    if (trendWindow === "custom") {
      if (customStart) params.set("trendStart", customStart);
      else params.delete("trendStart");
      if (customEnd) params.set("trendEnd", customEnd);
      else params.delete("trendEnd");
    } else {
      params.delete("trendStart");
      params.delete("trendEnd");
    }
    const newSearch = params.toString();
    setLocation(location + (newSearch ? "?" + newSearch : ""), { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendWindow, customStart, customEnd]);
  const [saveMode, setSaveMode] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const { savedRanges, saveRange, deleteRange, reorderRanges, isReordering } = useSavedDateRanges();

  const [editingPoint, setEditingPoint] = useState<EditingPoint | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  const [activeSnapshotId, setActiveSnapshotId] = useState<string | null>(null);
  const chartAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveSnapshotId(null);
  }, [trendWindow, customStart, customEnd]);

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { mutate: updateSnapshot, isPending: isSaving } = useUpdateSnapshot();
  const { isAdmin } = useIsAdmin();
  const { mutate: bustCache, isPending: isBusting } = useInvalidateSnapshotsCache();

  const handleRefreshData = () => {
    bustCache(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetTrainingSnapshotsQueryKey() });
        toast({ title: "Data refreshed", description: "Snapshot cache cleared and data reloaded." });
      },
      onError: () => {
        toast({ title: "Refresh failed", description: "Could not clear the snapshot cache.", variant: "destructive" });
      },
    });
  };

  const handleUpdateSnapshot = (snapshotId: string, data: { batchLabel: string | null }) => {
    updateSnapshot({ snapshotId, data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetTrainingSnapshotsQueryKey() });
        setEditingPoint(null);
      }
    });
  };

  const params = useMemo(
    () => trendWindowToParams(trendWindow, customStart, customEnd),
    [trendWindow, customStart, customEnd]
  );
  const { data: initialData, isLoading } = useGetTrainingSnapshots(params);

  const [allSnapshots, setAllSnapshots] = useState<TrainingSnapshot[]>([]);
  const [totalSnapshots, setTotalSnapshots] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  useEffect(() => {
    setAllSnapshots([]);
    setTotalSnapshots(0);
    setIsLoadingMore(false);
  }, [params]);

  useEffect(() => {
    if (initialData) {
      setAllSnapshots(initialData.snapshots);
      setTotalSnapshots(initialData.total);
    }
  }, [initialData]);

  const hasMore = allSnapshots.length < totalSnapshots;

  async function handleLoadMore() {
    setIsLoadingMore(true);
    try {
      const moreData = await getTrainingSnapshots({ ...params, offset: allSnapshots.length });
      setAllSnapshots(prev => [...moreData.snapshots, ...prev]);
    } finally {
      setIsLoadingMore(false);
    }
  }

  const trend: TrainingSnapshot[] = allSnapshots;

  const canSave = trendWindow === "custom" && (customStart || customEnd);

  function handleApplySaved(range: SavedDateRange) {
    setCustomStart(range.start);
    setCustomEnd(range.end);
    setTrendWindow("custom");
    setSaveMode(false);
  }

  function handleSave() {
    const name = saveName.trim();
    if (!name) return;
    saveRange(name, customStart, customEnd);
    setSaveName("");
    setSaveMode(false);
  }

  const windowControls = (
    <div className="flex flex-col items-end gap-2 shrink-0">
      <div className="flex items-center gap-1 flex-wrap justify-end">
        {TREND_WINDOWS.map(({ label, value }) => (
          <button
            key={String(value)}
            onClick={() => { setTrendWindow(value); setSaveMode(false); }}
            className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
              trendWindow === value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
          >
            {label}
          </button>
        ))}
        {isReordering && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" aria-label="Saving order…" />
        )}
        {savedRanges.map(range => (
          <span
            key={range.id}
            draggable
            onDragStart={e => {
              dragIdRef.current = range.id;
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnter={() => setDragOverId(range.id)}
            onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
            onDragLeave={e => {
              if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
                setDragOverId(null);
              }
            }}
            onDrop={e => {
              e.preventDefault();
              if (dragIdRef.current) reorderRanges(dragIdRef.current, range.id);
              dragIdRef.current = null;
              setDragOverId(null);
            }}
            onDragEnd={() => { dragIdRef.current = null; setDragOverId(null); }}
            className={`inline-flex items-center gap-0.5 pl-2.5 pr-1 py-1 text-xs rounded font-medium transition-colors group cursor-grab active:cursor-grabbing ${
              dragOverId === range.id ? "ring-2 ring-primary ring-offset-1" : ""
            } ${
              trendWindow === "custom" && customStart === range.start && customEnd === range.end
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
          >
            <button
              onClick={() => handleApplySaved(range)}
              title={`${range.start || "any"} – ${range.end || "any"}`}
            >
              {range.name}
            </button>
            <button
              onClick={e => { e.stopPropagation(); deleteRange(range.id); }}
              className="ml-0.5 opacity-40 hover:opacity-100 transition-opacity"
              title={`Remove "${range.name}"`}
              aria-label={`Remove saved range "${range.name}"`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      {trendWindow === "custom" && (
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customStart}
              onChange={e => setCustomStart(e.target.value)}
              max={customEnd || undefined}
              className="h-7 px-2 text-xs rounded border border-input bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              aria-label="Start date"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <input
              type="date"
              value={customEnd}
              onChange={e => setCustomEnd(e.target.value)}
              min={customStart || undefined}
              className="h-7 px-2 text-xs rounded border border-input bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              aria-label="End date"
            />
            {canSave && !saveMode && (
              <button
                onClick={() => { setSaveMode(true); setSaveName(""); }}
                title="Save this date range"
                className="h-7 px-2 flex items-center gap-1 text-xs rounded border border-input bg-background text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <Bookmark className="h-3.5 w-3.5" />
                Save
              </button>
            )}
          </div>
          {saveMode && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setSaveMode(false); }}
                placeholder="Name this range…"
                autoFocus
                className="h-7 px-2 text-xs rounded border border-input bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring w-44"
              />
              <button
                onClick={handleSave}
                disabled={!saveName.trim()}
                className="h-7 px-2.5 text-xs rounded bg-primary text-primary-foreground font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
              >
                Save
              </button>
              <button
                onClick={() => setSaveMode(false)}
                className="h-7 px-2 text-xs rounded border border-input bg-background text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  if (!isLoading && trend.length === 0) {
    return (
      <Card>
        <CardHeader className={collapsed ? "pb-4" : undefined}>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2">
                {onToggle && (
                  <button onClick={onToggle} className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors">
                    {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                )}
                <CardTitle className="text-base">Rule Confidence Trend</CardTitle>
                {isAdmin && (
                  <button
                    onClick={handleRefreshData}
                    disabled={isBusting}
                    title="Refresh data"
                    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${isBusting ? "animate-spin" : ""}`} />
                  </button>
                )}
              </div>
              {!collapsed && <CardDescription>Average active-rule confidence after each import batch — improves as you add more corrections.</CardDescription>}
            </div>
            {!collapsed && windowControls}
          </div>
        </CardHeader>
        {!collapsed && <CardContent>
          <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
            {trendWindow === "all"
              ? "No imports yet. Import training data to see confidence improve after each batch."
              : trendWindow === "custom"
              ? "No data in the selected date range. Try adjusting the dates."
              : `No data in the last ${trendWindow} days. Try a wider range.`}
          </div>
        </CardContent>}
      </Card>
    );
  }

  const formatImportDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const formatConfidence = (value: number) => `${Math.round(value * 100)}%`;

  const chartData = trend.map((p, i) => {
    const prev = i > 0 ? trend[i - 1].avgConfidence : null;
    const delta = prev !== null ? p.avgConfidence - prev : null;
    return {
      snapshotId: p.id,
      label: formatImportDate(p.snapshotDate),
      importIndex: `Import #${i + 1}`,
      avgConfidence: p.avgConfidence,
      count: p.activeOverrideCount,
      newRulesCount: p.newRulesCount,
      updatedRulesCount: p.updatedRulesCount,
      correctionCount: p.correctionCount,
      batchLabel: p.batchLabel ?? null,
      rawImportDate: p.snapshotDate,
      fullDate: new Date(p.snapshotDate).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }),
      delta,
      sourceJobId: p.sourceJobId ?? null,
      sourceJobName: p.sourceJobName ?? null,
    };
  });

  const maxJumpIdx = chartData.reduce<number | null>((best, d, i) => {
    if (d.delta === null || d.delta <= 0) return best;
    if (best === null || d.delta > (chartData[best].delta ?? 0)) return i;
    return best;
  }, null);

  const emptyMessage = () => {
    if (trendWindow === "custom") return "No data in the selected date range. Try adjusting the dates.";
    if (trendWindow === "all") return "No override data yet. Import training data to see confidence improve over time.";
    return `No data in the last ${trendWindow} days. Try a wider range.`;
  };

  const totalOverridesInWindow = trend.reduce((sum, p) => sum + p.activeOverrideCount, 0);
  const confidenceDelta = trend.length >= 2
    ? Math.round((trend[trend.length - 1].avgConfidence - trend[0].avgConfidence) * 100)
    : null;

  function handleDotClick(d: typeof chartData[0]) {
    setActiveSnapshotId(prev => prev === d.snapshotId ? null : d.snapshotId);
    setEditingPoint({
      snapshotId: d.snapshotId,
      importIndex: d.importIndex,
      fullDate: d.fullDate,
      batchLabel: d.batchLabel ?? "",
    });
    setEditLabel(d.batchLabel ?? "");
    setTimeout(() => editInputRef.current?.focus(), 50);
  }

  function handleSaveLabel() {
    if (!editingPoint) return;
    const prevLabel = editingPoint.batchLabel || null;
    const snapshotId = editingPoint.snapshotId;
    const newLabel = editLabel || null;
    updateSnapshot(
      { snapshotId, data: { batchLabel: newLabel } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetTrainingSnapshotsQueryKey() });
          setEditingPoint(null);
          toast({
            description: "Label saved.",
            duration: 5000,
            action: (
              <ToastAction
                altText="Undo"
                onClick={() => {
                  handleUpdateSnapshot(snapshotId, { batchLabel: prevLabel });
                }}
              >
                Undo
              </ToastAction>
            ),
          });
        },
      }
    );
  }

  function handleClearLabel() {
    if (!editingPoint) return;
    const prevLabel = editLabel;
    const snapshotId = editingPoint.snapshotId;
    setEditLabel("");
    updateSnapshot(
      { snapshotId, data: { batchLabel: null } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetTrainingSnapshotsQueryKey() });
          toast({
            description: "Label cleared.",
            duration: 5000,
            action: (
              <ToastAction
                altText="Undo"
                onClick={() => {
                  handleUpdateSnapshot(snapshotId, { batchLabel: prevLabel });
                }}
              >
                Undo
              </ToastAction>
            ),
          });
        },
      }
    );
  }

  function handleCancelEdit() {
    setEditingPoint(null);
    setEditLabel("");
  }

  return (
    <Card>
      <CardHeader className={collapsed ? "pb-4" : undefined}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              {onToggle && (
                <button onClick={onToggle} className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors">
                  {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
              )}
              <CardTitle className="text-base">Rule Confidence Trend</CardTitle>
              {confidenceDelta !== null && (
                <UITooltipProvider>
                  <UITooltip>
                    <UITooltipTrigger asChild>
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold cursor-default ${
                          confidenceDelta > 0
                            ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
                            : confidenceDelta < 0
                            ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {confidenceDelta > 0 ? (
                          <TrendingUp className="h-3 w-3 mr-0.5 shrink-0" />
                        ) : confidenceDelta < 0 ? (
                          <TrendingDown className="h-3 w-3 mr-0.5 shrink-0" />
                        ) : (
                          <Minus className="h-3 w-3 mr-0.5 shrink-0" />
                        )}
                        {confidenceDelta > 0 ? "+" : ""}{confidenceDelta}pp
                      </span>
                    </UITooltipTrigger>
                    <UITooltipContent side="bottom">
                      {(() => {
                        const fmt = (d: string) => {
                          const parsed = new Date(d);
                          return isNaN(parsed.getTime()) ? d : parsed.toLocaleString("en-US", { month: "short", day: "numeric" });
                        };
                        const first = chartData[0];
                        const last = chartData[chartData.length - 1];
                        const firstDate = first.rawImportDate ? fmt(first.rawImportDate) : null;
                        const lastDate = last.rawImportDate ? fmt(last.rawImportDate) : null;
                        if (confidenceDelta === 0) {
                          return `No change in confidence (${Math.round(first.avgConfidence * 100)}% → ${Math.round(last.avgConfidence * 100)}%) from ${first.importIndex}${firstDate ? ` (${firstDate})` : ""} to ${last.importIndex}${lastDate ? ` (${lastDate})` : ""} in this window`;
                        }
                        return `Confidence ${confidenceDelta > 0 ? "improved" : "declined"} by ${confidenceDelta > 0 ? "+" : ""}${Math.abs(confidenceDelta)} percentage point${Math.abs(confidenceDelta) !== 1 ? "s" : ""} (from ${Math.round(first.avgConfidence * 100)}% → ${Math.round(last.avgConfidence * 100)}%) from ${first.importIndex}${firstDate ? ` (${firstDate})` : ""} to ${last.importIndex}${lastDate ? ` (${lastDate})` : ""} in this window`;
                      })()}
                    </UITooltipContent>
                  </UITooltip>
                </UITooltipProvider>
              )}
              {isAdmin && (
                <button
                  onClick={handleRefreshData}
                  disabled={isBusting}
                  title="Refresh data"
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isBusting ? "animate-spin" : ""}`} />
                </button>
              )}
            </div>
            {!collapsed && <CardDescription>Average active-rule confidence after each import batch — improves as you add more corrections.</CardDescription>}
          </div>
          {!collapsed && windowControls}
        </div>
      </CardHeader>
      {!collapsed && <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center h-[180px]">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : trend.length === 0 ? (
          <div className="flex items-center justify-center h-[180px] text-sm text-muted-foreground">
            {emptyMessage()}
          </div>
        ) : (
          <div ref={chartAreaRef}>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart
                data={chartData}
                margin={{ top: 20, right: 48, left: 0, bottom: 20 }}
                onClick={(e) => {
                  const payload = e?.activePayload?.[0]?.payload as typeof chartData[0] | undefined;
                  if (payload?.snapshotId) handleDotClick(payload);
                  if (onWeekClick && payload?.rawImportDate) {
                    onWeekClick(payload.rawImportDate as string);
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 12 }}
                  className="fill-muted-foreground"
                  tickLine={false}
                  axisLine={false}
                  label={{ value: "Import Date", position: "insideBottom", offset: -12, fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                />
                <YAxis
                  yAxisId="confidence"
                  tickFormatter={formatConfidence}
                  domain={[0, 1]}
                  tick={{ fontSize: 12 }}
                  className="fill-muted-foreground"
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  label={{ value: "Confidence %", angle: -90, position: "insideLeft", offset: 12, fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                />
                <YAxis
                  yAxisId="corrections"
                  orientation="right"
                  allowDecimals={false}
                  tick={{ fontSize: 11 }}
                  className="fill-muted-foreground"
                  tickLine={false}
                  axisLine={false}
                  width={36}
                  label={{ value: "Corrections", angle: 90, position: "insideRight", offset: 14, fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload as typeof chartData[0];
                    const isMaxJump = maxJumpIdx !== null && chartData[maxJumpIdx]?.snapshotId === d.snapshotId;
                    const deltaPp = d.delta !== null ? Math.round(d.delta * 100) : null;
                    return (
                      <div className="rounded border bg-background px-3 py-2 shadow text-xs space-y-1">
                        <p className="font-medium">{d.importIndex} — {d.label}</p>
                        {d.batchLabel && (
                          <p className="text-muted-foreground italic">{d.batchLabel}</p>
                        )}
                        {d.sourceJobId && (
                          <p>
                            Job:{" "}
                            <a
                              href={`/jobs/${d.sourceJobId}`}
                              onClick={e => { e.stopPropagation(); setLocation(`/jobs/${d.sourceJobId}`); e.preventDefault(); }}
                              className="font-medium text-primary hover:underline"
                            >
                              {d.sourceJobName ?? d.sourceJobId}
                            </a>
                          </p>
                        )}
                        <p>Avg Confidence: <span className="font-semibold">{formatConfidence(d.avgConfidence)}</span></p>
                        {deltaPp !== null && (
                          <p>
                            Change:{" "}
                            <span className={`font-semibold ${deltaPp > 0 ? "text-green-600 dark:text-green-400" : deltaPp < 0 ? "text-red-600 dark:text-red-400" : ""}`}>
                              {deltaPp > 0 ? "+" : ""}{deltaPp}pp
                            </span>
                            {isMaxJump && deltaPp > 0 && (
                              <span className="ml-1.5 text-amber-600 dark:text-amber-400 font-semibold">★ Biggest jump</span>
                            )}
                          </p>
                        )}
                        <p>Active Rules: <span className="font-semibold">{d.count}</span></p>
                        {(d.newRulesCount > 0 || d.updatedRulesCount > 0) && (
                          <p className="text-muted-foreground">
                            +{d.newRulesCount} new · {d.updatedRulesCount} updated
                          </p>
                        )}
                        <p>Corrections this week: <span className="font-semibold">{d.correctionCount}</span></p>
                        <p className="text-muted-foreground pt-0.5 border-t border-border">Click to highlight row · edit label{onWeekClick ? " · filter overrides" : ""}</p>
                      </div>
                    );
                  }}
                />
                {maxJumpIdx !== null && chartData[maxJumpIdx] && (() => {
                  const pt = chartData[maxJumpIdx];
                  const deltaPp = pt.delta !== null ? Math.round(pt.delta * 100) : 0;
                  return (
                    <ReferenceLine
                      x={pt.label}
                      yAxisId="confidence"
                      stroke="#d97706"
                      strokeDasharray="4 3"
                      strokeOpacity={0.6}
                      label={{
                        value: `+${deltaPp}pp`,
                        position: "top",
                        fontSize: 11,
                        fontWeight: 600,
                        fill: "#d97706",
                        offset: 6,
                      }}
                    />
                  );
                })()}
                <Bar
                  yAxisId="corrections"
                  dataKey="correctionCount"
                  fill="hsl(262 30% 60% / 0.45)"
                  radius={[2, 2, 0, 0]}
                  maxBarSize={20}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="confidence"
                  type="monotone"
                  dataKey="avgConfidence"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={(dotProps: { cx: number; cy: number; index: number; payload: typeof chartData[0] }) => {
                    const { cx, cy, index, payload } = dotProps;
                    const isActive = payload.snapshotId === activeSnapshotId;
                    const isMax = index === maxJumpIdx;
                    if (isActive) {
                      return (
                        <g key={`dot-active-${payload.snapshotId}`}>
                          <circle cx={cx} cy={cy} r={12} fill="hsl(var(--primary))" opacity={0.15} />
                          <circle cx={cx} cy={cy} r={7} fill="hsl(var(--primary))" stroke="hsl(var(--background))" strokeWidth={2.5} />
                        </g>
                      );
                    }
                    if (isMax) {
                      const r = 7;
                      const points = Array.from({ length: 5 }, (_, k) => {
                        const outerAngle = (Math.PI * 2 * k) / 5 - Math.PI / 2;
                        const innerAngle = outerAngle + Math.PI / 5;
                        const ox = cx + r * Math.cos(outerAngle);
                        const oy = cy + r * Math.sin(outerAngle);
                        const ix = cx + (r * 0.45) * Math.cos(innerAngle);
                        const iy = cy + (r * 0.45) * Math.sin(innerAngle);
                        return `${ox},${oy} ${ix},${iy}`;
                      }).join(" ");
                      return (
                        <polygon
                          key={`star-${index}`}
                          points={points}
                          fill="#d97706"
                          stroke="#fff"
                          strokeWidth={1.5}
                          style={{ cursor: "pointer" }}
                        />
                      );
                    }
                    return (
                      <circle
                        key={`dot-${payload.snapshotId}`}
                        cx={cx}
                        cy={cy}
                        r={4}
                        fill="hsl(var(--primary))"
                        stroke="none"
                        style={{ cursor: "pointer" }}
                      />
                    );
                  }}
                  activeDot={{ r: 6, cursor: "pointer" }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        {!isLoading && trend.length > 0 && (
          <div className="mt-3 space-y-3">
            <div className="flex items-center justify-center gap-4 flex-wrap">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <svg width="20" height="4" aria-hidden="true">
                  <line x1="0" y1="2" x2="20" y2="2" stroke="hsl(var(--primary))" strokeWidth="2" />
                </svg>
                <span>Avg confidence</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <svg width="12" height="10" aria-hidden="true">
                  <rect x="0" y="2" width="12" height="8" rx="1" fill="hsl(262 30% 60% / 0.55)" />
                </svg>
                <span>Corrections</span>
              </div>
              {maxJumpIdx !== null && (
                <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <svg width="12" height="12" viewBox="-7 -7 14 14" aria-hidden="true">
                    <polygon
                      points={Array.from({ length: 5 }, (_, k) => {
                        const outerAngle = (Math.PI * 2 * k) / 5 - Math.PI / 2;
                        const innerAngle = outerAngle + Math.PI / 5;
                        return `${7 * Math.cos(outerAngle)},${7 * Math.sin(outerAngle)} ${7 * 0.45 * Math.cos(innerAngle)},${7 * 0.45 * Math.sin(innerAngle)}`;
                      }).join(" ")}
                      fill="#d97706"
                    />
                  </svg>
                  <span>= biggest single-import confidence jump</span>
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground text-center">
              {totalOverridesInWindow} override{totalOverridesInWindow !== 1 ? "s" : ""} in this period — click any point to edit its label
            </p>
            {hasMore && (
              <div className="flex flex-col items-center gap-1">
                <button
                  onClick={handleLoadMore}
                  disabled={isLoadingMore}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-input bg-background text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                >
                  {isLoadingMore ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ChevronLeft className="h-3.5 w-3.5" />
                  )}
                  {isLoadingMore ? "Loading…" : `Load older history (${totalSnapshots - allSnapshots.length} more)`}
                </button>
              </div>
            )}
            <ImportHistoryTable
              activeSnapshotId={activeSnapshotId}
              onSnapshotSelect={setActiveSnapshotId}
              chartAreaRef={chartAreaRef}
            />
          </div>
        )}

        {editingPoint && (
          <div className="mt-3 rounded-md border border-border bg-muted/40 px-4 py-3 space-y-2">
            <div className="flex items-center gap-2">
              <Pencil className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-medium">{editingPoint.importIndex}</span>
              <span className="text-xs text-muted-foreground">{editingPoint.fullDate}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  ref={editInputRef}
                  type="text"
                  value={editLabel}
                  onChange={e => setEditLabel(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") handleSaveLabel();
                    if (e.key === "Escape") handleCancelEdit();
                  }}
                  placeholder="Add a label for this batch…"
                  className={`w-full h-7 px-2 text-xs rounded border border-input bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring ${editLabel ? "pr-6" : ""}`}
                  disabled={isSaving}
                />
                {editLabel && (
                  <button
                    type="button"
                    onClick={handleClearLabel}
                    disabled={isSaving}
                    title="Clear label"
                    aria-label="Clear batch label"
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <button
                onClick={handleSaveLabel}
                disabled={isSaving}
                className="h-7 px-2.5 flex items-center gap-1 text-xs rounded bg-primary text-primary-foreground font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
              >
                {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Save
              </button>
              <button
                onClick={handleCancelEdit}
                disabled={isSaving}
                className="h-7 px-2 text-xs rounded border border-input bg-background text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </CardContent>}
    </Card>
  );
}

const IMPORT_HISTORY_PAGE_SIZE = 10;

function ImportHistoryTable({
  activeSnapshotId,
  onSnapshotSelect,
  chartAreaRef,
}: {
  activeSnapshotId?: string | null;
  onSnapshotSelect?: (id: string | null) => void;
  chartAreaRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: allImpact, isLoading } = useGetOverrideImpact();
  const trend = useMemo<ConfidenceTrendPoint[]>(
    () => allImpact?.confidenceTrend ?? [],
    [allImpact?.confidenceTrend],
  );

  const [collapsed, setCollapsed] = useState(true);
  const [page, setPage] = useState(0);
  const [searchQuery, setSearchQuery] = useState(() => {
    try { return localStorage.getItem("training.importTab.searchQuery") ?? ""; } catch { return ""; }
  });
  const [minConfidence, setMinConfidence] = useState(() => {
    try { return localStorage.getItem("training.importTab.minConfidence") ?? ""; } catch { return ""; }
  });
  const [maxConfidence, setMaxConfidence] = useState(() => {
    try { return localStorage.getItem("training.importTab.maxConfidence") ?? ""; } catch { return ""; }
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [editJobValue, setEditJobValue] = useState<string>("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const didAutoPageToBest = useRef(false);

  const { data: jobsList } = useListJobs();

  const { mutate: updateSnapshot, isPending: isSaving } = useUpdateSnapshot();
  const handleUpdateSnapshotHistory = (snapshotId: string, data: { batchLabel: string | null }) => {
    updateSnapshot({ snapshotId, data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetTrainingSnapshotsQueryKey() });
        setEditingId(null);
        setEditLabel("");
      },
    });
  };

  const { mutate: updateSnapshotJob, isPending: isSavingJob } = useUpdateSnapshot();
  const handleUpdateSnapshotJob = (snapshotId: string, sourceJobId: string | null) => {
    updateSnapshotJob({ snapshotId, data: { sourceJobId } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetTrainingSnapshotsQueryKey() });
        setEditingJobId(null);
        setEditJobValue("");
      },
    });
  };

  const { mutate: deleteSnapshotMutate, isPending: isDeleting } = useDeleteSnapshot();
  const handleDeleteSnapshot = (snapshotId: string) => {
    deleteSnapshotMutate({ snapshotId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetTrainingSnapshotsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetOverrideImpactQueryKey() });
        setConfirmDeleteId(null);
      },
    });
  };

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setIsBulkDeleting(true);
    try {
      await Promise.all(Array.from(selectedIds).map((id) => deleteSnapshot(id)));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetTrainingSnapshotsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetOverrideImpactQueryKey() }),
      ]);
      setSelectedIds(new Set());
      setConfirmBulkDelete(false);
    } finally {
      setIsBulkDeleting(false);
    }
  }, [selectedIds, queryClient]);

  function handleToggleSelect(snapshotId: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(snapshotId);
      else next.delete(snapshotId);
      return next;
    });
  }

  const rows = useMemo(() => {
    const reversed = [...trend].reverse();
    return reversed.map((p, i) => {
      const prevInReversed = reversed[i + 1];
      return {
        snapshotId: p.snapshotId,
        importNumber: trend.length - i,
        avgConfidence: p.avgConfidence,
        prevAvgConfidence: prevInReversed?.avgConfidence ?? null,
        count: p.count,
        newRulesCount: p.newRulesCount ?? 0,
        updatedRulesCount: p.updatedRulesCount ?? 0,
        batchLabel: p.batchLabel ?? null,
        sourceJobId: p.sourceJobId ?? null,
        sourceJobName: p.sourceJobName ?? null,
        accuracyScore: (p as { accuracyScore?: number | null }).accuracyScore ?? null,
        buildingType: (p as { buildingType?: string | null }).buildingType ?? null,
        fullDate: p.importDate
          ? new Date(p.importDate).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })
          : p.week,
      };
    });
  }, [trend]);

  const { bestSnapshotId, bestDeltaPp } = useMemo(() => {
    let bestIdx: number | null = null;
    for (let i = 1; i < trend.length; i++) {
      const delta = trend[i].avgConfidence - trend[i - 1].avgConfidence;
      if (delta <= 0) continue;
      if (bestIdx === null || delta > trend[bestIdx].avgConfidence - trend[bestIdx - 1].avgConfidence) {
        bestIdx = i;
      }
    }
    if (bestIdx === null) return { bestSnapshotId: null, bestDeltaPp: null };
    return {
      bestSnapshotId: trend[bestIdx].snapshotId,
      bestDeltaPp: Math.round((trend[bestIdx].avgConfidence - trend[bestIdx - 1].avgConfidence) * 100),
    };
  }, [trend]);

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const minPct = minConfidence !== "" ? parseFloat(minConfidence) : null;
    const maxPct = maxConfidence !== "" ? parseFloat(maxConfidence) : null;
    return rows.filter((r) => {
      if (q && !(r.batchLabel ?? "").toLowerCase().includes(q) && !(r.fullDate ?? "").toLowerCase().includes(q)) {
        return false;
      }
      const pct = Math.round(r.avgConfidence * 100);
      if (minPct !== null && !isNaN(minPct) && pct < minPct) return false;
      if (maxPct !== null && !isNaN(maxPct) && pct > maxPct) return false;
      return true;
    });
  }, [rows, searchQuery, minConfidence, maxConfidence]);

  const totalPages = Math.ceil(filteredRows.length / IMPORT_HISTORY_PAGE_SIZE);
  const pageRows = filteredRows.slice(
    page * IMPORT_HISTORY_PAGE_SIZE,
    (page + 1) * IMPORT_HISTORY_PAGE_SIZE,
  );

  const allPageSelected = pageRows.length > 0 && pageRows.every((r) => selectedIds.has(r.snapshotId));
  const somePageSelected = !allPageSelected && pageRows.some((r) => selectedIds.has(r.snapshotId));

  function handleSelectAll(checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const r of pageRows) {
        if (checked) next.add(r.snapshotId);
        else next.delete(r.snapshotId);
      }
      return next;
    });
  }

  useEffect(() => {
    setPage(0);
  }, [searchQuery, minConfidence, maxConfidence]);

  useEffect(() => {
    try { localStorage.setItem("training.importTab.searchQuery", searchQuery); } catch {}
  }, [searchQuery]);

  useEffect(() => {
    try { localStorage.setItem("training.importTab.minConfidence", minConfidence); } catch {}
  }, [minConfidence]);

  useEffect(() => {
    try { localStorage.setItem("training.importTab.maxConfidence", maxConfidence); } catch {}
  }, [maxConfidence]);

  useEffect(() => {
    if (!activeSnapshotId) return;
    const idx = filteredRows.findIndex(r => r.snapshotId === activeSnapshotId);
    if (idx === -1) return;
    const targetPage = Math.floor(idx / IMPORT_HISTORY_PAGE_SIZE);
    setPage(targetPage);
    setTimeout(() => {
      const el = rowRefs.current.get(activeSnapshotId);
      el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 80);
  }, [activeSnapshotId, filteredRows]);

  useEffect(() => {
    if (didAutoPageToBest.current) return;
    if (!bestSnapshotId || filteredRows.length === 0) return;
    const idx = filteredRows.findIndex(r => r.snapshotId === bestSnapshotId);
    if (idx === -1) return;
    didAutoPageToBest.current = true;
    const targetPage = Math.floor(idx / IMPORT_HISTORY_PAGE_SIZE);
    if (targetPage !== 0) {
      setPage(targetPage);
    }
    setTimeout(() => {
      const el = rowRefs.current.get(bestSnapshotId);
      el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 80);
  }, [bestSnapshotId, filteredRows]);

  useEffect(() => {
    if (!activeSnapshotId) return;
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onSnapshotSelect?.(null);
    }
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [activeSnapshotId, onSnapshotSelect]);

  function handleRowClick(snapshotId: string) {
    if (!onSnapshotSelect) return;
    const next = activeSnapshotId === snapshotId ? null : snapshotId;
    onSnapshotSelect(next);
    if (next) {
      chartAreaRef?.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function handleStartEdit(row: typeof rows[0]) {
    setEditingId(row.snapshotId);
    setEditLabel(row.batchLabel ?? "");
    setEditingJobId(null);
    setEditJobValue("");
    setTimeout(() => editInputRef.current?.focus(), 50);
  }

  function handleSave() {
    if (!editingId) return;
    const row = rows.find(r => r.snapshotId === editingId);
    const prevLabel = row?.batchLabel ?? null;
    const snapshotId = editingId;
    const newLabel = editLabel || null;
    updateSnapshot(
      { snapshotId, data: { batchLabel: newLabel } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetTrainingSnapshotsQueryKey() });
          setEditingId(null);
          setEditLabel("");
          toast({
            description: "Label saved.",
            duration: 5000,
            action: (
              <ToastAction
                altText="Undo"
                onClick={() => {
                  handleUpdateSnapshotHistory(snapshotId, { batchLabel: prevLabel });
                }}
              >
                Undo
              </ToastAction>
            ),
          });
        },
      }
    );
  }

  function handleCancel() {
    setEditingId(null);
    setEditLabel("");
  }

  function handleStartJobEdit(row: typeof rows[0]) {
    setEditingJobId(row.snapshotId);
    setEditJobValue(row.sourceJobId ?? "");
    setEditingId(null);
    setEditLabel("");
  }

  function handleSaveJob() {
    if (!editingJobId) return;
    handleUpdateSnapshotJob(editingJobId, editJobValue || null);
  }

  function handleCancelJobEdit() {
    setEditingJobId(null);
    setEditJobValue("");
  }

  function handleExportCsv() {
    const headers = ["Import #", "Date", "Avg Confidence", "Accuracy", "Building Type", "Active Rules", "New Rules", "Updated Rules", "Batch Label"];
    const escape = (v: string | number | null | undefined) => {
      const s = String(v ?? "");
      return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csvRows = [
      headers.join(","),
      ...filteredRows.map(r =>
        [
          r.importNumber,
          r.fullDate ?? "",
          `${Math.round(r.avgConfidence * 100)}%`,
          r.accuracyScore !== null && r.accuracyScore !== undefined ? `${Math.round(r.accuracyScore * 1000) / 10}%` : "",
          r.buildingType ?? "",
          r.count,
          r.newRulesCount,
          r.updatedRulesCount,
          r.batchLabel ?? "",
        ].map(escape).join(",")
      ),
    ];
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "import-history.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!isLoading && trend.length === 0) return null;

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setCollapsed(c => !c)}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              Import History
              {collapsed && !isLoading && rows.length > 0 && (
                <span className="text-xs font-normal text-muted-foreground">
                  {rows.length} {rows.length === 1 ? "import" : "imports"} — click to expand
                </span>
              )}
            </CardTitle>
            {!collapsed && (
              <CardDescription>
                All past import batches — click a row to highlight its point on the chart above, or the edit icon to rename the batch.
              </CardDescription>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!isLoading && filteredRows.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={e => { e.stopPropagation(); handleExportCsv(); }}
                className="shrink-0 gap-1.5"
              >
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={e => { e.stopPropagation(); setCollapsed(c => !c); }}>
              {collapsed
                ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      {!collapsed && <CardContent>
        {isLoading ? (
          <div className="flex justify-center p-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <div className="relative flex-1 min-w-[160px] max-w-xs">
                <Input
                  type="text"
                  placeholder="Filter by batch label or date…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-8 text-xs pr-7"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    title="Clear filter"
                    aria-label="Clear filter"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-xs text-muted-foreground whitespace-nowrap">Confidence</span>
                <div className="relative">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    placeholder="Min %"
                    value={minConfidence}
                    onChange={(e) => setMinConfidence(e.target.value)}
                    className="h-8 text-xs w-20 pr-5"
                    aria-label="Minimum confidence percentage"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">%</span>
                </div>
                <span className="text-xs text-muted-foreground">–</span>
                <div className="relative">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    placeholder="Max %"
                    value={maxConfidence}
                    onChange={(e) => setMaxConfidence(e.target.value)}
                    className="h-8 text-xs w-20 pr-5"
                    aria-label="Maximum confidence percentage"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">%</span>
                </div>
                {(minConfidence !== "" || maxConfidence !== "") && (
                  <button
                    onClick={() => { setMinConfidence(""); setMaxConfidence(""); }}
                    className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    title="Clear confidence filter"
                    aria-label="Clear confidence filter"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {selectedIds.size > 0 && (
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-8 text-xs gap-1.5"
                  onClick={() => setConfirmBulkDelete(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete selected ({selectedIds.size})
                </Button>
              )}
              <p className="text-xs text-muted-foreground shrink-0">
                {filteredRows.length} of {rows.length} import
                {rows.length !== 1 ? "s" : ""}
              </p>
            </div>
            <div className="border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-3 w-8">
                      <Checkbox
                        checked={allPageSelected ? true : somePageSelected ? "indeterminate" : false}
                        onCheckedChange={(checked) => handleSelectAll(!!checked)}
                        aria-label="Select all on this page"
                        onClick={(e) => e.stopPropagation()}
                      />
                    </th>
                    {[
                      "#",
                      "Date",
                      "Avg Confidence",
                      "Accuracy",
                      "Building Type",
                      "Active Rules",
                      "New",
                      "Updated",
                      "Batch Label",
                      "Source Job",
                      "",
                    ].map((h) => (
                      <th
                        key={h}
                        className="p-3 text-left font-medium text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => {
                    const isActiveRow = activeSnapshotId === row.snapshotId;
                    const isBest = row.snapshotId === bestSnapshotId;
                    const isSelected = selectedIds.has(row.snapshotId);
                    return (
                    <Fragment key={row.snapshotId}>
                    <tr
                      ref={(el) => {
                        if (el) rowRefs.current.set(row.snapshotId, el);
                        else rowRefs.current.delete(row.snapshotId);
                      }}
                      onClick={() => handleRowClick(row.snapshotId)}
                      className={`border-t transition-colors cursor-pointer ${
                        isSelected
                          ? "bg-destructive/5"
                          : isActiveRow
                          ? "bg-primary/10 hover:bg-primary/15 outline outline-1 outline-primary/30"
                          : isBest
                          ? "bg-amber-50 dark:bg-amber-900/20 border-l-2 border-l-amber-400 hover:bg-amber-100/60 dark:hover:bg-amber-900/30"
                          : "hover:bg-muted/20"
                      }`}
                    >
                      <td className="p-3 w-8" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={(checked) => handleToggleSelect(row.snapshotId, !!checked)}
                          aria-label={`Select import #${row.importNumber}`}
                        />
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">
                        <div className="flex items-center gap-1">
                          {row.importNumber}
                          {isBest && bestDeltaPp !== null && (
                            <UITooltipProvider>
                              <UITooltip>
                                <UITooltipTrigger asChild>
                                  <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400 cursor-default">
                                    <Star className="h-3 w-3 fill-amber-500 text-amber-500" />
                                    <span className="text-[10px] font-semibold">+{bestDeltaPp}pp</span>
                                  </span>
                                </UITooltipTrigger>
                                <UITooltipContent side="right">
                                  Biggest confidence jump: +{bestDeltaPp} percentage point{bestDeltaPp !== 1 ? "s" : ""}
                                </UITooltipContent>
                              </UITooltip>
                            </UITooltipProvider>
                          )}
                        </div>
                      </td>
                      <td className="p-3 text-xs whitespace-nowrap">
                        {row.fullDate}
                      </td>
                      <td className="p-3">
                        <span
                          className={`text-xs font-medium ${
                            row.avgConfidence >= 0.9
                              ? "text-green-700"
                              : row.avgConfidence >= 0.7
                                ? "text-yellow-700"
                                : "text-red-700"
                          }`}
                        >
                          {Math.round(row.avgConfidence * 100)}%
                        </span>
                      </td>
                      <td className="p-3 text-xs">
                        {row.accuracyScore !== null && row.accuracyScore !== undefined ? (
                          <span className={`font-medium ${row.accuracyScore >= 0.9 ? "text-emerald-700" : row.accuracyScore >= 0.7 ? "text-yellow-700" : "text-red-700"}`}>
                            {Math.round(row.accuracyScore * 1000) / 10}%
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">
                        {row.buildingType ? (
                          <span className="inline-flex items-center gap-1">
                            <span>{getBuildingTypeOption(row.buildingType)?.icon ?? ""}</span>
                            <span>{getBuildingTypeLabel(row.buildingType)}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </td>
                      <td className="p-3 text-xs text-center text-muted-foreground">
                        {row.count}
                      </td>
                      <td className="p-3 text-xs text-center text-muted-foreground">
                        {row.newRulesCount}
                      </td>
                      <td className="p-3 text-xs text-center text-muted-foreground">
                        {row.updatedRulesCount}
                      </td>
                      <td className="p-3 text-xs min-w-[180px]">
                        {editingId === row.snapshotId ? (
                          <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                            <input
                              ref={editInputRef}
                              type="text"
                              value={editLabel}
                              onChange={(e) => setEditLabel(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleSave();
                                if (e.key === "Escape") handleCancel();
                              }}
                              placeholder="Add a label…"
                              className="flex-1 h-7 px-2 text-xs rounded border border-input bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                              disabled={isSaving}
                            />
                            <button
                              onClick={handleSave}
                              disabled={isSaving}
                              className="h-7 px-2 flex items-center gap-1 text-xs rounded bg-primary text-primary-foreground font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
                              title="Save label"
                            >
                              {isSaving ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Check className="h-3 w-3" />
                              )}
                            </button>
                            <button
                              onClick={handleCancel}
                              disabled={isSaving}
                              className="h-7 px-2 text-xs rounded border border-input bg-background text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                              title="Cancel"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            <span
                              className={
                                row.batchLabel
                                  ? "font-medium"
                                  : "text-muted-foreground italic"
                              }
                            >
                              {row.batchLabel ?? "—"}
                            </span>
                            {row.sourceJobId && (
                              <span className="text-[11px] text-muted-foreground truncate max-w-[160px]" title={row.sourceJobName ?? row.sourceJobId}>
                                {row.sourceJobName ?? row.sourceJobId}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-xs min-w-[160px]">
                        {editingJobId === row.snapshotId ? (
                          <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                            <select
                              value={editJobValue}
                              onChange={(e) => setEditJobValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleSaveJob();
                                if (e.key === "Escape") handleCancelJobEdit();
                              }}
                              disabled={isSavingJob}
                              className="flex-1 h-7 px-2 text-xs rounded border border-input bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                            >
                              <option value="">— No job linked —</option>
                              {(jobsList ?? []).map(job => (
                                <option key={job.id} value={job.id}>{job.name}</option>
                              ))}
                            </select>
                            <button
                              onClick={handleSaveJob}
                              disabled={isSavingJob}
                              className="h-7 px-2 flex items-center gap-1 text-xs rounded bg-primary text-primary-foreground font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
                              title="Save job link"
                            >
                              {isSavingJob ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Check className="h-3 w-3" />
                              )}
                            </button>
                            <button
                              onClick={handleCancelJobEdit}
                              disabled={isSavingJob}
                              className="h-7 px-2 text-xs rounded border border-input bg-background text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                              title="Cancel"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 group">
                            {row.sourceJobId ? (
                              <a
                                href={`/jobs/${row.sourceJobId}`}
                                className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
                                title={`View job: ${row.sourceJobName ?? row.sourceJobId}`}
                              >
                                <ExternalLink className="h-3 w-3 shrink-0" />
                                <span className="truncate max-w-[110px]">{row.sourceJobName ?? row.sourceJobId}</span>
                              </a>
                            ) : (
                              <span className="text-muted-foreground italic">—</span>
                            )}
                            {editingId !== row.snapshotId && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleStartJobEdit(row); }}
                                className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-muted transition-all"
                                title="Edit source job"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-right">
                        {editingId !== row.snapshotId && editingJobId !== row.snapshotId && (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleStartEdit(row); }}
                              className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                              title="Edit batch label"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(row.snapshotId); }}
                              className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-red-600 hover:bg-red-50 transition-colors"
                              title="Delete snapshot"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                    {isActiveRow && (
                      <tr key={`${row.snapshotId}-detail`} className="bg-primary/5 border-t border-primary/20">
                        <td colSpan={9} className="px-4 py-3">
                          <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <span title="Dismiss (Esc)" onClick={(e) => { e.stopPropagation(); onSnapshotSelect?.(null); }} className="cursor-pointer hover:text-foreground transition-colors">
                                <X className="h-3.5 w-3.5" />
                              </span>
                              <span className="font-medium text-foreground">Batch Summary</span>
                              <span className="text-muted-foreground">· press Esc to close</span>
                            </div>
                            <div className="flex flex-wrap gap-x-6 gap-y-2 flex-1">
                              <div className="text-xs">
                                <p className="text-muted-foreground mb-0.5">Label</p>
                                <p className="font-medium">{row.batchLabel ?? <span className="italic text-muted-foreground">No label</span>}</p>
                              </div>
                              <div className="text-xs">
                                <p className="text-muted-foreground mb-0.5">Date</p>
                                <p className="font-medium">{row.fullDate}</p>
                              </div>
                              <div className="text-xs">
                                <p className="text-muted-foreground mb-0.5">Overrides</p>
                                <p className="font-medium">
                                  <span className="text-green-700 dark:text-green-400">+{row.newRulesCount} new</span>
                                  {" · "}
                                  <span className="text-blue-700 dark:text-blue-400">{row.updatedRulesCount} updated</span>
                                </p>
                              </div>
                              <div className="text-xs">
                                <p className="text-muted-foreground mb-0.5">Confidence</p>
                                <p className="font-medium">
                                  {row.prevAvgConfidence !== null ? (
                                    <>
                                      <span className="text-muted-foreground">{Math.round(row.prevAvgConfidence * 100)}%</span>
                                      {" → "}
                                      <span className={row.avgConfidence >= row.prevAvgConfidence ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
                                        {Math.round(row.avgConfidence * 100)}%
                                      </span>
                                      {" "}
                                      <span className={`text-[10px] font-semibold ${row.avgConfidence > row.prevAvgConfidence ? "text-green-600 dark:text-green-400" : row.avgConfidence < row.prevAvgConfidence ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
                                        {row.avgConfidence > row.prevAvgConfidence ? "+" : ""}{Math.round((row.avgConfidence - row.prevAvgConfidence) * 100)}pp
                                      </span>
                                    </>
                                  ) : (
                                    <span>{Math.round(row.avgConfidence * 100)}%</span>
                                  )}
                                </p>
                              </div>
                              <div className="text-xs">
                                <p className="text-muted-foreground mb-0.5">Active Rules</p>
                                <p className="font-medium">{row.count}</p>
                              </div>
                              {row.accuracyScore !== null && row.accuracyScore !== undefined && (
                                <div className="text-xs">
                                  <p className="text-muted-foreground mb-0.5">Accuracy</p>
                                  <p className={`font-medium ${row.accuracyScore >= 0.9 ? "text-emerald-700 dark:text-emerald-400" : row.accuracyScore >= 0.7 ? "text-yellow-700 dark:text-yellow-400" : "text-red-700 dark:text-red-400"}`}>
                                    {Math.round(row.accuracyScore * 1000) / 10}%
                                  </p>
                                </div>
                              )}
                              {row.buildingType && (
                                <div className="text-xs">
                                  <p className="text-muted-foreground mb-0.5">Building Type</p>
                                  <p className="font-medium inline-flex items-center gap-1">
                                    <span>{getBuildingTypeOption(row.buildingType)?.icon ?? ""}</span>
                                    <span>{getBuildingTypeLabel(row.buildingType)}</span>
                                  </p>
                                </div>
                              )}
                              {row.sourceJobId && (
                                <div className="text-xs">
                                  <p className="text-muted-foreground mb-0.5">Source Job</p>
                                  <a
                                    href={`/jobs/${row.sourceJobId}`}
                                    className="font-medium text-primary hover:underline inline-flex items-center gap-1"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <ExternalLink className="h-3 w-3 shrink-0" />
                                    {row.sourceJobName ?? row.sourceJobId}
                                  </a>
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ); })}
                  {pageRows.length === 0 && (
                    <tr>
                      <td colSpan={12} className="p-6 text-center text-xs text-muted-foreground">
                        No imports match your filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-3">
                <p className="text-xs text-muted-foreground">
                  Page {page + 1} of {totalPages} · {filteredRows.length} import
                  {filteredRows.length !== 1 ? "s" : ""}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="h-8 w-8 p-0"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setPage((p) => Math.min(totalPages - 1, p + 1))
                    }
                    disabled={page >= totalPages - 1}
                    className="h-8 w-8 p-0"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>}

      <Dialog open={confirmDeleteId !== null} onOpenChange={(open) => { if (!open) setConfirmDeleteId(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete import snapshot?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently remove this snapshot from the history table and confidence trend chart. This action cannot be undone.
          </p>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setConfirmDeleteId(null)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isDeleting}
              onClick={() => {
                if (confirmDeleteId) {
                  handleDeleteSnapshot(confirmDeleteId);
                }
              }}
            >
              {isDeleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmBulkDelete} onOpenChange={(open) => { if (!open && !isBulkDeleting) setConfirmBulkDelete(false); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {selectedIds.size} snapshot{selectedIds.size !== 1 ? "s" : ""}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently remove {selectedIds.size} import snapshot{selectedIds.size !== 1 ? "s" : ""} from the history table and confidence trend chart. This action cannot be undone.
          </p>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setConfirmBulkDelete(false)}
              disabled={isBulkDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isBulkDeleting}
              onClick={handleBulkDelete}
            >
              {isBulkDeleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete {selectedIds.size} snapshot{selectedIds.size !== 1 ? "s" : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function FileOrDriveInput({
  file,
  driveUrl,
  onFileChange,
  onDriveUrlChange,
  accept,
  icon: Icon,
  sizeHint,
  driveStatus,
  driveFileSizeMB,
}: {
  file: File | null;
  driveUrl: string;
  onFileChange: (f: File | null) => void;
  onDriveUrlChange: (url: string) => void;
  accept: string;
  icon: React.ElementType;
  sizeHint: string;
  driveStatus?: "idle" | "downloading" | "success" | "error";
  driveFileSizeMB?: number | null;
}) {
  const [mode, setMode] = useState<"file" | "drive">("file");
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      <div className="flex gap-0.5 rounded-md border border-input p-0.5 bg-muted/40 w-fit text-xs">
        <button
          type="button"
          onClick={() => setMode("file")}
          className={`px-2.5 py-1 rounded transition-colors ${mode === "file" ? "bg-background shadow-sm font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          Upload File
        </button>
        <button
          type="button"
          onClick={() => setMode("drive")}
          className={`px-2.5 py-1 rounded transition-colors ${mode === "drive" ? "bg-background shadow-sm font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          Google Drive Link
        </button>
      </div>

      {mode === "file" ? (
        <div
          className={`border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition-colors hover:border-primary/50 hover:bg-muted/30 ${
            file ? "border-primary/40 bg-primary/5" : "border-muted-foreground/25"
          }`}
          onClick={() => inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={e => onFileChange(e.target.files?.[0] || null)}
          />
          {file ? (
            <div className="flex flex-col items-center gap-1.5">
              <Icon className="h-6 w-6 text-primary" />
              <p className="font-medium text-sm truncate max-w-full px-2">{file.name}</p>
              <p className="text-xs text-muted-foreground">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={e => { e.stopPropagation(); onFileChange(null); }}
              >
                Remove
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1.5">
              <Upload className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm font-medium">Click to select</p>
              <p className="text-xs text-muted-foreground">{sizeHint}</p>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <Input
            value={driveUrl}
            onChange={e => onDriveUrlChange(e.target.value)}
            placeholder="Paste Google Drive link here..."
            className="text-sm"
          />
          {driveStatus === "success" && driveFileSizeMB != null ? (
            <p className="text-xs text-green-500 flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              Downloaded successfully ({driveFileSizeMB.toFixed(1)} MB)
            </p>
          ) : driveStatus === "downloading" ? (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              Downloading from Google Drive…
            </p>
          ) : driveStatus === "error" ? null : (
            <p className="text-xs text-muted-foreground flex items-start gap-1.5">
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              File must be shared as "Anyone with the link can view"
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function FilePicker({
  label,
  hint,
  accept,
  file,
  onChange,
  icon: Icon,
  required,
}: {
  label: string;
  hint: string;
  accept: string;
  file: File | null;
  onChange: (f: File | null) => void;
  icon: React.ElementType;
  required?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div
        className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors hover:border-primary/50 hover:bg-muted/30 ${
          file ? "border-primary/40 bg-primary/5" : "border-muted-foreground/25"
        }`}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={e => onChange(e.target.files?.[0] || null)}
        />
        {file ? (
          <div className="flex flex-col items-center gap-1.5">
            <Icon className="h-7 w-7 text-primary" />
            <p className="font-medium text-sm">{file.name}</p>
            <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={e => { e.stopPropagation(); onChange(null); }}
            >
              Remove
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5">
            <Upload className="h-7 w-7 text-muted-foreground" />
            <p className="text-sm font-medium">Click to select</p>
          </div>
        )}
      </div>
    </div>
  );
}

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

function humanizeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    const data = err.data as Record<string, unknown> | null;
    const detail =
      (typeof data?.error === "string" && data.error) ||
      (typeof data?.message === "string" && data.message) ||
      (typeof data?.detail === "string" && data.detail !== "Not Found" && data.detail);
    if (detail) return String(detail);
    const status: number = err.status;
    const message: string = err.message;
    if (status === 404) return "The requested resource was not found. Check your file and try again.";
    if (status === 413) return "File is too large to upload. Please reduce the file size and try again.";
    if (status === 422) return "The server could not process your file. Check the format and try again.";
    if (status >= 500) return "The server encountered an error. Please try again in a moment.";
    if (status === 401 || status === 403) return "You are not authorized to perform this action.";
    return message;
  }
  if (err instanceof Error) return err.message;
  return "An unexpected error occurred. Please try again.";
}

function ImportTab({ onDone, onViewOverrides, onGoToSettings, overwriteThreshold, pendingThreshold }: { onDone: () => void; onViewOverrides: () => void; onGoToSettings: () => void; overwriteThreshold: number; pendingThreshold: number | null }) {
  const [step, setStep] = useState<ImportStep>("upload");
  const [xlsxFile, setXlsxFile] = useState<File | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<ImportDiff[]>([]);
  const [collisions, setCollisions] = useState<CollisionPreview[]>([]);
  const [collisionsOpen, setCollisionsOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem("training.collisionPanel.open");
      return stored === "true" ? true : stored === "false" ? false : false;
    } catch { return false; }
  });
  const [skippedCollisionKeys, setSkippedCollisionKeys] = useState<Set<string>>(new Set());
  const [skippedOverwriteRows, setSkippedOverwriteRows] = useState<Array<{ roomName: string; signType: string }>>([]);
  const [skippedListOpen, setSkippedListOpen] = useState(false);
  const [totalRows, setTotalRows] = useState(0);
  const [collisionCount, setCollisionCount] = useState(0);
  const [collisionSearch, setCollisionSearch] = useState<string>(() => {
    try { return localStorage.getItem("training.collisionPanel.search") || ""; } catch { return ""; }
  });
  const [collisionSortCol, setCollisionSortCol] = useState<CollisionSortCol>(() => {
    const VALID: CollisionSortCol[] = ["roomNamePattern", "oldCorrectedValue", "newCorrectedValue"];
    try {
      const stored = localStorage.getItem("training.collisionPanel.sortCol") as CollisionSortCol;
      return VALID.includes(stored) ? stored : "roomNamePattern";
    } catch { return "roomNamePattern"; }
  });
  const [collisionSortDir, setCollisionSortDir] = useState<"asc" | "desc">(() => {
    try {
      const stored = localStorage.getItem("training.collisionPanel.sortDir");
      return stored === "asc" || stored === "desc" ? stored : "asc";
    } catch { return "asc"; }
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importMode, setImportMode] = useState<ImportMode>("skip");
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmProgress, setConfirmProgress] = useState<{ done: number; total: number } | null>(null);
  const [confirmResult, setConfirmResult] = useState<ConfirmResult | null>(null);
  const [sortCol, setSortCol] = useState<SortCol>(() => {
    const VALID_SORT_COLS: SortCol[] = ["roomNamePattern", "signType", "pipelineSignType", "confidence", "status"];
    try {
      const stored = localStorage.getItem("training.importTab.sortCol") as SortCol;
      return VALID_SORT_COLS.includes(stored) ? stored : "status";
    } catch { return "status"; }
  });
  const [sortDir, setSortDir] = useState<SortDir>(() => {
    try {
      const stored = localStorage.getItem("training.importTab.sortDir");
      return stored === "asc" || stored === "desc" ? stored : "asc";
    } catch { return "asc"; }
  });
  const [filterStatus, setFilterStatus] = useState<"all" | "new" | "updated">(() => {
    try {
      const stored = localStorage.getItem("training.importTab.filterStatus");
      return stored === "all" || stored === "new" || stored === "updated" ? stored : "all";
    } catch { return "all"; }
  });

  useEffect(() => {
    try { localStorage.setItem("training.importTab.sortCol", sortCol); } catch {}
  }, [sortCol]);
  useEffect(() => {
    try { localStorage.setItem("training.importTab.sortDir", sortDir); } catch {}
  }, [sortDir]);
  useEffect(() => {
    try { localStorage.setItem("training.importTab.filterStatus", filterStatus); } catch {}
  }, [filterStatus]);
  useEffect(() => {
    try { localStorage.setItem("training.collisionPanel.sortCol", collisionSortCol); } catch {}
  }, [collisionSortCol]);
  useEffect(() => {
    try { localStorage.setItem("training.collisionPanel.sortDir", collisionSortDir); } catch {}
  }, [collisionSortDir]);
  useEffect(() => {
    try { localStorage.setItem("training.collisionPanel.search", collisionSearch); } catch {}
  }, [collisionSearch]);
  useEffect(() => {
    try { localStorage.setItem("training.collisionPanel.open", String(collisionsOpen)); } catch {}
  }, [collisionsOpen]);
  const [filterText, setFilterText] = useState(() => {
    try { return localStorage.getItem("training.importTab.filterText") ?? ""; } catch { return ""; }
  });
  const [pageSize, setPageSize] = useState<typeof PAGE_SIZE_OPTIONS[number]>(() => {
    try {
      const stored = Number(localStorage.getItem("training.importTab.pageSize"));
      return (PAGE_SIZE_OPTIONS as readonly number[]).includes(stored) ? stored as typeof PAGE_SIZE_OPTIONS[number] : 20;
    } catch { return 20; }
  });
  const [page, setPage] = useState(0);
  useEffect(() => {
    try { localStorage.setItem("training.importTab.filterText", filterText); } catch {}
  }, [filterText]);
  useEffect(() => {
    try { localStorage.setItem("training.importTab.pageSize", String(pageSize)); } catch {}
  }, [pageSize]);
  const [batchLabel, setBatchLabel] = useState("");
  const [sourceJobId, setSourceJobId] = useState("");
  const [sourceType, setSourceType] = useState<SourceType>("");
  const [buildingType, setBuildingType] = useState("");
  const [signScheduleFile, setSignScheduleFile] = useState<File | null>(null);
  const [pdfDriveUrl, setPdfDriveUrl] = useState("");
  const [pdfDriveStatus, setPdfDriveStatus] = useState<"idle" | "downloading" | "success" | "error">("idle");
  const [pdfDriveFileSizeMB, setPdfDriveFileSizeMB] = useState<number | null>(null);
  const [signScheduleDriveUrl, setSignScheduleDriveUrl] = useState("");
  const [signScheduleDriveStatus, setSignScheduleDriveStatus] = useState<"idle" | "downloading" | "success" | "error">("idle");
  const [signScheduleDriveFileSizeMB, setSignScheduleDriveFileSizeMB] = useState<number | null>(null);
  const signScheduleStoragePathRef = useRef<string | undefined>(undefined);
  const [aiMissed, setAiMissed] = useState<AiMissedItem[]>([]);
  const [aiExtra, setAiExtra] = useState<AiExtraItem[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [aiMissedOpen, setAiMissedOpen] = useState(false);
  const [aiExtraOpen, setAiExtraOpen] = useState(false);
  const [hasExported, setHasExported] = useState(false);
  const [csvFilenameDialogOpen, setCsvFilenameDialogOpen] = useState(false);
  const [csvFilename, setCsvFilename] = useState("");
  const [csvGeneratedDefault, setCsvGeneratedDefault] = useState("");
  const [lastCustomCsvFilename, setLastCustomCsvFilename] = useState<string>(() => {
    try { return localStorage.getItem("lastCsvFilename") ?? ""; } catch { return ""; }
  });

  const ALL_EXPORT_COLUMNS = [
    { key: "roomNamePattern", label: "Room Pattern" },
    { key: "pipelineSignType", label: "AI Predicted" },
    { key: "signType", label: "Correct Sign Type" },
    { key: "confidence", label: "Confidence" },
    { key: "status", label: "Status" },
  ] as const;
  type ExportColKey = typeof ALL_EXPORT_COLUMNS[number]["key"];
  const EXPORT_COLS_STORAGE_KEY = "training.importTab.exportCols";
  const EXPORT_PRESETS_STORAGE_KEY = "training.importTab.exportPresets";
  const allExportKeys = ALL_EXPORT_COLUMNS.map(c => c.key);
  const [exportCols, setExportCols] = useState<Set<ExportColKey>>(() => {
    try {
      const stored = localStorage.getItem(EXPORT_COLS_STORAGE_KEY);
      if (stored) {
        const parsed: string[] = JSON.parse(stored);
        const valid = parsed.filter((k): k is ExportColKey =>
          (allExportKeys as string[]).includes(k)
        );
        if (valid.length > 0) return new Set(valid);
      }
    } catch {
    }
    return new Set(allExportKeys);
  });
  const setExportColsPersisted = (next: Set<ExportColKey>) => {
    try {
      localStorage.setItem(EXPORT_COLS_STORAGE_KEY, JSON.stringify([...next]));
    } catch {
    }
    setExportCols(next);
  };

  type ExportPreset = { name: string; cols: ExportColKey[] };
  const [exportPresets, setExportPresets] = useState<ExportPreset[]>(() => {
    try {
      const stored = localStorage.getItem(EXPORT_PRESETS_STORAGE_KEY);
      if (stored) return JSON.parse(stored) as ExportPreset[];
    } catch {
    }
    return [];
  });
  const saveExportPresets = (presets: ExportPreset[]) => {
    try {
      localStorage.setItem(EXPORT_PRESETS_STORAGE_KEY, JSON.stringify(presets));
    } catch {
    }
    setExportPresets(presets);
  };
  const [showPresetInput, setShowPresetInput] = useState(false);
  const [savingPresetName, setSavingPresetName] = useState("");

  const { data: jobsList } = useListJobs();
  const requestUploadUrlMutation = useRequestUploadUrl();

  useEffect(() => {
    const raw = sessionStorage.getItem("training_pending_import");
    if (!raw) return;
    try {
      sessionStorage.removeItem("training_pending_import");
      const data = JSON.parse(raw) as {
        analyzeResult: ImportAnalysisResult;
        batchLabel?: string;
        sourceJobId?: string;
      };
      const result = data.analyzeResult;
      const fetchedDiffs = result.diffs ?? [];
      setDiffs(fetchedDiffs);
      setCollisions(result.collisions ?? []);
      setTotalRows(result.totalRows ?? 0);
      setCollisionCount(result.collisionCount ?? 0);
      setMatchedCount(result.matchedCount ?? 0);
      setAiMissed(result.aiMissed ?? []);
      setAiExtra(result.aiExtra ?? []);
      setAiMissedOpen((result.aiMissed?.length ?? 0) > 0);
      setSelected(new Set(fetchedDiffs.filter(d => getDiffCategory(d) !== "duplicate").map(d => d.id)));
      if (fetchedDiffs.some(d => getDiffCategory(d) === "conflict")) setImportMode("update");
      if (data.batchLabel) setBatchLabel(data.batchLabel);
      if (data.sourceJobId) setSourceJobId(data.sourceJobId);
      setStep("review");
    } catch {
      // ignore malformed data
    }
  }, []);

  async function uploadFile(file: File, contentType: string): Promise<string> {
    const { uploadURL, objectPath } = await requestUploadUrlMutation.mutateAsync({
      data: { name: file.name, size: file.size, contentType },
    });
    await fetch(uploadURL, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": contentType },
    });
    return objectPath;
  }

  async function handleAnalyze() {
    if (!xlsxFile) return;

    const PDF_MAX_BYTES = 50 * 1024 * 1024;
    const SCHED_MAX_BYTES = 25 * 1024 * 1024;
    const XLSX_MAX_BYTES = 5 * 1024 * 1024;

    if (pdfFile && pdfFile.size > PDF_MAX_BYTES) {
      setUploadError("Floor plan PDF exceeds 50MB limit. Use a Google Drive link instead for large files.");
      return;
    }
    if (signScheduleFile && signScheduleFile.size > SCHED_MAX_BYTES) {
      setUploadError("Sign schedule exceeds 25MB limit. Use a Google Drive link instead.");
      return;
    }
    if (xlsxFile.size > XLSX_MAX_BYTES) {
      setUploadError("Takeoff spreadsheet exceeds 5MB limit.");
      return;
    }

    // Auto-detect building type from the linked job (invisible to user)
    const selectedJob = (jobsList ?? []).find(j => j.id === sourceJobId);
    const autoDetectedBuildingType = (selectedJob as { buildingType?: string | null } | undefined)?.buildingType ?? null;
    setBuildingType(autoDetectedBuildingType ?? "");

    setIsUploading(true);
    setUploadError(null);
    setAnalyzeError(null);

    let xlsxStoragePath: string;
    let pdfStoragePath: string | undefined;

    try {
      const xlsxContentType = xlsxFile.name.toLowerCase().endsWith(".xlsx")
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : xlsxFile.name.toLowerCase().endsWith(".xls")
        ? "application/vnd.ms-excel"
        : "text/csv";

      xlsxStoragePath = await uploadFile(xlsxFile, xlsxContentType);

      if (pdfFile) {
        pdfStoragePath = await uploadFile(pdfFile, "application/pdf");
      } else if (pdfDriveUrl.trim()) {
        setPdfDriveStatus("downloading");
        setPdfDriveFileSizeMB(null);
        try {
          const driveRes = await customFetch<{ storagePath: string; filename: string; sizeBytes: number; sizeMB: number }>(
            "/api/training/import/drive",
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ driveUrl: pdfDriveUrl.trim() }) }
          );
          pdfStoragePath = driveRes.storagePath;
          setPdfDriveStatus("success");
          setPdfDriveFileSizeMB(driveRes.sizeMB);
        } catch (err: unknown) {
          setPdfDriveStatus("error");
          throw new Error(`Floor plan PDF from Google Drive: ${humanizeApiError(err)}`, { cause: err });
        }
      }

      if (signScheduleFile) {
        signScheduleStoragePathRef.current = await uploadFile(signScheduleFile, "application/pdf");
      } else if (signScheduleDriveUrl.trim()) {
        setSignScheduleDriveStatus("downloading");
        setSignScheduleDriveFileSizeMB(null);
        try {
          const driveRes = await customFetch<{ storagePath: string; filename: string; sizeBytes: number; sizeMB: number }>(
            "/api/training/import/drive",
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ driveUrl: signScheduleDriveUrl.trim() }) }
          );
          signScheduleStoragePathRef.current = driveRes.storagePath;
          setSignScheduleDriveStatus("success");
          setSignScheduleDriveFileSizeMB(driveRes.sizeMB);
        } catch (err: unknown) {
          setSignScheduleDriveStatus("error");
          throw new Error(`Sign schedule from Google Drive: ${humanizeApiError(err)}`, { cause: err });
        }
      } else {
        signScheduleStoragePathRef.current = undefined;
      }
    } catch (err: unknown) {
      setUploadError(humanizeApiError(err));
      setIsUploading(false);
      return;
    }
    setIsUploading(false);

    setIsAnalyzing(true);
    try {
      const result = await customFetch<ImportAnalysisResult>("/api/training/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          xlsxStoragePath,
          xlsxFileName: xlsxFile.name,
          ...(pdfStoragePath ? { pdfStoragePath } : {}),
          ...(signScheduleStoragePathRef.current ? { signScheduleStoragePath: signScheduleStoragePathRef.current } : {}),
          ...(sourceJobId.trim() ? { sourceJobId: sourceJobId.trim() } : {}),
        }),
      });
      const fetchedDiffs = result.diffs || [];
      const fetchedCollisions = result.collisions || [];
      setDiffs(fetchedDiffs);
      setCollisions(fetchedCollisions);
      setCollisionSearch("");
      setCollisionsOpen(fetchedCollisions.length > overwriteThreshold);
      setTotalRows(result.totalRows || 0);
      setSelected(new Set(fetchedDiffs.filter((d: ImportDiff) => getDiffCategory(d) !== "duplicate").map((d: ImportDiff) => d.id)));
      if (fetchedDiffs.some((d: ImportDiff) => getDiffCategory(d) === "conflict")) setImportMode("update");
      setMatchedCount(result.matchedCount ?? 0);
      setAiMissed(result.aiMissed ?? []);
      setAiExtra(result.aiExtra ?? []);
      setAiMissedOpen((result.aiMissed?.length ?? 0) > 0);
      setAiExtraOpen(false);
      setStep("review");
    } catch (err: unknown) {
      setAnalyzeError(humanizeApiError(err));
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function handleConfirm() {
    const confirmedDiffs = diffs.filter(d => selected.has(d.id)).map(d => {
      const collisionKey = `${d.roomName}::${d.humanSignType}`;
      return {
        ...d,
        ...(importMode === "update" && skippedCollisionKeys.has(collisionKey)
          ? { skipOverwrite: true }
          : {}),
      };
    });
    if (confirmedDiffs.length === 0) return;

    const skippedRows = importMode === "update"
      ? diffs
          .filter(d => d.existingCorrectedSignType != null && !selected.has(d.id))
          .map(d => ({ roomName: d.roomName, signType: d.humanSignType }))
      : [];

    const CHUNK_SIZE = 250;
    const chunks: typeof confirmedDiffs[] = [];
    for (let i = 0; i < confirmedDiffs.length; i += CHUNK_SIZE) {
      chunks.push(confirmedDiffs.slice(i, i + CHUNK_SIZE));
    }
    const totalChunks = chunks.length;

    setIsConfirming(true);
    setConfirmError(null);
    setConfirmProgress({ done: 0, total: confirmedDiffs.length });

    let lastResult: ConfirmResult | null = null;
    let currentBatch = 0;
    try {
      for (let i = 0; i < totalChunks; i++) {
        currentBatch = i + 1;
        const chunk = chunks[i];
        const result = await customFetch<ConfirmResult>("/api/training/import/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            diffs: chunk,
            mode: importMode,
            batchLabel: batchLabel.trim() || (pdfFile?.name.replace(/\.pdf$/i, "").trim() ?? undefined),
            xlsxFilename: xlsxFile?.name ?? undefined,
            sourceJobId: sourceJobId.trim() || undefined,
            sourceType: sourceType || undefined,
            matchedCount,
            aiMissedCount: aiMissed.length,
            aiExtraCount: aiExtra.length,
            buildingType: buildingType || undefined,
            ...(signScheduleStoragePathRef.current ? { signScheduleStoragePath: signScheduleStoragePathRef.current } : {}),
            totalHumanSigns: totalRows,
          }),
        });
        lastResult = result;
        setConfirmProgress({ done: Math.min(i * CHUNK_SIZE + chunk.length, confirmedDiffs.length), total: confirmedDiffs.length });
      }
      setConfirmResult(lastResult);
      setSkippedOverwriteRows(skippedRows);
      setStep("done");
      onDone();
    } catch (err: unknown) {
      const baseMsg = err instanceof Error ? err.message : "Failed to save corrections";
      setConfirmError(
        totalChunks > 1
          ? `Failed on batch ${currentBatch} of ${totalChunks}: ${baseMsg}`
          : baseMsg
      );
    } finally {
      setIsConfirming(false);
      setConfirmProgress(null);
    }
  }

  function handleReset() {
    setStep("upload");
    setXlsxFile(null);
    setPdfFile(null);
    setDiffs([]);
    setCollisions([]);
    setCollisionSearch("");
    setCollisionsOpen(false);
    setSkippedCollisionKeys(new Set());
    setSkippedOverwriteRows([]);
    setSkippedListOpen(false);
    setTotalRows(0);
    setCollisionCount(0);
    setSelected(new Set());
    setImportMode("skip");
    setConfirmResult(null);
    setUploadError(null);
    setAnalyzeError(null);
    setConfirmError(null);
    setFilterText("");
    try { localStorage.removeItem("training.importTab.filterText"); } catch {}
    setBatchLabel("");
    setBuildingType("");
    setSignScheduleFile(null);
    setPdfDriveUrl("");
    setSignScheduleDriveUrl("");
    signScheduleStoragePathRef.current = undefined;
    setPage(0);
    setMatchedCount(0);
    setAiMissed([]);
    setAiExtra([]);
    setAiMissedOpen(false);
    setAiExtraOpen(false);
  }

  function handleSortClick(col: SortCol) {
    if (sortCol === col) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
    setPage(0);
  }

  const processedOverrides = useMemo(() => {
    const changes = confirmResult?.overrideChanges ?? [];
    const text = filterText.trim().toLowerCase();
    let filtered = changes.filter(c => {
      if (filterStatus !== "all" && c.status !== filterStatus) return false;
      if (text) {
        return (
          c.roomNamePattern.toLowerCase().includes(text) ||
          c.signType.toLowerCase().includes(text) ||
          c.pipelineSignType.toLowerCase().includes(text)
        );
      }
      return true;
    });
    filtered = [...filtered].sort((a, b) => {
      let av: string | number = a[sortCol];
      let bv: string | number = b[sortCol];
      if (sortCol === "confidence") {
        av = a.confidence;
        bv = b.confidence;
        return sortDir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
      }
      av = String(av).toLowerCase();
      bv = String(bv).toLowerCase();
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return filtered;
  }, [confirmResult, filterStatus, filterText, sortCol, sortDir]);

  const totalPages = Math.max(1, Math.ceil(processedOverrides.length / pageSize));
  const pagedOverrides = processedOverrides.slice(page * pageSize, (page + 1) * pageSize);

  function toggleDiff(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = diffs.length > 0 && selected.size === diffs.length;
  const someSelected = selected.size > 0 && selected.size < diffs.length;
  const categoryCount = useMemo(() => {
    const counts = { new: 0, conflict: 0, duplicate: 0 };
    for (const d of diffs) counts[getDiffCategory(d)]++;
    return counts;
  }, [diffs]);

  const overwriteCount = useMemo(
    () => diffs.filter(d => {
      if (getDiffCategory(d) !== "conflict") return false;
      if (!selected.has(d.id)) return false;
      const key = `${d.roomName}::${d.humanSignType}`;
      return !skippedCollisionKeys.has(key);
    }).length,
    [diffs, selected, skippedCollisionKeys]
  );

  const deselectedOverwriteCount = useMemo(
    () => diffs.filter(d => getDiffCategory(d) === "conflict" && !selected.has(d.id)).length,
    [diffs, selected]
  );

  function handleSelectAllChange(value: boolean | "indeterminate") {
    setSelected(value === true ? new Set(diffs.map(d => d.id)) : new Set());
  }

  function toggleCollisionSkip(key: string) {
    setSkippedCollisionKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const filteredCollisions = useMemo(() => {
    let list = collisions;
    const q = collisionSearch.trim().toLowerCase();
    if (q) {
      list = list.filter(c =>
        c.roomNamePattern.toLowerCase().includes(q) ||
        c.oldCorrectedValue.toLowerCase().includes(q) ||
        c.newCorrectedValue.toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => {
      const cmp = a[collisionSortCol].localeCompare(b[collisionSortCol]);
      return collisionSortDir === "asc" ? cmp : -cmp;
    });
  }, [collisions, collisionSearch, collisionSortCol, collisionSortDir]);

  function handleCollisionSortClick(col: CollisionSortCol) {
    if (collisionSortCol === col) {
      setCollisionSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setCollisionSortCol(col);
      setCollisionSortDir("asc");
    }
  }

  function toggleAllCollisionSkip(skipAll: boolean) {
    const visibleKeys = new Set(filteredCollisions.map(c => `${c.roomNamePattern}::${c.signType}`));
    if (skipAll) {
      setSkippedCollisionKeys(prev => {
        const next = new Set(prev);
        visibleKeys.forEach(k => next.add(k));
        return next;
      });
    } else {
      setSkippedCollisionKeys(prev => {
        const next = new Set(prev);
        visibleKeys.forEach(k => next.delete(k));
        return next;
      });
    }
  }

  function handleExportCsv() {
    const dateStr = new Date().toISOString().slice(0, 10);
    const projectSlug = xlsxFile
      ? xlsxFile.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9-_]+/g, "-").toLowerCase()
      : null;
    const defaultName = projectSlug
      ? `${projectSlug}-rule-override-changes-${dateStr}.csv`
      : `rule-override-changes-${dateStr}.csv`;
    setCsvGeneratedDefault(defaultName);
    setCsvFilename(lastCustomCsvFilename || defaultName);
    setCsvFilenameDialogOpen(true);
  }

  function handleCsvDownload() {
    const colValueMap: Record<ExportColKey, (c: OverrideChange) => string> = {
      roomNamePattern: c => c.roomNamePattern,
      pipelineSignType: c => c.pipelineSignType,
      signType: c => c.signType,
      confidence: c => (c.confidence * 100).toFixed(1) + "%",
      status: c => c.status,
    };
    const activeCols = ALL_EXPORT_COLUMNS.filter(col => exportCols.has(col.key));
    const headers = activeCols.map(col => col.label);
    const rows = processedOverrides.map(c => activeCols.map(col => colValueMap[col.key](c)));
    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const filename = csvFilename.trim() || "rule-override-changes.csv";
    link.download = filename.toLowerCase().endsWith(".csv") ? filename : `${filename}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    const isCustom = link.download !== csvGeneratedDefault;
    if (isCustom) {
      setLastCustomCsvFilename(link.download);
      try { localStorage.setItem("lastCsvFilename", link.download); } catch {}
    }
    setCsvFilenameDialogOpen(false);
    setHasExported(true);
  }

  if (step === "done" && confirmResult) {
    function SortIcon({ col }: { col: SortCol }) {
      if (sortCol !== col) return <ChevronsUpDown className="h-3 w-3 ml-1 opacity-40" />;
      return sortDir === "asc"
        ? <ChevronUp className="h-3 w-3 ml-1" />
        : <ChevronDown className="h-3 w-3 ml-1" />;
    }

    return (
      <>
      <Card>
        <CardHeader>
          <CardTitle>Import Complete</CardTitle>
          <CardDescription>Your historical takeoff has been imported and the training engine updated.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-200 rounded-lg">
            <CheckCircle2 className="h-6 w-6 text-green-600 shrink-0" />
            <div className="space-y-1">
              {confirmResult.saved > 0 && (
                <p className="font-medium text-green-800">{confirmResult.saved} new correction{confirmResult.saved !== 1 ? "s" : ""} saved</p>
              )}
              {confirmResult.updated > 0 && (
                <p className="font-medium text-green-800">{confirmResult.updated} existing correction{confirmResult.updated !== 1 ? "s" : ""} updated</p>
              )}
              {confirmResult.saved === 0 && confirmResult.updated === 0 && (
                <p className="font-medium text-green-800">No changes applied</p>
              )}
              <p className="text-sm text-green-700">
                {confirmResult.overridesCreatedOrUpdated} rule override{confirmResult.overridesCreatedOrUpdated !== 1 ? "s" : ""} created or updated
              </p>
              {confirmResult.skipped > 0 && (
                <p className="text-sm text-green-600">
                  {confirmResult.skipped} already known pattern{confirmResult.skipped !== 1 ? "s" : ""} skipped
                </p>
              )}
              {skippedOverwriteRows.length > 0 && (
                <div className="text-sm text-amber-700">
                  <button
                    type="button"
                    onClick={() => setSkippedListOpen(o => !o)}
                    className="flex items-center gap-1 hover:underline focus:outline-none"
                  >
                    {skippedListOpen
                      ? <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                      : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                    {skippedOverwriteRows.length} overwriting row{skippedOverwriteRows.length !== 1 ? "s" : ""} skipped (deselected at confirm)
                  </button>
                  {skippedListOpen && (
                    <ul className="mt-1.5 ml-5 space-y-0.5 text-xs text-amber-800">
                      {skippedOverwriteRows.map((row, i) => (
                        <li key={i} className="list-disc">
                          <span className="font-medium">{row.roomName}</span>
                          {row.signType && <span className="text-amber-600"> — {row.signType}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>

          {confirmResult.accuracyScore !== null && confirmResult.accuracyScore !== undefined && (
            <div className="border rounded-lg p-4 bg-emerald-50 border-emerald-200">
              <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-3">Accuracy Score</p>
              <div className="flex items-center justify-center gap-3">
                <div className="text-center">
                  <div className="text-3xl font-bold text-emerald-800">
                    {Math.round(confirmResult.accuracyScore * 1000) / 10}%
                  </div>
                  <div className="text-xs text-emerald-600 mt-1">matched / total rooms</div>
                </div>
              </div>
            </div>
          )}

          <div className="border rounded-lg p-4 bg-blue-50 border-blue-200">
            <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-3">Confidence Impact</p>
            <div className="flex items-center justify-center gap-4">
              <div className="text-center">
                <div className={`text-2xl font-bold ${confirmResult.prevAvgConfidence !== null ? "text-blue-800" : "text-blue-400"}`}>
                  {confirmResult.prevAvgConfidence !== null
                    ? `${Math.round(confirmResult.prevAvgConfidence * 100)}%`
                    : "First import"}
                </div>
                <div className="text-xs text-blue-600 mt-1">Before</div>
              </div>
              <div className="text-blue-400 text-xl font-light">→</div>
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-800">
                  {`${Math.round(confirmResult.newAvgConfidence * 100)}%`}
                </div>
                <div className="text-xs text-blue-600 mt-1">After</div>
              </div>
              {confirmResult.prevAvgConfidence !== null && (
                <div className="text-center ml-2">
                  <div className={`flex items-center gap-1 text-xl font-bold ${
                    Math.round((confirmResult.newAvgConfidence - confirmResult.prevAvgConfidence) * 100) > 0
                      ? "text-green-600"
                      : Math.round((confirmResult.newAvgConfidence - confirmResult.prevAvgConfidence) * 100) < 0
                      ? "text-red-600"
                      : "text-muted-foreground"
                  }`}>
                    {Math.round((confirmResult.newAvgConfidence - confirmResult.prevAvgConfidence) * 100) > 0
                      ? <TrendingUp className="h-5 w-5 shrink-0" />
                      : Math.round((confirmResult.newAvgConfidence - confirmResult.prevAvgConfidence) * 100) < 0
                      ? <TrendingDown className="h-5 w-5 shrink-0" />
                      : <Minus className="h-5 w-5 shrink-0" />
                    }
                    {Math.round((confirmResult.newAvgConfidence - confirmResult.prevAvgConfidence) * 100) > 0 ? "+" : ""}
                    {Math.round((confirmResult.newAvgConfidence - confirmResult.prevAvgConfidence) * 100)}%
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">Change</div>
                </div>
              )}
            </div>
            <p className="text-xs text-blue-600 text-center mt-3">
              {confirmResult.prevAvgConfidence !== null
                ? "Avg confidence across all active rule overrides"
                : "Baseline established — confidence trend will appear after your next import"}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="text-center p-4 bg-muted rounded-lg">
              <div className="text-2xl font-bold">{confirmResult.impact.totalCorrections}</div>
              <div className="text-xs text-muted-foreground mt-1">Total Corrections</div>
            </div>
            <div className="text-center p-4 bg-muted rounded-lg">
              <div className="text-2xl font-bold">{confirmResult.impact.activeOverrides}</div>
              <div className="text-xs text-muted-foreground mt-1">Active Overrides</div>
            </div>
            <div className="text-center p-4 bg-muted rounded-lg">
              <div className="text-2xl font-bold">{confirmResult.impact.totalOverrides}</div>
              <div className="text-xs text-muted-foreground mt-1">Total Overrides</div>
            </div>
          </div>

          {(confirmResult.overrideChanges ?? []).length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex flex-col gap-0.5">
                  <h3 className="text-sm font-semibold">Rule Override Changes</h3>
                  {hasExported && (
                    <p className="text-xs text-muted-foreground">
                      Adjust filters or columns above, then click <span className="font-medium">Download again</span>.
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Input
                    placeholder="Search sign type or room…"
                    value={filterText}
                    onChange={e => { setFilterText(e.target.value); setPage(0); }}
                    className="h-8 text-sm w-48"
                  />
                  <DropdownMenu onOpenChange={(open) => { if (!open) { setShowPresetInput(false); setSavingPresetName(""); } }}>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline" className="h-8 text-xs gap-1">
                        Columns ({exportCols.size}/{ALL_EXPORT_COLUMNS.length})
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuLabel className="text-xs">Export Columns</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-xs cursor-pointer"
                        onSelect={e => {
                          e.preventDefault();
                          setExportColsPersisted(new Set(allExportKeys));
                        }}
                      >
                        Select all
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {ALL_EXPORT_COLUMNS.map(col => (
                        <DropdownMenuCheckboxItem
                          key={col.key}
                          className="text-xs"
                          checked={exportCols.has(col.key)}
                          onCheckedChange={checked => {
                            const next = new Set(exportCols);
                            if (checked) next.add(col.key);
                            else next.delete(col.key);
                            setExportColsPersisted(next);
                          }}
                        >
                          {col.label}
                        </DropdownMenuCheckboxItem>
                      ))}
                      <DropdownMenuSeparator />
                      {showPresetInput && (
                        <div className="px-2 py-1.5" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            <input
                              autoFocus
                              placeholder="Preset name…"
                              value={savingPresetName}
                              onChange={e => setSavingPresetName(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === "Enter" && savingPresetName.trim()) {
                                  const name = savingPresetName.trim();
                                  const updated = [
                                    ...exportPresets.filter(p => p.name !== name),
                                    { name, cols: [...exportCols] as ExportColKey[] },
                                  ];
                                  saveExportPresets(updated);
                                  setSavingPresetName("");
                                  setShowPresetInput(false);
                                }
                                if (e.key === "Escape") { setSavingPresetName(""); setShowPresetInput(false); }
                              }}
                              className="flex-1 h-6 text-xs border rounded px-1.5 bg-background outline-none focus:ring-1 focus:ring-ring"
                            />
                            <button
                              className="text-xs text-primary font-medium disabled:opacity-40"
                              disabled={!savingPresetName.trim()}
                              onClick={() => {
                                const name = savingPresetName.trim();
                                if (!name) return;
                                const updated = [
                                  ...exportPresets.filter(p => p.name !== name),
                                  { name, cols: [...exportCols] as ExportColKey[] },
                                ];
                                saveExportPresets(updated);
                                setSavingPresetName("");
                                setShowPresetInput(false);
                              }}
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      )}
                      <DropdownMenuItem
                        className="text-xs cursor-pointer text-muted-foreground"
                        onSelect={e => {
                          e.preventDefault();
                          if (showPresetInput) {
                            setShowPresetInput(false);
                            setSavingPresetName("");
                          } else {
                            setShowPresetInput(true);
                          }
                        }}
                      >
                        {showPresetInput ? "Cancel" : "Save preset…"}
                      </DropdownMenuItem>
                      {exportPresets.length > 0 && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel className="text-xs text-muted-foreground">Saved presets</DropdownMenuLabel>
                          {exportPresets.map(preset => (
                            <div key={preset.name} className="flex items-center group">
                              <DropdownMenuItem
                                className="text-xs cursor-pointer flex-1"
                                onSelect={() => {
                                  const valid = preset.cols.filter((k): k is ExportColKey =>
                                    (allExportKeys as string[]).includes(k)
                                  );
                                  setExportColsPersisted(new Set(valid));
                                }}
                              >
                                {preset.name}
                              </DropdownMenuItem>
                              <button
                                className="px-2 py-1 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity text-xs"
                                onClick={e => {
                                  e.stopPropagation();
                                  saveExportPresets(exportPresets.filter(p => p.name !== preset.name));
                                }}
                                title="Delete preset"
                              >
                                ×
                              </button>
                            </div>
                          ))}
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    size="sm"
                    variant={hasExported ? "default" : "outline"}
                    className="h-8 text-xs gap-1"
                    onClick={handleExportCsv}
                    disabled={processedOverrides.length === 0 || exportCols.size === 0}
                  >
                    <Download className="h-3.5 w-3.5" />
                    {hasExported ? "Download again" : "Export CSV"}
                  </Button>
                  <div className="flex gap-1">
                    {(["all", "new", "updated"] as const).map(f => (
                      <Button
                        key={f}
                        size="sm"
                        variant={filterStatus === f ? "default" : "outline"}
                        className="h-8 text-xs capitalize px-3"
                        onClick={() => { setFilterStatus(f); setPage(0); }}
                      >
                        {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="border rounded-md overflow-hidden">
                <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 sticky top-0 z-10">
                      <tr>
                        <th
                          className="p-3 text-left font-medium cursor-pointer select-none whitespace-nowrap hover:bg-muted"
                          onClick={() => handleSortClick("roomNamePattern")}
                        >
                          <span className="flex items-center">Room Pattern<SortIcon col="roomNamePattern" /></span>
                        </th>
                        <th
                          className="p-3 text-left font-medium cursor-pointer select-none whitespace-nowrap hover:bg-muted"
                          onClick={() => handleSortClick("pipelineSignType")}
                        >
                          <span className="flex items-center">AI Predicted<SortIcon col="pipelineSignType" /></span>
                        </th>
                        <th
                          className="p-3 text-left font-medium cursor-pointer select-none whitespace-nowrap hover:bg-muted"
                          onClick={() => handleSortClick("signType")}
                        >
                          <span className="flex items-center">Correct Sign Type<SortIcon col="signType" /></span>
                        </th>
                        <th
                          className="p-3 text-left font-medium cursor-pointer select-none whitespace-nowrap hover:bg-muted"
                          onClick={() => handleSortClick("confidence")}
                        >
                          <span className="flex items-center">Confidence<SortIcon col="confidence" /></span>
                        </th>
                        <th
                          className="p-3 text-left font-medium cursor-pointer select-none whitespace-nowrap hover:bg-muted"
                          onClick={() => handleSortClick("status")}
                        >
                          <span className="flex items-center">Status<SortIcon col="status" /></span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {pagedOverrides.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="p-6 text-center text-muted-foreground text-sm">
                            No overrides match the current filter.
                          </td>
                        </tr>
                      ) : pagedOverrides.map((c, i) => (
                        <tr key={c.ruleRef + i} className="hover:bg-muted/30">
                          <td className="p-3 font-mono text-xs max-w-[200px] truncate" title={c.roomNamePattern}>{c.roomNamePattern}</td>
                          <td className="p-3 text-muted-foreground">{c.pipelineSignType}</td>
                          <td className="p-3 font-medium">{c.signType}</td>
                          <td className="p-3">{(c.confidence * 100).toFixed(1)}%</td>
                          <td className="p-3">
                            <Badge variant={c.status === "new" ? "default" : "secondary"} className="capitalize text-xs">
                              {c.status}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {processedOverrides.length > 0 && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>
                    Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, processedOverrides.length)} of {processedOverrides.length}
                  </span>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-muted-foreground">Rows per page:</label>
                    <select
                      value={pageSize}
                      onChange={e => { setPageSize(Number(e.target.value) as typeof PAGE_SIZE_OPTIONS[number]); setPage(0); }}
                      className="h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      {PAGE_SIZE_OPTIONS.map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                    {totalPages > 1 && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs"
                          onClick={() => setPage(p => Math.max(0, p - 1))}
                          disabled={page === 0}
                        >
                          Previous
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs"
                          onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                          disabled={page >= totalPages - 1}
                        >
                          Next
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={handleReset} variant="outline" className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4" />
              Import Another File
            </Button>
            <Button onClick={onViewOverrides} variant="default" className="flex items-center gap-2">
              <ExternalLink className="h-4 w-4" />
              View Rule Overrides
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={csvFilenameDialogOpen} onOpenChange={setCsvFilenameDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save CSV As</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="csv-filename">Filename</Label>
            <Input
              id="csv-filename"
              value={csvFilename}
              onChange={e => setCsvFilename(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && csvFilename.trim()) handleCsvDownload(); }}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">The .csv extension will be added automatically if omitted.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCsvFilenameDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCsvDownload} disabled={!csvFilename.trim()}>
              <Download className="h-4 w-4 mr-1.5" />
              Download
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </>
    );
  }

  if (step === "review") {
    const hasDelta = sourceJobId && (matchedCount > 0 || aiMissed.length > 0 || aiExtra.length > 0);
    return (
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle>Review Differences</CardTitle>
              <CardDescription>
                Found {diffs.length} sign-type difference{diffs.length !== 1 ? "s" : ""} out of {totalRows} rows.
                {hasDelta
                  ? " A job comparison was run — see the delta summary below."
                  : " The rule engine predicted a different sign type than your historical takeoff."}
                {" "}Select which corrections to apply to the training engine.
              </CardDescription>
              {diffs.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-1">
                  {categoryCount.new > 0 && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-800 border border-green-200">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                      {categoryCount.new} new
                    </span>
                  )}
                  {categoryCount.conflict > 0 && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                      {categoryCount.conflict} conflict{categoryCount.conflict !== 1 ? "s" : ""}
                    </span>
                  )}
                  {categoryCount.duplicate > 0 && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0" />
                      {categoryCount.duplicate} duplicate{categoryCount.duplicate !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={handleReset}>Start Over</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {hasDelta && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-center">
                  <div className="text-2xl font-bold text-emerald-700">{matchedCount}</div>
                  <div className="text-xs text-emerald-600 mt-1 font-medium">Matched</div>
                  <div className="text-xs text-emerald-500 mt-0.5">AI found it, human has it</div>
                </div>
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-center">
                  <div className="text-2xl font-bold text-red-700">{aiMissed.length}</div>
                  <div className="text-xs text-red-600 mt-1 font-medium">AI Missed</div>
                  <div className="text-xs text-red-500 mt-0.5">Human has it, AI didn&apos;t find it</div>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-center">
                  <div className="text-2xl font-bold text-amber-700">{aiExtra.length}</div>
                  <div className="text-xs text-amber-600 mt-1 font-medium">AI Extra</div>
                  <div className="text-xs text-amber-500 mt-0.5">AI found it, not in takeoff</div>
                </div>
              </div>

              {aiMissed.length > 0 && (
                <div className="rounded-md border border-red-200 overflow-hidden">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left bg-red-50 hover:bg-red-100/60 transition-colors"
                    onClick={() => setAiMissedOpen(o => !o)}
                  >
                    <div className="flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 text-red-600 shrink-0" />
                      <span className="text-sm font-medium text-red-800">
                        {aiMissed.length} room{aiMissed.length !== 1 ? "s" : ""} AI missed — these are the most valuable training signals
                      </span>
                    </div>
                    {aiMissedOpen ? <ChevronUp className="h-4 w-4 text-red-500 shrink-0" /> : <ChevronDown className="h-4 w-4 text-red-500 shrink-0" />}
                  </button>
                  {aiMissedOpen && (
                    <div className="border-t border-red-200 overflow-x-auto max-h-52 overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-red-50 sticky top-0">
                          <tr>
                            <th className="p-2.5 text-left font-medium text-xs text-red-800">Room #</th>
                            <th className="p-2.5 text-left font-medium text-xs text-red-800">Room Name</th>
                            <th className="p-2.5 text-left font-medium text-xs text-red-800">Level</th>
                            <th className="p-2.5 text-left font-medium text-xs text-red-800">Sign Type</th>
                            <th className="p-2.5 text-left font-medium text-xs text-red-800">Qty</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-red-100">
                          {aiMissed.map(r => (
                            <tr key={r.id} className="hover:bg-red-50/60">
                              <td className="p-2.5 text-xs text-muted-foreground">{r.roomNumber || "—"}</td>
                              <td className="p-2.5 text-xs font-medium">{r.roomName}</td>
                              <td className="p-2.5 text-xs text-muted-foreground">{r.level || "—"}</td>
                              <td className="p-2.5 text-xs">
                                <Badge variant="secondary" className="bg-green-100 text-green-800 border-green-200 text-xs">{r.signType}</Badge>
                              </td>
                              <td className="p-2.5 text-xs text-muted-foreground">{r.qty}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {aiExtra.length > 0 && (
                <div className="rounded-md border border-amber-200 overflow-hidden">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left bg-amber-50 hover:bg-amber-100/60 transition-colors"
                    onClick={() => setAiExtraOpen(o => !o)}
                  >
                    <div className="flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
                      <span className="text-sm font-medium text-amber-800">
                        {aiExtra.length} room{aiExtra.length !== 1 ? "s" : ""} AI found that aren&apos;t in your takeoff — possible AI false positives or estimator misses
                      </span>
                    </div>
                    {aiExtraOpen ? <ChevronUp className="h-4 w-4 text-amber-500 shrink-0" /> : <ChevronDown className="h-4 w-4 text-amber-500 shrink-0" />}
                  </button>
                  {aiExtraOpen && (
                    <div className="border-t border-amber-200 overflow-x-auto max-h-52 overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-amber-50 sticky top-0">
                          <tr>
                            <th className="p-2.5 text-left font-medium text-xs text-amber-800">Room #</th>
                            <th className="p-2.5 text-left font-medium text-xs text-amber-800">Room Name</th>
                            <th className="p-2.5 text-left font-medium text-xs text-amber-800">Level</th>
                            <th className="p-2.5 text-left font-medium text-xs text-amber-800">AI Sign Type</th>
                            <th className="p-2.5 text-left font-medium text-xs text-amber-800">Confidence</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-amber-100">
                          {aiExtra.map(r => (
                            <tr key={r.id} className="hover:bg-amber-50/60">
                              <td className="p-2.5 text-xs text-muted-foreground">{r.roomNumber || "—"}</td>
                              <td className="p-2.5 text-xs font-medium">{r.roomName}</td>
                              <td className="p-2.5 text-xs text-muted-foreground">{r.level || "—"}</td>
                              <td className="p-2.5 text-xs">
                                <Badge variant="secondary" className="bg-orange-100 text-orange-800 border-orange-200 text-xs">{r.signType}</Badge>
                              </td>
                              <td className="p-2.5 text-xs">{Math.round(r.confidence * 100)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {diffs.length === 0 ? (
            <div className="flex flex-col items-center gap-3 p-12 border border-dashed rounded-md">
              <CheckCircle2 className="h-8 w-8 text-green-500" />
              <p className="text-muted-foreground text-center">
                No differences found — the rule engine predictions match your historical takeoff perfectly.
              </p>
              <Button variant="outline" onClick={handleReset}>Upload Another File</Button>
            </div>
          ) : (
            <>
              {importMode === "update" && (overwriteCount > 0 || deselectedOverwriteCount > 0) && (
                <div className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 p-3 rounded-md">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div className="flex-1 flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {overwriteCount > 0 ? (
                        <>
                          <span className="font-medium">{overwriteCount} conflict{overwriteCount !== 1 ? "s" : ""} will overwrite an existing correction.</span>
                          {" "}Rows highlighted in amber have a different trained value — confirm the new value is correct before applying.
                          {deselectedOverwriteCount > 0 && (
                            <>{" "}<span className="font-medium">{deselectedOverwriteCount} of {overwriteCount + deselectedOverwriteCount} conflict{overwriteCount + deselectedOverwriteCount !== 1 ? "s" : ""} {deselectedOverwriteCount === 1 ? "is" : "are"} currently deselected.</span></>
                          )}
                        </>
                      ) : (
                        <>All <span className="font-medium">{deselectedOverwriteCount}</span> conflict{deselectedOverwriteCount !== 1 ? "s" : ""} {deselectedOverwriteCount === 1 ? "is" : "are"} currently deselected. Click <span className="font-medium">Re-select conflicts</span> to restore them.</>
                      )}
                    </span>
                    <div className="flex items-center gap-3 whitespace-nowrap">
                      {overwriteCount > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setSelected(prev => {
                              const next = new Set(prev);
                              diffs.forEach(d => {
                                if (getDiffCategory(d) === "conflict") next.delete(d.id);
                              });
                              return next;
                            })
                          }
                          className="text-amber-800 underline underline-offset-2 hover:text-amber-900 font-medium"
                        >
                          Deselect conflicts
                        </button>
                      )}
                      {deselectedOverwriteCount > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setSelected(prev => {
                              const next = new Set(prev);
                              diffs.forEach(d => {
                                if (getDiffCategory(d) === "conflict") next.add(d.id);
                              });
                              return next;
                            })
                          }
                          className="text-amber-800 underline underline-offset-2 hover:text-amber-900 font-medium"
                        >
                          Re-select conflicts
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
              <div className="border rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="p-3 text-left w-10">
                        <Checkbox
                          checked={someSelected ? "indeterminate" : allSelected}
                          onCheckedChange={handleSelectAllChange}
                          aria-label="Select all"
                        />
                      </th>
                      <th className="p-3 text-left font-medium">Room #</th>
                      <th className="p-3 text-left font-medium">Room Name</th>
                      <th className="p-3 text-left font-medium">Level</th>
                      <th className="p-3 text-left font-medium">Pipeline Said</th>
                      <th className="p-3 text-left font-medium">Human Said</th>
                      {importMode === "update" && (
                        <th className="p-3 text-left font-medium">Current Training Value</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {diffs.map((diff, idx) => {
                      const cat = getDiffCategory(diff);
                      const isConflict = cat === "conflict";
                      const isDuplicate = cat === "duplicate";
                      return (
                        <tr
                          key={diff.id}
                          className={`border-t cursor-pointer transition-colors ${
                            isConflict && selected.has(diff.id)
                              ? "bg-amber-50 hover:bg-amber-100/70"
                              : isDuplicate
                              ? selected.has(diff.id)
                                ? "bg-muted/30 hover:bg-muted/50"
                                : "opacity-60 hover:opacity-80 hover:bg-muted/20"
                              : selected.has(diff.id)
                              ? "bg-blue-50/50 hover:bg-muted/30"
                              : "hover:bg-muted/30"
                          }`}
                          onClick={() => toggleDiff(diff.id)}
                        >
                          <td className="p-3" onClick={e => e.stopPropagation()}>
                            <Checkbox
                              checked={selected.has(diff.id)}
                              onCheckedChange={() => toggleDiff(diff.id)}
                              aria-label={`Select row ${idx + 1}`}
                            />
                          </td>
                          <td className="p-3 text-muted-foreground">{diff.roomNumber || "—"}</td>
                          <td className="p-3 font-medium">
                            <span className="flex items-center gap-2">
                              {diff.roomName}
                              {cat === "new" && (
                                <Badge variant="secondary" className="bg-green-100 text-green-800 border-green-200 text-xs shrink-0">New</Badge>
                              )}
                              {isConflict && (
                                <Badge variant="secondary" className="bg-amber-100 text-amber-800 border-amber-200 text-xs shrink-0">Conflict</Badge>
                              )}
                              {isDuplicate && (
                                <Badge variant="secondary" className="bg-slate-100 text-slate-600 border-slate-200 text-xs shrink-0">Duplicate</Badge>
                              )}
                            </span>
                          </td>
                          <td className="p-3 text-muted-foreground">{diff.level || "—"}</td>
                          <td className="p-3">
                            <Badge variant="secondary" className="bg-orange-100 text-orange-800 border-orange-200">
                              {diff.pipelineSignType}
                            </Badge>
                          </td>
                          <td className="p-3">
                            <Badge variant="secondary" className="bg-green-100 text-green-800 border-green-200">
                              {diff.humanSignType}
                            </Badge>
                          </td>
                          {importMode === "update" && (
                            <td className="p-3">
                              {diff.existingCorrectedSignType != null ? (
                                <span className="flex items-center gap-1.5">
                                  <Badge variant="secondary" className="bg-slate-100 text-slate-700 border-slate-200">
                                    {diff.existingCorrectedSignType}
                                  </Badge>
                                  <ArrowRight className="h-3 w-3 text-amber-500 shrink-0" />
                                  <Badge variant="secondary" className="bg-green-100 text-green-800 border-green-200">
                                    {diff.humanSignType}
                                  </Badge>
                                </span>
                              ) : (
                                <span className="text-muted-foreground text-xs">New pattern</span>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="rounded-md border bg-muted/30 p-4 space-y-2">
                <p className="text-sm font-medium">Batch label <span className="font-normal text-muted-foreground">(optional)</span></p>
                <input
                  type="text"
                  value={batchLabel}
                  onChange={e => setBatchLabel(e.target.value)}
                  placeholder="e.g. Building A Phase 1"
                  maxLength={120}
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <p className="text-xs text-muted-foreground">Give this import batch a name for easier tracking on the confidence trend chart.</p>
              </div>

              <div className="rounded-md border bg-muted/30 p-4 space-y-2">
                <p className="text-sm font-medium">When a pattern already exists in training data:</p>
                <div className="flex flex-col gap-2">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="importMode"
                      value="skip"
                      checked={importMode === "skip"}
                      onChange={() => setImportMode("skip")}
                      className="mt-0.5 accent-primary"
                    />
                    <span className="text-sm">
                      <span className="font-medium">Skip</span>
                      <span className="text-muted-foreground"> — keep the existing correction, ignore the new value (default)</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="importMode"
                      value="update"
                      checked={importMode === "update"}
                      onChange={() => setImportMode("update")}
                      className="mt-0.5 accent-primary"
                    />
                    <span className="text-sm">
                      <span className="font-medium">Update</span>
                      <span className="text-muted-foreground"> — overwrite existing corrections with the values from this file</span>
                      {collisionCount > 0 && (
                        <span className="ml-1 text-amber-700 font-medium">
                          ({collisionCount} existing correction{collisionCount !== 1 ? "s" : ""} will be overwritten)
                        </span>
                      )}
                    </span>
                  </label>
                </div>
              </div>

              {importMode === "update" && collisions.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 overflow-hidden">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-amber-100/60 transition-colors"
                    onClick={() => setCollisionsOpen(o => !o)}
                    aria-expanded={collisionsOpen}
                  >
                    <div className="flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
                      <span className="text-sm font-medium text-amber-800">
                        {(() => {
                          const selected = collisions.length - skippedCollisionKeys.size;
                          const total = collisions.length;
                          const isFiltered = collisionSearch.trim().length > 0;
                          if (isFiltered) {
                            const filteredSelected = filteredCollisions.filter(
                              c => !skippedCollisionKeys.has(`${c.roomNamePattern}::${c.signType}`)
                            ).length;
                            const filteredTotal = filteredCollisions.length;
                            const overwritePart = selected > 0
                              ? ` • ${selected} correction${selected !== 1 ? "s" : ""} will be overwritten`
                              : ` • all set to skip`;
                            return `${filteredSelected} of ${filteredTotal} selected (filtered)${overwritePart}`;
                          }
                          if (selected > 0) {
                            return `${selected} of ${total} selected • ${selected} correction${selected !== 1 ? "s" : ""} will be overwritten`;
                          }
                          return `${total} collision${total !== 1 ? "s" : ""} detected — all set to skip`;
                        })()}
                      </span>
                      <span className="text-xs text-amber-700 hidden sm:inline">
                        — toggle each row to choose skip or update
                      </span>
                    </div>
                    {collisionsOpen
                      ? <ChevronUp className="h-4 w-4 text-amber-600 shrink-0" />
                      : <ChevronDown className="h-4 w-4 text-amber-600 shrink-0" />
                    }
                  </button>
                  {collisionsOpen && (
                    <div className="border-t border-amber-200">
                      <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 space-y-1">
                        <Input
                          placeholder="Filter by room pattern, old or new value…"
                          value={collisionSearch}
                          onChange={e => setCollisionSearch(e.target.value)}
                          className="h-7 text-xs bg-white border-amber-300 placeholder:text-amber-500 focus-visible:ring-amber-400"
                        />
                        <div className="flex items-center justify-between">
                          {collisionSearch.trim() && (
                            <p className="text-xs text-amber-700">
                              Showing {filteredCollisions.length} of {collisions.length} collision{collisions.length !== 1 ? "s" : ""}
                            </p>
                          )}
                          <p className="text-xs text-amber-800 font-medium ml-auto">
                            {filteredCollisions.filter(c => !skippedCollisionKeys.has(`${c.roomNamePattern}::${c.signType}`)).length} of {filteredCollisions.length} selected to update
                          </p>
                        </div>
                      </div>
                      <div className="overflow-x-auto overflow-y-auto max-h-[300px]">
                        <table className="w-full text-sm">
                          <thead className="bg-amber-100/60 sticky top-0 z-10">
                            <tr>
                              <th className="p-3 text-left w-10">
                                <Checkbox
                                  checked={
                                    filteredCollisions.length === 0
                                      ? false
                                      : filteredCollisions.every(c => !skippedCollisionKeys.has(`${c.roomNamePattern}::${c.signType}`))
                                      ? true
                                      : filteredCollisions.every(c => skippedCollisionKeys.has(`${c.roomNamePattern}::${c.signType}`))
                                      ? false
                                      : "indeterminate"
                                  }
                                  onCheckedChange={(val) => toggleAllCollisionSkip(val === false)}
                                  aria-label="Toggle all visible collisions"
                                  title="Check to update all visible, uncheck to skip all visible"
                                />
                              </th>
                              <th
                                className="p-3 text-left font-medium text-xs uppercase tracking-wide text-amber-800 cursor-pointer select-none hover:bg-amber-200/40 whitespace-nowrap"
                                onClick={() => handleCollisionSortClick("roomNamePattern")}
                              >
                                <span className="flex items-center gap-1">
                                  Room Name Pattern
                                  {collisionSortCol === "roomNamePattern"
                                    ? collisionSortDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                                    : <ChevronsUpDown className="h-3 w-3 opacity-40" />
                                  }
                                </span>
                              </th>
                              <th
                                className="p-3 text-left font-medium text-xs uppercase tracking-wide text-amber-800 cursor-pointer select-none hover:bg-amber-200/40 whitespace-nowrap"
                                onClick={() => handleCollisionSortClick("oldCorrectedValue")}
                              >
                                <span className="flex items-center gap-1">
                                  Old Corrected Value
                                  {collisionSortCol === "oldCorrectedValue"
                                    ? collisionSortDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                                    : <ChevronsUpDown className="h-3 w-3 opacity-40" />
                                  }
                                </span>
                              </th>
                              <th
                                className="p-3 text-left font-medium text-xs uppercase tracking-wide text-amber-800 cursor-pointer select-none hover:bg-amber-200/40 whitespace-nowrap"
                                onClick={() => handleCollisionSortClick("newCorrectedValue")}
                              >
                                <span className="flex items-center gap-1">
                                  Incoming New Value
                                  {collisionSortCol === "newCorrectedValue"
                                    ? collisionSortDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                                    : <ChevronsUpDown className="h-3 w-3 opacity-40" />
                                  }
                                </span>
                              </th>
                              <th className="p-3 text-left font-medium text-xs uppercase tracking-wide text-amber-800">Action</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-amber-200">
                            {filteredCollisions.length === 0 ? (
                              <tr>
                                <td colSpan={5} className="p-4 text-center text-xs text-amber-700">
                                  No collisions match the filter.
                                </td>
                              </tr>
                            ) : filteredCollisions.map((c, i) => {
                              const key = `${c.roomNamePattern}::${c.signType}`;
                              const willUpdate = !skippedCollisionKeys.has(key);
                              return (
                                <tr
                                  key={c.roomNamePattern + i}
                                  className={`hover:bg-amber-100/40 cursor-pointer ${willUpdate ? "" : "opacity-60"}`}
                                  onClick={() => toggleCollisionSkip(key)}
                                >
                                  <td className="p-3" onClick={e => e.stopPropagation()}>
                                    <Checkbox
                                      checked={willUpdate}
                                      onCheckedChange={() => toggleCollisionSkip(key)}
                                      aria-label={`${willUpdate ? "Skip" : "Update"} ${c.roomNamePattern}`}
                                    />
                                  </td>
                                  <td className="p-3 font-mono text-xs text-amber-900 max-w-[200px] truncate" title={c.roomNamePattern}>
                                    {c.roomNamePattern}
                                  </td>
                                  <td className="p-3">
                                    <Badge variant="secondary" className="bg-white border-amber-300 text-amber-800 text-xs">
                                      {c.oldCorrectedValue}
                                    </Badge>
                                  </td>
                                  <td className="p-3">
                                    <Badge variant="secondary" className={`text-xs ${willUpdate ? "bg-green-100 text-green-800 border-green-200" : "bg-gray-100 text-gray-500 border-gray-200"}`}>
                                      {c.newCorrectedValue}
                                    </Badge>
                                  </td>
                                  <td className="p-3">
                                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${willUpdate ? "bg-amber-200 text-amber-800" : "bg-gray-200 text-gray-600"}`}>
                                      {willUpdate ? "Update" : "Skip"}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {importMode === "update" && overwriteCount > overwriteThreshold && (
                <div className="flex items-start gap-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 p-4 rounded-md">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold">Large overwrite detected</p>
                    <p className="mt-0.5 text-amber-700">
                      Your current selection will overwrite <span className="font-semibold">{overwriteCount} existing corrections</span> that may have been carefully calibrated.
                      Your team&apos;s safety limit is <span className="font-medium">{overwriteThreshold}</span> — switch to <span className="font-medium">Skip</span> mode to preserve them, or continue only if you are sure this file contains more accurate data.
                    </p>
                    {pendingThreshold !== null && pendingThreshold !== overwriteThreshold && (
                      <p className="mt-1.5 text-xs text-amber-700 bg-amber-100 border border-amber-200 rounded px-2 py-1 inline-flex items-center gap-1">
                        <span className="font-medium">Unsaved change in Settings:</span> new limit would be <span className="font-semibold">{pendingThreshold}</span> — this warning would {overwriteCount > pendingThreshold ? "still trigger" : "not trigger"} at that limit.
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={onGoToSettings}
                      className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-amber-800 underline underline-offset-2 hover:text-amber-900 transition-colors"
                    >
                      Adjust threshold in Settings
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              )}
              {importMode === "update" && pendingThreshold !== null && pendingThreshold !== overwriteThreshold && overwriteCount <= overwriteThreshold && overwriteCount > pendingThreshold && (
                <div className="flex items-start gap-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 p-4 rounded-md">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold">Unsaved threshold change would trigger a warning</p>
                    <p className="mt-0.5 text-amber-700">
                      Your current selection of <span className="font-semibold">{overwriteCount} correction{overwriteCount !== 1 ? "s" : ""}</span> is within the active limit ({overwriteThreshold}), but exceeds the pending unsaved limit of <span className="font-semibold">{pendingThreshold}</span>.
                    </p>
                    <button
                      type="button"
                      onClick={onGoToSettings}
                      className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-amber-800 underline underline-offset-2 hover:text-amber-900 transition-colors"
                    >
                      Review pending change in Settings
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              )}


              {confirmError && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-md border border-red-200">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {confirmError}
                </div>
              )}

              {deselectedOverwriteCount > 0 && (
                <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 p-3 rounded-md border border-amber-200">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>
                    Note: <span className="font-medium">{deselectedOverwriteCount} overwriting row{deselectedOverwriteCount !== 1 ? "s" : ""}</span> {deselectedOverwriteCount === 1 ? "was" : "were"} deselected and will not be updated.
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <p className="text-sm text-muted-foreground">
                  {selected.size} of {diffs.length} differences selected
                </p>
                <Button
                  onClick={handleConfirm}
                  disabled={selected.size === 0 || isConfirming}
                  className={`flex items-center gap-2 ${importMode === "update" && overwriteCount > 0 ? "bg-amber-600 hover:bg-amber-700" : ""}`}
                >
                  {isConfirming ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowRight className="h-4 w-4" />
                  )}
                  {isConfirming && confirmProgress
                    ? `Applying corrections... (${confirmProgress.done} / ${confirmProgress.total})`
                    : importMode === "update" && overwriteCount > 0
                      ? `Update ${overwriteCount} Correction${overwriteCount !== 1 ? "s" : ""}`
                      : `Apply ${selected.size} Correction${selected.size !== 1 ? "s" : ""}`}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <>
    <Card>
      <CardHeader>
        <CardTitle>Import Training Data</CardTitle>
        <CardDescription>
          Upload a historical takeoff spreadsheet paired with its original PDF to bulk-train the rule engine.
          The system will compare the spreadsheet sign assignments against rule-based predictions and let you review the differences before saving any corrections.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {pendingThreshold !== null && pendingThreshold !== overwriteThreshold && (
          <div className="flex items-center gap-1.5 text-xs text-amber-700">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>
              Pending threshold change: <span className="font-semibold">{pendingThreshold}</span> correction{pendingThreshold !== 1 ? "s" : ""} (unsaved) —{" "}
              <button type="button" onClick={onGoToSettings} className="underline hover:no-underline font-medium">Review in Settings</button>
            </span>
          </div>
        )}
        {/* 3-zone file upload layout */}
        <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
          {/* Zone 1 – Floor Plan PDF */}
          <div className="rounded-lg border border-border border-l-4 border-l-blue-500 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-sm">Floor Plan PDF</p>
              <Badge variant="outline" className="text-[11px] text-blue-600 border-blue-300 bg-blue-50/30">Required*</Badge>
            </div>
            <FileOrDriveInput
              file={pdfFile}
              driveUrl={pdfDriveUrl}
              onFileChange={setPdfFile}
              onDriveUrlChange={(url) => { setPdfDriveUrl(url); setPdfDriveStatus("idle"); setPdfDriveFileSizeMB(null); }}
              accept=".pdf,application/pdf"
              icon={FileText}
              sizeHint="PDF up to 50MB · or paste a Google Drive link for larger files"
              driveStatus={pdfDriveStatus}
              driveFileSizeMB={pdfDriveFileSizeMB}
            />
          </div>

          {/* Zone 2 – Sign Schedule */}
          <div className="rounded-lg border border-border border-l-4 border-l-purple-500 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-sm">Sign Schedule</p>
              <Badge variant="outline" className="text-[11px] text-muted-foreground border-muted-foreground/30">Optional</Badge>
            </div>
            <FileOrDriveInput
              file={signScheduleFile}
              driveUrl={signScheduleDriveUrl}
              onFileChange={setSignScheduleFile}
              onDriveUrlChange={(url) => { setSignScheduleDriveUrl(url); setSignScheduleDriveStatus("idle"); setSignScheduleDriveFileSizeMB(null); }}
              accept=".pdf,application/pdf"
              icon={FileText}
              sizeHint="PDF up to 25MB · or paste a Google Drive link"
              driveStatus={signScheduleDriveStatus}
              driveFileSizeMB={signScheduleDriveFileSizeMB}
            />
          </div>

          {/* Zone 3 – Takeoff XLSX */}
          <div className="rounded-lg border border-border border-l-4 border-l-green-500 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-sm">Takeoff Spreadsheet</p>
              <Badge variant="outline" className="text-[11px] text-green-600 border-green-300 bg-green-50/30">Required</Badge>
            </div>
            <FilePicker
              label=""
              hint="XLSX or CSV up to 5MB · tall or wide format"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              file={xlsxFile}
              onChange={setXlsxFile}
              icon={FileSpreadsheet}
            />
          </div>
        </div>

        {/* Metadata row */}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm font-medium">Takeoff source <span className="font-normal text-muted-foreground">(optional)</span></p>
            <select
              value={sourceType}
              onChange={e => setSourceType(e.target.value as SourceType)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">— Select source type —</option>
              <option value="estimator_verified">Estimator verified</option>
              <option value="architect_schedule">Architect sign schedule</option>
              <option value="as_built">As-built record</option>
            </select>
            <p className="text-xs text-muted-foreground">Indicates the authority level of this takeoff for accuracy tracking.</p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Link to job <span className="font-normal text-muted-foreground">(optional — enables delta analysis &amp; building type detection)</span></p>
            <select
              value={sourceJobId}
              onChange={e => setSourceJobId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">— No job linked —</option>
              {(jobsList ?? []).map(job => (
                <option key={job.id} value={job.id}>{job.name}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">Link to a processed job to see which rooms AI found vs. missed vs. added. Building type is auto-detected from the job.</p>
          </div>
        </div>

        {(uploadError || analyzeError) && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm space-y-1.5">
            <div className="flex items-start gap-2 text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="space-y-1 min-w-0">
                <p className="font-semibold leading-tight">
                  {uploadError ? "Upload failed" : "Analysis failed"}
                </p>
                <p className="text-destructive/90 leading-snug break-words">
                  {uploadError || analyzeError}
                </p>
                {((uploadError || analyzeError)?.includes("Sign Type") || (uploadError || analyzeError)?.includes("Failed to read spreadsheet")) && (
                  <p className="text-xs text-destructive/70 pt-0.5">
                    Tip: Convert to tall format — one row per sign type:
                    Sign Type | Room # | Room Name | Level
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between pt-1">
          <div className="text-xs text-muted-foreground space-y-1">
            <p>The system applies rule-based predictions and shows where they differ from your historical data.</p>
            {sourceJobId ? (
              <p className="text-primary/70 font-medium">A job is linked — the review will also show which rooms AI found vs. missed vs. added.</p>
            ) : (
              <p>You confirm which differences to add as training corrections — nothing is saved until you approve.</p>
            )}
          </div>
          <Button
            onClick={handleAnalyze}
            disabled={!xlsxFile || isUploading || isAnalyzing}
            className="flex items-center gap-2 ml-4 shrink-0"
          >
            {isUploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Uploading...
              </>
            ) : isAnalyzing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <ArrowRight className="h-4 w-4" />
                Analyze &amp; Review
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
    <ImportHistorySection />
    </>
  );
}

function ImportHistorySection() {
  const { data, isLoading } = useQuery<Array<{
    id: string;
    filename: string;
    importedAt: string;
    rowsParsed: number;
    rowsSaved: number;
    rowsSkipped: number;
    status: string;
  }>>({
    queryKey: ["/api/training/import-history"],
    queryFn: () => customFetch("/api/training/import-history"),
    staleTime: 30_000,
  });

  const fmt = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit",
      }).format(new Date(iso));
    } catch { return iso; }
  };

  if (!isLoading && (!Array.isArray(data) || data.length === 0)) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Import History</CardTitle>
        <CardDescription className="text-xs">Last 20 imports for this account.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="px-6 py-4 text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading history…
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Date</th>
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Filename</th>
                  <th className="px-4 py-2 text-right font-medium text-muted-foreground">Saved</th>
                  <th className="px-4 py-2 text-right font-medium text-muted-foreground">Skipped</th>
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((row) => (
                  <tr key={row.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">{fmt(row.importedAt)}</td>
                    <td className="px-4 py-2 max-w-[200px] truncate font-medium" title={row.filename}>{row.filename}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{row.rowsSaved}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{row.rowsSkipped}</td>
                    <td className="px-4 py-2">
                      <span className={
                        row.status === "success" ? "text-green-600 font-medium" :
                        row.status === "partial" ? "text-amber-600 font-medium" :
                        "text-muted-foreground"
                      }>
                        {row.status === "success" ? "Success" :
                         row.status === "partial" ? "Partial" :
                         row.status === "no_changes" ? "No changes" : row.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TrainingSettingsTab({ overwriteThreshold, onPendingThresholdChange }: { overwriteThreshold: number; onPendingThresholdChange: (v: number | null) => void }) {
  const { isAdmin, isResolved: roleResolved } = useIsAdmin();
  const { data: tenant } = useGetTenant();
  const updateTenant = useUpdateTenant();
  const queryClient = useQueryClient();
  const [inputValue, setInputValue] = useState(String(overwriteThreshold));
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const parsedValue = parseInt(inputValue, 10);
  const isValid = !isNaN(parsedValue) && parsedValue >= 1 && parsedValue <= 10000;
  const isDirty = parsedValue !== overwriteThreshold;

  useEffect(() => {
    if (isValid && isDirty) {
      onPendingThresholdChange(parsedValue);
    } else {
      onPendingThresholdChange(null);
    }
  }, [parsedValue, isValid, isDirty, onPendingThresholdChange]);

  async function handleSave() {
    if (!isValid || !isAdmin) return;
    setIsSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const existingSettings = (tenant?.settings as Record<string, unknown>) ?? {};
      await updateTenant.mutateAsync({
        data: { settings: { ...existingSettings, overwriteThreshold: parsedValue } },
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/tenant"] });
      onPendingThresholdChange(null);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Training Settings</CardTitle>
        <CardDescription>Configure safety limits and behavior for the training import workflow.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 max-w-lg">
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="overwrite-threshold">
            Overwrite Warning Threshold
          </label>
          <p className="text-xs text-muted-foreground">
            Show a warning banner in the Import tab when more than this many corrections are selected in <strong>Update</strong> mode. This helps prevent accidental bulk overwrites of existing training data. Defaults to {DEFAULT_OVERWRITE_THRESHOLD}.
          </p>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Current active limit:</span>
            <span className="font-semibold tabular-nums">{overwriteThreshold}</span>
            <span className="text-muted-foreground">correction{overwriteThreshold !== 1 ? "s" : ""}</span>
          </div>
          <div className="flex items-center gap-3">
            <Input
              id="overwrite-threshold"
              type="number"
              min={1}
              max={10000}
              value={inputValue}
              onChange={e => { setInputValue(e.target.value); setSaveSuccess(false); setSaveError(null); }}
              className="w-32"
              disabled={!roleResolved || !isAdmin}
            />
            {roleResolved && isAdmin && (
              <Button
                onClick={handleSave}
                disabled={!isValid || !isDirty || isSaving}
                size="sm"
                className="flex items-center gap-2"
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save
              </Button>
            )}
            {!roleResolved && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </div>
          {isValid && isDirty && (
            <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-600" />
              <span>
                <span className="font-medium">Preview:</span> With this limit, the warning banner in the Import tab will appear when more than <span className="font-semibold">{parsedValue}</span> correction{parsedValue !== 1 ? "s" : ""} would be overwritten (currently {overwriteThreshold}). Save to apply.
              </span>
            </div>
          )}
          {roleResolved && !isAdmin && (
            <p className="text-xs text-muted-foreground">Only owners can change this setting.</p>
          )}
          {roleResolved && isAdmin && !isValid && inputValue !== "" && (
            <p className="text-xs text-red-600">Enter a whole number between 1 and 10,000.</p>
          )}
          {saveSuccess && (
            <div className="flex items-center gap-2 text-sm text-green-700">
              <CheckCircle2 className="h-4 w-4" />
              Threshold saved successfully.
            </div>
          )}
          {saveError && (
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="h-4 w-4" />
              {saveError}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Patterns Tab
// ---------------------------------------------------------------------------

interface TrainingPatternRow {
  id: string;
  patternType: string;
  description: string;
  evidenceCount: number;
  exampleJobIds: string[];
  suggestedFix: string | null;
  status: string;
  accuracyImpactEstimate: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  deployedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type PatternStatus = "all" | "detected" | "reviewed" | "approved" | "deployed" | "dismissed";
type PatternSort = "evidence" | "created";

function patternTypeBadge(type: string) {
  if (type === "ai_missed") return <Badge className="bg-red-900/40 text-red-300 border-red-700 text-[10px]">AI Missed</Badge>;
  if (type === "sign_type_mismatch") return <Badge className="bg-amber-900/40 text-amber-300 border-amber-700 text-[10px]">Sign Mismatch</Badge>;
  if (type === "ai_extra") return <Badge className="bg-blue-900/40 text-blue-300 border-blue-700 text-[10px]">AI Extra</Badge>;
  return <Badge variant="outline" className="text-[10px]">{type}</Badge>;
}

function patternStatusBadge(status: string) {
  if (status === "detected") return <Badge variant="outline" className="text-gray-400 border-gray-600 text-[10px]">Detected</Badge>;
  if (status === "reviewed") return <Badge className="bg-blue-900/40 text-blue-300 border-blue-700 text-[10px]">Reviewed</Badge>;
  if (status === "approved") return <Badge className="bg-emerald-900/40 text-emerald-300 border-emerald-700 text-[10px]">Approved</Badge>;
  if (status === "deployed") return <Badge className="bg-purple-900/40 text-purple-300 border-purple-700 text-[10px]">Deployed</Badge>;
  if (status === "dismissed") return <Badge variant="outline" className="text-muted-foreground/50 border-muted-foreground/30 line-through text-[10px]">Dismissed</Badge>;
  return <Badge variant="outline" className="text-[10px]">{status}</Badge>;
}

function PatternsTab() {
  const [patterns, setPatterns] = useState<TrainingPatternRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [lastRun, setLastRun] = useState<Date | null>(null);
  const [analyzeResult, setAnalyzeResult] = useState<{ newPatterns: number; updatedPatterns: number; totalPatterns: number } | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<PatternStatus>("all");
  const [sortBy, setSortBy] = useState<PatternSort>("evidence");
  const [expandedFix, setExpandedFix] = useState<Set<string>>(new Set());
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployProgress, setDeployProgress] = useState<{ done: number; total: number } | null>(null);
  const [tick, setTick] = useState(0);

  const fetchPatterns = useCallback(async (status?: PatternStatus) => {
    setLoading(true);
    try {
      const qs = status && status !== "all" ? `?status=${status}` : "";
      const rows = await customFetch<TrainingPatternRow[]>(`/api/training/patterns${qs}`);
      setPatterns(rows);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPatterns(statusFilter);
  }, [fetchPatterns, statusFilter]);

  // tick every minute so lastRunLabel re-renders
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60000);
    return () => clearInterval(id);
  }, []);

  const lastRunLabel = useMemo(() => {
    void tick;
    if (!lastRun) return null;
    const diffMs = Date.now() - lastRun.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin === 1) return "1 minute ago";
    return `${diffMin} minutes ago`;
  }, [lastRun, tick]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setAnalyzeError(null);
    setAnalyzeResult(null);
    try {
      const result = await customFetch<{ newPatterns: number; updatedPatterns: number; totalPatterns: number }>(
        "/api/training/patterns/analyze",
        { method: "POST" }
      );
      setAnalyzeResult(result);
      setLastRun(new Date());
      await fetchPatterns(statusFilter);
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleDeployAll = async () => {
    const approved = patterns.filter(p => p.status === "approved");
    if (approved.length === 0) return;
    setDeploying(true);
    setDeployProgress({ done: 0, total: approved.length });
    try {
      for (let i = 0; i < approved.length; i++) {
        await customFetch<TrainingPatternRow>(`/api/training/patterns/${approved[i].id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "deployed" }),
        });
        setDeployProgress({ done: i + 1, total: approved.length });
      }
      await fetchPatterns(statusFilter);
    } catch {
      toast.error("Failed to deploy one or more patterns");
    } finally {
      setDeploying(false);
      setDeployProgress(null);
    }
  };

  const handleAction = async (patternId: string, status: string) => {
    setActionLoading(patternId + status);
    try {
      const updated = await customFetch<TrainingPatternRow>(`/api/training/patterns/${patternId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      setPatterns(prev => prev.map(p => p.id === patternId ? updated : p));
    } catch {
      toast.error("Failed to update pattern status");
    } finally {
      setActionLoading(null);
    }
  };

  const toggleFixExpand = (id: string) => {
    setExpandedFix(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const sorted = useMemo(() => {
    return [...patterns].sort((a, b) => {
      if (sortBy === "evidence") return b.evidenceCount - a.evidenceCount;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [patterns, sortBy]);

  return (
    <div className="space-y-6">
      {/* Run Analysis header */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Pattern Detection</CardTitle>
          <CardDescription className="text-xs">
            Scans all confirmed training corrections and groups them into systematic patterns for review.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-4">
            <Button
              onClick={() => void handleAnalyze()}
              disabled={analyzing || deploying}
              className="bg-emerald-700 hover:bg-emerald-600 text-white"
            >
              {analyzing ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Analyzing…</>
              ) : (
                <>Run Analysis</>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => void handleDeployAll()}
              disabled={deploying || analyzing || patterns.filter(p => p.status === "approved").length === 0}
            >
              {deploying && deployProgress ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Deploying {deployProgress.done} / {deployProgress.total}…</>
              ) : (
                <>Deploy All Approved{patterns.filter(p => p.status === "approved").length > 0 ? ` (${patterns.filter(p => p.status === "approved").length})` : ""}</>
              )}
            </Button>
            {lastRunLabel && (
              <span className="text-xs text-muted-foreground">Last run: {lastRunLabel}</span>
            )}
            {analyzeResult && !analyzing && (
              <span className="text-xs text-emerald-400">
                Found {analyzeResult.newPatterns} new pattern{analyzeResult.newPatterns !== 1 ? "s" : ""},
                updated {analyzeResult.updatedPatterns} existing
              </span>
            )}
            {analyzeError && (
              <span className="text-xs text-red-400 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />{analyzeError}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Status:</span>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as PatternStatus)}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="all">All</option>
            <option value="detected">Detected</option>
            <option value="reviewed">Reviewed</option>
            <option value="approved">Approved</option>
            <option value="deployed">Deployed</option>
            <option value="dismissed">Dismissed</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Sort by:</span>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value as PatternSort)}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="evidence">Evidence Count</option>
            <option value="created">Created Date</option>
          </select>
        </div>
      </div>

      {/* Patterns table */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
          <TrendingUp className="h-10 w-10 text-muted-foreground/30" />
          <p className="text-sm font-medium text-muted-foreground">No patterns detected yet.</p>
          <p className="text-xs text-muted-foreground/70">Run Analysis to scan your training data.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">Pattern Type</th>
                <th className="px-3 py-2 text-left font-medium">Description</th>
                <th className="px-3 py-2 text-center font-medium w-16">Evidence</th>
                <th className="px-3 py-2 text-left font-medium max-w-xs">Suggested Fix</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map(p => (
                <tr key={p.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-3 align-top whitespace-nowrap">
                    {patternTypeBadge(p.patternType)}
                  </td>
                  <td className="px-3 py-3 align-top">
                    <span className="text-foreground">{p.description}</span>
                  </td>
                  <td className="px-3 py-3 align-top text-center">
                    <span className="font-bold text-sm text-foreground">{p.evidenceCount}</span>
                  </td>
                  <td className="px-3 py-3 align-top max-w-xs">
                    {p.suggestedFix ? (
                      <div>
                        <p className={`text-muted-foreground leading-relaxed ${expandedFix.has(p.id) ? "" : "line-clamp-2"}`}>
                          {p.suggestedFix}
                        </p>
                        {p.suggestedFix.length > 80 && (
                          <button
                            onClick={() => toggleFixExpand(p.id)}
                            className="text-[10px] text-emerald-400 hover:underline mt-0.5"
                          >
                            {expandedFix.has(p.id) ? "Show less" : "Show more"}
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 align-top whitespace-nowrap">
                    {patternStatusBadge(p.status)}
                  </td>
                  <td className="px-3 py-3 align-top">
                    <div className="flex flex-wrap gap-1">
                      {p.status === "detected" && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[10px] text-blue-300 border-blue-700 hover:bg-blue-900/30"
                            disabled={actionLoading !== null}
                            onClick={() => void handleAction(p.id, "reviewed")}
                          >
                            {actionLoading === p.id + "reviewed" ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : "Mark Reviewed"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[10px] text-red-300 border-red-700 hover:bg-red-900/30"
                            disabled={actionLoading !== null}
                            onClick={() => void handleAction(p.id, "dismissed")}
                          >
                            {actionLoading === p.id + "dismissed" ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : "Dismiss"}
                          </Button>
                        </>
                      )}
                      {p.status === "reviewed" && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[10px] text-emerald-300 border-emerald-700 hover:bg-emerald-900/30"
                            disabled={actionLoading !== null}
                            onClick={() => void handleAction(p.id, "approved")}
                          >
                            {actionLoading === p.id + "approved" ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : "Approve"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[10px] text-red-300 border-red-700 hover:bg-red-900/30"
                            disabled={actionLoading !== null}
                            onClick={() => void handleAction(p.id, "dismissed")}
                          >
                            {actionLoading === p.id + "dismissed" ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : "Dismiss"}
                          </Button>
                        </>
                      )}
                      {p.status === "approved" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[10px] text-purple-300 border-purple-700 hover:bg-purple-900/30"
                          disabled={actionLoading !== null}
                          onClick={() => void handleAction(p.id, "deployed")}
                        >
                          {actionLoading === p.id + "deployed" ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : "Mark Deployed"}
                        </Button>
                      )}
                      {(p.status === "deployed" || p.status === "dismissed") && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[10px] text-muted-foreground border-border hover:bg-muted"
                          disabled={actionLoading !== null}
                          onClick={() => void handleAction(p.id, "detected")}
                        >
                          {actionLoading === p.id + "detected" ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : "Reset"}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
