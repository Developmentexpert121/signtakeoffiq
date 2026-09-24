import { useState, useRef } from "react";
import { usePersistedState } from "@/hooks/usePersistedState";
import { toast } from "sonner";
import {
  useGetTenant,
  useUpdateTenant,
  useListTenantUsers,
  useGetGuestCleanupStats,
  useRunGuestCleanup,
  getGetGuestCleanupStatsQueryKey,
  getGetTenantQueryKey,
  useGetServerConfig,
  usePatchAdminConfig,
  getGetServerConfigQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Settings, Trash2, ScanSearch, Building2, Plus, X, Download, ChevronDown, ChevronRight } from "lucide-react";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useQueryClient } from "@tanstack/react-query";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const DATE_RANGE_STORAGE_KEY = "admin-cleanup-chart-date-range";
const RETRY_TIMEOUT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const CLAUDE_VISION_MAX_DELAY_MS = 64_000; // mirrors pipeline.ts cap

/**
 * Compute the worst-case total retry wait time (no jitter), mirroring the
 * exponential back-off logic in callClaudeVision in pipeline.ts.
 * (delay doubles each attempt, capped at CLAUDE_VISION_MAX_DELAY_MS;
 *  no wait occurs after the final failed attempt.)
 */
function computeMaxRetryWaitMs(baseDelayMs: number, maxRetries: number): number {
  const effectiveMaxRetries = Math.max(1, maxRetries);
  let total = 0;
  let delay = baseDelayMs;
  for (let attempt = 1; attempt < effectiveMaxRetries; attempt++) {
    total += Math.min(delay, CLAUDE_VISION_MAX_DELAY_MS);
    delay = Math.min(delay * 2, CLAUDE_VISION_MAX_DELAY_MS);
  }
  return total;
}

const HISTORY_DATE_RANGE_STORAGE_KEY = "admin-run-history-date-range";
const HISTORY_RANGE_MODE_STORAGE_KEY = "admin-run-history-range-mode";

const BASE_RULES_PROFILES: { value: string; label: string }[] = [
  { value: "commercial", label: "Commercial" },
  { value: "residential", label: "Residential" },
  { value: "school", label: "School" },
  { value: "hospital", label: "Hospital" },
  { value: "hotel", label: "Hotel" },
  { value: "retail", label: "Retail" },
  { value: "warehouse", label: "Warehouse" },
  { value: "lab", label: "Lab" },
  { value: "bank", label: "Bank" },
  { value: "government", label: "Government" },
  { value: "church", label: "Church" },
  { value: "senior-living", label: "Senior Living" },
  { value: "mixed", label: "Mixed" },
];

function toDateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getDefaultStartDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return toDateInputValue(d);
}


function getStoredHistoryRangeMode(): number | "all" | "custom" | null {
  try {
    const stored = localStorage.getItem(HISTORY_RANGE_MODE_STORAGE_KEY);
    if (stored === "all" || stored === "custom") return stored;
    const num = Number(stored);
    if (!isNaN(num) && stored !== null && stored !== "") return num;
  } catch {
    // ignore
  }
  return null;
}

function getMatchingHistoryPreset(range: { start: string; end: string }): number | "all" | "custom" {
  if (!range.start) return "all";
  const today = toDateInputValue(new Date());
  if (range.end === today) {
    for (const days of [7, 30]) {
      const d = new Date();
      d.setDate(d.getDate() - days);
      if (range.start === toDateInputValue(d)) return days;
    }
  }
  return "custom";
}

