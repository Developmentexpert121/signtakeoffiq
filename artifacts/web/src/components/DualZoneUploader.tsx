import { useState, useRef, useCallback } from "react";
import { Upload, X, FileText, Loader2, Link2, CheckCircle2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export interface JobFileItem {
  id: string;
  filename: string;
  fileSizeBytes?: number | null;
  pageCount?: number | null;
  createdAt: string;
  fileCategory?: string | null;
}

type AuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Filename heuristics (kept for external callers in job-detail.tsx)
// ---------------------------------------------------------------------------

export function looksLikeFloorPlan(filename: string): boolean {
  const n = filename.toLowerCase();
  return (
    /\ba-\d/.test(n) ||
    /\bfp[-_ ]/.test(n) ||
    /\bfloor[\s_-]?plan/.test(n) ||
    /\bfloor\b/.test(n) ||
    /\blevel\b/.test(n) ||
    /\belevation\b/.test(n) ||
    /\bsection\b/.test(n) ||
    /\bplan[\s_-]?set\b/.test(n) ||
    /\barchitectural\b/.test(n) ||
    /^a\d{1,3}[-_]/.test(n)
  );
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatUploadDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Single upload zone — exported as DualZoneUploader for backward compat
// ---------------------------------------------------------------------------

interface DualZoneUploaderProps {
  jobId: string;
  authFetch: AuthFetch;
  files: JobFileItem[];
  canAct: boolean;
  onRefresh: () => void;
  showAutoSwapWarning?: boolean;
  slotMode?: boolean;
  filterCategory?: string;
  warnSizeMB?: number;
  warnSizeMessage?: string;
}

export function DualZoneUploader({
  jobId,
  authFetch,
  files,
  canAct,
  onRefresh,
  slotMode,
  filterCategory,
  warnSizeMB,
  warnSizeMessage,
}: DualZoneUploaderProps) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadingNames, setUploadingNames] = useState<string[]>([]);
  const [sizeWarning, setSizeWarning] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [driveUrl, setDriveUrl] = useState("");
  const [driveStatus, setDriveStatus] = useState<"idle" | "downloading" | "success" | "error">("idle");
  const [driveFileSizeMB, setDriveFileSizeMB] = useState<number | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);

  const uploadFiles = useCallback(async (fileList: FileList | File[]) => {
    const filesToUpload = Array.from(fileList).filter(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
    );
    if (filesToUpload.length === 0) {
      toast.error("Only PDF files are accepted");
      return;
    }
    setUploading(true);
    setUploadingNames(filesToUpload.map((f) => f.name));
    setSizeWarning(null);
    let succeeded = 0;
    for (const file of filesToUpload) {
      try {
        const urlRes = await authFetch("/api/storage/uploads/request-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "application/pdf" }),
        });
        if (!urlRes.ok) throw new Error("Failed to get upload URL");
        const { uploadURL, objectPath } = await urlRes.json();
        let storagePath: string = objectPath;

        // Try the direct browser → storage PUT first. A missing CORS rule on the
        // bucket makes this reject (a CORS failure surfaces as a thrown
        // TypeError, not a non-ok response), so treat any failure as a signal to
        // fall back to the server-side upload proxy.
        let putOk = false;
        try {
          const putRes = await fetch(uploadURL, {
            method: "PUT",
            headers: { "Content-Type": file.type || "application/pdf" },
            body: file,
          });
          putOk = putRes.ok;
        } catch {
          putOk = false;
        }

        if (!putOk) {
          const proxyRes = await authFetch("/api/storage/uploads/direct", {
            method: "POST",
            headers: { "Content-Type": file.type || "application/pdf" },
            body: file,
          });
          if (!proxyRes.ok) throw new Error("Failed to upload file");
          const proxyJson = await proxyRes.json();
          storagePath = proxyJson.objectPath;
        }

        await authFetch(`/api/jobs/${jobId}/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            storagePath,
            fileSizeBytes: file.size,
            ...(slotMode && filterCategory ? { fileCategory: filterCategory } : {}),
          }),
        });
        succeeded++;
        if (warnSizeMB && file.size > warnSizeMB * 1024 * 1024) {
          setSizeWarning(warnSizeMessage ?? `This file is larger than expected.`);
        }
      } catch {
        toast.error(`Failed to upload ${file.name}`);
      }
    }
    setUploading(false);
    setUploadingNames([]);
    if (succeeded > 0) {
      toast.success(`${succeeded} file${succeeded > 1 ? "s" : ""} uploaded`);
      onRefresh();
    }
  }, [authFetch, jobId, onRefresh, slotMode, filterCategory, warnSizeMB, warnSizeMessage]);

  const handleDriveAdd = useCallback(async () => {
    const url = driveUrl.trim();
    if (!url) return;
    setDriveStatus("downloading");
    setDriveError(null);
    setDriveFileSizeMB(null);
    try {
      const res = await authFetch(`/api/jobs/${jobId}/files/drive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driveUrl: url,
          ...(slotMode && filterCategory ? { fileCategory: filterCategory } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Server error ${res.status}`);
      }
      const data = await res.json() as { sizeMB?: number };
      setDriveStatus("success");
      setDriveFileSizeMB(data.sizeMB ?? null);
      setDriveUrl("");
      toast.success("File downloaded from Google Drive");
      onRefresh();
    } catch (err: unknown) {
      setDriveStatus("error");
      setDriveError(err instanceof Error ? err.message : "Download failed");
    }
  }, [authFetch, driveUrl, jobId, onRefresh, slotMode, filterCategory]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (!canAct) return;
      uploadFiles(e.dataTransfer.files);
    },
    [canAct, uploadFiles],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) uploadFiles(e.target.files);
      e.target.value = "";
    },
    [uploadFiles],
  );

  const handleRemove = useCallback(
    async (fileId: string, filename: string) => {
      try {
        await authFetch(`/api/jobs/${jobId}/files/${fileId}`, { method: "DELETE" });
        onRefresh();
      } catch {
        toast.error(`Failed to remove ${filename}`);
      }
    },
    [authFetch, jobId, onRefresh],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Size warning */}
      {sizeWarning && (
        <div className="flex items-start gap-2 rounded-md border border-yellow-400/50 bg-yellow-50 dark:bg-yellow-950/30 px-3 py-2 text-xs text-yellow-800 dark:text-yellow-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{sizeWarning}</span>
          <button
            type="button"
            className="ml-auto shrink-0 hover:opacity-70"
            onClick={() => setSizeWarning(null)}
          >
            ×
          </button>
        </div>
      )}

      {/* Upload zone */}
      <div className="flex flex-col gap-3">
        <div
          className={cn(
            "relative rounded-lg border-2 border-dashed transition-colors cursor-pointer",
            dragging
              ? "border-primary bg-primary/5"
              : "border-border hover:border-primary/50 hover:bg-muted/30",
            !canAct && "opacity-50 cursor-not-allowed pointer-events-none",
          )}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => canAct && inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={handleInputChange}
          />

          <div className="flex flex-col items-center justify-center gap-2 py-8 px-4 text-center">
            {uploading ? (
              <>
                <Loader2 className="h-7 w-7 text-primary animate-spin" />
                <p className="text-xs text-muted-foreground">
                  Uploading {uploadingNames.length > 1 ? `${uploadingNames.length} files` : uploadingNames[0] ?? "file"}…
                </p>
              </>
            ) : (
              <>
                <Upload className="h-7 w-7 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Drop PDFs here or <span className="text-primary underline underline-offset-2">browse</span>
                  </p>
                </div>
              </>
            )}
          </div>
        </div>

        {!slotMode && (
          <div className="flex flex-wrap gap-1.5">
            {[
              "✓ Floor plans (A-series sheets)",
              "✓ Sign schedules & specs",
              "✓ Multiple PDFs OK",
              "✓ Multi-page PDFs OK",
            ].map((chip) => (
              <span
                key={chip}
                className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground"
              >
                {chip}
              </span>
            ))}
          </div>
        )}

        {/* Google Drive link */}
        {canAct && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted-foreground px-1">or add from Google Drive</span>
              <div className="flex-1 h-px bg-border" />
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Link2 className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="url"
                  value={driveUrl}
                  onChange={e => { setDriveUrl(e.target.value); setDriveStatus("idle"); setDriveError(null); }}
                  onKeyDown={e => { if (e.key === "Enter") handleDriveAdd(); }}
                  placeholder="Paste Google Drive link…"
                  className="w-full rounded-md border border-input bg-background pl-8 pr-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  disabled={driveStatus === "downloading"}
                />
              </div>
              <button
                type="button"
                onClick={handleDriveAdd}
                disabled={!driveUrl.trim() || driveStatus === "downloading"}
                className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium shadow-sm transition-colors hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {driveStatus === "downloading" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Add
              </button>
            </div>

            {driveStatus === "downloading" && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                Downloading from Google Drive… (200 MB max)
              </p>
            )}
            {driveStatus === "success" && driveFileSizeMB != null && (
              <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                Downloaded successfully ({driveFileSizeMB.toFixed(1)} MB)
              </p>
            )}
            {driveStatus === "error" && driveError && (
              <p className="text-xs text-red-400 flex items-start gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                {driveError}
              </p>
            )}
            {driveStatus === "idle" && (
              <p className="text-xs text-muted-foreground">
                File must be shared as "Anyone with the link can view" · up to 200 MB
              </p>
            )}
          </div>
        )}
      </div>

      {/* Uploaded file list */}
      {files.length > 0 && (
        <div className="flex flex-col gap-2">
          {!slotMode && (
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-medium text-foreground">Uploaded files</h4>
              <span className="inline-flex items-center rounded-full bg-primary/10 text-primary px-2 py-0.5 text-xs font-medium">
                {files.length} file{files.length !== 1 ? "s" : ""}
              </span>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            {files.map((f) => (
              <div key={f.id} className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-xs font-medium truncate text-foreground">{f.filename}</span>
                  <span className="text-xs text-muted-foreground">
                    {[formatBytes(f.fileSizeBytes), f.createdAt && `Uploaded ${formatUploadDate(f.createdAt)}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                {canAct && (
                  <button
                    type="button"
                    className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    onClick={(e) => { e.stopPropagation(); handleRemove(f.id, f.filename); }}
                    title="Remove file"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
