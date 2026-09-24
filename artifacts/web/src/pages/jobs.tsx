import { useListJobs, useDeleteJob } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { CANONICAL_BUILDING_TYPES, getBuildingTypeOption } from "@/lib/buildingTypes";
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
import { Link, useLocation, useSearch } from "wouter";
import { Plus, Search, Loader2, ArrowRight, ChevronDown, AlertTriangle, ArrowUp, ArrowDown, ArrowUpDown, Trash2 } from "lucide-react";
import { useState, useCallback } from "react";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useQueryClient } from "@tanstack/react-query";

interface PipelineStepRecord {
  step: number;
  label: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: "completed" | "running" | "failed";
}

function getSteps(metadata: Record<string, unknown> | null | undefined): PipelineStepRecord[] {
  if (!metadata) return [];
  const s = (metadata as Record<string, unknown>).steps;
  if (!Array.isArray(s)) return [];
  return s as PipelineStepRecord[];
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getTotalProcessingTime(metadata: Record<string, unknown> | null | undefined): number | null {
  const steps = getSteps(metadata);
  if (steps.length === 0) return null;
  if (steps.some((s) => typeof s.durationMs !== "number")) return null;
  const total = steps.reduce((sum, s) => sum + s.durationMs!, 0);
  return total;
}

interface AiScanSummary {
  capHit?: boolean;
  capPerRun?: number;
  used?: number;
}

function getAiScanSummary(metadata: Record<string, unknown> | null | undefined): AiScanSummary | null {
  if (!metadata) return null;
  const s = (metadata as Record<string, unknown>).aiScanSummary;
  if (!s || typeof s !== "object") return null;
  return s as AiScanSummary;
}

const BUILDING_TYPES = CANONICAL_BUILDING_TYPES;

export default function Jobs() {
  const [location, setLocation] = useLocation();
  const searchString = useSearch();
  const { isMember, isGuest } = useCurrentUser();
  const canAct = isMember || isGuest;
  const queryClient = useQueryClient();

  const [deleteJobId, setDeleteJobId] = useState<string | null>(null);
  const [deleteJobName, setDeleteJobName] = useState<string>("");

  const { mutate: deleteJob, isPending: isDeleting } = useDeleteJob({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
        setDeleteJobId(null);
      },
    },
  });

  const [visionFilterOpen, setVisionFilterOpen] = useState(false);
  const [buildingTypeOpen, setBuildingTypeOpen] = useState(false);
  const [statusFilterOpen, setStatusFilterOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [processingTimeSort, setProcessingTimeSort] = useState<"asc" | "desc" | null>(null);

  const params = new URLSearchParams(searchString);
  const selectedBuildingTypes = params.getAll("buildingType");

  const rawVision = params.get("vision") ?? "";
  const selectedVisionFilters = rawVision
    ? rawVision.split(",").filter(v => ["default", "off", "custom"].includes(v))
    : [];

  const rawStatus = params.get("status") ?? "";
  const STATUS_OPTIONS = [
    { value: "pending", label: "Pending" },
    { value: "processing", label: "Processing" },
    { value: "completed", label: "Completed" },
    { value: "error", label: "Error" },
  ];
  const VALID_STATUS_VALUES = STATUS_OPTIONS.map(o => o.value);
  const selectedStatuses = rawStatus
    ? rawStatus.split(",").filter(v => VALID_STATUS_VALUES.includes(v))
    : [];

  const updateParams = useCallback((updates: Record<string, string | string[] | null>) => {
    const next = new URLSearchParams(searchString);
    for (const [key, value] of Object.entries(updates)) {
      next.delete(key);
      if (value === null) continue;
      if (Array.isArray(value)) {
        value.forEach(v => next.append(key, v));
      } else if (value !== "all" && value !== "") {
        next.set(key, value);
      }
    }
    const qs = next.toString();
    setLocation(qs ? `${location}?${qs}` : location, { replace: true });
  }, [searchString, location, setLocation]);

  function toggleStatus(value: string) {
    const next = selectedStatuses.includes(value)
      ? selectedStatuses.filter(v => v !== value)
      : [...selectedStatuses, value];
    updateParams({ status: next.join(",") });
  }

  function clearStatuses() {
    updateParams({ status: "" });
  }

  const statusTriggerLabel = selectedStatuses.length === 0
    ? "All Statuses"
    : selectedStatuses.length === 1
      ? (STATUS_OPTIONS.find(o => o.value === selectedStatuses[0])?.label ?? selectedStatuses[0])
      : `${selectedStatuses.length} selected`;



  const { data: jobs, isLoading } = useListJobs({ 
    buildingType: selectedBuildingTypes.length > 0 ? selectedBuildingTypes : undefined,
  });

  const filteredJobs = jobs?.filter(job => {
    const matchesSearch =
      job.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (job.location && job.location.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesVision =
      selectedVisionFilters.length === 0 ||
      (selectedVisionFilters.includes("default") && job.visionThreshold == null) ||
      (selectedVisionFilters.includes("off") && job.visionThreshold === 0) ||
      (selectedVisionFilters.includes("custom") && job.visionThreshold != null && job.visionThreshold !== 0);

    const matchesStatus =
      selectedStatuses.length === 0 ||
      selectedStatuses.includes(job.status);

    return matchesSearch && matchesVision && matchesStatus;
  });

  const sortedJobs = processingTimeSort === null
    ? filteredJobs
    : [...(filteredJobs ?? [])].sort((a, b) => {
        const aMs = getTotalProcessingTime(a.metadata as Record<string, unknown> | null | undefined) ?? -1;
        const bMs = getTotalProcessingTime(b.metadata as Record<string, unknown> | null | undefined) ?? -1;
        return processingTimeSort === "asc" ? aMs - bMs : bMs - aMs;
      });

  function toggleProcessingTimeSort() {
    setProcessingTimeSort(prev =>
      prev === null ? "asc" : prev === "asc" ? "desc" : null
    );
  }

  const VISION_OPTIONS = [
    { value: "default", label: "Default" },
    { value: "off", label: "Off" },
    { value: "custom", label: "Custom Threshold" },
  ];

  function toggleVisionFilter(value: string) {
    const next = selectedVisionFilters.includes(value)
      ? selectedVisionFilters.filter(v => v !== value)
      : [...selectedVisionFilters, value];
    updateParams({ vision: next.join(",") });
  }

  function clearVisionFilters() {
    updateParams({ vision: "" });
  }

  const visionFilterTriggerLabel = selectedVisionFilters.length === 0
    ? "All AI Vision"
    : selectedVisionFilters.length === 1
      ? (VISION_OPTIONS.find(o => o.value === selectedVisionFilters[0])?.label ?? selectedVisionFilters[0])
      : `${selectedVisionFilters.length} selected`;

  function toggleBuildingType(value: string) {
    const next = selectedBuildingTypes.includes(value)
      ? selectedBuildingTypes.filter(v => v !== value)
      : [...selectedBuildingTypes, value];
    updateParams({ buildingType: next });
  }

  function clearBuildingTypes() {
    updateParams({ buildingType: [] });
  }

  const buildingTypeTriggerLabel = selectedBuildingTypes.length === 0
    ? "All Building Types"
    : selectedBuildingTypes.length === 1
      ? (() => {
          const bt = BUILDING_TYPES.find(t => t.value === selectedBuildingTypes[0]);
          return bt ? `${bt.icon} ${bt.label}` : selectedBuildingTypes[0];
        })()
      : `${selectedBuildingTypes.length} types selected`;

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8 max-w-[1600px] mx-auto w-full">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Jobs</h1>
          <p className="text-muted-foreground mt-1">Manage sign extraction jobs and projects.</p>
        </div>
        {canAct && (
          <Link href="/jobs/new">
            <Button data-testid="btn-new-job">
              <Plus className="h-4 w-4 mr-2" />
              New Job
            </Button>
          </Link>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-center">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder="Search jobs by name or location..." 
            className="pl-9 bg-card"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-testid="input-search-jobs"
          />
        </div>
        <Popover open={statusFilterOpen} onOpenChange={setStatusFilterOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={statusFilterOpen}
              className="w-full sm:w-[180px] bg-card justify-between font-normal"
              data-testid="btn-status-filter"
            >
              <span className={selectedStatuses.length === 0 ? "text-muted-foreground" : ""}>
                {statusTriggerLabel}
              </span>
              <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[180px] p-2" align="start">
            <div className="space-y-1">
              {STATUS_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer hover:bg-accent text-sm"
                  data-testid={`status-option-${option.value}`}
                >
                  <Checkbox
                    checked={selectedStatuses.includes(option.value)}
                    onCheckedChange={() => toggleStatus(option.value)}
                    id={`status-${option.value}`}
                  />
                  {option.label}
                </label>
              ))}
            </div>
            {selectedStatuses.length > 0 && (
              <div className="mt-2 pt-2 border-t">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full h-7 text-xs"
                  onClick={clearStatuses}
                  data-testid="btn-clear-status-filters"
                >
                  Clear filter
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
        <Popover open={visionFilterOpen} onOpenChange={setVisionFilterOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={visionFilterOpen}
              className="w-full sm:w-[200px] bg-card justify-between font-normal"
              data-testid="btn-vision-filter"
            >
              <span className={selectedVisionFilters.length === 0 ? "text-muted-foreground" : ""}>
                {visionFilterTriggerLabel}
              </span>
              <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[200px] p-2" align="end">
            <div className="space-y-1">
              {VISION_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer hover:bg-accent text-sm"
                  data-testid={`vision-option-${option.value}`}
                >
                  <Checkbox
                    checked={selectedVisionFilters.includes(option.value)}
                    onCheckedChange={() => toggleVisionFilter(option.value)}
                    id={`vision-${option.value}`}
                  />
                  {option.label}
                </label>
              ))}
            </div>
            {selectedVisionFilters.length > 0 && (
              <div className="mt-2 pt-2 border-t">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full h-7 text-xs"
                  onClick={clearVisionFilters}
                  data-testid="btn-clear-vision-filters"
                >
                  Clear filter
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
        <Popover open={buildingTypeOpen} onOpenChange={setBuildingTypeOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={buildingTypeOpen}
              className="w-full sm:w-[220px] bg-card justify-between font-normal"
              data-testid="btn-building-type-filter"
            >
              <span className={selectedBuildingTypes.length === 0 ? "text-muted-foreground" : ""}>
                {buildingTypeTriggerLabel}
              </span>
              <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[220px] p-2" align="end">
            <div className="space-y-1">
              {BUILDING_TYPES.map((type) => (
                <label
                  key={type.value}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer hover:bg-accent text-sm"
                  data-testid={`building-type-option-${type.value}`}
                >
                  <Checkbox
                    checked={selectedBuildingTypes.includes(type.value)}
                    onCheckedChange={() => toggleBuildingType(type.value)}
                    id={`bt-${type.value}`}
                  />
                  <span className="mr-0.5">{type.icon}</span>
                  {type.label}
                </label>
              ))}
            </div>
            {selectedBuildingTypes.length > 0 && (
              <div className="mt-2 pt-2 border-t">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full h-7 text-xs"
                  onClick={clearBuildingTypes}
                  data-testid="btn-clear-building-types"
                >
                  Clear filter
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>

      <div className="rounded-md border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project Name</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Building Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total Signs</TableHead>
              <TableHead className="text-right">Needs Review</TableHead>
              <TableHead className="text-right">AI Vision</TableHead>
              <TableHead className="text-right">
                <button
                  onClick={toggleProcessingTimeSort}
                  className="inline-flex items-center gap-1 justify-end w-full hover:text-foreground transition-colors"
                  data-testid="sort-processing-time"
                  aria-label={`Sort by processing time${processingTimeSort === "asc" ? " (ascending)" : processingTimeSort === "desc" ? " (descending)" : ""}`}
                >
                  Processing Time
                  {processingTimeSort === "asc" ? (
                    <ArrowUp className="h-3.5 w-3.5 text-foreground" />
                  ) : processingTimeSort === "desc" ? (
                    <ArrowDown className="h-3.5 w-3.5 text-foreground" />
                  ) : (
                    <ArrowUpDown className="h-3.5 w-3.5 opacity-40" />
                  )}
                </button>
              </TableHead>
              <TableHead className="text-right">Date</TableHead>
              <TableHead className="w-[80px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              [...Array(5)].map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-5 w-40" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="h-5 w-8 ml-auto" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="h-5 w-8 ml-auto" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="h-5 w-16 ml-auto" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="h-5 w-12 ml-auto" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="h-5 w-24 ml-auto" /></TableCell>
                  <TableCell></TableCell>
                </TableRow>
              ))
            ) : sortedJobs && sortedJobs.length > 0 ? (
              sortedJobs.map((job) => (
                <TableRow 
                  key={job.id} 
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => setLocation(`/jobs/${job.id}`)}
                  data-testid={`row-job-${job.id}`}
                >
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      {job.buildingType && (() => {
                        const bt = getBuildingTypeOption(job.buildingType);
                        return bt ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-base leading-none select-none" aria-label={bt.label}>{bt.icon}</span>
                            </TooltipTrigger>
                            <TooltipContent side="top">{bt.label}</TooltipContent>
                          </Tooltip>
                        ) : null;
                      })()}
                      {job.name}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{job.location || "-"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {job.buildingType
                      ? (getBuildingTypeOption(job.buildingType)?.label ?? job.buildingType)
                      : "-"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={
                      job.status === 'completed' ? 'default' :
                      job.status === 'processing' ? 'secondary' :
                      job.status === 'error' ? 'destructive' : 'outline'
                    } className="capitalize">
                      {job.status === 'processing' && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                      {job.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono">{job.totalSigns}</TableCell>
                  <TableCell className="text-right">
                    {job.needsReview > 0 ? (
                      <span className="inline-flex items-center text-amber-500 font-mono">
                        {job.needsReview}
                      </span>
                    ) : (
                      <span className="text-muted-foreground font-mono">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex items-center gap-2 justify-end">
                      {(() => {
                        const aiSummary = getAiScanSummary(job.metadata as Record<string, unknown> | null | undefined);
                        return aiSummary?.capHit ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge
                                variant="outline"
                                className="border-amber-400 text-amber-500 bg-amber-50 dark:bg-amber-950/30 gap-1 px-1.5 py-0 text-xs font-medium cursor-default"
                                data-testid={`badge-cap-hit-${job.id}`}
                              >
                                <AlertTriangle className="h-3 w-3" />
                                Cap hit
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent side="left">
                              Sheets were skipped because the AI scan cap was reached for this job
                            </TooltipContent>
                          </Tooltip>
                        ) : null;
                      })()}
                      <span className="font-mono text-sm text-muted-foreground">
                        {job.visionThreshold == null
                          ? "default"
                          : job.visionThreshold === 0
                          ? "off"
                          : `thr ${job.visionThreshold}`}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {job.status === "completed" && (() => {
                      const totalMs = getTotalProcessingTime(job.metadata as Record<string, unknown> | null | undefined);
                      return totalMs !== null ? (
                        <span className="font-mono text-sm text-muted-foreground">{formatDuration(totalMs)}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground text-sm">
                    {new Date(job.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {canAct && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          data-testid={`btn-delete-job-${job.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteJobId(job.id);
                            setDeleteJobName(job.name);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={10} className="h-32 text-center text-muted-foreground">
                  No jobs found matching your filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={deleteJobId !== null} onOpenChange={(open) => { if (!open) setDeleteJobId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete job?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{deleteJobName}</strong> and all its extracted signs, rooms, and files. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={isDeleting}
              onClick={() => deleteJobId && deleteJob({ jobId: deleteJobId })}
              data-testid="btn-confirm-delete-job"
            >
              {isDeleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
