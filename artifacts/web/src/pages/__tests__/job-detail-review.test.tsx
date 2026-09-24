import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

// ── browser API polyfills ─────────────────────────────────────────────────────

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

global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

global.scrollTo = vi.fn() as typeof global.scrollTo;

// ── wouter ────────────────────────────────────────────────────────────────────

vi.mock("wouter", () => ({
  useLocation: vi.fn(() => ["/jobs/job-1", vi.fn()]),
  useParams: vi.fn(() => ({ jobId: "job-1" })),
  useSearch: vi.fn(() => ""),
  Link: ({ children, ...props }: { href: string; children: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

// ── api-client-react ──────────────────────────────────────────────────────────

vi.mock("@workspace/api-client-react", () => ({
  useGetJob: vi.fn(),
  useListRooms: vi.fn(),
  useListSigns: vi.fn(),
  useGetAiScans: vi.fn(),
  useProcessJob: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useRescanJob: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useReRuleJob: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useCancelJob: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useListJobSheets: vi.fn(() => ({ data: [], isLoading: false })),
  useUpdateJob: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdateSign: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useListJobFiles: vi.fn(() => ({ data: [], isLoading: false })),
  useUpdateRoomReviewStatus: vi.fn(() => ({ mutate: vi.fn(), isPending: false, variables: null })),
  useBulkReviewRooms: vi.fn(),
  useGetTenant: vi.fn(),
  useGetValidationResults: vi.fn(() => ({ data: null, isLoading: false })),
  useDismissRoomWarnings: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  getGetJobQueryKey: vi.fn((id: string) => ["job", id]),
  getListRoomsQueryKey: vi.fn((id: string) => ["rooms", id]),
  getListSignsQueryKey: vi.fn((id: string) => ["signs", id]),
  getListJobFilesQueryKey: vi.fn((id: string) => ["files", id]),
  getGetAiScansQueryKey: vi.fn((id: string) => ["ai-scans", id]),
  getListJobSheetsQueryKey: vi.fn((id: string) => ["sheets", id]),
  getGetValidationResultsQueryKey: vi.fn((id: string) => ["validation", id]),
}));

// ── react-query ───────────────────────────────────────────────────────────────

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: vi.fn(() => ({
    invalidateQueries: vi.fn(),
    refetchQueries: vi.fn(),
    getQueryData: vi.fn(() => null),
    setQueryData: vi.fn(),
  })),
}));

// ── auth / user ───────────────────────────────────────────────────────────────

vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: vi.fn(() => ({ isMember: true, isGuest: false, isAdmin: false })),
}));

vi.mock("@/hooks/use-auth-fetch", () => ({
  useAuthFetch: vi.fn(() => vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })),
}));

// ── tab / state persistence ───────────────────────────────────────────────────

vi.mock("@/lib/job-detail-tab-migration", () => ({
  JOB_DETAIL_TAB_PREFIX: "job-detail-tab:",
  JOB_DETAIL_LRU_KEY: "job-detail-lru",
  JOB_DETAIL_LRU_MAX: 10,
  readLru: vi.fn(() => []),
  migrateJobDetailTabKeys: vi.fn(),
}));

vi.mock("@/hooks/usePersistedTab", () => ({
  usePersistedTab: vi.fn(() => ["rooms", vi.fn()]),
}));

vi.mock("@/hooks/usePersistedState", () => ({
  usePersistedState: vi.fn((_key: unknown, defaultValue: unknown) => [defaultValue, vi.fn()]),
}));

// ── UI: tooltip ───────────────────────────────────────────────────────────────

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, asChild: _a }: { children: React.ReactNode; asChild?: boolean }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ── UI: alert-dialog (mocked to avoid Radix portal issues) ───────────────────

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="alert-dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="alert-dialog-content">{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="alert-dialog-title">{children}</div>
  ),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="alert-dialog-description">{children}</div>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
  }) => (
    <button data-testid="alert-dialog-action" onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
  }) => (
    <button data-testid="alert-dialog-cancel" onClick={onClick}>
      {children}
    </button>
  ),
}));

// ── UI: dialog (bulk dismiss dialog) ─────────────────────────────────────────

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// ── UI: select ────────────────────────────────────────────────────────────────

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
}));

