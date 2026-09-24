import { useMemo } from "react";
import { useGetConfidenceHistogram } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertTriangle, HelpCircle, X } from "lucide-react";

export interface ConfidenceBracket {
  label: string;
  minConfidence: number;
  maxConfidence: number;
}

interface Props {
  jobId: string;
  lowConfidenceCount: number;
  reviewedLowConfidenceCount: number;
  allLowConfidenceReviewed: boolean;
  confidenceThreshold: number;
  activeBracketMin?: number;
  activeBracketMax?: number;
  onBracketClick?: (bracket: ConfidenceBracket) => void;
  onClearBracket?: () => void;
}

const BRACKET_COLORS: Record<string, { bar: string; text: string; border: string; activeBorder: string; activeRing: string }> = {
  low: { bar: "bg-red-500", text: "text-red-700 dark:text-red-400", border: "border-red-200 dark:border-red-800", activeBorder: "border-red-500 dark:border-red-500", activeRing: "ring-2 ring-red-400 dark:ring-red-600" },
  medium: { bar: "bg-amber-400", text: "text-amber-700 dark:text-amber-400", border: "border-amber-200 dark:border-amber-800", activeBorder: "border-amber-500 dark:border-amber-500", activeRing: "ring-2 ring-amber-400 dark:ring-amber-500" },
  neutral: { bar: "bg-yellow-300", text: "text-yellow-700 dark:text-yellow-400", border: "border-yellow-200 dark:border-yellow-700", activeBorder: "border-yellow-500 dark:border-yellow-500", activeRing: "ring-2 ring-yellow-400 dark:ring-yellow-500" },
  top: { bar: "bg-green-500", text: "text-green-700 dark:text-green-400", border: "border-green-200 dark:border-green-800", activeBorder: "border-green-500 dark:border-green-500", activeRing: "ring-2 ring-green-400 dark:ring-green-500" },
};

function getBracketKey(
  minConfidence: number,
  maxConfidence: number,
  threshold: number,
): keyof typeof BRACKET_COLORS {
  // ≥ 80 %: always green — never overridden by threshold
  if (minConfidence >= 0.8) return "top";
  // 60–79 %: always yellow/neutral — fixed severity band per task spec
  if (minConfidence >= 0.6) return "neutral";
  // Below 60 %: use the tenant threshold (capped at 60 %) to distinguish red from amber.
  // Buckets whose ceiling is strictly below the effective cutoff are clearly problematic → red.
  // Buckets that reach or straddle the cutoff → amber.
  // As a hard baseline, anything below 50 % is always red and 50–59 % is always amber.
  const cutoff = Math.min(threshold, 0.6);
  if (maxConfidence < cutoff) return "low";
  if (minConfidence < 0.5) return "low";
  return "medium";
}

function formatBracket(minConfidence: number, maxConfidence: number) {
  if (minConfidence === 0) return `< ${Math.round(maxConfidence * 100)}%`;
  if (maxConfidence >= 1) return `${Math.round(minConfidence * 100)}–100%`;
  return `${Math.round(minConfidence * 100)}–${Math.round(maxConfidence * 100)}%`;
}

