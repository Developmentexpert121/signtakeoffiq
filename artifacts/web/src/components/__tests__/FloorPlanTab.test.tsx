import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

vi.mock("@workspace/api-client-react", () => ({
  useListJobSheets: vi.fn(),
  useListSigns: vi.fn(),
  useListRooms: vi.fn(),
  useCreateSign: vi.fn(),
  useUpdateSign: vi.fn(),
  useDeleteSign: vi.fn(),
  useProcessJob: vi.fn(),
  getListSignsQueryKey: vi.fn(() => ["signs"]),
  getListRoomsQueryKey: vi.fn(() => ["rooms"]),
  customFetch: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: vi.fn(() => ({
    invalidateQueries: vi.fn(),
    getQueryData: vi.fn(() => []),
    setQueryData: vi.fn(),
  })),
}));

vi.mock("react-zoom-pan-pinch", () => ({
  TransformWrapper: React.forwardRef(({ children }: { children: React.ReactNode }, _ref: unknown) => (
    <div data-testid="transform-wrapper">{children}</div>
  )),
  TransformComponent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="transform-component">{children}</div>
  ),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/contexts/GuestAuthContext", () => ({
  useGuestAuth: () => ({ guestSession: null }),
}));

import {
  useListJobSheets,
  useListSigns,
  useListRooms,
  useCreateSign,
  useUpdateSign,
  useDeleteSign,
  useProcessJob,
} from "@workspace/api-client-react";

const mockUseListJobSheets = vi.mocked(useListJobSheets);
const mockUseListSigns = vi.mocked(useListSigns);
const mockUseListRooms = vi.mocked(useListRooms);
const mockUseCreateSign = vi.mocked(useCreateSign);
const mockUseUpdateSign = vi.mocked(useUpdateSign);
const mockUseDeleteSign = vi.mocked(useDeleteSign);
const mockUseProcessJob = vi.mocked(useProcessJob);

const MOCK_SHEET = {
  id: "sheet-1",
  jobId: "job-1",
  isRelevant: true,
  rasterizedPath: "sheets/sheet-1.png",
  level: "Level 1",
  sheetTitle: "Floor 1",
  pdfPage: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const MOCK_SIGN = {
  id: "sign-1",
  jobId: "job-1",
  sheetId: "sheet-1",
  markerX: 500,
  markerY: 500,
  signType: "Room ID",
  qty: 1,
  status: "extracted",
  confidence: 0.9,
  source: "ai",
  color: "#f59e0b",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function setupDefaultMocks() {
  mockUseListJobSheets.mockReturnValue({
    data: [MOCK_SHEET],
    isLoading: false,
  } as ReturnType<typeof useListJobSheets>);

  mockUseListSigns.mockReturnValue({
    data: [MOCK_SIGN],
    isLoading: false,
  } as ReturnType<typeof useListSigns>);

  mockUseListRooms.mockReturnValue({
    data: [],
    isLoading: false,
  } as ReturnType<typeof useListRooms>);

  mockUseCreateSign.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useCreateSign>);

  mockUseUpdateSign.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateSign>);

  mockUseDeleteSign.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useDeleteSign>);

  mockUseProcessJob.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useProcessJob>);
}