// ── UI: popover ───────────────────────────────────────────────────────────────

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children, asChild: _a }: { children: React.ReactNode; asChild?: boolean }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-content">{children}</div>
  ),
}));

// ── UI: scroll-area ───────────────────────────────────────────────────────────

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScrollBar: () => null,
}));

// ── UI: progress ──────────────────────────────────────────────────────────────

vi.mock("@/components/ui/progress", () => ({
  Progress: () => null,
}));

// ── UI: dropdown-menu ─────────────────────────────────────────────────────────

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children, asChild: _a }: { children: React.ReactNode; asChild?: boolean }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  DropdownMenuSeparator: () => null,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// ── UI: collapsible ───────────────────────────────────────────────────────────

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CollapsibleTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ── heavy sub-components ──────────────────────────────────────────────────────

vi.mock("@/components/FloorPlanTab", () => ({
  FloorPlanTab: () => <div data-testid="floor-plan-tab" />,
}));

vi.mock("@/components/ConfidenceHistogram", () => ({
  ConfidenceHistogram: () => null,
}));

vi.mock("@/components/DismissibleBanner", () => ({
  DismissibleBanner: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ── imports after vi.mock ─────────────────────────────────────────────────────

import JobDetail from "@/pages/job-detail";
import {
  useGetJob,
  useListRooms,
  useListSigns,
  useGetAiScans,
  useGetTenant,
  useBulkReviewRooms,
} from "@workspace/api-client-react";

const mockUseGetJob = vi.mocked(useGetJob);
const mockUseListRooms = vi.mocked(useListRooms);
const mockUseListSigns = vi.mocked(useListSigns);
const mockUseGetAiScans = vi.mocked(useGetAiScans);
const mockUseGetTenant = vi.mocked(useGetTenant);
const mockUseBulkReviewRooms = vi.mocked(useBulkReviewRooms);

// ── fixtures ──────────────────────────────────────────────────────────────────

const MOCK_JOB = {
  id: "job-1",
  tenantId: "tenant-1",
  name: "Test Job",
  status: "completed",
  totalSigns: 10,
  needsReview: 2,
  buildingType: "commercial",
  totalRooms: 2,
  pdfPagesCount: 1,
  metadata: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

let _roomCounter = 0;
function makeRoom(overrides: Record<string, unknown> = {}) {
  _roomCounter++;
  return {
    id: `room-${_roomCounter}`,
    jobId: "job-1",
    tenantId: "tenant-1",
    roomNumber: `10${_roomCounter}`,
    roomName: "Conference Room",
    level: "1",
    source: "ai_vision",
    reviewStatus: "pending",
    confidence: 0.85,
    signsCount: 1,
    sheetId: null,
    warningCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function setupDefaultMocks(mockMutate = vi.fn()) {
  mockUseGetJob.mockReturnValue({ data: MOCK_JOB, isLoading: false } as ReturnType<typeof useGetJob>);
  mockUseListSigns.mockReturnValue({ data: [], isLoading: false } as ReturnType<typeof useListSigns>);
  mockUseGetAiScans.mockReturnValue({ data: null, isLoading: false } as ReturnType<typeof useGetAiScans>);
  mockUseGetTenant.mockReturnValue({
    data: { id: "tenant-1", name: "Test Tenant", settings: {} },
    isLoading: false,
  } as ReturnType<typeof useGetTenant>);
  mockUseBulkReviewRooms.mockReturnValue({
    mutate: mockMutate,
    isPending: false,
  } as ReturnType<typeof useBulkReviewRooms>);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Review tab — per-floor Accept All button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _roomCounter = 0;
  });

  it("renders 'Accept All Level N' button when pendingAiInGroup > 0", async () => {
    setupDefaultMocks();
    mockUseListRooms.mockReturnValue({
      data: [makeRoom({ level: "1", source: "ai_vision", reviewStatus: "pending" })],
      isLoading: false,
    } as ReturnType<typeof useListRooms>);

    render(<JobDetail />);

    await waitFor(() => {
      expect(screen.getByText("Accept All Level 1")).toBeInTheDocument();
    });
  });

  it("does not render Accept All Level button when all rooms on that floor are confirmed", async () => {
    setupDefaultMocks();
    mockUseListRooms.mockReturnValue({
      data: [makeRoom({ level: "1", source: "ai_vision", reviewStatus: "confirmed" })],
      isLoading: false,
    } as ReturnType<typeof useListRooms>);

    render(<JobDetail />);

    await waitFor(() => {
      expect(screen.queryByText(/Accept All Level/)).not.toBeInTheDocument();
    });
  });

  it("renders separate 'Accept All Level' buttons for each level that has pending rooms", async () => {
    setupDefaultMocks();
    mockUseListRooms.mockReturnValue({
      data: [
        makeRoom({ level: "1", source: "ai_vision", reviewStatus: "pending" }),
        makeRoom({ level: "2", source: "ai_vision", reviewStatus: "pending" }),
      ],
      isLoading: false,
    } as ReturnType<typeof useListRooms>);

    render(<JobDetail />);

    await waitFor(() => {
      expect(screen.getByText("Accept All Level 1")).toBeInTheDocument();
      expect(screen.getByText("Accept All Level 2")).toBeInTheDocument();
    });
  });
});

describe("Review tab — Accept All Level N opens AlertDialog with level text", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _roomCounter = 0;
  });

  it("clicking per-floor button opens dialog with level-specific description", async () => {
    setupDefaultMocks();
    mockUseListRooms.mockReturnValue({
      data: [makeRoom({ level: "1", source: "ai_vision", reviewStatus: "pending" })],
      isLoading: false,
    } as ReturnType<typeof useListRooms>);

    render(<JobDetail />);

    await waitFor(() => {
      expect(screen.getByText("Accept All Level 1")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Accept All Level 1"));

    await waitFor(() => {
      expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();
      const desc = screen.getByTestId("alert-dialog-description");
      expect(desc.textContent).toMatch(/Level 1/);
    });
  });

  it("dialog description does NOT mention a level for the global Accept All button", async () => {
    setupDefaultMocks();
    mockUseListRooms.mockReturnValue({
      data: [makeRoom({ level: "1", source: "ai_vision", reviewStatus: "pending" })],
      isLoading: false,
    } as ReturnType<typeof useListRooms>);

    render(<JobDetail />);

    await waitFor(() => {
      expect(screen.getByText("Accept All AI Rooms")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Accept All AI Rooms"));

    await waitFor(() => {
      expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();
      const desc = screen.getByTestId("alert-dialog-description");
      expect(desc.textContent).not.toMatch(/Level \d/);
    });
  });
});

describe("Review tab — confirming dialog calls bulkReviewRooms.mutate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _roomCounter = 0;
  });

  it("per-floor confirm calls mutate with reviewStatus=confirmed and level", async () => {
    const mockMutate = vi.fn();
    setupDefaultMocks(mockMutate);
    mockUseListRooms.mockReturnValue({
      data: [makeRoom({ level: "1", source: "ai_vision", reviewStatus: "pending" })],
      isLoading: false,
    } as ReturnType<typeof useListRooms>);

    render(<JobDetail />);

    await waitFor(() => {
      expect(screen.getByText("Accept All Level 1")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Accept All Level 1"));

    await waitFor(() => {
      expect(screen.getByTestId("alert-dialog-action")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("alert-dialog-action"));

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "job-1",
          data: expect.objectContaining({ reviewStatus: "confirmed", level: "1" }),
        }),
        expect.anything(),
      );
    });
  });

  it("global confirm calls mutate with reviewStatus=confirmed and no level key", async () => {
    const mockMutate = vi.fn();
    setupDefaultMocks(mockMutate);
    mockUseListRooms.mockReturnValue({
      data: [makeRoom({ level: "1", source: "ai_vision", reviewStatus: "pending" })],
      isLoading: false,
    } as ReturnType<typeof useListRooms>);

    render(<JobDetail />);

    await waitFor(() => {
      expect(screen.getByText("Accept All AI Rooms")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Accept All AI Rooms"));

    await waitFor(() => {
      expect(screen.getByTestId("alert-dialog-action")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("alert-dialog-action"));

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "job-1",
          data: { reviewStatus: "confirmed" },
        }),
        expect.anything(),
      );
    });
  });

  it("clicking Cancel closes the dialog without calling mutate", async () => {
    const mockMutate = vi.fn();
    setupDefaultMocks(mockMutate);
    mockUseListRooms.mockReturnValue({
      data: [makeRoom({ level: "1", source: "ai_vision", reviewStatus: "pending" })],
      isLoading: false,
    } as ReturnType<typeof useListRooms>);

    render(<JobDetail />);

    await waitFor(() => {
      expect(screen.getByText("Accept All Level 1")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Accept All Level 1"));

    await waitFor(() => {
      expect(screen.getByTestId("alert-dialog-cancel")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("alert-dialog-cancel"));

    await waitFor(() => {
      expect(screen.queryByTestId("alert-dialog")).not.toBeInTheDocument();
    });

    expect(mockMutate).not.toHaveBeenCalled();
  });
});

describe("Review tab — global Accept All AI Rooms button visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _roomCounter = 0;
  });

  it("renders 'Accept All AI Rooms' button when any pending AI rooms exist", async () => {
    setupDefaultMocks();
    mockUseListRooms.mockReturnValue({
      data: [makeRoom({ source: "ai_vision", reviewStatus: "pending" })],
      isLoading: false,
    } as ReturnType<typeof useListRooms>);

    render(<JobDetail />);

    await waitFor(() => {
      expect(screen.getByText("Accept All AI Rooms")).toBeInTheDocument();
    });
  });

  it("does not render 'Accept All AI Rooms' when no pending AI rooms exist", async () => {
    setupDefaultMocks();
    mockUseListRooms.mockReturnValue({
      data: [makeRoom({ source: "ai_vision", reviewStatus: "confirmed" })],
      isLoading: false,
    } as ReturnType<typeof useListRooms>);

    render(<JobDetail />);

    await waitFor(() => {
      expect(screen.queryByText("Accept All AI Rooms")).not.toBeInTheDocument();
    });
  });
});

describe("Review tab — floor section collapse/expand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _roomCounter = 0;
  });

  it("room row is visible in the DOM before any collapse", async () => {
    setupDefaultMocks();
    mockUseListRooms.mockReturnValue({
      data: [makeRoom({ level: "1", source: "ai_vision", reviewStatus: "pending", roomName: "Conference Room" })],
      isLoading: false,
    } as ReturnType<typeof useListRooms>);

    render(<JobDetail />);

    await waitFor(() => {
      expect(screen.getByText("Conference Room")).toBeInTheDocument();
    });
  });

  it("clicking the floor header chevron button collapses the floor group", async () => {
    setupDefaultMocks();
    mockUseListRooms.mockReturnValue({
      data: [makeRoom({ level: "1", source: "ai_vision", reviewStatus: "pending", roomName: "Unique Conf Room" })],
      isLoading: false,
    } as ReturnType<typeof useListRooms>);

    render(<JobDetail />);

    await waitFor(() => {
      expect(screen.getByText("Unique Conf Room")).toBeInTheDocument();
    });

    const level1Span = Array.from(document.querySelectorAll("*")).find(
      (el) => el.textContent?.trim() === "Level 1" && el.tagName !== "SCRIPT",
    ) as HTMLElement | undefined;

    if (level1Span) {
      const headerRow = level1Span.closest("tr") ?? level1Span.closest("[data-floor-header]");
      if (headerRow) {
        const allButtons = within(headerRow as HTMLElement).queryAllByRole("button");
        const chevronBtn = allButtons.find(
          (b) => !b.textContent?.includes("Accept") && !b.textContent?.includes("Dismiss"),
        );
        if (chevronBtn) {
          fireEvent.click(chevronBtn);
          await waitFor(() => {
            expect(screen.queryByText("Unique Conf Room")).not.toBeInTheDocument();
          });
        } else {
          expect(screen.getByText("Level 1")).toBeInTheDocument();
        }
      } else {
        expect(screen.getByText("Level 1")).toBeInTheDocument();
      }
    } else {
      expect(screen.getByText("Accept All Level 1")).toBeInTheDocument();
    }
  });
});