export function ConfidenceHistogram({
  jobId,
  lowConfidenceCount,
  reviewedLowConfidenceCount,
  allLowConfidenceReviewed,
  confidenceThreshold,
  activeBracketMin,
  activeBracketMax,
  onBracketClick,
  onClearBracket,
}: Props) {
  const { data: buckets, isLoading, isError } = useGetConfidenceHistogram(jobId);

  const totalRooms = buckets ? buckets.reduce((sum, b) => sum + b.count, 0) : 0;
  const maxCount = buckets ? Math.max(...buckets.map(b => b.count), 1) : 1;
  const thresholdPct = Math.round(confidenceThreshold * 100);

  const hasActiveBracket = activeBracketMin !== undefined && activeBracketMax !== undefined;
  const isClickable = !!onBracketClick;

  const reviewBadge = useMemo(() => {
    if (lowConfidenceCount === 0) return null;
    if (allLowConfidenceReviewed) {
      return (
        <Badge variant="outline" className="gap-1 border-green-300 text-green-700 dark:border-green-700 dark:text-green-400">
          <CheckCircle2 className="h-3 w-3" />
          All {lowConfidenceCount} low-confidence room{lowConfidenceCount !== 1 ? "s" : ""} reviewed
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="gap-1 border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-3 w-3" />
        {reviewedLowConfidenceCount} / {lowConfidenceCount} low-confidence reviewed
      </Badge>
    );
  }, [allLowConfidenceReviewed, lowConfidenceCount, reviewedLowConfidenceCount]);

  if (isLoading) {
    return (
      <div className="space-y-4 p-2">
        <Skeleton className="h-6 w-48" />
        <div className="space-y-3">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-8 flex-1" />
              <Skeleton className="h-4 w-8" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (isError || !buckets) {
    return (
      <div className="flex items-center justify-center p-12 border border-dashed rounded-md text-muted-foreground gap-2">
        <AlertTriangle className="h-4 w-4" />
        <span>Could not load confidence data.</span>
      </div>
    );
  }

  if (buckets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 border border-dashed rounded-md text-muted-foreground gap-2">
        <HelpCircle className="h-5 w-5" />
        <span className="text-sm">No AI-detected rooms found for this job.</span>
      </div>
    );
  }

  const ALL_LEGEND_ENTRIES = [
    { key: "low",     label: "Below threshold" },
    { key: "medium",  label: "Near threshold"  },
    { key: "neutral", label: "Acceptable"       },
    { key: "top",     label: "High confidence"  },
  ] as const;

  const presentKeys = new Set(
    buckets.map(b => getBracketKey(b.minConfidence, b.maxConfidence, confidenceThreshold))
  );
  const LEGEND_ENTRIES = ALL_LEGEND_ENTRIES.filter(e => presentKeys.has(e.key));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold">AI Confidence Distribution</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {totalRooms} AI-detected room{totalRooms !== 1 ? "s" : ""} across {buckets.length} bracket{buckets.length !== 1 ? "s" : ""}
            {isClickable && " · Click a bar to filter the Rooms tab"}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
            {LEGEND_ENTRIES.map(({ key, label }) => (
              <span key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className={`inline-block h-2.5 w-2.5 rounded-sm shrink-0 ${BRACKET_COLORS[key].bar}`} />
                {label}
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {hasActiveBracket && onClearBracket && (
            <button
              type="button"
              onClick={onClearBracket}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground underline focus:outline-none"
            >
              <X className="h-3 w-3" />
              Clear bracket filter
            </button>
          )}
          {reviewBadge}
        </div>
      </div>

      <div className="space-y-2.5">
        {buckets.map(bucket => {
          const bracketKey = getBracketKey(bucket.minConfidence, bucket.maxConfidence, confidenceThreshold);
          const colors = BRACKET_COLORS[bracketKey];
          const barWidthPct = Math.round((bucket.count / maxCount) * 100);
          const roomPct = totalRooms > 0 ? ((bucket.count / totalRooms) * 100).toFixed(1) : "0.0";
          const isBelowThreshold = bucket.maxConfidence <= confidenceThreshold;
          const label = formatBracket(bucket.minConfidence, bucket.maxConfidence);
          const isActive = hasActiveBracket &&
            bucket.minConfidence === activeBracketMin &&
            bucket.maxConfidence === activeBracketMax;

          const borderClass = isActive
            ? `${colors.activeBorder} ${colors.activeRing}`
            : colors.border;

          const rowContent = (
            <div className={`rounded-lg border p-3 transition-all ${borderClass} ${isActive ? "bg-card shadow-sm" : "bg-card"} ${isClickable ? "cursor-pointer hover:shadow-sm" : ""}`}>
              <div className="flex items-center gap-3">
                <div className="w-24 shrink-0 text-right">
                  <span className={`text-xs font-medium tabular-nums ${colors.text}`}>{label}</span>
                </div>
                <div className="flex-1 relative h-7 bg-muted rounded overflow-hidden">
                  <div
                    className={`absolute left-0 top-0 h-full ${colors.bar} rounded transition-all duration-500`}
                    style={{ width: `${barWidthPct}%` }}
                  />
                  <span className="absolute inset-0 flex items-center px-2 text-xs font-medium text-foreground/80 mix-blend-multiply dark:mix-blend-normal">
                    {bucket.count} room{bucket.count !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="w-14 shrink-0 text-right">
                  <span className="text-xs tabular-nums text-muted-foreground">{roomPct}%</span>
                </div>
                {isBelowThreshold && (
                  <div className="shrink-0">
                    <Badge variant="outline" className="text-xs gap-1 border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400 px-1.5 py-0">
                      <AlertTriangle className="h-2.5 w-2.5" />
                      &lt;{thresholdPct}%
                    </Badge>
                  </div>
                )}
                {isActive && (
                  <div className="shrink-0">
                    <Badge variant="outline" className={`text-xs gap-1 px-1.5 py-0 ${colors.text} ${colors.activeBorder}`}>
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      Filtered
                    </Badge>
                  </div>
                )}
              </div>
            </div>
          );

          if (isClickable) {
            return (
              <button
                key={bucket.bucket}
                type="button"
                className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
                onClick={() => {
                  if (isActive && onClearBracket) {
                    onClearBracket();
                  } else {
                    onBracketClick({ label, minConfidence: bucket.minConfidence, maxConfidence: bucket.maxConfidence });
                  }
                }}
                aria-pressed={isActive}
                aria-label={isActive ? `Deselect ${label} confidence filter` : `Filter rooms to ${label} confidence range (${bucket.count} room${bucket.count !== 1 ? "s" : ""})`}
              >
                {rowContent}
              </button>
            );
          }

          return <div key={bucket.bucket}>{rowContent}</div>;
        })}
      </div>

      <div className="rounded-lg border bg-muted/40 p-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          {[
            { label: "Total rooms", value: totalRooms },
            { label: `Below ${thresholdPct}% threshold`, value: lowConfidenceCount },
            { label: "Reviewed", value: reviewedLowConfidenceCount },
            { label: "Pending review", value: Math.max(0, lowConfidenceCount - reviewedLowConfidenceCount) },
          ].map(({ label, value }) => (
            <div key={label} className="space-y-0.5">
              <div className="text-lg font-semibold tabular-nums">{value}</div>
              <div className="text-xs text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