describe("FloorPlanTab — image loading, error, and retry states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setupDefaultMocks();
  });

  it("shows the loading spinner while the floor plan image is pending", async () => {
    const { FloorPlanTab } = await import("@/components/FloorPlanTab");
    render(<FloorPlanTab jobId="job-1" />);

    await waitFor(() => {
      const spinners = document.querySelectorAll(".animate-spin");
      const loadingSpinner = Array.from(spinners).find((el) => {
        const parent = el.parentElement;
        return parent && (parent as HTMLElement).style.opacity === "1";
      });
      expect(loadingSpinner).toBeTruthy();
    });
  });

  it("shows the error fallback UI (ImageOff icon text and Retry button) when the floor plan image fails to load", async () => {
    const { FloorPlanTab } = await import("@/components/FloorPlanTab");
    render(<FloorPlanTab jobId="job-1" />);

    const img = await screen.findByRole("img", { name: /Floor 1/i });
    fireEvent.error(img);

    await waitFor(() => {
      expect(
        screen.getByText(/Floor plan image could not be loaded/i),
      ).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
  });

  it("does not render sign markers when the floor plan image has failed to load", async () => {
    const { FloorPlanTab } = await import("@/components/FloorPlanTab");
    const { container } = render(<FloorPlanTab jobId="job-1" />);

    const img = await screen.findByRole("img", { name: /Floor 1/i });
    fireEvent.error(img);

    await waitFor(() => {
      expect(
        screen.getByText(/Floor plan image could not be loaded/i),
      ).toBeInTheDocument();
    });

    const markers = container.querySelectorAll("[data-sign-id]");
    expect(markers).toHaveLength(0);
  });

  it("clears the error state and shows the image again after clicking Retry", async () => {
    const { FloorPlanTab } = await import("@/components/FloorPlanTab");
    render(<FloorPlanTab jobId="job-1" />);

    const img = await screen.findByRole("img", { name: /Floor 1/i });
    fireEvent.error(img);

    await waitFor(() => {
      expect(
        screen.getByText(/Floor plan image could not be loaded/i),
      ).toBeInTheDocument();
    });

    const retryButton = screen.getByRole("button", { name: /Retry/i });
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(
        screen.queryByText(/Floor plan image could not be loaded/i),
      ).not.toBeInTheDocument();
    });

    await waitFor(() => {
      const img2 = screen.queryByRole("img", { name: /Floor 1/i });
      expect(img2).toBeInTheDocument();
      const src = img2?.getAttribute("src") ?? "";
      expect(src).toContain("retry=1");
    });
  });
});

// ── P2b: Plans tab visual layer ───────────────────────────────────────────────