function getMatchingPreset(range: { start: string; end: string }): number | null {
  const today = toDateInputValue(new Date());
  if (range.end !== today) return null;
  for (const days of [7, 30, 90]) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    if (range.start === toDateInputValue(d)) return days;
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

const AI_RETRY_DEFAULT = 5;
const AI_VISION_CALLS_DEFAULT = 10;
const AI_BASE_DELAY_DEFAULT = 5000;

export default function Admin() {
  const { isAdmin } = useIsAdmin();
  const { data: tenant, isLoading: loadingTenant } = useGetTenant();
  const { data: users, isLoading: loadingUsers } = useListTenantUsers();
  const queryClient = useQueryClient();

  const isDateRangeValue = (v: unknown): v is { start: string; end: string } =>
    typeof (v as Record<string, unknown>)?.start === "string" &&
    typeof (v as Record<string, unknown>)?.end === "string";

  const [dateRange, setDateRange, clearDateRange] = usePersistedState<{ start: string; end: string }>(
    DATE_RANGE_STORAGE_KEY,
    { start: getDefaultStartDate(), end: toDateInputValue(new Date()) },
    isDateRangeValue
  );
  const [historyDateRange, setHistoryDateRange, clearHistoryDateRange] = usePersistedState<{ start: string; end: string }>(
    HISTORY_DATE_RANGE_STORAGE_KEY,
    { start: getDefaultStartDate(), end: toDateInputValue(new Date()) },
    isDateRangeValue
  );
  const [activePreset, setActivePreset] = useState<number | null>(() => getMatchingPreset(dateRange));
  const [activeHistoryPreset, setActiveHistoryPreset] = useState<number | "all" | "custom">(
    () => getStoredHistoryRangeMode() ?? getMatchingHistoryPreset(historyDateRange)
  );

  const isDateRangeCustom =
    dateRange.start !== getDefaultStartDate() || dateRange.end !== toDateInputValue(new Date());

  function handleDateRangeChange(field: "start" | "end", value: string) {
    const next = { ...dateRange, [field]: value };
    setDateRange(next);
    setActivePreset(null);
  }

  function handlePresetSelect(days: number) {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    const next = { start: toDateInputValue(start), end: toDateInputValue(end) };
    setDateRange(next);
    setActivePreset(days);
  }

  function handleDateRangeReset() {
    clearDateRange({ start: getDefaultStartDate(), end: toDateInputValue(new Date()) });
  }


  const tenantSettings = (tenant?.settings ?? {}) as Record<string, unknown>;
  const storedRetryMax = typeof tenantSettings.aiRetryMax === "number" ? tenantSettings.aiRetryMax : AI_RETRY_DEFAULT;
  const [retryInput, setRetryInput] = useState<string | null>(null);
  const retryValue = retryInput ?? String(storedRetryMax);

  const storedBaseDelay = typeof tenantSettings.aiBaseDelayMs === "number" ? tenantSettings.aiBaseDelayMs : AI_BASE_DELAY_DEFAULT;
  const [baseDelayInput, setBaseDelayInput] = useState<string | null>(null);
  const baseDelayValue = baseDelayInput ?? String(storedBaseDelay);

  const [visionCapInput, setVisionCapInput] = useState<string | null>(null);

  const LOW_CONFIDENCE_DEFAULT = 70;
  const storedLowConfidence = typeof tenantSettings.lowConfidenceThreshold === "number" ? tenantSettings.lowConfidenceThreshold : LOW_CONFIDENCE_DEFAULT;
  const [lowConfidenceInput, setLowConfidenceInput] = useState<string | null>(null);
  const lowConfidenceValue = lowConfidenceInput ?? String(storedLowConfidence);

  const storedCustomBuildingTypes: string[] = Array.isArray(tenantSettings.customBuildingTypes)
    ? (tenantSettings.customBuildingTypes as string[])
    : [];
  const storedCustomBuildingTypeMappings: Record<string, string> =
    typeof tenantSettings.customBuildingTypeMappings === "object" &&
    tenantSettings.customBuildingTypeMappings !== null &&
    !Array.isArray(tenantSettings.customBuildingTypeMappings)
      ? (tenantSettings.customBuildingTypeMappings as Record<string, string>)
      : {};
  const storedStandardBuildingTypeMappings: Record<string, string> =
    typeof tenantSettings.standardBuildingTypeMappings === "object" &&
    tenantSettings.standardBuildingTypeMappings !== null &&
    !Array.isArray(tenantSettings.standardBuildingTypeMappings)
      ? (tenantSettings.standardBuildingTypeMappings as Record<string, string>)
      : {};
  const [newBuildingTypeInput, setNewBuildingTypeInput] = useState("");

  // Built-in keyword list visibility
  const [showBuiltIn, setShowBuiltIn] = useState(false);

  // Custom multi-entry room keywords state
  const storedKeywords: string[] = Array.isArray(tenantSettings.multiEntryRoomKeywords)
    ? (tenantSettings.multiEntryRoomKeywords as unknown[]).filter((k): k is string => typeof k === "string")
    : [];
  const [keywordDraft, setKeywordDraft] = useState<string[] | null>(null);
  const activeKeywords = keywordDraft ?? storedKeywords;
  const [keywordInput, setKeywordInput] = useState("");
  const keywordInputRef = useRef<HTMLInputElement>(null);

  const keywordsChanged =
    keywordDraft !== null &&
    JSON.stringify(keywordDraft) !== JSON.stringify(storedKeywords);

  function addKeyword() {
    const trimmed = keywordInput.trim();
    if (!trimmed || trimmed.length > 100) return;
    if (activeKeywords.some((k) => k.toLowerCase() === trimmed.toLowerCase())) return;
    setKeywordDraft([...activeKeywords, trimmed]);
    setKeywordInput("");
    keywordInputRef.current?.focus();
  }

  function removeKeyword(kw: string) {
    setKeywordDraft(activeKeywords.filter((k) => k !== kw));
  }

  function saveKeywords() {
    updateTenant({ data: { settings: { ...tenantSettings, multiEntryRoomKeywords: activeKeywords } } });
  }

  const { mutate: updateTenant, isPending: savingTenant } = useUpdateTenant({
    mutation: {
      onSuccess: (updatedTenant) => {
        queryClient.setQueryData(getGetTenantQueryKey(), updatedTenant);
        queryClient.invalidateQueries({ queryKey: getGetTenantQueryKey() });
        setRetryInput(null);
        setBaseDelayInput(null);
        setVisionCapInput(null);
        setLowConfidenceInput(null);
        setNewBuildingTypeInput("");
        setKeywordDraft(null);
        toast.success("Settings saved.");
      },
      onError: (err: unknown) => {
        const message =
          err &&
          typeof err === "object" &&
          "response" in err &&
          err.response &&
          typeof err.response === "object" &&
          "data" in err.response &&
          err.response.data &&
          typeof err.response.data === "object" &&
          "error" in err.response.data &&
          typeof (err.response.data as Record<string, unknown>).error === "string"
            ? (err.response.data as Record<string, string>).error
            : "Failed to save settings.";
        toast.error(message);
      },
    },
  });

  function saveRetryMax() {
    const parsed = parseInt(retryValue, 10);
    if (isNaN(parsed) || parsed < 0 || parsed > 10) return;
    if (baseDelayValid && computeMaxRetryWaitMs(baseDelayParsed, parsed) > RETRY_TIMEOUT_THRESHOLD_MS) return;
    updateTenant({ data: { settings: { ...tenantSettings, aiRetryMax: parsed } } });
  }

  function saveBaseDelay() {
    const parsed = parseInt(baseDelayValue, 10);
    if (isNaN(parsed) || parsed < 500 || parsed > 30000) return;
    if (retryValid && computeMaxRetryWaitMs(parsed, retryParsed) > RETRY_TIMEOUT_THRESHOLD_MS) return;
    updateTenant({ data: { settings: { ...tenantSettings, aiBaseDelayMs: parsed } } });
  }

  function saveVisionCap() {
    const parsed = parseInt(visionCapValue, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 500) return;
    updateTenant({ data: { settings: { ...tenantSettings, aiVisionCallsPerRun: parsed } } });
  }

  function saveLowConfidenceThreshold() {
    const parsed = parseInt(lowConfidenceValue, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 99) return;
    updateTenant({ data: { settings: { ...tenantSettings, lowConfidenceThreshold: parsed } } });
  }

  const lowConfidenceParsed = parseInt(lowConfidenceValue, 10);
  const lowConfidenceValid = !isNaN(lowConfidenceParsed) && lowConfidenceParsed >= 1 && lowConfidenceParsed <= 99;
  const lowConfidenceChanged = lowConfidenceParsed !== storedLowConfidence;

  const retryParsed = parseInt(retryValue, 10);
  const retryValid = !isNaN(retryParsed) && retryParsed >= 0 && retryParsed <= 10;
  const retryChanged = retryParsed !== storedRetryMax;

  function addCustomBuildingType() {
    const trimmed = newBuildingTypeInput.trim();
    if (!trimmed) return;
    if (storedCustomBuildingTypes.some((t) => t.toLowerCase() === trimmed.toLowerCase())) {
      toast.error("That building type already exists.");
      return;
    }
    updateTenant({
      data: { settings: { ...tenantSettings, customBuildingTypes: [...storedCustomBuildingTypes, trimmed] } },
    });
  }

  function removeCustomBuildingType(type: string) {
    const nextMappings = { ...storedCustomBuildingTypeMappings };
    delete nextMappings[type];
    updateTenant({
      data: {
        settings: {
          ...tenantSettings,
          customBuildingTypes: storedCustomBuildingTypes.filter((t) => t !== type),
          customBuildingTypeMappings: nextMappings,
        },
      },
    });
  }

  function updateCustomBuildingTypeMapping(type: string, profile: string) {
    const nextMappings = { ...storedCustomBuildingTypeMappings };
    if (profile) {
      nextMappings[type] = profile;
    } else {
      delete nextMappings[type];
    }
    updateTenant({
      data: {
        settings: {
          ...tenantSettings,
          customBuildingTypeMappings: nextMappings,
        },
      },
    });
  }

  function updateStandardBuildingTypeMapping(type: string, profile: string) {
    const nextMappings = { ...storedStandardBuildingTypeMappings };
    if (profile) {
      nextMappings[type] = profile;
    } else {
      delete nextMappings[type];
    }
    updateTenant({
      data: {
        settings: {
          ...tenantSettings,
          standardBuildingTypeMappings: nextMappings,
        },
      },
    });
  }

  const baseDelayParsed = parseInt(baseDelayValue, 10);
  const baseDelayValid = !isNaN(baseDelayParsed) && baseDelayParsed >= 500 && baseDelayParsed <= 30000;
  const baseDelayChanged = baseDelayParsed !== storedBaseDelay;

  const retryTimeoutWarning =
    baseDelayValid &&
    retryValid &&
    computeMaxRetryWaitMs(baseDelayParsed, retryParsed) > RETRY_TIMEOUT_THRESHOLD_MS;

  const {
    data: serverConfig,
    isLoading: loadingServerConfig,
  } = useGetServerConfig({ query: { retry: false, enabled: isAdmin, queryKey: getGetServerConfigQueryKey() } });

  const serverVisionDefault = serverConfig?.maxAiVisionCallsPerRun ?? AI_VISION_CALLS_DEFAULT;
  const storedVisionCap = typeof tenantSettings.aiVisionCallsPerRun === "number" ? tenantSettings.aiVisionCallsPerRun : serverVisionDefault;

  const [maxAgeDaysInput, setMaxAgeDaysInput] = useState<string | null>(null);
  const [maxRowsInput, setMaxRowsInput] = useState<string | null>(null);

  const serverMaxAgeDays = serverConfig?.cleanupHistoryMaxAgeDays ?? 90;
  const serverMaxRows = serverConfig?.cleanupHistoryMaxRows ?? 1000;

  const maxAgeDaysValue = maxAgeDaysInput ?? String(serverMaxAgeDays);
  const maxRowsValue = maxRowsInput ?? String(serverMaxRows);

  const maxAgeDaysParsed = parseInt(maxAgeDaysValue, 10);
  const maxAgeDaysValid = !isNaN(maxAgeDaysParsed) && maxAgeDaysParsed >= 1 && maxAgeDaysParsed <= 3650;
  const maxAgeDaysChanged = maxAgeDaysParsed !== serverMaxAgeDays;

  const maxRowsParsed = parseInt(maxRowsValue, 10);
  const maxRowsValid = !isNaN(maxRowsParsed) && maxRowsParsed >= 1 && maxRowsParsed <= 100000;
  const maxRowsChanged = maxRowsParsed !== serverMaxRows;

  const { mutate: patchAdminConfig, isPending: savingConfig } = usePatchAdminConfig({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetServerConfigQueryKey() });
        setMaxAgeDaysInput(null);
        setMaxRowsInput(null);
        toast.success("Retention settings saved.");
      },
      onError: (err: unknown) => {
        const message =
          err &&
          typeof err === "object" &&
          "response" in err &&
          err.response &&
          typeof err.response === "object" &&
          "data" in err.response &&
          err.response.data &&
          typeof err.response.data === "object" &&
          "error" in err.response.data &&
          typeof (err.response.data as Record<string, unknown>).error === "string"
            ? (err.response.data as Record<string, string>).error
            : "Failed to save retention settings.";
        toast.error(message);
      },
    },
  });

  function saveMaxAgeDays() {
    if (!maxAgeDaysValid || !maxAgeDaysChanged) return;
    patchAdminConfig({ data: { cleanupHistoryMaxAgeDays: maxAgeDaysParsed } });
  }

  function saveMaxRows() {
    if (!maxRowsValid || !maxRowsChanged) return;
    patchAdminConfig({ data: { cleanupHistoryMaxRows: maxRowsParsed } });
  }
  const visionCapValue = visionCapInput ?? String(storedVisionCap);
  const visionCapParsed = parseInt(visionCapValue, 10);
  const visionCapValid = !isNaN(visionCapParsed) && visionCapParsed >= 1 && visionCapParsed <= 500;
  const visionCapChanged = visionCapParsed !== storedVisionCap;

  const {
    data: cleanupStats,
    isLoading: loadingCleanupStats,
  } = useGetGuestCleanupStats({ query: { retry: false, enabled: isAdmin, queryKey: getGetGuestCleanupStatsQueryKey() } });

  const { mutate: runCleanup, isPending: runningCleanup } = useRunGuestCleanup({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetGuestCleanupStatsQueryKey() });
      },
    },
  });

  const lastRun = cleanupStats?.lastRun;

  const allChartData = (cleanupStats?.history ?? []).map((run) => ({
    ranAt: run.ranAt,
    date: new Date(run.ranAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    bytesRecovered: run.bytesRecovered,
    sessions: run.tenantsDeleted,
  }));

  const chartData = allChartData.filter((run) => {
    const runDate = run.ranAt.slice(0, 10);
    return (
      (!dateRange.start || runDate >= dateRange.start) &&
      (!dateRange.end || runDate <= dateRange.end)
    );
  });

  function handleHistoryDateRangeChange(field: "start" | "end", value: string) {
    const next = { ...historyDateRange, [field]: value };
    setHistoryDateRange(next);
    setActiveHistoryPreset("custom");
    try {
      localStorage.setItem(HISTORY_RANGE_MODE_STORAGE_KEY, "custom");
    } catch {
      // ignore
    }
  }

  function handleHistoryPresetSelect(days: number | null) {
    const end = toDateInputValue(new Date());
    let start = "";
    if (days !== null) {
      const d = new Date();
      d.setDate(d.getDate() - days);
      start = toDateInputValue(d);
    }
    const next = { start, end };
    const mode: number | "all" = days === null ? "all" : days;
    setHistoryDateRange(next);
    setActiveHistoryPreset(mode);
    try {
      localStorage.setItem(HISTORY_RANGE_MODE_STORAGE_KEY, String(mode));
    } catch {
      // ignore
    }
  }

  function handleHistoryDateRangeReset() {
    const freshDefault = { start: getDefaultStartDate(), end: toDateInputValue(new Date()) };
    clearHistoryDateRange(freshDefault);
    setActiveHistoryPreset(getMatchingHistoryPreset(freshDefault));
    try {
      localStorage.removeItem(HISTORY_RANGE_MODE_STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  function exportCleanupHistoryCSV() {
    const header = ["Date & Time", "Sessions", "Files", "Storage Freed", "Storage Freed (bytes)"];
    const rows = filteredHistory.map((run) => [
      new Date(run.ranAt).toLocaleString(),
      String(run.tenantsDeleted),
      String(run.filesDeleted),
      formatBytes(run.bytesRecovered),
      String(run.bytesRecovered),
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cleanup-history-${toDateInputValue(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const filteredHistory = (cleanupStats?.history ?? []).filter((run) => {
    const runDate = run.ranAt.slice(0, 10);
    return (
      (!historyDateRange.start || runDate >= historyDateRange.start) &&
      (!historyDateRange.end || runDate <= historyDateRange.end)
    );
  });

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8 max-w-[1200px] mx-auto w-full">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Owner Settings</h1>
        <p className="text-muted-foreground mt-1">Manage tenant configuration and users.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Tenant Settings
            </CardTitle>
            <CardDescription>Configure global preferences for your organization.</CardDescription>
          </CardHeader>
          <CardContent>
            {loadingTenant ? (
              <div className="flex justify-center p-4"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : tenant ? (
              <div className="space-y-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Tenant Name</p>
                  <p className="text-sm text-muted-foreground">{tenant.name}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">Plan</p>
                  <Badge variant="outline" className="uppercase">{tenant.plan}</Badge>
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">Joined</p>
                  <p className="text-sm text-muted-foreground">{new Date(tenant.createdAt).toLocaleDateString()}</p>
                </div>
                {isAdmin && (
                  <div className="space-y-2 pt-2 border-t">
                    <Label htmlFor="aiRetryMax" className="text-sm font-medium">
                      AI Retry Limit
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      How many times the AI will retry a failed call before giving up (0–10). Default is {AI_RETRY_DEFAULT}.
                    </p>
                    <div className="flex items-center gap-2">
                      <Input
                        id="aiRetryMax"
                        type="number"
                        min={0}
                        max={10}
                        step={1}
                        value={retryValue}
                        onChange={(e) => setRetryInput(e.target.value)}
                        className="w-24"
                      />
                      <Button
                        size="sm"
                        onClick={saveRetryMax}
                        disabled={savingTenant || !retryValid || !retryChanged || retryTimeoutWarning}
                      >
                        {savingTenant ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                      </Button>
                    </div>
                    {!retryValid && (
                      <p className="text-xs text-destructive">Enter a number between 0 and 10.</p>
                    )}
                    {retryTimeoutWarning && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        Warning: this combination could produce more than 5 minutes of total retry wait time. Reduce the retry limit or the base delay before saving.
                      </p>
                    )}
                  </div>
                )}
                {isAdmin && (
                  <div className="space-y-2 pt-2 border-t">
                    <Label htmlFor="aiBaseDelayMs" className="text-sm font-medium">
                      AI Retry Base Delay (ms)
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Initial back-off delay before the first AI retry (500–30 000 ms). Subsequent retries double the delay. Default is {AI_BASE_DELAY_DEFAULT} ms.
                    </p>
                    <div className="flex items-center gap-2">
                      <Input
                        id="aiBaseDelayMs"
                        type="number"
                        min={500}
                        max={30000}
                        step={500}
                        value={baseDelayValue}
                        onChange={(e) => setBaseDelayInput(e.target.value)}
                        className="w-28"
                      />
                      <Button
                        size="sm"
                        onClick={saveBaseDelay}
                        disabled={savingTenant || !baseDelayValid || !baseDelayChanged || retryTimeoutWarning}
                      >
                        {savingTenant ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                      </Button>
                    </div>
                    {!baseDelayValid && (
                      <p className="text-xs text-destructive">Enter a number between 500 and 30 000.</p>
                    )}
                    {retryTimeoutWarning && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        Warning: this combination could produce more than 5 minutes of total retry wait time. Reduce the base delay or the retry limit before saving.
                      </p>
                    )}
                  </div>
                )}
                {isAdmin && (
                  <div className="space-y-2 pt-2 border-t">
                    <Label htmlFor="aiVisionCallsPerRun" className="text-sm font-medium">
                      AI Vision Scan Limit
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Maximum number of AI vision scans per run (1–500). Server default is {serverVisionDefault}. Increase for larger projects or decrease to control costs.
                    </p>
                    <div className="flex items-center gap-2">
                      <Input
                        id="aiVisionCallsPerRun"
                        type="number"
                        min={1}
                        max={500}
                        step={1}
                        value={visionCapValue}
                        onChange={(e) => setVisionCapInput(e.target.value)}
                        className="w-24"
                      />
                      <Button
                        size="sm"
                        onClick={saveVisionCap}
                        disabled={savingTenant || !visionCapValid || !visionCapChanged}
                      >
                        {savingTenant ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                      </Button>
                    </div>
                    {!visionCapValid && (
                      <p className="text-xs text-destructive">Enter a number between 1 and 500.</p>
                    )}
                  </div>
                )}
                {isAdmin && (
                  <div className="space-y-2 pt-2 border-t">
                    <Label htmlFor="lowConfidenceThreshold" className="text-sm font-medium">
                      Low Confidence Threshold (%)
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      AI-detected rooms with a confidence score below this percentage are flagged as low confidence and shown in the review filter. Default is {LOW_CONFIDENCE_DEFAULT}%.
                    </p>
                    <div className="flex items-center gap-2">
                      <Input
                        id="lowConfidenceThreshold"
                        type="number"
                        min={1}
                        max={99}
                        step={1}
                        value={lowConfidenceValue}
                        onChange={(e) => setLowConfidenceInput(e.target.value)}
                        className="w-24"
                      />
                      <Button
                        size="sm"
                        onClick={saveLowConfidenceThreshold}
                        disabled={savingTenant || !lowConfidenceValid || !lowConfidenceChanged}
                      >
                        {savingTenant ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                      </Button>
                    </div>
                    {!lowConfidenceValid && (
                      <p className="text-xs text-destructive">Enter a whole number between 1 and 99.</p>
                    )}
                  </div>
                )}
                {isAdmin && (
                  <div className="space-y-2 pt-2 border-t">
                    <Label className="text-sm font-medium">
                      Multi-Entry Room Keywords
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Room names containing these keywords (in addition to the built-in list) will be flagged as multi-entry rooms and receive a quantity of 3 during rule evaluation. Changes take effect on the next scan run.
                    </p>

                    {/* Built-in keywords collapsible */}
                    <div className="rounded-md border border-dashed p-2">
                      <button
                        type="button"
                        onClick={() => setShowBuiltIn((v) => !v)}
                        className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        aria-expanded={showBuiltIn}
                      >
                        {showBuiltIn ? (
                          <ChevronDown className="h-3 w-3 shrink-0" />
                        ) : (
                          <ChevronRight className="h-3 w-3 shrink-0" />
                        )}
                        Built-in keywords
                        {serverConfig?.builtInMultiEntryKeywords && (
                          <span className="ml-0.5">({serverConfig.builtInMultiEntryKeywords.length})</span>
                        )}
                      </button>
                      {showBuiltIn && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {serverConfig?.builtInMultiEntryKeywords
                            ? serverConfig.builtInMultiEntryKeywords.map((kw) => (
                              <span
                                key={kw}
                                className="inline-flex items-center rounded-md bg-muted/50 px-2 py-0.5 text-xs font-medium text-muted-foreground"
                                title="Built-in keyword (read-only)"
                              >
                                {kw}
                              </span>
                            ))
                            : loadingServerConfig && (
                              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                            )
                          }
                        </div>
                      )}
                    </div>

                    {/* Custom keywords */}
                    {activeKeywords.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {activeKeywords.map((kw) => (
                          <span
                            key={kw}
                            className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-medium"
                          >
                            {kw}
                            <button
                              type="button"
                              onClick={() => removeKeyword(kw)}
                              className="text-muted-foreground hover:text-foreground"
                              aria-label={`Remove keyword ${kw}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <Input
                        ref={keywordInputRef}
                        placeholder="e.g. Assembly Hall"
                        value={keywordInput}
                        onChange={(e) => setKeywordInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); addKeyword(); }
                        }}
                        className="flex-1"
                        maxLength={100}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={addKeyword}
                        disabled={!keywordInput.trim()}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                    <Button
                      size="sm"
                      onClick={saveKeywords}
                      disabled={savingTenant || !keywordsChanged}
                    >
                      {savingTenant ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save Keywords"}
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Failed to load tenant details.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Users</CardTitle>
            <CardDescription>Manage access and roles for your team members.</CardDescription>
          </CardHeader>
          <CardContent>
            {loadingUsers ? (
              <div className="flex justify-center p-4"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : users && users.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Role</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map(user => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">{user.fullName || "Unnamed User"}</span>
                          <span className="text-xs text-muted-foreground">{user.email}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={user.role === 'admin' ? 'default' : 'secondary'} className="capitalize">
                          {user.role}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">No users found.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              Custom Building Types
            </CardTitle>
            <CardDescription>
              Add custom building type options to the dropdown on job forms. Override the rules profile for standard or custom types to control how signs are assigned.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingTenant ? (
              <div className="flex justify-center p-4"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Standard Types</p>
                  <p className="text-xs text-muted-foreground">Override the rules profile used for any standard building type.</p>
                  <div className="space-y-2">
                    {[
                      { value: "commercial", label: "Commercial Office" },
                      { value: "healthcare", label: "Healthcare / Hospital" },
                      { value: "education", label: "Education / University" },
                      { value: "residential", label: "Multi-Family Residential" },
                      { value: "retail", label: "Retail / Mall" },
                      { value: "industrial", label: "Industrial / Warehouse" },
                      { value: "other", label: "Other" },
                    ].map(({ value, label }) => (
                      <div key={value} className="flex items-center gap-2 flex-wrap">
                        <Badge variant="secondary" className="flex-shrink-0">{label}</Badge>
                        <span className="text-xs text-muted-foreground">→ rules profile:</span>
                        <select
                          value={storedStandardBuildingTypeMappings[value] ?? ""}
                          onChange={(e) => updateStandardBuildingTypeMapping(value, e.target.value)}
                          disabled={savingTenant}
                          className="text-sm border rounded-md px-2 py-1 bg-background disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-ring"
                          aria-label={`Rules profile override for ${label}`}
                        >
                          <option value="">Default</option>
                          {BASE_RULES_PROFILES.map((p) => (
                            <option key={p.value} value={p.value}>{p.label}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
                {storedCustomBuildingTypes.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Custom Types</p>
                    <div className="space-y-2">
                      {storedCustomBuildingTypes.map((type) => (
                        <div key={type} className="flex items-center gap-2 flex-wrap">
                          <div className="flex items-center gap-1 rounded-full border px-3 py-1 text-sm bg-background min-w-0">
                            <span className="truncate max-w-[160px]">{type}</span>
                            <button
                              onClick={() => removeCustomBuildingType(type)}
                              disabled={savingTenant}
                              className="ml-1 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50 flex-shrink-0"
                              aria-label={`Remove ${type}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                          <span className="text-xs text-muted-foreground">→ rules profile:</span>
                          <select
                            value={storedCustomBuildingTypeMappings[type] ?? ""}
                            onChange={(e) => updateCustomBuildingTypeMapping(type, e.target.value)}
                            disabled={savingTenant}
                            className="text-sm border rounded-md px-2 py-1 bg-background disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-ring"
                            aria-label={`Rules profile for ${type}`}
                          >
                            <option value="">Commercial (default)</option>
                            {BASE_RULES_PROFILES.filter((p) => p.value !== "commercial").map((p) => (
                              <option key={p.value} value={p.value}>{p.label}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2 pt-1">
                  <Input
                    placeholder="e.g. Education, Hospitality, Retail"
                    value={newBuildingTypeInput}
                    onChange={(e) => setNewBuildingTypeInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomBuildingType(); } }}
                    disabled={savingTenant}
                    className="max-w-xs"
                    maxLength={60}
                  />
                  <Button
                    size="sm"
                    onClick={addCustomBuildingType}
                    disabled={savingTenant || !newBuildingTypeInput.trim()}
                  >
                    {savingTenant ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plus className="h-4 w-4 mr-1" />Add</>}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScanSearch className="h-5 w-5" />
              AI Scan Configuration
            </CardTitle>
            <CardDescription>Active runtime settings controlling AI scan image quality and usage limits.</CardDescription>
          </CardHeader>
          <CardContent>
            {loadingServerConfig ? (
              <div className="flex justify-center p-4"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : serverConfig ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="rounded-lg border bg-muted/30 p-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">AI Provider</p>
                  <p className="text-xl font-bold">{serverConfig.aiProvider}</p>
                  <p className="text-xs text-muted-foreground mt-1">Service powering vision scans</p>
                </div>
                <div className="rounded-lg border bg-muted/30 p-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">AI Model</p>
                  <p className="text-xl font-bold font-mono">{serverConfig.aiModel}</p>
                  <p className="text-xs text-muted-foreground mt-1">Model used for all AI vision calls</p>
                </div>
                <div className="rounded-lg border bg-muted/30 p-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Rasterization DPI</p>
                  <p className="text-2xl font-bold">{serverConfig.rasterizeDpi}</p>
                  <p className="text-xs text-muted-foreground mt-1">Controls image quality for AI scanning (RASTERIZE_DPI)</p>
                </div>
                <div className="rounded-lg border bg-muted/30 p-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Max AI Vision Calls / Run</p>
                  <p className="text-2xl font-bold">{serverConfig.maxAiVisionCallsPerRun}</p>
                  <p className="text-xs text-muted-foreground mt-1">Per-job AI vision call cap (AI_VISION_CALLS_PER_RUN)</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Failed to load server configuration.</p>
            )}
          </CardContent>
        </Card>
      )}

      {isAdmin && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Trash2 className="h-5 w-5" />
                  Guest Session Cleanup
                </CardTitle>
                <CardDescription className="mt-1">
                  Expired guest sessions are purged automatically every hour, including all uploaded files. Run manually to free storage immediately.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => runCleanup()}
                disabled={runningCleanup || loadingCleanupStats}
              >
                {runningCleanup ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" />Running…</>
                ) : (
                  "Run Now"
                )}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {loadingCleanupStats ? (
              <div className="flex justify-center p-4">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="rounded-lg border bg-muted/30 p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Pending Expired Sessions</p>
                    <p className="text-2xl font-bold">{cleanupStats?.expiredGuestTenants ?? 0}</p>
                  </div>

                  <div className="rounded-lg border bg-muted/30 p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Files Deleted (last run)</p>
                    <p className="text-2xl font-bold">
                      {lastRun ? lastRun.filesDeleted.toLocaleString() : <span className="text-base text-muted-foreground">—</span>}
                    </p>
                  </div>

                  <div className="rounded-lg border bg-muted/30 p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Storage Recovered (last run)</p>
                    <p className="text-2xl font-bold">
                      {lastRun ? formatBytes(lastRun.bytesRecovered) : <span className="text-base text-muted-foreground">—</span>}
                    </p>
                  </div>
                </div>

                {lastRun ? (
                  <p className="text-sm text-muted-foreground">
                    <span className="font-medium">Last run:</span>{" "}
                    {new Date(lastRun.ranAt).toLocaleString()}
                    {" — "}
                    {lastRun.tenantsDeleted === 0
                      ? "No expired sessions found."
                      : `${lastRun.tenantsDeleted} guest session${lastRun.tenantsDeleted === 1 ? "" : "s"} removed.`}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No cleanup has run yet.
                  </p>
                )}

                <div className="pt-2 border-t space-y-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">History Retention</p>
                  <div className="space-y-2">
                    <Label htmlFor="cleanupHistoryMaxAgeDays" className="text-sm font-medium">
                      Max Age (days)
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Cleanup run records older than this number of days are pruned (1–3650).
                    </p>
                    <div className="flex items-center gap-2">
                      {loadingServerConfig ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : (
                        <>
                          <Input
                            id="cleanupHistoryMaxAgeDays"
                            type="number"
                            min={1}
                            max={3650}
                            step={1}
                            value={maxAgeDaysValue}
                            onChange={(e) => setMaxAgeDaysInput(e.target.value)}
                            className="w-28"
                          />
                          <Button
                            size="sm"
                            onClick={saveMaxAgeDays}
                            disabled={savingConfig || !maxAgeDaysValid || !maxAgeDaysChanged}
                          >
                            {savingConfig ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                          </Button>
                        </>
                      )}
                    </div>
                    {!maxAgeDaysValid && (
                      <p className="text-xs text-destructive">Enter a number between 1 and 3650.</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="cleanupHistoryMaxRows" className="text-sm font-medium">
                      Row Cap (rows)
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Maximum number of cleanup run records kept in history (1–100 000).
                    </p>
                    <div className="flex items-center gap-2">
                      {loadingServerConfig ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : (
                        <>
                          <Input
                            id="cleanupHistoryMaxRows"
                            type="number"
                            min={1}
                            max={100000}
                            step={1}
                            value={maxRowsValue}
                            onChange={(e) => setMaxRowsInput(e.target.value)}
                            className="w-28"
                          />
                          <Button
                            size="sm"
                            onClick={saveMaxRows}
                            disabled={savingConfig || !maxRowsValid || !maxRowsChanged}
                          >
                            {savingConfig ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                          </Button>
                        </>
                      )}
                    </div>
                    {!maxRowsValid && (
                      <p className="text-xs text-destructive">Enter a number between 1 and 100 000.</p>
                    )}
                  </div>
                </div>

                {allChartData.length > 1 && (
                  <div className="pt-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                      <div className="flex items-center gap-2">
                        <p className="text-xs text-muted-foreground uppercase tracking-wide">Storage Recovered per Run</p>
                        <span className="text-xs text-muted-foreground font-medium tabular-nums">
                          {chartData.length} {chartData.length === 1 ? "run" : "runs"}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-1">
                          {([7, 30, 90] as const).map((days) => (
                            <button
                              key={days}
                              type="button"
                              onClick={() => handlePresetSelect(days)}
                              className={
                                activePreset === days
                                  ? "text-xs border rounded px-2 py-1 transition-colors border-primary bg-primary text-primary-foreground font-medium"
                                  : "text-xs border border-border rounded px-2 py-1 bg-background text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                              }
                            >
                              {`Last ${days}d`}
                            </button>
                          ))}
                        </div>
                        <label className="text-xs text-muted-foreground">From</label>
                        <input
                          type="date"
                          value={dateRange.start}
                          max={dateRange.end || undefined}
                          onChange={(e) => handleDateRangeChange("start", e.target.value)}
                          className="text-xs border border-border rounded px-2 py-1 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        <label className="text-xs text-muted-foreground">To</label>
                        <input
                          type="date"
                          value={dateRange.end}
                          min={dateRange.start || undefined}
                          onChange={(e) => handleDateRangeChange("end", e.target.value)}
                          className="text-xs border border-border rounded px-2 py-1 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        <div className="relative inline-flex items-center">
                          <Button
                            variant={isDateRangeCustom ? "outline" : "ghost"}
                            size="sm"
                            onClick={handleDateRangeReset}
                            className={`text-xs h-7 px-2 ${isDateRangeCustom ? "border-blue-500 text-blue-600 hover:text-blue-700 hover:bg-blue-50" : ""}`}
                          >
                            Reset
                          </Button>
                          {isDateRangeCustom && (
                            <span className="absolute -top-1.5 -right-1.5 h-2.5 w-2.5 rounded-full bg-blue-500" />
                          )}
                        </div>
                      </div>
                    </div>
                    {chartData.length === 0 ? (
                      <div className="flex items-center justify-center h-[160px] text-sm text-muted-foreground">
                        No runs found in the selected date range.
                      </div>
                    ) : (
                      <ResponsiveContainer width="100%" height={160}>
                        <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                          <YAxis
                            tickFormatter={(v: number) => formatBytes(v)}
                            tick={{ fontSize: 11 }}
                            width={60}
                          />
                          <Tooltip
                            formatter={(value: number, name: string) => [
                              name === "bytesRecovered" ? formatBytes(value) : value,
                              name === "bytesRecovered" ? "Storage Recovered" : "Sessions Cleaned",
                            ]}
                            labelFormatter={(label: string) => `Run: ${label}`}
                          />
                          <Bar dataKey="bytesRecovered" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} name="bytesRecovered" />
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                )}

                {allChartData.length > 0 && (
                  <div className="pt-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                      <div className="flex items-center gap-2">
                        <p className="text-xs text-muted-foreground uppercase tracking-wide">Run History</p>
                        <span className="text-xs text-muted-foreground font-medium tabular-nums">
                          {filteredHistory.length} {filteredHistory.length === 1 ? "run" : "runs"}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={exportCleanupHistoryCSV}
                          disabled={filteredHistory.length === 0}
                          className="h-6 px-2 text-xs"
                        >
                          <Download className="h-3 w-3 mr-1" />
                          Export CSV
                        </Button>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-1">
                          {([7, 30] as const).map((days) => (
                            <button
                              key={days}
                              type="button"
                              onClick={() => handleHistoryPresetSelect(days)}
                              className={
                                activeHistoryPreset === days
                                  ? "text-xs border rounded px-2 py-1 transition-colors border-primary bg-primary text-primary-foreground font-medium"
                                  : "text-xs border border-border rounded px-2 py-1 bg-background text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                              }
                            >
                              {`Last ${days}d`}
                            </button>
                          ))}
                          <button
                            type="button"
                            onClick={() => handleHistoryPresetSelect(null)}
                            className={
                              activeHistoryPreset === "all"
                                ? "text-xs border rounded px-2 py-1 transition-colors border-primary bg-primary text-primary-foreground font-medium"
                                : "text-xs border border-border rounded px-2 py-1 bg-background text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                            }
                          >
                            All time
                          </button>
                        </div>
                        <label className="text-xs text-muted-foreground">From</label>
                        <input
                          type="date"
                          value={historyDateRange.start}
                          max={historyDateRange.end || undefined}
                          onChange={(e) => handleHistoryDateRangeChange("start", e.target.value)}
                          className="text-xs border border-border rounded px-2 py-1 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        <label className="text-xs text-muted-foreground">To</label>
                        <input
                          type="date"
                          value={historyDateRange.end}
                          min={historyDateRange.start || undefined}
                          onChange={(e) => handleHistoryDateRangeChange("end", e.target.value)}
                          className="text-xs border border-border rounded px-2 py-1 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleHistoryDateRangeReset}
                          className="text-xs h-7 px-2"
                        >
                          Reset
                        </Button>
                      </div>
                    </div>
                    {filteredHistory.length === 0 ? (
                      <div className="flex items-center justify-center h-16 text-sm text-muted-foreground border rounded-md">
                        No runs found in the selected range.
                      </div>
                    ) : (
                      <div className="max-h-64 overflow-y-auto rounded-md border">
                        <Table>
                          <TableHeader className="sticky top-0 bg-background z-10">
                            <TableRow>
                              <TableHead className="text-xs">Date & Time</TableHead>
                              <TableHead className="text-xs text-right">Sessions</TableHead>
                              <TableHead className="text-xs text-right">Files</TableHead>
                              <TableHead className="text-xs text-right">Storage Freed</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {filteredHistory.map((run, i) => (
                              <TableRow key={i}>
                                <TableCell className="text-xs tabular-nums">
                                  {new Date(run.ranAt).toLocaleString()}
                                </TableCell>
                                <TableCell className="text-xs text-right tabular-nums">
                                  {run.tenantsDeleted.toLocaleString()}
                                </TableCell>
                                <TableCell className="text-xs text-right tabular-nums">
                                  {run.filesDeleted.toLocaleString()}
                                </TableCell>
                                <TableCell className="text-xs text-right tabular-nums">
                                  {formatBytes(run.bytesRecovered)}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                          {(() => {
                            const totalSessions = filteredHistory.reduce((sum, r) => sum + r.tenantsDeleted, 0);
                            const totalFiles = filteredHistory.reduce((sum, r) => sum + r.filesDeleted, 0);
                            const totalBytes = filteredHistory.reduce((sum, r) => sum + r.bytesRecovered, 0);
                            return (
                              <TableFooter className="sticky bottom-0 z-10 bg-background border-t">
                                <TableRow>
                                  <TableCell className="text-xs font-semibold">Total</TableCell>
                                  <TableCell className="text-xs text-right tabular-nums font-semibold">
                                    {totalSessions.toLocaleString()}
                                  </TableCell>
                                  <TableCell className="text-xs text-right tabular-nums font-semibold">
                                    {totalFiles.toLocaleString()}
                                  </TableCell>
                                  <TableCell className="text-xs text-right tabular-nums font-semibold">
                                    {formatBytes(totalBytes)}
                                  </TableCell>
                                </TableRow>
                              </TableFooter>
                            );
                          })()}
                        </Table>
                      </div>
                    )}
                  </div>
                )}

              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
