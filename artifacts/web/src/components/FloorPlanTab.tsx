import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import {
  useListSigns,
  useListJobSheets,
  useCreateSign,
  useUpdateSign,
  useDeleteSign,
  useProcessJob,
  useListRooms,
  getListSignsQueryKey,
} from "@workspace/api-client-react";
import type { Sign, Room } from "@workspace/api-client-react";
import { DEFAULT_SIGN_COLOR } from "@/lib/signColors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Loader2, MapPin, X, Check, ImageOff, RefreshCw, GripHorizontal, Grid3X3, ChevronLeft, ChevronRight, Maximize2, ZoomIn, Pencil, Trash2, Move, CheckCircle, Palette, Search } from "lucide-react";
import { toast } from "sonner";
import { useAuthedImgUrl } from "@/hooks/use-authed-img-url";
import { useGuestAuth } from "@/contexts/GuestAuthContext";


// Engineering-discipline sheet filter — applied unconditionally when choosing
// the floor plan background. Any sheet whose title matches is skipped, even if
// selectedSheetId points to it. Defined at module scope so it's a stable
// reference and doesn't need to appear in React dependency arrays.
const NON_ARCH_TITLE_KW = /\b(lighting|electrical|power|comm|mechanical|plumbing|structural|ceiling|reflected)\b/i;
const isEngineeringSheet = (s: { sheetTitle?: string | null; sheetId?: string | null }): boolean =>
  NON_ARCH_TITLE_KW.test(s.sheetTitle ?? s.sheetId ?? "");

// Extract the numeric wing index from a sheetId (e.g. "PLAN-1-P2" → 1, "PLAN-0-P2" → 0).
// Used as a tiebreaker so lower-indexed wings sort before the garage podium (PLAN-0).
// Returns 999 for any sheetId that doesn't match the PLAN-N pattern.
function sheetNumericOrder(s: { sheetId?: string | null }): number {
  const match = (s.sheetId ?? "").match(/PLAN-(\d+)/i);
  return match ? parseInt(match[1], 10) : 999;
}

const ADA_CANONICAL_SIGN_TYPES = [
  "Room ID",
  "Room ID w/insert",
  "Restroom",
  "Restroom Accessible",
  "Exit",
  "Stair(Corridor)",
  "Stair(Landing)",
  "Elevator",
  "Evac Map",
  "Max Occupancy",
  "Accessible",
  "In case of fire",
  "Office Directory",
  "Unit ID",
  "Unit/Room #",
  "Directional",
  "Wayfinding",
  "Fire Extinguisher",
  "Occupancy Sign",
  "Electrical Closet",
  "Mechanical Room",
  "N/A",
];
const SIGN_TYPES = ADA_CANONICAL_SIGN_TYPES;


// The rules engine historically inserted status="auto". Treat it as "extracted"
// so legacy records show up under the Extracted filter without needing a rescan.
// Also normalizes to lowercase for case-insensitive matching against DB values.
function normalizeStatus(status: string | null | undefined): string {
  if (!status) return "unknown";
  const lower = status.toLowerCase();
  return lower === "auto" ? "extracted" : lower;
}

const STATUS_LABELS: Record<string, string> = {
  extracted: "Extracted",
  confirmed: "Confirmed",
  needs_review: "Needs Review",
  rejected: "Rejected",
};

const MARKER_COLORS: Record<string, string> = {
  "Room ID": "#F59E0B",
  "Room ID w/insert": "#F59E0B",
  "Restroom": "#06B6D4",
  "Exit": "#10B981",
  "Stair(Corridor)": "#10B981",
  "Stair(Landing)": "#10B981",
  "Elevator": "#8B5CF6",
  "Unit ID": "#F59E0B",
  "Unit/Room #": "#F59E0B",
  "Evac Map": "#EF4444",
  "Max Occupancy": "#F97316",
  "Accessible": "#06B6D4",
  "In case of fire": "#EF4444",
  "Office Directory": "#6b7280",
};

const SIGN_ABBREV: Record<string, string> = {
  "Room ID": "RID",
  "Room ID w/insert": "RII",
  "Restroom": "RST",
  "Exit": "EXT",
  "Stair(Corridor)": "STR",
  "Stair(Landing)": "SLD",
  "Elevator": "ELV",
  "Unit ID": "UID",
  "Unit/Room #": "UID",
  "Evac Map": "EVC",
  "Max Occupancy": "MAX",
  "Accessible": "ADA",
  "In case of fire": "ICF",
  "Office Directory": "OFD",
};

function getMarkerColor(signType: string, fallback?: string | null): string {
  if (!signType || signType === "N/A") return fallback ?? DEFAULT_SIGN_COLOR;
  if (/^(EGRESS|EVAC|STAIR)/i.test(signType)) return "#EF4444";   // red — egress/stair
  if (/^EXIT$/i.test(signType))               return "#22C55E";   // green — pure exit
  if (/EXIT/i.test(signType))                 return "#EF4444";   // red — exit variant
  if (/^[A-Z][0-9]{3,4}$/.test(signType))    return "#F59E0B";   // amber — residential unit
  if (/RESTROOM|TOILET|TLT/i.test(signType)) return "#3B82F6";   // blue — restroom
  if (/CORRIDOR|LOBBY|LOUNGE/i.test(signType)) return "#8B5CF6"; // purple — common area
  return MARKER_COLORS[signType] ?? fallback ?? DEFAULT_SIGN_COLOR;
}

function getConfidenceOpacity(confidence: number | null | undefined): number {
  const c = confidence ?? 0;
  if (c > 0.85) return 1.0;
  if (c >= 0.60) return 0.75;
  return 0.5;
}