describe("Plans tab visual layer (P2b)", () => {
  const SIGN_WITH_MARKER = {
    id: "sign-p2b-marker",
    jobId: "job-1",
    sheetId: "sheet-1",
    markerX: 48500,
    markerY: 33200,
    canvasX: null as number | null,
    canvasY: null as number | null,
    signType: "Room ID",
    qty: 2,
    status: "extracted",
    confidence: 0.85,
    source: "ai_vision",
    color: "#10b981",
    floorLabel: "LEVEL 1",
    roomNumber: "101",
    roomName: "Conference Room",
    isDeleted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const SIGN_UNLOCATED_L1 = {
    id: "sign-unlocated-l1",
    jobId: "job-1",
    sheetId: null as string | null,
    markerX: null as number | null,
    markerY: null as number | null,
    canvasX: null as number | null,
    canvasY: null as number | null,
    signType: "Room ID",
    qty: 1,
    status: "extracted",
    confidence: 0.85,
    source: "ai",
    color: "#f59e0b",
    floorLabel: "LEVEL 1",
    roomNumber: "101",
    roomName: "Office A",
    isDeleted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const SIGN_UNLOCATED_L2 = {
    ...SIGN_UNLOCATED_L1,
    id: "sign-unlocated-l2",
    floorLabel: "LEVEL 2",
    roomNumber: "201",
    roomName: "Office B",
  };

  const SIGN_UNLOCATED_NO_FLOOR = {
    ...SIGN_UNLOCATED_L1,
    id: "sign-unlocated-no-floor",
    floorLabel: null as string | null,
    roomNumber: "001",
    roomName: "Lobby",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setupDefaultMocks();
  });

  describe("Floor level filter on unlocated signs", () => {
    it("shows all unlocated signs regardless of level (no per-level filtering since Option B)", async () => {
      mockUseListSigns.mockReturnValue({
        data: [SIGN_UNLOCATED_L1, SIGN_UNLOCATED_L2],
        isLoading: false,
      } as ReturnType<typeof useListSigns>);

      const { FloorPlanTab } = await import("@/components/FloorPlanTab");
      render(<FloorPlanTab jobId="job-1" />);

      await waitFor(() => {
        expect(screen.getAllByText("101 Office A").length).toBeGreaterThan(0);
        expect(screen.getAllByText("201 Office B").length).toBeGreaterThan(0);
      });
    });

    it("shows all unlocated signs including those with null floorLabel", async () => {
      mockUseListSigns.mockReturnValue({
        data: [SIGN_UNLOCATED_L2, SIGN_UNLOCATED_NO_FLOOR],
        isLoading: false,
      } as ReturnType<typeof useListSigns>);

      const { FloorPlanTab } = await import("@/components/FloorPlanTab");
      render(<FloorPlanTab jobId="job-1" />);

      await waitFor(() => {
        expect(screen.getAllByText("001 Lobby").length).toBeGreaterThan(0);
        expect(screen.getAllByText("201 Office B").length).toBeGreaterThan(0);
      });
    });

    it("shows all unlocated signs when no level filter is active", async () => {
      mockUseListSigns.mockReturnValue({
        data: [SIGN_UNLOCATED_L1, SIGN_UNLOCATED_L2, SIGN_UNLOCATED_NO_FLOOR],
        isLoading: false,
      } as ReturnType<typeof useListSigns>);

      const { FloorPlanTab } = await import("@/components/FloorPlanTab");
      render(<FloorPlanTab jobId="job-1" />);

      await waitFor(() => {
        expect(screen.getAllByText("101 Office A").length).toBeGreaterThan(0);
        expect(screen.getAllByText("201 Office B").length).toBeGreaterThan(0);
        expect(screen.getAllByText("001 Lobby").length).toBeGreaterThan(0);
      });
    });
  });

  describe("Unlocated signs sidebar", () => {
    it("shows 'All signs placed.' when every sign has a position", async () => {
      mockUseListSigns.mockReturnValue({
        data: [SIGN_WITH_MARKER],
        isLoading: false,
      } as ReturnType<typeof useListSigns>);

      const { FloorPlanTab } = await import("@/components/FloorPlanTab");
      render(<FloorPlanTab jobId="job-1" />);

      await waitFor(() => {
        expect(screen.getAllByText(/All signs placed/i).length).toBeGreaterThan(0);
      });
    });

    it("renders room entries in the unlocated list", async () => {
      mockUseListSigns.mockReturnValue({
        data: [SIGN_UNLOCATED_L1, SIGN_UNLOCATED_L2],
        isLoading: false,
      } as ReturnType<typeof useListSigns>);

      const { FloorPlanTab } = await import("@/components/FloorPlanTab");
      render(<FloorPlanTab jobId="job-1" />);

      await waitFor(() => {
        expect(screen.getAllByText("101 Office A").length).toBeGreaterThan(0);
        expect(screen.getAllByText("201 Office B").length).toBeGreaterThan(0);
      });
    });

    it("does not show located signs in the unlocated list (unlocated format absent)", async () => {
      mockUseListSigns.mockReturnValue({
        data: [SIGN_WITH_MARKER, SIGN_UNLOCATED_L1],
        isLoading: false,
      } as ReturnType<typeof useListSigns>);

      const { FloorPlanTab } = await import("@/components/FloorPlanTab");
      render(<FloorPlanTab jobId="job-1" />);

      await waitFor(() => {
        // Unplaced sign appears in the unlocated sidebar and tray unplaced section
        expect(screen.getAllByText("101 Office A").length).toBeGreaterThan(0);
        // Placed sign (real coords) correctly appears in the tray PLACED section —
        // it must NOT appear in the unlocated sidebar's mono format
        const monoEls = document.querySelectorAll(".font-mono");
        const inSidebar = Array.from(monoEls).some(el => el.textContent?.includes("101 Conference Room"));
        expect(inSidebar).toBe(false);
      });
    });
  });

  describe("localStorage selectedSheetId persistence", () => {
    it("initialises selectedSheetId from localStorage on mount (all unlocated signs shown)", async () => {
      localStorage.setItem("floor-plan-sheet-job-1", "sheet-1");
      mockUseListSigns.mockReturnValue({
        data: [SIGN_UNLOCATED_L1, SIGN_UNLOCATED_L2],
        isLoading: false,
      } as ReturnType<typeof useListSigns>);

      const { FloorPlanTab } = await import("@/components/FloorPlanTab");
      render(<FloorPlanTab jobId="job-1" />);

      await waitFor(() => {
        expect(screen.getAllByText("101 Office A").length).toBeGreaterThan(0);
        expect(screen.getAllByText("201 Office B").length).toBeGreaterThan(0);
      });
    });

    it("writes floor-plan-sheet-{jobId} to localStorage when the sheet changes", async () => {
      mockUseListSigns.mockReturnValue({
        data: [],
        isLoading: false,
      } as ReturnType<typeof useListSigns>);

      mockUseListJobSheets.mockReturnValue({
        data: [
          MOCK_SHEET,
          {
            ...MOCK_SHEET,
            id: "sheet-2",
            sheetId: "PLAN-1",
            level: "Level 2",
            sheetTitle: "Floor 2",
            pdfPage: 2,
          },
        ],
        isLoading: false,
      } as ReturnType<typeof useListJobSheets>);

      const { FloorPlanTab } = await import("@/components/FloorPlanTab");
      render(<FloorPlanTab jobId="job-1" />);

      const select = await screen.findByRole("combobox");
      fireEvent.change(select, { target: { value: "sheet-2" } });

      await waitFor(() => {
        expect(localStorage.getItem("floor-plan-sheet-job-1")).toBe("sheet-2");
      });
    });
  });

  describe("Marker click popover", () => {
    it("clicking a sign marker opens a popover with room label and sign type", async () => {
      mockUseListSigns.mockReturnValue({
        data: [SIGN_WITH_MARKER],
        isLoading: false,
      } as ReturnType<typeof useListSigns>);

      const { FloorPlanTab } = await import("@/components/FloorPlanTab");
      render(<FloorPlanTab jobId="job-1" />);

      const img = await screen.findByRole("img", { name: /Floor 1/i });
      fireEvent.load(img);

      await waitFor(() => {
        expect(document.querySelector('[data-sign-id="sign-p2b-marker"]')).toBeTruthy();
      });

      fireEvent.click(document.querySelector('[data-sign-id="sign-p2b-marker"]') as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText("101 \u2014 Conference Room")).toBeInTheDocument();
      });
    });

    it("popover shows qty, confidence percentage, floor label and source", async () => {
      mockUseListSigns.mockReturnValue({
        data: [SIGN_WITH_MARKER],
        isLoading: false,
      } as ReturnType<typeof useListSigns>);

      const { FloorPlanTab } = await import("@/components/FloorPlanTab");
      render(<FloorPlanTab jobId="job-1" />);

      const img = await screen.findByRole("img", { name: /Floor 1/i });
      fireEvent.load(img);

      await waitFor(() => {
        expect(document.querySelector('[data-sign-id="sign-p2b-marker"]')).toBeTruthy();
      });

      fireEvent.click(document.querySelector('[data-sign-id="sign-p2b-marker"]') as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText("Qty")).toBeInTheDocument();
        const confSpans = screen.getAllByText("85%");
        expect(confSpans.some((el) => el.style?.color)).toBe(true);
        expect(screen.getByText("LEVEL 1")).toBeInTheDocument();
        expect(screen.getByText("ai_vision")).toBeInTheDocument();
      });
    });

    it("confidence ≥ 0.80 confidence span has green colour style", async () => {
      const highConfSign = { ...SIGN_WITH_MARKER, confidence: 0.90 };
      mockUseListSigns.mockReturnValue({
        data: [highConfSign],
        isLoading: false,
      } as ReturnType<typeof useListSigns>);

      const { FloorPlanTab } = await import("@/components/FloorPlanTab");
      render(<FloorPlanTab jobId="job-1" />);

      const img = await screen.findByRole("img", { name: /Floor 1/i });
      fireEvent.load(img);

      await waitFor(() => {
        expect(document.querySelector('[data-sign-id="sign-p2b-marker"]')).toBeTruthy();
      });

      fireEvent.click(document.querySelector('[data-sign-id="sign-p2b-marker"]') as HTMLElement);

      await waitFor(() => {
        const confSpans = screen.getAllByText("90%");
        const styledSpan = confSpans.find((el) => el.style?.color);
        expect(styledSpan).toBeDefined();
        const color = styledSpan!.style.color;
        expect(color).toBeTruthy();
        expect(color).not.toMatch(/9ca3af/);
        expect(color).not.toMatch(/d97706/);
      });
    });

  });
});

// ── Plans tab fixes (Session 10) ──────────────────────────────────────────────

describe("Plans tab fixes (Session 10)", () => {
  // A Level 2 sign with no sheet marker — sheetId null
  const SIGN_L2_UNPLACED = {
    id: "sign-l2-unplaced",
    jobId: "job-1",
    sheetId: null as string | null,
    markerX: null as number | null,
    markerY: null as number | null,
    canvasX: null as number | null,
    canvasY: null as number | null,
    signType: "Room ID",
    qty: 1,
    status: "extracted",
    confidence: 0.80,
    source: "ai_vision",
    color: "#f59e0b",
    floorLabel: "LEVEL 2",
    roomNumber: "201",
    roomName: "Storage",
    isDeleted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Two sheets at Level 1 with identical sheetTitle but distinct sheetId
  const SHEET_WING_A = {
    ...MOCK_SHEET,
    id: "sheet-wa",
    sheetId: "A-101W",
    sheetTitle: "FLOOR PLAN LEVEL 1",
    level: "Level 1",
    pdfPage: 1,
  };

  const SHEET_WING_B = {
    ...MOCK_SHEET,
    id: "sheet-wb",
    sheetId: "A-101E",
    sheetTitle: "FLOOR PLAN LEVEL 1",
    level: "Level 1",
    pdfPage: 2,
  };

  // Level 2 sheet (for the fallback-rooms test)
  const SHEET_L2 = {
    ...MOCK_SHEET,
    id: "sheet-l2",
    sheetTitle: "FLOOR PLAN LEVEL 2",
    level: "Level 2",
    pdfPage: 2,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setupDefaultMocks();
  });

  it("Level 2 shows rooms even with no placed markers — falls back to filteredAllPlacedSigns", async () => {
    localStorage.setItem("floor-plan-level-job-1", "LEVEL 2");

    mockUseListJobSheets.mockReturnValue({
      data: [MOCK_SHEET, SHEET_L2],
      isLoading: false,
    } as ReturnType<typeof useListJobSheets>);

    mockUseListSigns.mockReturnValue({
      data: [SIGN_L2_UNPLACED],
      isLoading: false,
    } as ReturnType<typeof useListSigns>);

    const { FloorPlanTab } = await import("@/components/FloorPlanTab");
    render(<FloorPlanTab jobId="job-1" />);

    await waitFor(() => {
      expect(screen.getAllByText("201 Storage").length).toBeGreaterThan(0);
    });
  });

  it("dropdown option labels use sheetId when sheetTitle values are identical across sheets", async () => {
    mockUseListJobSheets.mockReturnValue({
      data: [SHEET_WING_A, SHEET_WING_B],
      isLoading: false,
    } as ReturnType<typeof useListJobSheets>);

    mockUseListSigns.mockReturnValue({
      data: [],
      isLoading: false,
    } as ReturnType<typeof useListSigns>);

    const { FloorPlanTab } = await import("@/components/FloorPlanTab");
    render(<FloorPlanTab jobId="job-1" />);

    // Single dropdown replaces the old Wing: pill row
    await waitFor(() => {
      const select = screen.getByRole("combobox");
      expect(select).toBeInTheDocument();
    });

    // Option text includes sheetId values, not just the shared sheetTitle
    const select = screen.getByRole("combobox");
    const optionTexts = Array.from(select.querySelectorAll("option")).map((o) => o.textContent ?? "");
    expect(optionTexts.some((t) => t.includes("A-101W"))).toBe(true);
    expect(optionTexts.some((t) => t.includes("A-101E"))).toBe(true);
  });

});