function darkenHex(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.round(r * 0.7)},${Math.round(g * 0.7)},${Math.round(b * 0.7)})`;
}

interface ContextMenuState {
  x: number;
  y: number;
  sign: Sign;
}

interface PendingMarker {
  normalizedX: number;
  normalizedY: number;
}

interface LastMove {
  signId: string;
  oldX: number;
  oldY: number;
  oldCanvasX?: number | null;
  oldCanvasY?: number | null;
}

/**
 * Normalize a floor level label to canonical uppercase format.
 * Handles legacy "Level 1" (title-case) and new "LEVEL 1" (uppercase) formats.
 * Also maps "Basement" → "LEVEL B1", "Mezzanine" → "MEZZANINE", etc.
 */
function normalizeLevel(raw: string | null | undefined): string {
  if (!raw) return "LEVEL 1";
  const u = raw.toUpperCase().trim();
  // Already canonical
  if (/^LEVEL\s+\w/.test(u) || u === "MEZZANINE" || u === "ROOF" || u === "PARKING") return u;
  // Title-case "Level N" → "LEVEL N"
  const lvlMatch = /^LEVEL\s*(\d+)$/i.exec(u);
  if (lvlMatch) return `LEVEL ${lvlMatch[1]}`;
  // "Basement" / "B1" → "LEVEL B1"
  if (u === "BASEMENT" || u === "LEVEL B1") return "LEVEL B1";
  // "Mezzanine" / "Mezz" → "MEZZANINE"
  if (u.startsWith("MEZZ")) return "MEZZANINE";
  // "Roof" → "ROOF"
  if (u === "ROOF") return "ROOF";
  // Fallback: uppercase whatever we have
  return u;
}

function getSignEffectivePos(
  sign: Sign,
  _rooms: Room[],
): { x: number; y: number } | null {
  // canvasX/canvasY: stored as 0–1 fractions when the user manually drags a marker.
  if (sign.canvasX != null && sign.canvasY != null) {
    return { x: Math.round(sign.canvasX * 100000), y: Math.round(sign.canvasY * 100000) };
  }
  // markerX/markerY: AI-vision percentages (0–100) × 1000, stored as integers 0–100000.
  // (0,0) is top-left — no Y-axis flip needed, no title-block adjustment.
  if (sign.markerX != null && sign.markerY != null) {
    return { x: sign.markerX, y: sign.markerY };
  }
  return null;
}

interface FloorPlanTabProps {
  jobId: string;
  onDirtyChange?: (dirty: boolean) => void;
  focusRoomId?: string | null;
  onFocusRoomConsumed?: () => void;
  editRoomId?: string | null;
  onEditRoomClose?: () => void;
  onSaveRoomName?: (roomId: string, name: string) => Promise<void>;
}

const DRAG_THRESHOLD_PX = 5;
const SAME_LEVEL_PREFETCH_RADIUS = 2;
const PREFETCH_AHEAD = 3;
const PREFETCH_BEHIND = 1;
const DRAG_HINT_KEY = "floorplan_drag_hint_dismissed";

export function FloorPlanTab({ jobId, onDirtyChange: _onDirtyChange, focusRoomId, onFocusRoomConsumed, editRoomId, onEditRoomClose, onSaveRoomName: _onSaveRoomName }: FloorPlanTabProps) {
  const queryClient = useQueryClient();
  const { guestSession } = useGuestAuth();
  const isGuest = Boolean(guestSession?.token);

  const { data: sheets = [], isLoading: loadingSheets } = useListJobSheets(jobId);
  const { data: allSigns = [], isLoading: loadingSigns } = useListSigns(jobId);
  const { data: rooms = [] } = useListRooms(jobId);
  const processJob = useProcessJob();

  const [selectedSheetId, setSelectedSheetId] = useState<string | null>(() => {
    return localStorage.getItem(`floor-plan-sheet-${jobId}`) ?? null;
  });
  const [trayOpen, setTrayOpen] = useState<boolean>(() => {
    return localStorage.getItem(`tray-collapsed-${jobId}`) !== "true";
  });
  const [traySearch, setTraySearch] = useState("");
  const [trayLevelFilter, setTrayLevelFilter] = useState<string | null>(null);
  const [selectedSignId, setSelectedSignId] = useState<string | null>(null);
  const [selectedSignData, setSelectedSignData] = useState<Sign | null>(null);
  const [editorRoomNumber, setEditorRoomNumber] = useState("");
  const [editorSignType, setEditorSignType] = useState("");
  const [editorMarkerColor, setEditorMarkerColor] = useState("");
  const [editorFloorLabel, setEditorFloorLabel] = useState("");
  const [dropGhost, setDropGhost] = useState<{ x: number; y: number } | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchDebounced, setSearchDebounced] = useState("");
  const [trayHighlightId, setTrayHighlightId] = useState<string | null>(null);

  const [showAllSheets, _setShowAllSheets] = useState(false);
  const [addMarkerMode, setAddMarkerMode] = useState(false);
  const [pendingMarker, setPendingMarker] = useState<PendingMarker | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newSignType, setNewSignType] = useState(SIGN_TYPES[0]);


  useEffect(() => {
    setAddMarkerMode(false);
    setPendingMarker(null);
    setDialogOpen(false);
  }, [jobId]);

  const [newQty, setNewQty] = useState(1);
  const [saving, setSaving] = useState(false);
  const [imgLoading, setImgLoading] = useState(false);
  const [wholeLevelPrefetchReady, setWholeLevelPrefetchReady] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const loadedTypesForJobRef = useRef(jobId);
  const loadedStatusesForJobRef = useRef(jobId);

  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(`floorplan_selected_types_${jobId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) return new Set<string>(parsed);
      }
    } catch {
      // ignore
    }
    return new Set<string>();
  });

  useEffect(() => {
    if (loadedTypesForJobRef.current !== jobId) return;
    try {
      localStorage.setItem(
        `floorplan_selected_types_${jobId}`,
        JSON.stringify([...selectedTypes])
      );
    } catch {
      // ignore
    }
  }, [selectedTypes, jobId]);

  useEffect(() => {
    loadedTypesForJobRef.current = jobId;
    try {
      const stored = localStorage.getItem(`floorplan_selected_types_${jobId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setSelectedTypes(new Set<string>(parsed));
          return;
        }
      }
    } catch {
      // ignore
    }
    setSelectedTypes(new Set<string>());
  }, [jobId]);

  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(`floorplan_selected_statuses_${jobId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) return new Set<string>(parsed);
      }
    } catch {
      // ignore
    }
    return new Set<string>();
  });

  useEffect(() => {
    if (loadedStatusesForJobRef.current !== jobId) return;
    try {
      localStorage.setItem(
        `floorplan_selected_statuses_${jobId}`,
        JSON.stringify([...selectedStatuses])
      );
    } catch {
      // ignore
    }
  }, [selectedStatuses, jobId]);

  useEffect(() => {
    loadedStatusesForJobRef.current = jobId;
    try {
      const stored = localStorage.getItem(`floorplan_selected_statuses_${jobId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setSelectedStatuses(new Set<string>(parsed));
          return;
        }
      }
    } catch {
      // ignore
    }
    setSelectedStatuses(new Set<string>());
  }, [jobId]);
  const signSearch = ""; // search UI removed; keep for sign list filter compat

  const [displayScale, setDisplayScale] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const transformFiredRef = useRef(false);

  const [snapToGrid, setSnapToGrid] = useState<boolean>(
    () => localStorage.getItem("floorplan_snap_to_grid") === "true",
  );
  const [draggingSignId, setDraggingSignId] = useState<string | null>(null);
  const [dragNormPos, setDragNormPos] = useState<{ x: number; y: number } | null>(null);
  const [shiftHeldDuringDrag, setShiftHeldDuringDrag] = useState(false);
  const [showDragHint, setShowDragHint] = useState<boolean>(
    () => localStorage.getItem(DRAG_HINT_KEY) !== "true"
  );
  const [dragHintDismissing, setDragHintDismissing] = useState(false);
  const [legendCollapsed, setLegendCollapsed] = useState(true);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [pulsingSignId, setPulsingSignId] = useState<string | null>(null);
  const [roomSearch, _setRoomSearch] = useState("");
  const [placeModeSignId, setPlaceModeSignId] = useState<string | null>(null);
  const [newRoomNumber, setNewRoomNumber] = useState("");
  const [newRoomName, setNewRoomName] = useState("");
  const dragHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (dragHintTimerRef.current !== null) {
        clearTimeout(dragHintTimerRef.current);
      }
    };
  }, []);

  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const dismissDragHint = useCallback(() => {
    localStorage.setItem(DRAG_HINT_KEY, "true");
    if (prefersReducedMotion) {
      setShowDragHint(false);
      return;
    }
    setDragHintDismissing(true);
    if (dragHintTimerRef.current !== null) {
      clearTimeout(dragHintTimerRef.current);
    }
    dragHintTimerRef.current = setTimeout(() => {
      setShowDragHint(false);
      setDragHintDismissing(false);
      dragHintTimerRef.current = null;
    }, 250);
  }, [prefersReducedMotion]);
  const imgContainerRef = useRef<HTMLDivElement>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const lastMoveRef = useRef<LastMove | null>(null);
  const dragStartScreenRef = useRef<{ x: number; y: number } | null>(null);
  const hasDraggedRef = useRef(false);

  const createSign = useCreateSign();
  const updateSign = useUpdateSign();
  const deleteSign = useDeleteSign();

  const transformRef = useRef<ReactZoomPanPinchRef>(null);
  const savedScaleRef = useRef<number | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchPanelRef = useRef<HTMLDivElement>(null);
  const trayScrollRef = useRef<HTMLDivElement>(null);

  const rowRefsMap = useRef<Map<string, HTMLButtonElement>>(new Map());
  const prevSheetNavRef = useRef<{ idx: number } | null>(null);
  const _setRowRef = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) {
      rowRefsMap.current.set(id, el);
    } else {
      rowRefsMap.current.delete(id);
    }
  }, []);

  useEffect(() => {
    if (!selectedSignId) return;
    const el = rowRefsMap.current.get(selectedSignId);
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedSignId]);

  const undoLastMove = useCallback(() => {
    const move = lastMoveRef.current;
    if (!move) return;
    lastMoveRef.current = null;
    updateSign.mutate(
      {
        jobId,
        signId: move.signId,
        data: { markerX: move.oldX, markerY: move.oldY, canvasX: move.oldCanvasX ?? null, canvasY: move.oldCanvasY ?? null, reason: "Undo marker move" },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
          toast.success("Marker move undone.");
        },
        onError: () => {
          toast.error("Failed to undo marker move.");
        },
      }
    );
  }, [jobId, updateSign, queryClient]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        if (lastMoveRef.current) {
          e.preventDefault();
          undoLastMove();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undoLastMove]);

  useEffect(() => {
    if (!draggingSignId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        setShiftHeldDuringDrag(e.type === "keydown");
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [draggingSignId]);

  const getNormFromPointer = (
    e: React.PointerEvent,
    containerRef: React.RefObject<HTMLDivElement | null>,
  ) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = Math.max(0, Math.min(100000, Math.round(((e.clientX - rect.left) / rect.width) * 100000)));
    const y = Math.max(0, Math.min(100000, Math.round(((e.clientY - rect.top) / rect.height) * 100000)));
    return { x, y };
  };

  const snapNormToGrid = (
    norm: { x: number; y: number },
    containerRef: React.RefObject<HTMLDivElement | null>,
  ): { x: number; y: number } => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return norm;
    const stepX = (40 / rect.width) * 100000;
    const stepY = (40 / rect.height) * 100000;
    return {
      x: Math.max(0, Math.min(100000, Math.round(norm.x / stepX) * stepX)),
      y: Math.max(0, Math.min(100000, Math.round(norm.y / stepY) * stepY)),
    };
  };

  const handleMarkerPointerDown = (
    e: React.PointerEvent<HTMLButtonElement>,
    signId: string,
  ) => {
    if (addMarkerMode) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragStartScreenRef.current = { x: e.clientX, y: e.clientY };
    hasDraggedRef.current = false;
    setDraggingSignId(signId);
    // Do NOT set selectedSignId here — selection is handled by onClick so the
    // toggle logic in handleMarkerClick works correctly and the panel doesn't
    // open-then-immediately-close on every mousedown/click cycle.
  };

  const handleMarkerPointerMove = (
    e: React.PointerEvent<HTMLButtonElement>,
    containerRef: React.RefObject<HTMLDivElement | null>,
  ) => {
    if (draggingSignId !== e.currentTarget.dataset.signId) return;
    if (dragStartScreenRef.current) {
      const dx = e.clientX - dragStartScreenRef.current.x;
      const dy = e.clientY - dragStartScreenRef.current.y;
      if (!hasDraggedRef.current && Math.sqrt(dx * dx + dy * dy) >= DRAG_THRESHOLD_PX) {
        hasDraggedRef.current = true;
      }
      if (!hasDraggedRef.current) return;
    }
    setShiftHeldDuringDrag(e.shiftKey);
    const norm = getNormFromPointer(e, containerRef);
    if (norm) {
      const effectiveSnap = e.shiftKey ? !snapToGrid : snapToGrid;
      const snapped =
        effectiveSnap && containerRef === gridContainerRef
          ? snapNormToGrid(norm, containerRef)
          : norm;
      setDragNormPos(snapped);
    }
  };

  const handleMarkerPointerUp = (
    e: React.PointerEvent<HTMLButtonElement>,
    signId: string,
  ) => {
    if (draggingSignId !== signId) return;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    const containerRef = imgContainerRef.current ? imgContainerRef : gridContainerRef;
    const norm = getNormFromPointer(e, containerRef);
    const rawPos = norm ?? dragNormPos;
    const effectiveSnap = e.shiftKey ? !snapToGrid : snapToGrid;
    const finalPos =
      rawPos && effectiveSnap && containerRef === gridContainerRef
        ? snapNormToGrid(rawPos, containerRef)
        : rawPos;
    const didDrag = hasDraggedRef.current;
    setDraggingSignId(null);
    setDragNormPos(null);
    setShiftHeldDuringDrag(false);
    dragStartScreenRef.current = null;
    hasDraggedRef.current = false;
    if (!finalPos || !didDrag) return;

    dismissDragHint();

    const allSignsData = queryClient.getQueryData<Sign[]>(getListSignsQueryKey(jobId));
    const existingSign = allSignsData?.find((s) => s.id === signId);
    const oldEffectivePos = existingSign ? getSignEffectivePos(existingSign, rooms) : null;
    const oldX = oldEffectivePos?.x ?? existingSign?.markerX;
    const oldY = oldEffectivePos?.y ?? existingSign?.markerY;

    if (oldX != null && oldY != null) {
      const diff = Math.abs(finalPos.x - oldX) + Math.abs(finalPos.y - oldY);
      if (diff < 2) return;
      lastMoveRef.current = { signId, oldX, oldY, oldCanvasX: existingSign?.canvasX, oldCanvasY: existingSign?.canvasY };
    }

    queryClient.setQueryData(
      getListSignsQueryKey(jobId),
      (old: Sign[] | undefined) =>
        old?.map((s) =>
          s.id === signId ? { ...s, markerX: finalPos.x, markerY: finalPos.y, canvasX: finalPos.x / 100000, canvasY: finalPos.y / 100000 } : s,
        ) ?? old,
    );

    updateSign.mutate(
      {
        jobId,
        signId,
        data: { markerX: finalPos.x, markerY: finalPos.y, canvasX: finalPos.x / 100000, canvasY: finalPos.y / 100000, reason: "Marker repositioned on floor plan" },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
          if (lastMoveRef.current?.signId === signId) {
            toast.success("Marker moved.", {
              action: {
                label: "Undo",
                onClick: undoLastMove,
              },
              duration: 6000,
            });
          }
        },
        onError: () => {
          lastMoveRef.current = null;
          toast.error("Failed to move marker. Please try again.");
          queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
        },
      },
    );
  };

  // Build a set of sheetIds that have rooms or sign markers
  const sheetIdsWithData = new Set([
    ...(rooms as { sheetId?: string | null }[])
      .filter((r) => r.sheetId)
      .map((r) => r.sheetId!),
    ...(allSigns as Sign[])
      .filter((s) => s.sheetId && !s.isDeleted)
      .map((s) => s.sheetId!),
  ]);

  // When sheetIdsWithData is empty (rooms + signs still loading), fall back to
  // the pre-filter behaviour so the image view never regresses to the grid
  // fallback during load.  Once data arrives the phantom P2/P3 sheets are
  // filtered out as intended.
  const relevantSheets = sheets.filter(
    (s) =>
      s.isRelevant &&
      s.rasterizedPath &&
      (sheetIdsWithData.size === 0 ||
        sheetIdsWithData.has(s.id) ||
        sheetIdsWithData.has(s.sheetId ?? "")),
  );

  // All relevant sheets ordered by level then score then numeric wing index.
  const orderedSheets = useMemo(() => {
    const sheetScore = (s: typeof relevantSheets[0]) => {
      if (s.sheetType !== "floor_plan") return 3;
      if (isEngineeringSheet(s)) return 2;
      return 1;
    };
    return [...relevantSheets].sort((a, b) => {
      const levelDiff = normalizeLevel(a.level).localeCompare(normalizeLevel(b.level));
      if (levelDiff !== 0) return levelDiff;
      const scoreDiff = sheetScore(a) - sheetScore(b);
      if (scoreDiff !== 0) return scoreDiff;
      return sheetNumericOrder(a) - sheetNumericOrder(b);
    });
  }, [relevantSheets]);

  // Resolve the active (background) sheet.
  // RULE: engineering sheets are unconditionally skipped — even if selectedSheetId
  // points to one. Default to the sheet with the most markers so the most
  // informative view opens automatically.
  const activeSheet = useMemo(() => {
    const nonEng = orderedSheets.filter((s) => !isEngineeringSheet(s));
    // 1. Honour the user's explicit selection, but only if it's not engineering.
    const explicit = orderedSheets.find((s) => s.id === selectedSheetId && !isEngineeringSheet(s));
    if (explicit) return explicit;
    // 2. Default to the non-engineering sheet with the most sign markers.
    if (nonEng.length > 0) {
      const signCountBySheet = (allSigns as Sign[]).reduce<Record<string, number>>((acc, s) => {
        if (s.sheetId && !s.isDeleted) acc[s.sheetId] = (acc[s.sheetId] ?? 0) + 1;
        return acc;
      }, {});
      const sheetsWithMarkers = nonEng.filter((s) => (signCountBySheet[s.id] ?? 0) > 0);
      if (sheetsWithMarkers.length > 0) {
        // Sort: most markers first; tiebreak by "PLAN" in title, then sheet ID ascending.
        return sheetsWithMarkers.slice().sort((a, b) => {
          const countDiff = (signCountBySheet[b.id] ?? 0) - (signCountBySheet[a.id] ?? 0);
          if (countDiff !== 0) return countDiff;
          const aHasPlan = (a.sheetTitle ?? "").toUpperCase().includes("PLAN") ? 1 : 0;
          const bHasPlan = (b.sheetTitle ?? "").toUpperCase().includes("PLAN") ? 1 : 0;
          if (aHasPlan !== bHasPlan) return bHasPlan - aHasPlan;
          // Prefer non-zero wing index (skip garage/podium PLAN-0 sheets)
          const aIsZero = sheetNumericOrder(a) === 0 ? 1 : 0;
          const bIsZero = sheetNumericOrder(b) === 0 ? 1 : 0;
          if (aIsZero !== bIsZero) return aIsZero - bIsZero;
          return sheetNumericOrder(a) - sheetNumericOrder(b);
        })[0];
      }
      // No markers yet — fall back to first architectural sheet.
      return nonEng[0];
    }
    // 3. Last resort: any sheet.
    return orderedSheets[0] ?? null;
  }, [orderedSheets, selectedSheetId, allSigns]);

  const sheetSigns = (allSigns as Sign[]).filter(
    (s) => s.sheetId === activeSheet?.id && getSignEffectivePos(s, rooms) != null,
  );
  const sheetSignsRef = useRef(sheetSigns);
  sheetSignsRef.current = sheetSigns;
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  // Include ALL signs in the overview — signs without a computable position
  // are rendered in a right-edge column by the grid view renderer.
  const allPlacedSigns = (allSigns as Sign[]).filter(
    (s) => !s.isDeleted,
  );

  const hasRasterizedSheets = relevantSheets.length > 0;

  const listSigns = showAllSheets ? allPlacedSigns : (hasRasterizedSheets ? sheetSigns : allPlacedSigns);

  const signTypeCounts = useMemo(() => {
    const map = new Map<string, { count: number; color: string }>();
    for (const sign of listSigns) {
      const type = sign.signType || "Room ID";
      const color = getMarkerColor(type, sign.color);
      const existing = map.get(type);
      if (existing) {
        existing.count++;
      } else {
        map.set(type, { count: 1, color });
      }
    }
    return Array.from(map.entries())
      .map(([type, { count, color }]) => ({ type, count, color }))
      .sort((a, b) => b.count - a.count);
  }, [listSigns]);

  const signRowNumbers = useMemo(() => {
    const map = new Map<string, number>();
    (allSigns as Sign[]).forEach((s, idx) => map.set(s.id, idx + 1));
    return map;
  }, [allSigns]);

  const selectedSign =
    selectedSignData ??
    allPlacedSigns.find((s) => s.id === selectedSignId) ??
    null;

  // Sync Room Editor form fields when the selected marker changes
  // (must live after selectedSign is defined — no TDZ)
  useEffect(() => {
    if (!selectedSign) return;
    setEditorRoomNumber(selectedSign.roomNumber ?? "");
    setEditorSignType(selectedSign.signType ?? "");
    setEditorMarkerColor(selectedSign.markerColor ?? getMarkerColor(selectedSign.signType, selectedSign.color));
    setEditorFloorLabel(selectedSign.floorLabel ?? "");
  }, [selectedSign?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset level filter pill when the active sheet changes
  useEffect(() => {
    setTrayLevelFilter(null);
  }, [activeSheet?.id]); // activeSheet.id is the only relevant dependency

  const selectedSignRoom = selectedSign?.roomId
    ? rooms.find((r) => r.id === selectedSign.roomId) ?? null
    : null;
  const _selectedSignRoomIsDismissed = selectedSignRoom?.reviewStatus === "dismissed";
  const _selectedSignRoomDismissalReason = selectedSignRoom?.dismissalReason ?? null;

  const selectedSignSheet = selectedSign?.sheetId
    ? relevantSheets.find((s) => s.id === selectedSign.sheetId) ?? null
    : null;
  const _selectedSignSheetTitle = selectedSignSheet
    ? (selectedSignSheet.sheetTitle ?? (selectedSignSheet.pdfPage ? `Pg ${selectedSignSheet.pdfPage}` : undefined))
    : undefined;
  const _selectedSignIndex =
    selectedSign
      ? (allSigns as Sign[]).findIndex((s) => s.id === selectedSign.id) + 1
      : 1;

  const imageUrl = activeSheet?.rasterizedPath
    ? `/api/storage/objects/${activeSheet.rasterizedPath.replace(/^\/objects\//, "")}${retryCount > 0 ? `?retry=${retryCount}` : ""}`
    : null;

  const { displayUrl: displayImageUrl, fetching: imgFetching, fetchFailed: imgFetchFailed } = useAuthedImgUrl(imageUrl);

  useEffect(() => {
    setImageError(false);
    setRetryCount(0);
  }, [activeSheet?.id]);

  useEffect(() => {
    if (imgFetchFailed) {
      setImgLoading(false);
      setImageError(true);
      setImgSize(null);
    }
  }, [imgFetchFailed]);

  useEffect(() => {
    setAddMarkerMode(false);
    setDialogOpen(false);
    setPendingMarker(null);
  }, [activeSheet?.id]);

  useEffect(() => {
    if (imageUrl) {
      setImgLoading(true);
      setImageError(false);
      setImgSize(null);
      setWholeLevelPrefetchReady(false);
    }
  }, [imageUrl]);

  const activeSheetId = activeSheet ? activeSheet.id : null;

  const handleCanvasDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDropGhost(null);
    const signId = e.dataTransfer.getData("signId");
    if (!signId || !imgContainerRef.current || !activeSheet) return;
    // getBoundingClientRect on the image container already accounts for pan/zoom
    // via CSS transform, so (clientX - rect.left) / rect.width is the correct
    // 0-1 fraction even at arbitrary zoom levels.
    const rect = imgContainerRef.current.getBoundingClientRect();
    const finalX = Math.max(0, Math.min(100000, Math.round(((e.clientX - rect.left) / rect.width) * 100000)));
    const finalY = Math.max(0, Math.min(100000, Math.round(((e.clientY - rect.top) / rect.height) * 100000)));
    updateSign.mutate(
      { jobId, signId, data: { markerX: finalX, markerY: finalY, sheetId: activeSheet.id, reason: "Placed via drag-and-drop" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
          toast.success("Sign placed on plan.");
        },
        onError: () => toast.error("Failed to place sign."),
      },
    );
  }, [activeSheet, jobId, updateSign, queryClient]);

  const orderedSheetIdKey = orderedSheets.map((s) => s.id).join(",");

  const neighbourPrefetchUrls = useMemo(() => {
    const urls: string[] = [];

    if (activeSheetId && orderedSheets.length > 1) {
      const idx = orderedSheets.findIndex((s) => s.id === activeSheetId);
      if (idx !== -1) {
        const prev = prevSheetNavRef.current;
        let forwardRadius: number;
        let backwardRadius: number;
        if (prev === null || prev.idx === idx) {
          forwardRadius = SAME_LEVEL_PREFETCH_RADIUS;
          backwardRadius = SAME_LEVEL_PREFETCH_RADIUS;
        } else if (idx > prev.idx) {
          forwardRadius = PREFETCH_AHEAD;
          backwardRadius = PREFETCH_BEHIND;
        } else {
          forwardRadius = PREFETCH_BEHIND;
          backwardRadius = PREFETCH_AHEAD;
        }
        prevSheetNavRef.current = { idx };
        for (let offset = -backwardRadius; offset <= forwardRadius; offset++) {
          if (offset === 0) continue;
          const sheet = orderedSheets[idx + offset];
          if (sheet && sheet.rasterizedPath) {
            urls.push(`/api/storage/objects/${sheet.rasterizedPath.replace(/^\/objects\//, "")}`);
          }
        }
      }
    }

    return urls;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSheetId, orderedSheetIdKey]);

  const wholeLevelPrefetchUrls = useMemo(() => {
    if (!activeSheetId) return [];
    const neighbourSet = new Set(neighbourPrefetchUrls);
    return orderedSheets
      .filter((s) => s.id !== activeSheetId && s.rasterizedPath)
      .map((s) => `/api/storage/objects/${s.rasterizedPath!.replace(/^\/objects\//, "")}`)
      .filter((url) => !neighbourSet.has(url));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSheetId, orderedSheetIdKey, neighbourPrefetchUrls]);

  const prefetchCacheRef = useRef<HTMLImageElement[]>([]);
  const MAX_PREFETCH_CACHE = 50;

  useEffect(() => {
    if (isGuest || neighbourPrefetchUrls.length === 0) return;
    for (const url of neighbourPrefetchUrls) {
      const img = new Image();
      img.fetchPriority = "low";
      img.src = url;
      prefetchCacheRef.current.push(img);
    }
    if (prefetchCacheRef.current.length > MAX_PREFETCH_CACHE) {
      prefetchCacheRef.current = prefetchCacheRef.current.slice(-MAX_PREFETCH_CACHE);
    }
  }, [isGuest, neighbourPrefetchUrls]);

  useEffect(() => {
    if (isGuest || !wholeLevelPrefetchReady || wholeLevelPrefetchUrls.length === 0) return;
    for (const url of wholeLevelPrefetchUrls) {
      const img = new Image();
      img.fetchPriority = "low";
      img.src = url;
      prefetchCacheRef.current.push(img);
    }
    if (prefetchCacheRef.current.length > MAX_PREFETCH_CACHE) {
      prefetchCacheRef.current = prefetchCacheRef.current.slice(-MAX_PREFETCH_CACHE);
    }
  }, [isGuest, wholeLevelPrefetchReady, wholeLevelPrefetchUrls]);

  const handleRetry = () => {
    setImageError(false);
    setRetryCount((c) => c + 1);
  };

  const clearTypeFilter = () => {
    setSelectedTypes(new Set());
    setSelectedSignId(null);
    setSelectedSignData(null);
  };

  const clearStatusFilter = () => {
    setSelectedStatuses(new Set());
    setSelectedSignId(null);
    setSelectedSignData(null);
  };

  const handleSheetChange = useCallback((sheetId: string) => {
    if (transformRef.current?.state) {
      savedScaleRef.current = transformRef.current.state.scale;
    }
    localStorage.setItem(`floor-plan-sheet-${jobId}`, sheetId);
    setSelectedSheetId(sheetId);
    setSelectedSignId(null);
    setSelectedSignData(null);

    setAddMarkerMode(false);
    setDialogOpen(false);
    setPendingMarker(null);
    setPlaceModeSignId(null);
  }, [jobId]);

  const handleAreaClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clampedX = Math.max(0, Math.min(100000, Math.round(((e.clientX - rect.left) / rect.width) * 100000)));
    const clampedY = Math.max(0, Math.min(100000, Math.round(((e.clientY - rect.top) / rect.height) * 100000)));
    // Place mode: position an existing unlocated sign
    if (placeModeSignId) {
      queryClient.setQueryData(
        getListSignsQueryKey(jobId),
        (old: Sign[] | undefined) =>
          old?.map((s) =>
            s.id === placeModeSignId
              ? { ...s, markerX: clampedX, markerY: clampedY, canvasX: clampedX / 100000, canvasY: clampedY / 100000 }
              : s,
          ) ?? old,
      );
      updateSign.mutate(
        {
          jobId,
          signId: placeModeSignId,
          data: { markerX: clampedX, markerY: clampedY, canvasX: clampedX / 100000, canvasY: clampedY / 100000, reason: "Marker placed from room list" },
        },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
            toast.success("Marker placed.");
          },
          onError: () => {
            queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
            toast.error("Failed to place marker.");
          },
        },
      );
      setPlaceModeSignId(null);
      return;
    }
    if (!addMarkerMode) return;
    setPendingMarker({ normalizedX: clampedX, normalizedY: clampedY });
    setNewSignType(SIGN_TYPES[0]);
    setNewQty(1);
    setDialogOpen(true);
  };

  const handleDialogClose = () => {
    setDialogOpen(false);
    setPendingMarker(null);
    setNewRoomNumber("");
    setNewRoomName("");
  };

  const handleSave = () => {
    if (!pendingMarker) return;
    setSaving(true);
    const roomLabel = [newRoomNumber, newRoomName].filter(Boolean).join(" ").trim() || null;
    createSign.mutate(
      {
        jobId,
        data: {
          signType: newSignType,
          qty: newQty,
          markerX: pendingMarker.normalizedX,
          markerY: pendingMarker.normalizedY,
          sheetId: activeSheet?.id,
          roomNumber: newRoomNumber || undefined,
          roomName: newRoomName || undefined,
          reason: "Manual placement on floor plan",
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
          setDialogOpen(false);
          setPendingMarker(null);
          setNewRoomNumber("");
          setNewRoomName("");
          setSaving(false);
          toast.success(
            roomLabel
              ? `${newSignType} sign added for ${roomLabel}`
              : `${newSignType} sign placed on floor plan`,
          );
        },
        onError: () => {
          setSaving(false);
        },
      },
    );
  };

  const handleMarkerClick = (sign: Sign) => {
    if (selectedSignId === sign.id) {
      setSelectedSignId(null);
      setSelectedSignData(null);
    } else {
      setSelectedSignId(sign.id);
      setSelectedSignData(null);
    }
  };

  const handleMarkerRightClick = (e: React.MouseEvent, sign: Sign) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, sign });
  };

  const closeContextMenu = () => setContextMenu(null);

  const pulseMarker = (signId: string) => {
    setPulsingSignId(signId);
    setTimeout(() => setPulsingSignId(null), 900);
  };

  const handleListSignClick = (sign: Sign) => {
    const onDifferentSheet = sign.sheetId && sign.sheetId !== activeSheet?.id;
    if (onDifferentSheet) {
      const targetSheet = relevantSheets.find((s) => s.id === sign.sheetId);
      if (targetSheet) {
        handleSheetChange(sign.sheetId!);
      }
    }
    handleMarkerClick(sign);
    pulseMarker(sign.id);
    if (
      !onDifferentSheet &&
      transformRef.current &&
      transformRef.current.state &&
      imgSize &&
      canvasContainerRef.current
    ) {
      const effPos = getSignEffectivePos(sign, rooms);
      if (!effPos) return;
      const containerW = canvasContainerRef.current.clientWidth;
      const containerH = canvasContainerRef.current.clientHeight;
      const currentScale = transformRef.current.state.scale;
      const scale = currentScale < 1.0 ? 1.5 : currentScale;
      const mx = (effPos.x / 100000) * imgSize.w;
      const my = (effPos.y / 100000) * imgSize.h;
      const posX = containerW / 2 - mx * scale;
      const posY = containerH / 2 - my * scale;
      transformRef.current.setTransform(posX, posY, scale, 400, "easeInOutQuad");
    }
  };

  // When focusRoomId is set from the Room Names tab, navigate to that room's first sign
  useEffect(() => {
    if (!focusRoomId || !allSigns.length) return;
    // Clear any active type/status filters so navigation arrives with a clean state
    clearTypeFilter();
    clearStatusFilter();
    const targetSign = allSigns.find(
      (s) => s.roomId === focusRoomId && getSignEffectivePos(s, rooms) != null
    ) ?? allSigns.find((s) => s.roomId === focusRoomId);
    if (targetSign) {
      // Small delay so the tab switch animation completes before the zoom
      setTimeout(() => {
        handleListSignClick(targetSign);
        onFocusRoomConsumed?.();
      }, 150);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRoomId]);

  // When editRoomId is set (pencil click from Room Names tab), navigate to that
  // room's sheet and open the sign's edit drawer.
  useEffect(() => {
    if (!editRoomId || !allSigns.length) return;
    const targetSign = allSigns.find(
      (s) => s.roomId === editRoomId && getSignEffectivePos(s, rooms) != null
    );
    if (!targetSign) return;
    setTimeout(() => {
      handleListSignClick(targetSign);
      setSelectedSignId(targetSign.id);
      setSelectedSignData(targetSign as Sign);
      onEditRoomClose?.();
    }, 150);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRoomId]);

  const handleSignUpdated = (updated: Sign) => {
    setSelectedSignData(updated);
    queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
  };

  const globalIdx = activeSheet ? orderedSheets.findIndex((s) => s.id === activeSheet.id) : -1;

  const goToPrevSheet = useCallback(() => {
    if (globalIdx > 0) handleSheetChange(orderedSheets[globalIdx - 1].id);
  }, [globalIdx, orderedSheets, handleSheetChange]);

  const goToNextSheet = useCallback(() => {
    if (globalIdx < orderedSheets.length - 1) handleSheetChange(orderedSheets[globalIdx + 1].id);
  }, [globalIdx, orderedSheets, handleSheetChange]);

  // Keyboard shortcuts: ← / → to navigate between floor plan sheets
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key === "ArrowLeft")  { e.preventDefault(); goToPrevSheet(); }
      if (e.key === "ArrowRight") { e.preventDefault(); goToNextSheet(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [goToPrevSheet, goToNextSheet]);

  const fitToCanvas = useCallback(() => {
    if (!transformRef.current) return;
    if (!imgSize || !canvasContainerRef.current) {
      transformRef.current.resetTransform(400, "easeInOutQuad");
      return;
    }
    const containerW = canvasContainerRef.current.clientWidth;
    const containerH = canvasContainerRef.current.clientHeight;

    // Smart fit: if there are placed markers on this sheet, zoom to their bounding box
    // so blank PDF margins are skipped and content fills the canvas.
    const placedWithPos = (sheetSignsRef.current ?? [])
      .map((s) => ({ sign: s, pos: getSignEffectivePos(s, roomsRef.current) }))
      .filter(({ pos }) => pos != null);
    if (placedWithPos.length >= 2) {
      const xs = placedWithPos.map(({ pos }) => (pos!.x / 100000) * imgSize.w);
      const ys = placedWithPos.map(({ pos }) => (pos!.y / 100000) * imgSize.h);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      // Pad 15% of content width/height (min 40px each side) for context
      const padX = Math.max(40, (maxX - minX) * 0.15);
      const padY = Math.max(40, (maxY - minY) * 0.15);
      const contentW = (maxX - minX) + padX * 2;
      const contentH = (maxY - minY) + padY * 2;
      const scale = Math.min(containerW / contentW, containerH / contentH, 4);
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const posX = containerW / 2 - centerX * scale;
      const posY = containerH / 2 - centerY * scale;
      transformRef.current.setTransform(posX, posY, scale, 400, "easeInOutQuad");
      setDisplayScale(scale);
      return;
    }

    // Fallback: fit the full page when no markers are placed yet
    const scaleX = containerW / imgSize.w;
    const scaleY = containerH / imgSize.h;
    const fitScale = Math.min(scaleX, scaleY);
    const posX = Math.max(0, (containerW - imgSize.w * fitScale) / 2);
    const posY = Math.max(0, (containerH - imgSize.h * fitScale) / 2);
    transformRef.current.setTransform(posX, posY, fitScale, 400, "easeInOutQuad");
    setDisplayScale(fitScale);
  }, [imgSize]);

  // ── Search debounce ──────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchQuery), 150);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Auto-focus search input when panel opens
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // Escape / click-outside to close search panel
  useEffect(() => {
    if (!searchOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setSearchOpen(false); setSearchQuery(""); setSearchDebounced(""); }
    };
    const onDown = (e: MouseEvent) => {
      if (searchPanelRef.current && !searchPanelRef.current.contains(e.target as Node)) {
        setSearchOpen(false); setSearchQuery(""); setSearchDebounced("");
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [searchOpen]);

  // Search results (against already-loaded signs cache)
  const searchResults = useMemo(() => {
    const q = searchDebounced.trim().toLowerCase();
    if (!q) return [] as Sign[];
    return (allSigns as Sign[]).filter((s) =>
      !s.isDeleted && (
        (s.signType ?? "").toLowerCase().includes(q) ||
        (s.roomNumber ?? "").toLowerCase().includes(q) ||
        (s.roomName ?? "").toLowerCase().includes(q) ||
        (s.floorLabel ?? "").toLowerCase().includes(q)
      )
    ).slice(0, 21);
  }, [allSigns, searchDebounced]);

  // Pan + pulse to a placed marker
  const panToMarker = useCallback((sign: Sign) => {
    if (!imgSize || !canvasContainerRef.current || !transformRef.current) return;
    if (!sign.markerX || sign.markerX === 50000 || sign.markerY == null) return;
    const containerW = canvasContainerRef.current.clientWidth;
    const containerH = canvasContainerRef.current.clientHeight;
    const pixX = (sign.markerX / 100000) * imgSize.w;
    const pixY = (sign.markerY / 100000) * imgSize.h;
    const scale = 1.5;
    transformRef.current.setTransform(
      containerW / 2 - pixX * scale,
      containerH / 2 - pixY * scale,
      scale, 400, "easeInOutQuad",
    );
    setPulsingSignId(sign.id);
    setTimeout(() => setPulsingSignId(null), 2000);
  }, [imgSize]);

  // Handle clicking a search result
  const handleSearchResultClick = useCallback((sign: Sign) => {
    const isPlaced = sign.markerX != null && sign.markerX !== 50000;
    setSearchOpen(false);
    setSearchQuery("");
    setSearchDebounced("");
    if (isPlaced) {
      panToMarker(sign);
    } else {
      setTrayOpen(true);
      setTrayHighlightId(sign.id);
      setTimeout(() => {
        const el = trayScrollRef.current?.querySelector(`[data-sign-id="${sign.id}"]`) as HTMLElement | null;
        el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      }, 80);
      setTimeout(() => setTrayHighlightId(null), 2000);
    }
  }, [panToMarker]);

  // ── Viewport-culled marker rendering ────────────────────────────────────────
  // MUST be declared before the early loading return — hooks cannot follow
  // conditional returns (Rules of Hooks).
  // cluster mode      — displayScale < 0.20: one count-dot per 8×8 grid cell
  // individual mode   — viewport-filtered, hard cap of 150 DOM nodes
  const _CLUSTER_ZOOM = 0.20;
  const _MAX_MARKERS  = 150;
  const _CLUSTER_GRID = 8;

  type VisibleMarkerEntry =
    | { kind: "individual"; sign: Sign; pixX: number; pixY: number }
    | { kind: "cluster"; id: string; count: number; pixX: number; pixY: number; color: string };

  const visibleMarkers = useMemo((): VisibleMarkerEntry[] => {
    // ── Before first transform fires: render all markers unculled ─────────────
    // imgSize may not be set yet (image still loading) so skip viewport culling
    // entirely and return every non-deleted sign up to the cap. pixX/pixY
    // default to 0 when imgSize is unknown — positions will be corrected once
    // the transform fires and the memo recomputes with real dimensions.
    if (!transformFiredRef.current) {
      return (sheetSigns as Sign[])
        .filter((s) => !s.isDeleted)
        .slice(0, _MAX_MARKERS)
        .map((s) => {
          const pos = imgSize ? getSignEffectivePos(s, rooms) : null;
          return {
            kind: "individual" as const,
            sign: s,
            pixX: pos && imgSize ? ((pos.x ?? 0) / 100000) * imgSize.w : 0,
            pixY: pos && imgSize ? ((pos.y ?? 0) / 100000) * imgSize.h : 0,
          };
        });
    }

    // imgSize not yet known (image still loading but transform already fired):
    // return all non-deleted signs without culling so markers aren't blank
    if (!imgSize) {
      return (sheetSigns as Sign[])
        .filter((s) => !s.isDeleted)
        .slice(0, _MAX_MARKERS)
        .map((s) => ({ kind: "individual" as const, sign: s, pixX: 0, pixY: 0 }));
    }

    // Inline filter (mirrors applyFilters, but runs before the loading guard)
    const base = (sheetSigns as Sign[]).filter((s) => {
      if (selectedTypes.size > 0 && !selectedTypes.has(s.signType)) return false;
      if (selectedStatuses.size > 0 && !selectedStatuses.has(normalizeStatus(s.status))) return false;
      return true;
    });
    if (base.length === 0) return [];

    const withPix = base.map((sign) => {
      const pos = getSignEffectivePos(sign, rooms);
      return {
        sign,
        pixX: ((pos?.x ?? 0) / 100000) * imgSize.w,
        pixY: ((pos?.y ?? 0) / 100000) * imgSize.h,
      };
    });

    // ── Cluster mode ─────────────────────────────────────────────────────────
    if (displayScale < _CLUSTER_ZOOM) {
      const cellW = imgSize.w / _CLUSTER_GRID;
      const cellH = imgSize.h / _CLUSTER_GRID;
      const cells = new Map<string, { count: number; pixX: number; pixY: number; color: string }>();
      for (const { sign, pixX, pixY } of withPix) {
        const cx = Math.min(_CLUSTER_GRID - 1, Math.floor(pixX / cellW));
        const cy = Math.min(_CLUSTER_GRID - 1, Math.floor(pixY / cellH));
        const key = `${cx},${cy}`;
        const existing = cells.get(key);
        if (existing) {
          existing.count++;
        } else {
          cells.set(key, {
            count: 1,
            pixX: (cx + 0.5) * cellW,
            pixY: (cy + 0.5) * cellH,
            color: getMarkerColor(sign.signType, sign.color),
          });
        }
      }
      return Array.from(cells.entries()).map(([key, c]) => ({
        kind: "cluster" as const,
        id: `cluster-${key}`,
        count: c.count,
        pixX: c.pixX,
        pixY: c.pixY,
        color: c.color,
      }));
    }

    // ── Individual mode: viewport cull + 150-node cap ─────────────────────────
    const containerW = canvasContainerRef.current?.clientWidth ?? 800;
    const containerH = canvasContainerRef.current?.clientHeight ?? 600;

    // Viewport bounds in image-pixel space (15% buffer on each side reduces pop-in)
    const vLeft   = (-panOffset.x - containerW * 0.15) / displayScale;
    const vRight  = (-panOffset.x + containerW * 1.15) / displayScale;
    const vTop    = (-panOffset.y - containerH * 0.15) / displayScale;
    const vBottom = (-panOffset.y + containerH * 1.15) / displayScale;

    // Viewport centre for proximity-based priority when over the cap
    const cX = (-panOffset.x + containerW / 2) / displayScale;
    const cY = (-panOffset.y + containerH / 2) / displayScale;

    const inView = withPix.filter(({ sign, pixX, pixY }) => {
      if (sign.id === draggingSignId || sign.id === selectedSignId) return true;
      // Sentinel (unplaced) signs live in the tray — skip canvas render
      const mx = sign.markerX ?? 50000;
      const my = sign.markerY ?? 50000;
      if (mx === 50000 && my === 50000) return false;
      return pixX >= vLeft && pixX <= vRight && pixY >= vTop && pixY <= vBottom;
    });

    if (inView.length <= _MAX_MARKERS) {
      return inView.map(({ sign, pixX, pixY }) => ({ kind: "individual" as const, sign, pixX, pixY }));
    }

    // Over cap: always keep dragging/selected, fill remainder nearest-to-center
    const priority = inView.filter(m => m.sign.id === draggingSignId || m.sign.id === selectedSignId);
    const rest = inView
      .filter(m => m.sign.id !== draggingSignId && m.sign.id !== selectedSignId)
      .sort((a, b) =>
        ((a.pixX - cX) ** 2 + (a.pixY - cY) ** 2) -
        ((b.pixX - cX) ** 2 + (b.pixY - cY) ** 2),
      );
    return [...priority, ...rest.slice(0, _MAX_MARKERS - priority.length)].map(
      ({ sign, pixX, pixY }) => ({ kind: "individual" as const, sign, pixX, pixY }),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSheet?.id, panOffset, displayScale, sheetSigns, imgSize, rooms,
      draggingSignId, selectedSignId, selectedTypes, selectedStatuses]);

  if (loadingSheets || loadingSigns) {
    return (
      <div className="flex justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const typeFilterActive = selectedTypes.size > 0;
  const statusFilterActive = selectedStatuses.size > 0;
  function applyFilters(signs: Sign[]): Sign[] {
    let result = signs;
    if (typeFilterActive) result = result.filter((s) => selectedTypes.has(s.signType));
    if (statusFilterActive) result = result.filter((s) => selectedStatuses.has(normalizeStatus(s.status)));
    return result;
  }

  const scopedSignsBase = !hasRasterizedSheets ? allPlacedSigns : sheetSigns;
  const scopedSignsForStatusCounts = typeFilterActive
    ? scopedSignsBase.filter((s) => selectedTypes.has(s.signType))
    : scopedSignsBase;
  const statusCounts: Record<string, number> = {};
  for (const s of scopedSignsForStatusCounts) {
    const ns = normalizeStatus(s.status);
    statusCounts[ns] = (statusCounts[ns] ?? 0) + 1;
  }
  const scopedSignsForTypeCounts = statusFilterActive
    ? scopedSignsBase.filter((s) => selectedStatuses.has(normalizeStatus(s.status)))
    : scopedSignsBase;
  const typeCounts: Record<string, number> = {};
  for (const s of scopedSignsForTypeCounts) {
    typeCounts[s.signType] = (typeCounts[s.signType] ?? 0) + 1;
  }
  const signSearchLower = signSearch.trim().toLowerCase();

  const baseDisplayedSigns = applyFilters(listSigns);
  const displayedSigns = signSearchLower
    ? baseDisplayedSigns.filter((s) => s.signType.toLowerCase().includes(signSearchLower))
    : baseDisplayedSigns;
  const filteredSheetSigns = applyFilters(sheetSigns);
  const filteredAllPlacedSigns = applyFilters(allPlacedSigns);
  const _unlocatedSigns = (allSigns as Sign[]).filter(
    (s) => !s.isDeleted && getSignEffectivePos(s, rooms) === null,
  );
  const typeOnlySheetSigns = typeFilterActive
    ? sheetSigns.filter((s) => selectedTypes.has(s.signType))
    : sheetSigns;
  const statusOnlySheetSigns = statusFilterActive
    ? sheetSigns.filter((s) => selectedStatuses.has(normalizeStatus(s.status)))
    : sheetSigns;

  const markerCount = displayedSigns.length;

  const draggingSign = draggingSignId
    ? displayedSigns.find((s) => s.id === draggingSignId)
    : null;

  // Room list sidebar derived values
  const roomListSigns = showAllSheets || filteredSheetSigns.length === 0 ? filteredAllPlacedSigns : filteredSheetSigns;
  const roomSearchLower = roomSearch.trim().toLowerCase();
  const filteredRoomListSigns = roomSearchLower
    ? roomListSigns.filter(
        (s) =>
          (s.roomNumber ?? "").toLowerCase().includes(roomSearchLower) ||
          (s.roomName ?? "").toLowerCase().includes(roomSearchLower) ||
          s.signType.toLowerCase().includes(roomSearchLower),
      )
    : roomListSigns;
  const matchingRoomSignIds = new Set(filteredRoomListSigns.map((s) => s.id));

  const placeModeSign = placeModeSignId
    ? (allSigns as Sign[]).find((s) => s.id === placeModeSignId) ?? null
    : null;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Compact Bloomberg-style toolbar ── */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b bg-card flex-shrink-0 flex-wrap">
        {/* Sheet dropdown navigation */}
        {hasRasterizedSheets && orderedSheets.length > 0 && (
          <div className="flex items-center gap-1">
            <button
              onClick={goToPrevSheet}
              disabled={globalIdx <= 0}
              className="h-6 w-6 flex items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Previous sheet (←)"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <div className="relative">
              <select
                value={activeSheet?.id ?? ""}
                onChange={(e) => handleSheetChange(e.target.value)}
                className="h-6 pl-2 pr-6 rounded border border-border text-[11px] font-mono text-foreground bg-background hover:bg-muted transition-colors appearance-none cursor-pointer max-w-[260px]"
                title="Select floor plan sheet (use ← → arrow keys to step through)"
              >
                {Object.entries(
                  orderedSheets.reduce<Record<string, typeof orderedSheets>>((acc, s) => {
                    const lvl = s.level ?? "Unknown";
                    if (!acc[lvl]) acc[lvl] = [];
                    acc[lvl].push(s);
                    return acc;
                  }, {})
                ).map(([lvl, lvlSheets]) => (
                  <optgroup key={lvl} label={lvl}>
                    {lvlSheets.map((sheet) => {
                      const sheetLabel = sheet.sheetId ?? sheet.sheetTitle ?? `Pg ${sheet.pdfPage}`;
                      return (
                        <option key={sheet.id} value={sheet.id}>
                          {sheetLabel} — {sheet.level ?? "Unknown"}
                        </option>
                      );
                    })}
                  </optgroup>
                ))}
              </select>
              <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 text-[9px]">▾</span>
            </div>
            <span className="text-[10px] font-mono text-muted-foreground flex-shrink-0">
              {globalIdx + 1}/{orderedSheets.length}
            </span>
            <button
              onClick={goToNextSheet}
              disabled={globalIdx >= orderedSheets.length - 1}
              className="h-6 w-6 flex items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Next sheet (→)"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Divider */}
        {hasRasterizedSheets && <div className="w-px h-5 bg-border mx-0.5 flex-shrink-0" />}

        {/* Zoom controls */}
        {hasRasterizedSheets && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => transformRef.current?.zoomOut(0.5, 200)}
              className="h-6 w-6 flex items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors font-bold text-sm"
              title="Zoom out"
            >
              −
            </button>
            <span className="text-[11px] font-mono text-muted-foreground w-10 text-center select-none">
              {Math.round(displayScale * 100)}%
            </span>
            <button
              onClick={() => transformRef.current?.zoomIn(0.5, 200)}
              className="h-6 w-6 flex items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors font-bold text-sm"
              title="Zoom in"
            >
              +
            </button>
            <button
              onClick={fitToCanvas}
              className="h-6 px-2 rounded border border-border text-[10px] font-bold text-muted-foreground hover:text-foreground hover:bg-muted transition-colors uppercase tracking-wider ml-0.5 flex items-center gap-1"
              title="Fit to view"
            >
              <Maximize2 className="h-3 w-3" />
              FIT
            </button>
            {filteredSheetSigns.some((s) => getSignEffectivePos(s, rooms) != null) && (
              <button
                onClick={fitToCanvas}
                className="h-6 px-2 rounded border border-border text-[10px] font-semibold text-muted-foreground hover:text-foreground hover:bg-muted transition-colors ml-0.5 flex items-center gap-1"
                title="Zoom to fit all markers on this sheet"
              >
                <ZoomIn className="h-3 w-3" />
                Markers
              </button>
            )}
          </div>
        )}

        {/* Snap to grid (always visible) */}
        <button
          onClick={() => {
            const next = !snapToGrid;
            setSnapToGrid(next);
            localStorage.setItem("floorplan_snap_to_grid", next ? "true" : "false");
          }}
          title="Snap markers to grid intersections while dragging"
          className={[
            "h-6 px-2 rounded border text-[11px] font-mono flex items-center gap-1 transition-colors",
            snapToGrid
              ? "bg-emerald-600 text-white border-emerald-600"
              : "border-border text-muted-foreground hover:border-foreground hover:text-foreground",
          ].join(" ")}
        >
          <Grid3X3 className="h-3 w-3" />
          Snap
        </button>

        {/* Search */}
        <button
          onClick={() => setSearchOpen((v) => !v)}
          title="Search rooms and signs"
          className={[
            "h-6 w-6 flex items-center justify-center rounded border transition-colors",
            searchOpen
              ? "bg-amber-500 text-white border-amber-500"
              : "border-border text-muted-foreground hover:border-foreground hover:text-foreground",
          ].join(" ")}
        >
          <Search className="h-3 w-3" />
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Marker count + Add Marker */}
        <Badge variant="secondary" className="text-[10px] font-mono">
          {markerCount} marker{markerCount !== 1 ? "s" : ""}
        </Badge>
        <Button
          variant={addMarkerMode ? "default" : "outline"}
          size="sm"
          onClick={() => setAddMarkerMode((v) => !v)}
          className={`h-6 text-xs px-2 ${addMarkerMode ? "bg-blue-600 hover:bg-blue-700 text-white border-blue-600" : ""}`}
        >
          <MapPin className="h-3 w-3 mr-1" />
          {addMarkerMode ? "Cancel Placement" : "+ Add Marker"}
        </Button>
      </div>


      {showDragHint && markerCount > 0 && (
        <div
          className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/40 px-3 py-2 text-sm text-blue-800 dark:text-blue-300 flex-shrink-0"
          style={{
            opacity: dragHintDismissing ? 0 : 1,
            transform: dragHintDismissing ? "translateY(-4px)" : "translateY(0)",
            transition: prefersReducedMotion ? undefined : "opacity 250ms ease-in-out, transform 250ms ease-in-out",
          }}
        >
          <GripHorizontal className="h-4 w-4 flex-shrink-0 opacity-70" />
          <span className="flex-1">
            <strong className="font-semibold">Tip:</strong> You can drag any marker to reposition it on the floor plan.
          </span>
          <button
            onClick={dismissDragHint}
            className="ml-1 rounded p-0.5 hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors text-blue-600 dark:text-blue-400"
            aria-label="Dismiss hint"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {typeFilterActive && hasRasterizedSheets && !showAllSheets && activeSheet !== null && typeOnlySheetSigns.length === 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300 flex-shrink-0">
          <span className="flex-1">
            {selectedTypes.size === 1
              ? <>No <strong className="font-semibold">'{[...selectedTypes][0]}'</strong> signs on this sheet.</>
              : <>No signs matching the selected type filter on this sheet.</>
            }
          </span>
          <button
            onClick={clearTypeFilter}
            className="ml-1 text-xs font-semibold underline underline-offset-2 hover:no-underline text-amber-700 dark:text-amber-400 whitespace-nowrap shrink-0"
          >
            Clear filter
          </button>
        </div>
      )}

      {statusFilterActive && hasRasterizedSheets && !showAllSheets && activeSheet !== null && statusOnlySheetSigns.length === 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300 flex-shrink-0">
          <span className="flex-1">
            {selectedStatuses.size === 1
              ? <>No <strong className="font-semibold">'{STATUS_LABELS[[...selectedStatuses][0]] ?? [...selectedStatuses][0]}'</strong> signs on this sheet.</>
              : <>No signs matching the selected status filter on this sheet.</>
            }
          </span>
          <button
            onClick={clearStatusFilter}
            className="ml-1 text-xs font-semibold underline underline-offset-2 hover:no-underline text-amber-700 dark:text-amber-400 whitespace-nowrap shrink-0"
          >
            Clear filter
          </button>
        </div>
      )}

      {/* Place mode banner */}
      {placeModeSign && (
        <div className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white text-sm flex-shrink-0">
          <MapPin className="h-4 w-4 flex-shrink-0 animate-bounce" />
          <span className="flex-1">
            Click anywhere on the plan to place{" "}
            <strong>
              {[placeModeSign.roomNumber, placeModeSign.roomName].filter(Boolean).join(" — ") || placeModeSign.signType}
            </strong>
          </span>
          <button
            onClick={() => setPlaceModeSignId(null)}
            className="flex items-center gap-1 rounded border border-white/40 px-2 py-0.5 text-xs hover:bg-white/20 transition-colors flex-shrink-0"
          >
            <X className="h-3 w-3" />
            Cancel
          </button>
        </div>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* ── RIGHT: Room Editor ── */}
        <div className="w-72 border-l flex flex-col min-h-0 flex-shrink-0 bg-card" style={{ order: 2 }}>
          {selectedSign ? (
            /* State B — marker selected */
            <div className="flex flex-col flex-1 min-h-0">
              <div className="px-3 py-2 border-b flex-shrink-0 flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Room Editor</span>
                <button
                  onClick={() => { setSelectedSignId(null); setSelectedSignData(null); }}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Close"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
                {/* Room Number */}
                <div className="flex flex-col gap-1">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Room Number</Label>
                  <Input
                    value={editorRoomNumber}
                    onChange={(e) => setEditorRoomNumber(e.target.value)}
                    placeholder="e.g. A215"
                    className="h-7 text-xs font-mono"
                  />
                </div>
                {/* Sign Type */}
                <div className="flex flex-col gap-1">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Sign Type</Label>
                  <Select value={editorSignType} onValueChange={setEditorSignType}>
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ADA_CANONICAL_SIGN_TYPES.map((t) => (
                        <SelectItem key={t} value={t} className="text-xs">
                          <div className="flex items-center gap-2">
                            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: getMarkerColor(t) }} />
                            {t}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {/* Marker Color */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Marker Color</Label>
                  <div className="flex gap-2 flex-wrap">
                    {[
                      "#F59E0B", "#EF4444", "#22C55E", "#3B82F6",
                      "#8B5CF6", "#64748B", "#14B8A6", "#F97316",
                    ].map((hex) => {
                      const isActive = editorMarkerColor.toLowerCase() === hex.toLowerCase();
                      return (
                        <button
                          key={hex}
                          title={hex}
                          onClick={() => setEditorMarkerColor(hex)}
                          className="w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 flex items-center justify-center"
                          style={{
                            backgroundColor: hex,
                            borderColor: isActive ? "white" : "transparent",
                            boxShadow: isActive ? `0 0 0 2px ${hex}` : undefined,
                          }}
                        >
                          {isActive && <Check className="h-3 w-3 text-white" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {/* Floor Label */}
                <div className="flex flex-col gap-1">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Floor Label</Label>
                  <Input
                    value={editorFloorLabel}
                    onChange={(e) => setEditorFloorLabel(e.target.value)}
                    placeholder="e.g. LEVEL 1"
                    className="h-7 text-xs"
                  />
                </div>
              </div>
              <div className="px-3 py-3 border-t flex-shrink-0 space-y-2">
                <Button
                  size="sm"
                  className="w-full h-7 text-xs"
                  disabled={updateSign.isPending}
                  onClick={() => {
                    updateSign.mutate(
                      {
                        jobId,
                        signId: selectedSign.id,
                        data: {
                          roomNumber: editorRoomNumber || undefined,
                          signType: editorSignType || selectedSign.signType,
                          markerColor: editorMarkerColor || undefined,
                          floorLabel: editorFloorLabel || undefined,
                          reason: "Room editor update",
                        },
                      },
                      {
                        onSuccess: (updated) => {
                          handleSignUpdated(updated);
                          toast.success("Changes saved.");
                        },
                        onError: () => toast.error("Failed to save changes."),
                      },
                    );
                  }}
                >
                  {updateSign.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Check className="h-3 w-3 mr-1" />}
                  Save Changes
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full h-7 text-xs text-muted-foreground hover:text-destructive"
                  disabled={updateSign.isPending}
                  onClick={() => {
                    updateSign.mutate(
                      {
                        jobId,
                        signId: selectedSign.id,
                        data: { markerX: null, markerY: null, sheetId: null, reason: "Removed from plan" },
                      },
                      {
                        onSuccess: () => {
                          queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
                          setSelectedSignId(null);
                          setSelectedSignData(null);
                          toast.success("Marker removed — tag returned to tray.");
                        },
                        onError: () => toast.error("Failed to remove marker."),
                      },
                    );
                  }}
                >
                  <Trash2 className="h-3 w-3 mr-1" />
                  Remove from plan
                </Button>
              </div>
            </div>
          ) : (
            /* State A — nothing selected */
            <div className="flex flex-col flex-1 min-h-0">
              <div className="px-3 py-2 border-b flex-shrink-0">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Room Editor</span>
              </div>
              <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-4">
                <MapPin className="h-10 w-10 text-muted-foreground/30" />
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Click any marker on the plan to edit it</p>
                  <p className="text-xs text-muted-foreground/60">Or drag a room from the tray below to place it</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── CENTER: Floor plan canvas ── */}
        <div
          ref={canvasContainerRef}
          className="flex-1 bg-muted/20 overflow-hidden relative border-y"
          style={{ minHeight: 0, order: 1 }}
        >

          {/* Drop ghost — follows cursor while dragging a tray tag over the canvas */}
          {dropGhost && (
            <div
              className="pointer-events-none absolute z-[999]"
              style={{
                left: dropGhost.x - 20,
                top: dropGhost.y - 10,
                width: 48,
                height: 20,
                background: "rgba(245,159,11,0.4)",
                border: "2px dashed #F59E0B",
                borderRadius: 3,
              }}
            />
          )}

          {/* ── Search panel overlay ── */}
          {searchOpen && (
            <div
              ref={searchPanelRef}
              className="absolute top-2 left-2 z-50 w-96 bg-card border border-border rounded-lg shadow-xl overflow-hidden"
            >
              {/* Input row */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                <Search className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search rooms, signs, labels…"
                  className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-muted-foreground/50"
                />
                <button
                  onClick={() => { setSearchOpen(false); setSearchQuery(""); setSearchDebounced(""); }}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Close search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Results list */}
              <div className="max-h-64 overflow-y-auto">
                {searchDebounced.trim() === "" ? (
                  <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                    Type to search rooms and signs…
                  </div>
                ) : searchResults.length === 0 ? (
                  <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                    No results for &ldquo;{searchDebounced}&rdquo;
                  </div>
                ) : (
                  <>
                    {searchResults.slice(0, 20).map((sign) => {
                      const isPlaced = sign.markerX != null && sign.markerX !== 50000;
                      const label = [sign.roomNumber, sign.roomName].filter(Boolean).join(" ") || sign.signType;
                      return (
                        <button
                          key={sign.id}
                          onClick={() => handleSearchResultClick(sign)}
                          className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-muted/50 transition-colors border-b border-border/30 last:border-0"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-mono font-bold truncate">{label}</div>
                            <div className="text-[10px] text-muted-foreground truncate">{sign.signType}</div>
                          </div>
                          <div className="text-[10px] text-muted-foreground/70 flex-shrink-0 font-mono">
                            {sign.floorLabel ?? sign.level ?? ""}
                          </div>
                          {isPlaced
                            ? <MapPin className="h-3 w-3 text-amber-500 flex-shrink-0" />
                            : <div className="h-3 w-3 rounded border border-dashed border-amber-500/60 flex-shrink-0" />}
                        </button>
                      );
                    })}
                    {searchResults.length > 20 && (
                      <div className="px-4 py-2 text-center text-[10px] text-muted-foreground border-t border-border">
                        {searchResults.length - 20} more — refine your search
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {draggingSignId && shiftHeldDuringDrag && (
            <div
              className="absolute bottom-3 left-1/2 -translate-x-1/2 z-50 pointer-events-none flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold shadow-md border"
              style={{
                backgroundColor: snapToGrid ? "rgb(239 68 68 / 0.92)" : "rgb(16 185 129 / 0.92)",
                borderColor: snapToGrid ? "rgb(220 38 38)" : "rgb(5 150 105)",
                color: "white",
              }}
            >
              {snapToGrid ? "Snap OFF" : "Snap ON"}
            </div>
          )}
          {!imageError && (
            <div
              className="absolute inset-0 flex items-center justify-center bg-black/60 z-20 pointer-events-none"
              style={{ opacity: (imgLoading || imgFetching) ? 1 : 0, transition: 'opacity 0.3s ease' }}
            >
              <Loader2 className="h-8 w-8 animate-spin text-white" />
            </div>
          )}
          {hasRasterizedSheets && imageUrl ? (
            <TransformWrapper
              ref={transformRef}
              initialScale={1}
              minScale={0.05}
              maxScale={10}
              smooth={false}
              disabled={addMarkerMode || draggingSignId !== null}
              panning={{ disabled: addMarkerMode || draggingSignId !== null }}
              pinch={{ disabled: addMarkerMode || draggingSignId !== null }}
              wheel={{
                disabled: addMarkerMode || draggingSignId !== null,
                step: 0.1,
              }}
              onTransform={(_ref: ReactZoomPanPinchRef, state: { scale: number; positionX: number; positionY: number }) => {
                transformFiredRef.current = true;
                setDisplayScale(state.scale);
                setPanOffset((prev) =>
                  prev.x === state.positionX && prev.y === state.positionY
                    ? prev
                    : { x: state.positionX, y: state.positionY },
                );
              }}
            >
              <TransformComponent wrapperClass="!w-full !h-full" contentClass="">
                <div
                  className="relative inline-block"
                  ref={imgContainerRef}
                  onClick={handleAreaClick}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const rect = canvasContainerRef.current?.getBoundingClientRect();
                    if (rect) setDropGhost({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                  }}
                  onDragLeave={() => setDropGhost(null)}
                  onDrop={handleCanvasDrop}
                  style={{ cursor: addMarkerMode ? "crosshair" : "default" }}
                >
                    {imageError && (
                      <div className="flex flex-col items-center justify-center gap-3 p-10 text-center min-w-[320px]">
                        <ImageOff className="h-10 w-10 text-muted-foreground" />
                        <p className="text-sm font-medium text-foreground">
                          Floor plan image could not be loaded.
                        </p>
                        {retryCount >= 3 ? (
                          <>
                            <p className="text-xs text-muted-foreground">
                              The image has failed to load multiple times. The file may be missing or corrupted — re-processing the job should regenerate it.
                            </p>
                            <div className="flex gap-2 mt-1">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={handleRetry}
                                className="gap-2"
                              >
                                <RefreshCw className="h-4 w-4" />
                                Retry
                              </Button>
                              <Button
                                size="sm"
                                onClick={() =>
                                  processJob.mutate(
                                    { jobId },
                                    {
                                      onSuccess: () =>
                                        toast.success("Job re-processing started."),
                                      onError: () =>
                                        toast.error("Failed to start re-processing."),
                                    }
                                  )
                                }
                                disabled={processJob.isPending}
                                className="gap-2"
                              >
                                {processJob.isPending ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-4 w-4" />
                                )}
                                Re-process Job
                              </Button>
                            </div>
                          </>
                        ) : (
                          <>
                            <p className="text-xs text-muted-foreground">
                              The file may be temporarily unavailable. Try again or re-process the job if the problem persists.
                            </p>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleRetry}
                              className="mt-1 gap-2"
                            >
                              <RefreshCw className="h-4 w-4" />
                              Retry
                            </Button>
                          </>
                        )}
                      </div>
                    )}

                    {!imageError && displayImageUrl && (
                      <img
                        src={displayImageUrl}
                        alt={activeSheet?.sheetTitle ?? "Floor plan"}
                        className="block max-w-none select-none"
                        draggable={false}
                        style={{ opacity: (imgLoading || imgFetching) ? 0 : 1, transition: 'opacity 0.3s ease' }}
                        onLoad={(e) => {
                          const img = e.currentTarget;
                          const naturalW = img.naturalWidth;
                          const naturalH = img.naturalHeight;
                          setImgSize({ w: naturalW, h: naturalH });
                          setImgLoading(false);
                          setWholeLevelPrefetchReady(true);
                          setTimeout(() => {
                            if (!transformRef.current?.instance) return;
                            if (savedScaleRef.current != null) {
                              const scale = savedScaleRef.current;
                              savedScaleRef.current = null;
                              transformRef.current.centerView(scale, 0);
                            } else if (canvasContainerRef.current) {
                              const containerW = canvasContainerRef.current.clientWidth;
                              const containerH = canvasContainerRef.current.clientHeight;
                              const fitScale = Math.min(4.0, Math.max(0.3, Math.min(
                                containerW / naturalW,
                                containerH / naturalH,
                              )));
                              transformRef.current.centerView(fitScale, 0);
                            }
                          }, 0);
                        }}
                        onError={() => {
                          savedScaleRef.current = null;
                          setImgLoading(false);
                          setImageError(true);
                          setImgSize(null);
                        }}
                      />
                    )}

                    {!imageError && imgSize &&
                      visibleMarkers.map((entry) => {
                        // ── Cluster dot (low-zoom mode) ──────────────────────
                        if (entry.kind === "cluster") {
                          return (
                            <div
                              key={entry.id}
                              className="pointer-events-none absolute"
                              style={{
                                left: `${entry.pixX}px`,
                                top: `${entry.pixY}px`,
                                transform: "translate(-50%, -50%)",
                                zIndex: 10,
                              }}
                            >
                              <div style={{
                                width: 36,
                                height: 36,
                                borderRadius: "50%",
                                background: "#F59E0B",
                                border: "2px solid white",
                                boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                color: "white",
                                fontWeight: "bold",
                                fontSize: entry.count >= 100 ? 9 : entry.count >= 10 ? 11 : 13,
                              }}>
                                {entry.count}
                              </div>
                            </div>
                          );
                        }

                        // ── Individual marker ────────────────────────────────
                        const { sign } = entry;
                        const isDraggingThis = draggingSignId === sign.id;
                        const isPulsing = pulsingSignId === sign.id;
                        const left = isDraggingThis && dragNormPos
                          ? (dragNormPos.x / 100000) * imgSize.w
                          : entry.pixX;
                        const top = isDraggingThis && dragNormPos
                          ? (dragNormPos.y / 100000) * imgSize.h
                          : entry.pixY;
                        const isSelected = sign.id === selectedSignId;
                        const ns = normalizeStatus(sign.status);
                        const isDismissed = ns === "rejected";
                        const isNeedsReview = ns === "needs_review";
                        const isLowConf = (sign.confidence ?? 0) < 0.60;
                        const color = isDismissed ? "#6b7280" : (sign.markerColor ?? getMarkerColor(sign.signType, sign.color));
                        const borderColor = darkenHex(isDismissed ? "#6b7280" : color);
                        const baseOpacity = isDismissed ? 0.4 : getConfidenceOpacity(sign.confidence);
                        const opacity = baseOpacity * (roomSearchLower && !matchingRoomSignIds.has(sign.id) ? 0.2 : 1);
                        const useDash = isNeedsReview || isLowConf;
                        const roomLabel = [sign.roomNumber, sign.roomName].filter(Boolean).join(" — ");
                        const circleLabel = (sign.roomNumber ?? "").slice(0, 4) || (SIGN_ABBREV[sign.signType] ?? sign.signType.slice(0, 3).toUpperCase());
                        const scaleFactor = isDraggingThis ? 1.3 : isPulsing ? 1.2 : 1;
                        return (
                          <div
                            key={sign.id}
                            className="group absolute"
                            style={{
                              left: `${left}px`,
                              top: `${top}px`,
                              transform: `translate(-50%, -50%) scale(${scaleFactor})`,
                              zIndex: isDraggingThis ? 20 : isSelected ? 15 : 10,
                              transition: isDraggingThis ? "none" : "transform 0.15s ease",
                              opacity,
                            }}
                          >
                            <Popover open={isSelected && !isDraggingThis} onOpenChange={(open) => { if (!open) { setSelectedSignId(null); setSelectedSignData(null); } }}>
                              <PopoverTrigger asChild>
                                <button
                                  data-sign-id={sign.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (!addMarkerMode && !hasDraggedRef.current) {
                                      handleMarkerClick(sign);
                                    }
                                  }}
                                  onContextMenu={(e) => handleMarkerRightClick(e, sign)}
                                  onPointerDown={(e) => handleMarkerPointerDown(e, sign.id)}
                                  onPointerMove={(e) => handleMarkerPointerMove(e, imgContainerRef)}
                                  onPointerUp={(e) => handleMarkerPointerUp(e, sign.id)}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    padding: 0,
                                    background: "transparent",
                                    border: "none",
                                    cursor: placeModeSignId ? "crosshair" : addMarkerMode ? "crosshair" : isDraggingThis ? "grabbing" : "grab",
                                  }}
                                >
                                    {displayScale < 0.25 ? (
                                    /* Tiny coloured square at very low zoom — no text */
                                    <div style={{
                                      width: 6,
                                      height: 6,
                                      backgroundColor: color,
                                      borderRadius: 1,
                                      boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
                                    }} />
                                  ) : (
                                    /* Rectangular label tag — colour bar + text body */
                                    <div style={{ display: "flex", alignItems: "stretch", gap: 0 }}>
                                      <div style={{
                                        width: 4,
                                        height: 20,
                                        backgroundColor: color,
                                        borderRadius: "2px 0 0 2px",
                                        flexShrink: 0,
                                      }} />
                                      <div style={{
                                        backgroundColor: color,
                                        color: "#FFFFFF",
                                        fontSize: 10,
                                        fontWeight: 700,
                                        fontFamily: "'IBM Plex Mono', monospace",
                                        padding: "2px 5px",
                                        borderRadius: "0 2px 2px 0",
                                        whiteSpace: "nowrap",
                                        maxWidth: 72,
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        lineHeight: "16px",
                                        boxShadow: isPulsing
                                          ? `0 0 0 4px ${color}44, 0 2px 8px rgba(0,0,0,0.5)`
                                          : isSelected
                                            ? "0 2px 8px rgba(0,0,0,0.5)"
                                            : "0 1px 3px rgba(0,0,0,0.4)",
                                        outline: isSelected ? `2px solid white` : useDash ? `2px dashed ${borderColor}` : "none",
                                        outlineOffset: isSelected ? 1 : 1,
                                        transform: isSelected ? "scale(1.15)" : isDraggingThis ? "scale(1.3)" : isPulsing ? "scale(1.2)" : "none",
                                        transition: isDraggingThis ? "none" : "transform 0.15s ease, box-shadow 0.2s ease",
                                        opacity: isDismissed ? 0.6 : useDash ? 0.75 : 1,
                                      }}>
                                        {circleLabel}
                                      </div>
                                    </div>
                                  )}
                                </button>
                              </PopoverTrigger>
                              <PopoverContent side="top" className="p-3 w-56" onOpenAutoFocus={(e) => e.preventDefault()}>
                                <div className="space-y-2">
                                  <div>
                                    <div className="text-xs font-bold leading-tight">{roomLabel || sign.signType}</div>
                                    {roomLabel && <div className="text-[11px] text-muted-foreground mt-0.5">{sign.signType}</div>}
                                  </div>
                                  <div className="space-y-1 text-[11px]">
                                    <div className="flex items-center justify-between">
                                      <span className="text-muted-foreground">Qty</span>
                                      <span className="font-medium">{sign.qty}</span>
                                    </div>
                                    {sign.dimensions && (
                                      <div className="flex items-center justify-between">
                                        <span className="text-muted-foreground">Dims</span>
                                        <span className="font-medium truncate max-w-[120px]">{sign.dimensions}</span>
                                      </div>
                                    )}
                                    <div className="flex items-center justify-between">
                                      <span className="text-muted-foreground">Confidence</span>
                                      <span className="font-medium" style={{ color: (sign.confidence ?? 0) >= 0.80 ? "#16a34a" : (sign.confidence ?? 0) >= 0.60 ? "#d97706" : "#9ca3af" }}>
                                        {Math.round((sign.confidence ?? 0) * 100)}%
                                      </span>
                                    </div>
                                    {sign.floorLabel && (
                                      <div className="flex items-center justify-between">
                                        <span className="text-muted-foreground">Floor</span>
                                        <span className="font-medium">{sign.floorLabel}</span>
                                      </div>
                                    )}
                                    <div className="flex items-center justify-between">
                                      <span className="text-muted-foreground">Source</span>
                                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted">{sign.source}</span>
                                    </div>
                                  </div>
                                </div>
                              </PopoverContent>
                            </Popover>
                          </div>
                        );
                      })}

                    {!imageError && imgSize && draggingSignId && dragNormPos && (
                      <>
                        <div
                          className="pointer-events-none absolute"
                          style={{
                            left: 0,
                            right: 0,
                            top: `${(dragNormPos.y / 100000) * imgSize.h}px`,
                            height: "1px",
                            background: "rgba(59,130,246,0.55)",
                            zIndex: 25,
                          }}
                        />
                        <div
                          className="pointer-events-none absolute"
                          style={{
                            top: 0,
                            bottom: 0,
                            left: `${(dragNormPos.x / 100000) * imgSize.w}px`,
                            width: "1px",
                            background: "rgba(59,130,246,0.55)",
                            zIndex: 25,
                          }}
                        />
                        <div
                          className="pointer-events-none absolute"
                          style={{
                            left: `${(dragNormPos.x / 100000) * imgSize.w}px`,
                            top: `${(dragNormPos.y / 100000) * imgSize.h}px`,
                            transform: "translate(-50%, -50%)",
                            zIndex: 30,
                          }}
                        >
                          <div
                            className="w-7 h-7 rounded-full border-2 border-white shadow-lg"
                            style={{
                              background: draggingSign?.color ?? "#6b7280",
                              opacity: 0.9,
                            }}
                          />
                          <div
                            className="absolute left-1/2 mt-1 whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-mono font-semibold text-white shadow"
                            style={{
                              transform: "translateX(-50%)",
                              background: "rgba(15,23,42,0.82)",
                              top: "100%",
                            }}
                          >
                            x: {dragNormPos.x}, y: {dragNormPos.y}
                          </div>
                        </div>
                      </>
                    )}

                    {!imageError && dialogOpen && pendingMarker && imgSize && (
                      <div
                        className="pointer-events-none absolute"
                        style={{
                          left: `${(pendingMarker.normalizedX / 100000) * imgSize.w}px`,
                          top: `${(pendingMarker.normalizedY / 100000) * imgSize.h}px`,
                          transform: "translate(-50%, -50%)",
                        }}
                      >
                        <div className="w-7 h-7 rounded-full border-2 border-white bg-blue-500 shadow-md animate-pulse" />
                      </div>
                    )}
                </div>
              </TransformComponent>
            </TransformWrapper>
          ) : (
            <div
              ref={gridContainerRef}
              className="w-full h-full relative"
              style={{ cursor: addMarkerMode ? "crosshair" : "default" }}
              onClick={handleAreaClick}
            >
              <div
                className="absolute inset-0"
                style={{
                  backgroundImage:
                    "linear-gradient(rgba(100,116,139,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(100,116,139,0.1) 1px, transparent 1px)",
                  backgroundSize: "40px 40px",
                  backgroundColor: "#f8fafc",
                }}
              />
              {filteredAllPlacedSigns.map((sign, unposIdx) => {
                const isDraggingThis = draggingSignId === sign.id;
                const isPulsing = pulsingSignId === sign.id;
                const effectivePos = getSignEffectivePos(sign, rooms);
                const normX = isDraggingThis && dragNormPos ? dragNormPos.x : (effectivePos?.x ?? 20);
                const normY = isDraggingThis && dragNormPos ? dragNormPos.y : (effectivePos?.y ?? Math.min(960, 30 + unposIdx * 55));
                const left = (normX / 100000) * 100;
                const top = (normY / 100000) * 100;
                const isSelected = sign.id === selectedSignId;
                const ns = normalizeStatus(sign.status);
                const isDismissed = ns === "rejected";
                const isNeedsReview = ns === "needs_review";
                const isLowConf = (sign.confidence ?? 0) < 0.60;
                const color = isDismissed ? "#6b7280" : (sign.markerColor ?? getMarkerColor(sign.signType, sign.color));
                const borderColor = darkenHex(isDismissed ? "#6b7280" : color);
                const opacity = isDismissed ? 0.4 : getConfidenceOpacity(sign.confidence);
                const useDash = isNeedsReview || isLowConf;
                const abbrev = SIGN_ABBREV[sign.signType] ?? sign.signType.slice(0, 3).toUpperCase();
                const rowNum = signRowNumbers.get(sign.id) ?? "";
                const location = [sign.roomNumber, sign.roomName].filter(Boolean).join(" ");
                const scaleFactor = isDraggingThis ? 1.3 : isPulsing ? 1.2 : 1;
                return (
                  <div
                    key={sign.id}
                    className="group absolute"
                    style={{
                      left: `${left}%`,
                      top: `${top}%`,
                      transform: `translate(-50%, -50%) scale(${scaleFactor})`,
                      cursor: isDraggingThis ? "grabbing" : "grab",
                      transition: isDraggingThis ? "none" : "transform 0.15s ease",
                      zIndex: isDraggingThis ? 20 : isSelected ? 15 : undefined,
                      opacity,
                    }}
                  >
                    <Popover open={isSelected && !isDraggingThis} onOpenChange={(open) => { if (!open) { setSelectedSignId(null); setSelectedSignData(null); } }}>
                      <PopoverTrigger asChild>
                        <button
                          data-sign-id={sign.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!addMarkerMode && !hasDraggedRef.current) handleMarkerClick(sign);
                          }}
                          onContextMenu={(e) => handleMarkerRightClick(e, sign)}
                          onPointerDown={(e) => handleMarkerPointerDown(e, sign.id)}
                          onPointerMove={(e) => handleMarkerPointerMove(e, gridContainerRef)}
                          onPointerUp={(e) => handleMarkerPointerUp(e, sign.id)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            padding: 0,
                            background: "transparent",
                            border: "none",
                            cursor: isDraggingThis ? "grabbing" : addMarkerMode ? "crosshair" : "grab",
                          }}
                        >
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: "50%",
                          background: color,
                          border: isSelected
                            ? "3px solid white"
                            : `2px ${useDash ? "dashed" : "solid"} ${borderColor}`,
                          boxShadow: isPulsing
                            ? `0 0 0 6px ${color}44, 0 0 0 3px white`
                            : isSelected
                              ? `0 0 0 3px white, 0 0 0 5px ${color}`
                              : "0 2px 6px rgba(0,0,0,0.35)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "white",
                          fontWeight: "bold",
                          fontSize: 11,
                          flexShrink: 0,
                          zIndex: 1,
                          transition: isDraggingThis ? "none" : "box-shadow 0.2s ease",
                        }}
                      >
                        {rowNum}
                      </div>
                      <div
                        style={{
                          marginLeft: -2,
                          background: color,
                          border: `2px ${useDash ? "dashed" : "solid"} ${borderColor}`,
                          borderLeft: "none",
                          borderRadius: "0 4px 4px 0",
                          paddingLeft: 4,
                          paddingRight: 5,
                          height: 20,
                          display: "flex",
                          alignItems: "center",
                          color: "white",
                          fontSize: 10,
                          fontWeight: 600,
                          letterSpacing: "0.02em",
                          whiteSpace: "nowrap",
                          userSelect: "none",
                        }}
                      >
                        {sign.roomNumber ?? abbrev}
                      </div>
                        </button>
                      </PopoverTrigger>
                      <PopoverContent side="top" className="p-3 w-56" onOpenAutoFocus={(e) => e.preventDefault()}>
                        <div className="space-y-2">
                          <div>
                            <div className="text-xs font-bold leading-tight">{location || sign.signType}</div>
                            {location && <div className="text-[11px] text-muted-foreground mt-0.5">{sign.signType}</div>}
                          </div>
                          <div className="space-y-1 text-[11px]">
                            <div className="flex items-center justify-between">
                              <span className="text-muted-foreground">Qty</span>
                              <span className="font-medium">{sign.qty}</span>
                            </div>
                            {sign.dimensions && (
                              <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">Dims</span>
                                <span className="font-medium truncate max-w-[120px]">{sign.dimensions}</span>
                              </div>
                            )}
                            <div className="flex items-center justify-between">
                              <span className="text-muted-foreground">Confidence</span>
                              <span className="font-medium" style={{ color: (sign.confidence ?? 0) >= 0.80 ? "#16a34a" : (sign.confidence ?? 0) >= 0.60 ? "#d97706" : "#9ca3af" }}>
                                {Math.round((sign.confidence ?? 0) * 100)}%
                              </span>
                            </div>
                            {sign.floorLabel && (
                              <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">Floor</span>
                                <span className="font-medium">{sign.floorLabel}</span>
                              </div>
                            )}
                            <div className="flex items-center justify-between">
                              <span className="text-muted-foreground">Source</span>
                              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted">{sign.source}</span>
                            </div>
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                );
              })}
              {draggingSignId && dragNormPos && (
                <>
                  {snapToGrid && (
                    <div
                      className="pointer-events-none absolute"
                      style={{
                        left: `${(dragNormPos.x / 100000) * 100}%`,
                        top: `${(dragNormPos.y / 100000) * 100}%`,
                        transform: "translate(-50%, -50%)",
                        zIndex: 20,
                      }}
                    >
                      <div
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: "50%",
                          border: "2.5px solid rgba(59,130,246,0.9)",
                          background: "rgba(59,130,246,0.18)",
                          boxShadow: "0 0 0 3px rgba(59,130,246,0.18)",
                        }}
                      />
                    </div>
                  )}
                  <div
                    className="pointer-events-none absolute"
                    style={{
                      left: 0,
                      right: 0,
                      top: `${(dragNormPos.y / 100000) * 100}%`,
                      height: "1px",
                      background: "rgba(59,130,246,0.55)",
                      zIndex: 25,
                    }}
                  />
                  <div
                    className="pointer-events-none absolute"
                    style={{
                      top: 0,
                      bottom: 0,
                      left: `${(dragNormPos.x / 100000) * 100}%`,
                      width: "1px",
                      background: "rgba(59,130,246,0.55)",
                      zIndex: 25,
                    }}
                  />
                  <div
                    className="pointer-events-none absolute"
                    style={{
                      left: `${(dragNormPos.x / 100000) * 100}%`,
                      top: `${(dragNormPos.y / 100000) * 100}%`,
                      transform: "translate(-50%, -50%)",
                      zIndex: 30,
                    }}
                  >
                    <div
                      className="w-6 h-6 rounded-full border-2 border-white shadow-lg"
                      style={{
                        background: draggingSign?.color ?? "#6b7280",
                        opacity: 0.9,
                      }}
                    />
                    <div
                      className="absolute left-1/2 mt-1 whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-mono font-semibold text-white shadow"
                      style={{
                        transform: "translateX(-50%)",
                        background: "rgba(15,23,42,0.82)",
                        top: "100%",
                      }}
                    >
                      x: {dragNormPos.x}, y: {dragNormPos.y}
                    </div>
                  </div>
                </>
              )}
              {dialogOpen && pendingMarker && (
                <div
                  className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none"
                  style={{
                    left: `${(pendingMarker.normalizedX / 100000) * 100}%`,
                    top: `${(pendingMarker.normalizedY / 100000) * 100}%`,
                  }}
                >
                  <div className="w-6 h-6 rounded-full border-2 border-white bg-blue-500 shadow-md animate-pulse" />
                </div>
              )}
              <div className="absolute bottom-4 left-0 right-0 flex justify-center pointer-events-none">
                <p className="text-xs text-slate-400 bg-white/80 rounded px-3 py-1.5 shadow">
                  {addMarkerMode
                    ? "Click anywhere to place a sign marker"
                    : "No floor plan pages detected for this job. Upload a PDF with floor plan sheets and re-run extraction."}
                </p>
              </div>
            </div>
          )}

          {signTypeCounts.length > 0 && (
            <div className="absolute top-3 left-3 z-20 bg-background/90 backdrop-blur-sm border border-border/60 rounded-lg text-xs shadow-lg min-w-[160px] pointer-events-auto select-none">
              <button
                onClick={() => setLegendCollapsed((c) => !c)}
                className="flex items-center justify-between w-full px-3 py-2 hover:bg-muted/30 rounded-lg transition-colors"
              >
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Legend</span>
                <span className="text-[10px] text-muted-foreground ml-4">{legendCollapsed ? "▾" : "▴"}</span>
              </button>
              {!legendCollapsed && (
                <div className="px-3 pb-3">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-border/40">
                        <th className="text-left text-[9px] uppercase tracking-wider text-muted-foreground/60 pb-1 pr-2 font-normal">Description</th>
                        <th className="text-right text-[9px] uppercase tracking-wider text-muted-foreground/60 pb-1 pr-1 font-normal">Qty</th>
                        <th className="text-right text-[9px] uppercase tracking-wider text-muted-foreground/60 pb-1 font-normal">Unit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {signTypeCounts.map(({ type, count, color }) => (
                        <tr key={type} className="border-b border-border/20 last:border-0">
                          <td className="py-0.5 pr-2">
                            <div className="flex items-center gap-1.5">
                              <span
                                className="w-2.5 h-2.5 rounded-full shrink-0 inline-block"
                                style={{ backgroundColor: color }}
                              />
                              <span className="text-[10px] font-mono text-foreground/80">{type}</span>
                            </div>
                          </td>
                          <td className="py-0.5 pr-1 text-right text-[10px] font-mono font-bold text-foreground">{count}</td>
                          <td className="py-0.5 text-right text-[9px] font-mono text-muted-foreground/60">Count</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

      </div>

      {/* Fixed legend strip */}
      {signTypeCounts.length > 0 && (
        <div className="flex-shrink-0 border-t bg-card px-3 py-1.5 flex items-center gap-3 flex-wrap overflow-x-auto">
          <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground flex-shrink-0">Legend</span>
          {signTypeCounts.map(({ type, color }) => {
            const abbrev = SIGN_ABBREV[type] ?? type.slice(0, 3).toUpperCase();
            return (
              <button
                key={type}
                onClick={() => {
                  setSelectedTypes((prev) => {
                    const next = new Set(prev);
                    if (next.has(type)) next.delete(type);
                    else next.add(type);
                    return next;
                  });
                }}
                className={[
                  "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors border",
                  selectedTypes.has(type)
                    ? "border-transparent text-white"
                    : "border-transparent bg-transparent text-foreground/70 hover:text-foreground",
                ].join(" ")}
                style={selectedTypes.has(type) ? { backgroundColor: color } : {}}
                title={`Filter: ${type}`}
              >
                <span style={{ display: "flex", alignItems: "stretch", gap: 0, flexShrink: 0 }}>
                  <span style={{ width: 3, height: 14, backgroundColor: color, borderRadius: "2px 0 0 2px", display: "inline-block" }} />
                  <span style={{ backgroundColor: color, color: "#fff", fontSize: 7, fontWeight: 700, padding: "1px 3px", borderRadius: "0 2px 2px 0", lineHeight: "12px", display: "inline-flex", alignItems: "center" }}>
                    {abbrev.slice(0, 1)}
                  </span>
                </span>
                {type}
              </button>
            );
          })}
          {selectedTypes.size > 0 && (
            <button
              onClick={() => setSelectedTypes(new Set())}
              className="text-[10px] text-muted-foreground hover:text-foreground underline flex-shrink-0 ml-auto"
            >
              Clear filter
            </button>
          )}
        </div>
      )}

      {/* Placement tray */}
      {hasRasterizedSheets && (
        <div className="flex-shrink-0 border-t bg-card">
          {/* Tray header */}
          <div
            className="flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none hover:bg-muted/40 transition-colors"
            onClick={() => {
              const next = !trayOpen;
              setTrayOpen(next);
              localStorage.setItem(`tray-collapsed-${jobId}`, next ? "false" : "true");
            }}
          >
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex-shrink-0">
              Placement Tray
            </span>
            <span className="flex-1" />
            {(() => {
              const isTraySign = (s: Sign) => s.markerX === null || s.markerX === undefined || s.markerX === 50000;
              const unplacedCount = (allSigns as Sign[]).filter((s) => !s.isDeleted && isTraySign(s)).length;
              return unplacedCount > 0 ? (
                <span className="rounded-full bg-amber-500 text-white text-[9px] font-bold px-1.5 py-0.5 leading-none">
                  {unplacedCount} to place
                </span>
              ) : (
                <span className="rounded-full bg-emerald-600 text-white text-[9px] font-bold px-1.5 py-0.5 leading-none">
                  All placed ✓
                </span>
              );
            })()}
            <span className="text-[10px] text-muted-foreground ml-1">{trayOpen ? "▴" : "▾"}</span>
          </div>

          {trayOpen && (() => {
            const ROOM_ID_PATTERN = /^[A-Za-z][0-9]{3,4}$/;
            const isTraySign = (s: Sign) => {
              // Must be unplaced (no valid marker coordinates)
              if (s.markerX !== null && s.markerX !== undefined && s.markerX !== 50000) return false;
              // Only include if roomNumber is populated OR signType looks like a room identifier
              return !!(s.roomNumber?.trim()) || ROOM_ID_PATTERN.test(s.signType ?? "");
            };

            const allUnplaced = (allSigns as Sign[]).filter((s) => !s.isDeleted && isTraySign(s));

            // Compute unique levels across all unplaced signs
            const levelSet = new Set<string>();
            for (const s of allUnplaced) {
              const lvl = s.level ? normalizeLevel(s.level) : s.floorLabel ? normalizeLevel(s.floorLabel) : null;
              if (lvl) levelSet.add(lvl);
            }
            const trayLevels = [...levelSet].sort();
            // trayLevelFilter is null → show all levels (Option B: no default per-level filter)
            const effectiveLevel = trayLevelFilter;

            const traySearchLower = traySearch.trim().toLowerCase();
            const byRoom = (a: Sign, b: Sign) =>
              ((a.roomNumber ?? "") + " " + (a.roomName ?? "")).localeCompare(
                (b.roomNumber ?? "") + " " + (b.roomName ?? ""),
              );

            const scopedUnplaced = allUnplaced.filter((s) => {
              if (effectiveLevel) {
                const sLvl = s.level ? normalizeLevel(s.level) : s.floorLabel ? normalizeLevel(s.floorLabel) : null;
                if (sLvl && sLvl !== effectiveLevel) return false;
              }
              if (traySearchLower) {
                return (
                  s.signType.toLowerCase().includes(traySearchLower) ||
                  (s.roomNumber ?? "").toLowerCase().includes(traySearchLower) ||
                  (s.roomName ?? "").toLowerCase().includes(traySearchLower)
                );
              }
              return true;
            }).sort(byRoom);

            return (
              <>
                {/* Level filter pills */}
                {trayLevels.length > 1 && (
                  <div className="flex gap-1.5 flex-wrap px-3 pt-1 pb-0.5">
                    {trayLevels.map((lvl) => (
                      <button
                        key={lvl}
                        onClick={() => setTrayLevelFilter(lvl === effectiveLevel ? null : lvl)}
                        className={[
                          "px-2 py-0.5 rounded-full text-[9px] font-bold border transition-colors",
                          lvl === effectiveLevel
                            ? "bg-amber-500 text-white border-amber-500"
                            : "border-border text-muted-foreground hover:border-amber-400 hover:text-amber-600",
                        ].join(" ")}
                      >
                        {lvl}
                      </button>
                    ))}
                  </div>
                )}

                {/* Search */}
                <div className="relative px-3 pt-1.5 pb-1">
                  <Search className="absolute left-5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Filter signs…"
                    value={traySearch}
                    onChange={(e) => setTraySearch(e.target.value)}
                    className="w-full h-6 pl-6 pr-2 text-[11px] rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>

                {/* Tags — fixed 140px scrollable row */}
                <div
                  ref={trayScrollRef}
                  style={{
                    display: "flex",
                    flexDirection: "row",
                    gap: 8,
                    overflowX: "auto",
                    overflowY: "hidden",
                    height: 140,
                    alignItems: "center",
                    padding: "8px 12px",
                    flexWrap: "nowrap",
                  }}
                >
                  {scopedUnplaced.length === 0 ? (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, height: "100%" }}>
                      <span style={{ color: "#22C55E", fontSize: 12, fontWeight: 600 }}>
                        All signs placed on this sheet ✓
                      </span>
                    </div>
                  ) : (
                    scopedUnplaced.map((sign) => (
                      <div
                        key={sign.id}
                        data-sign-id={sign.id}
                        draggable={!!activeSheet}
                        title={activeSheet ? "Drag to place on plan" : "Select a sheet first"}
                        onDragStart={(e) => {
                          e.dataTransfer.setData("signId", sign.id);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        style={{
                          display: "flex",
                          alignItems: "stretch",
                          minHeight: 32,
                          borderRadius: 4,
                          overflow: "hidden",
                          cursor: activeSheet ? "grab" : "not-allowed",
                          userSelect: "none",
                          flexShrink: 0,
                          background: "#1E1E2E",
                          border: "1px solid rgba(255,255,255,0.1)",
                          opacity: activeSheet ? 1 : 0.4,
                          boxShadow: trayHighlightId === sign.id ? "0 0 0 2px #F59E0B, 0 0 12px #F59E0B88" : undefined,
                          transition: "box-shadow 0.3s ease",
                        }}
                      >
                        <div style={{ width: 4, background: "#F59E0B", flexShrink: 0 }} />
                        <div style={{ padding: "4px 8px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", lineHeight: "16px", whiteSpace: "nowrap" }}>
                            {[sign.roomNumber, sign.roomName].filter(Boolean).join(" ") || sign.signType}
                          </div>
                          {(sign.roomNumber || sign.roomName) && (
                            <div style={{ fontSize: 10, color: "#9CA3AF", lineHeight: "14px", whiteSpace: "nowrap" }}>
                              {sign.signType}
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            );
          })()}
        </div>
      )}


      {/* Right-click context menu */}
      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-[999]"
            onClick={closeContextMenu}
            onContextMenu={(e) => { e.preventDefault(); closeContextMenu(); }}
          />
          <div
            className="fixed z-[1000] bg-popover border border-border rounded-md shadow-lg py-1 min-w-[160px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              onClick={() => { handleMarkerClick(contextMenu.sign); setSelectedSignId(contextMenu.sign.id); closeContextMenu(); }}
              className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-muted transition-colors"
            >
              <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
              Edit sign
            </button>
            <button
              onClick={async () => {
                closeContextMenu();
                if (!window.confirm("Delete this sign entry? This cannot be undone.")) return;
                deleteSign.mutate(
                  { jobId, signId: contextMenu.sign.id },
                  {
                    onSuccess: () => {
                      queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
                      toast.success("Sign deleted.");
                    },
                    onError: () => toast.error("Failed to delete sign."),
                  },
                );
              }}
              className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-destructive/10 text-destructive transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove sign
            </button>
            <button
              onClick={() => { setAddMarkerMode(false); closeContextMenu(); toast.info("Click anywhere on the plan to reposition this marker."); }}
              className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-muted transition-colors"
            >
              <Move className="h-3.5 w-3.5 text-muted-foreground" />
              Move marker (drag)
            </button>
            <div className="border-t border-border/40 mt-1 pt-1">
              <button
                onClick={() => {
                  closeContextMenu();
                  updateSign.mutate(
                    { jobId, signId: contextMenu.sign.id, data: { status: "confirmed", reason: "Confirmed via context menu" } },
                    {
                      onSuccess: () => {
                        queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) });
                        toast.success("Sign confirmed.");
                      },
                      onError: () => toast.error("Failed to confirm sign."),
                    },
                  );
                }}
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-muted transition-colors text-emerald-600"
              >
                <CheckCircle className="h-3.5 w-3.5" />
                Confirm sign
              </button>
            </div>
            <div className="border-t border-border/40 mt-1 pt-1 px-3 pb-1.5">
              <div className="flex items-center gap-1.5 mb-1.5 text-xs text-muted-foreground">
                <Palette className="h-3 w-3" />
                Marker color
              </div>
              <div className="flex flex-wrap gap-1">
                {[
                  { hex: "#F59E0B", label: "Amber" },
                  { hex: "#EF4444", label: "Red" },
                  { hex: "#22C55E", label: "Green" },
                  { hex: "#3B82F6", label: "Blue" },
                  { hex: "#8B5CF6", label: "Purple" },
                  { hex: "#64748B", label: "Slate" },
                  { hex: "#14B8A6", label: "Teal" },
                  { hex: "#F97316", label: "Orange" },
                ].map(({ hex, label }) => {
                  const currentColor = contextMenu.sign.markerColor ?? getMarkerColor(contextMenu.sign.signType, contextMenu.sign.color);
                  const isActive = currentColor.toLowerCase() === hex.toLowerCase();
                  return (
                    <button
                      key={hex}
                      title={label}
                      onClick={() => {
                        closeContextMenu();
                        updateSign.mutate(
                          { jobId, signId: contextMenu.sign.id, data: { markerColor: hex, reason: "Marker color changed" } },
                          {
                            onSuccess: () => queryClient.invalidateQueries({ queryKey: getListSignsQueryKey(jobId) }),
                            onError: () => toast.error("Failed to update color."),
                          },
                        );
                      }}
                      className={`w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 ${isActive ? "border-foreground" : "border-transparent"}`}
                      style={{ backgroundColor: hex }}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) handleDialogClose(); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Place New Sign Marker</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-sign-type">Sign Type</Label>
              <Select value={newSignType} onValueChange={setNewSignType}>
                <SelectTrigger id="new-sign-type">
                  <SelectValue placeholder="Select sign type" />
                </SelectTrigger>
                <SelectContent>
                  {SIGN_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: getMarkerColor(t) }}
                        />
                        {t}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-room-number">Room #</Label>
                <Input
                  id="new-room-number"
                  value={newRoomNumber}
                  onChange={(e) => setNewRoomNumber(e.target.value)}
                  placeholder="e.g. 103"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-room-name">Room Name</Label>
                <Input
                  id="new-room-name"
                  value={newRoomName}
                  onChange={(e) => setNewRoomName(e.target.value)}
                  placeholder="e.g. LOBBY"
                  list="room-name-suggestions"
                />
                <datalist id="room-name-suggestions">
                  {rooms.slice(0, 20).map((r) => r.roomName).filter(Boolean).map((name) => (
                    <option key={name} value={name ?? ""} />
                  ))}
                </datalist>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-qty">Quantity</Label>
              <Input
                id="new-qty"
                type="number"
                min={1}
                value={newQty}
                onChange={(e) => setNewQty(Math.max(1, parseInt(e.target.value, 10) || 1))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleDialogClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Place Marker"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default FloorPlanTab;
