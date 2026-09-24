import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("@/hooks/useIsAdmin");
vi.mock("@/hooks/usePersistedTab", () => ({
  usePersistedTab: vi.fn(),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: vi.fn(() => ({ toast: vi.fn() })),
}));
vi.mock("@workspace/api-client-react", () => ({
  useGetOverrideImpact: vi.fn(),
  useGetTrainingSnapshots: vi.fn(() => ({ data: { snapshots: [], total: 0 }, isLoading: false })),
  getTrainingSnapshots: vi.fn(() => Promise.resolve({ snapshots: [], total: 0 })),
  useGetTenant: vi.fn(),
  useUpdateTenant: vi.fn(),
  useListRuleOverrides: vi.fn(),
  useUpdateRuleOverride: vi.fn(),
  useListCorrections: vi.fn(),
  useListSavedDateRanges: vi.fn(),
  useCreateSavedDateRange: vi.fn(),
  useDeleteSavedDateRange: vi.fn(),
  useReorderSavedDateRanges: vi.fn(),
  getGetTrainingSnapshotsQueryKey: vi.fn(() => ["trainingSnapshots"]),
  useUpdateSnapshot: vi.fn(),
  useDeleteSnapshot: vi.fn(),
  useRequestUploadUrl: vi.fn(),
  useListJobs: vi.fn(),
  useInvalidateSnapshotsCache: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  customFetch: vi.fn(),
  getListRuleOverridesQueryKey: vi.fn(() => ["ruleOverrides"]),
  getGetOverrideImpactQueryKey: vi.fn(() => ["overrideImpact"]),
  getListSavedDateRangesQueryKey: vi.fn(() => ["savedDateRanges"]),
  createSavedDateRange: vi.fn(),
  deleteSnapshot: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
  useQuery: vi.fn(() => ({ data: undefined, isLoading: false })),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("recharts", () => ({
  ComposedChart: ({ children }: { children: React.ReactNode }) => <div data-testid="composed-chart">{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => <div data-testid="line-chart">{children}</div>,
  Line: () => null,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ReferenceLine: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@uppy/core", () => ({
  default: vi.fn().mockImplementation(() => ({
    use: vi.fn().mockReturnThis(),
    on: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn(),
    getFiles: vi.fn(() => []),
    setState: vi.fn(),
    cancelAll: vi.fn(),
  })),
}));
vi.mock("@uppy/aws-s3", () => ({ default: vi.fn() }));
vi.mock("@uppy/react", () => ({ Dashboard: () => <div data-testid="uppy-dashboard" /> }));
vi.mock("@uppy/dashboard", () => ({ default: vi.fn() }));
vi.mock("xlsx", () => ({ read: vi.fn(), utils: { sheet_to_json: vi.fn() } }));

import { useIsAdmin } from "@/hooks/useIsAdmin";
import { usePersistedTab } from "@/hooks/usePersistedTab";
import {
  useGetOverrideImpact,
  useGetTrainingSnapshots,
  useGetTenant,
  useUpdateTenant,
  useListRuleOverrides,
  useUpdateRuleOverride,
  useListCorrections,
  useListSavedDateRanges,
  useCreateSavedDateRange,
  useDeleteSavedDateRange,
  useReorderSavedDateRanges,
  useUpdateSnapshot,
  useDeleteSnapshot,
  useListJobs,
  useRequestUploadUrl,
} from "@workspace/api-client-react";

const mockUseIsAdmin = vi.mocked(useIsAdmin);
const mockUsePersistedTab = vi.mocked(usePersistedTab);
const mockUseGetOverrideImpact = vi.mocked(useGetOverrideImpact);
const mockUseGetTrainingSnapshots = vi.mocked(useGetTrainingSnapshots);
const mockUseGetTenant = vi.mocked(useGetTenant);
const mockUseUpdateTenant = vi.mocked(useUpdateTenant);
const mockUseListRuleOverrides = vi.mocked(useListRuleOverrides);
const mockUseUpdateRuleOverride = vi.mocked(useUpdateRuleOverride);
const mockUseListCorrections = vi.mocked(useListCorrections);
const mockUseListSavedDateRanges = vi.mocked(useListSavedDateRanges);
const mockUseCreateSavedDateRange = vi.mocked(useCreateSavedDateRange);
const mockUseDeleteSavedDateRange = vi.mocked(useDeleteSavedDateRange);
const mockUseReorderSavedDateRanges = vi.mocked(useReorderSavedDateRanges);
const mockUseUpdateSnapshot = vi.mocked(useUpdateSnapshot);
const mockUseDeleteSnapshot = vi.mocked(useDeleteSnapshot);
const mockUseListJobs = vi.mocked(useListJobs);
const mockUseRequestUploadUrl = vi.mocked(useRequestUploadUrl);

const MOCK_SNAPSHOTS = [
  {
    id: "snap-1",
    snapshotDate: "2024-01-15T10:00:00.000Z",
    avgConfidence: 0.75,
    activeOverrideCount: 10,
    newRulesCount: 2,
    updatedRulesCount: 1,
    batchLabel: "Batch Alpha",
    correctionCount: 0,
    sourceJobId: null,
    sourceJobName: null,
  },
  {
    id: "snap-2",
    snapshotDate: "2024-02-20T14:30:00.000Z",
    avgConfidence: 0.85,
    activeOverrideCount: 15,
    newRulesCount: 3,
    updatedRulesCount: 2,
    batchLabel: "Batch Beta",
    correctionCount: 0,
    sourceJobId: null,
    sourceJobName: null,
  },
];

const MOCK_TREND = [
  {
    snapshotId: "snap-1",
    importDate: "2024-01-15T10:00:00.000Z",
    avgConfidence: 0.75,
    count: 10,
    newRulesCount: 2,
    updatedRulesCount: 1,
    batchLabel: "Batch Alpha",
    delta: null,
    week: "2024-W03",
    sourceJobId: null,
    sourceJobName: null,
    correctionCount: 0,
  },
  {
    snapshotId: "snap-2",
    importDate: "2024-02-20T14:30:00.000Z",
    avgConfidence: 0.85,
    count: 15,
    newRulesCount: 3,
    updatedRulesCount: 2,
    batchLabel: "Batch Beta",
    delta: 0.1,
    week: "2024-W08",
    sourceJobId: null,
    sourceJobName: null,
    correctionCount: 0,
  },
];

function setupDefaultMocks() {
  mockUseIsAdmin.mockReturnValue({ isAdmin: true, isLoading: false, isResolved: true });
  mockUsePersistedTab.mockReturnValue(["import", vi.fn()]);

  mockUseGetOverrideImpact.mockReturnValue({
    data: {
      activeOverrides: 5,
      totalOverrides: 10,
      totalCorrections: 3,
      correctionsThisMonth: 1,
      confidenceTrend: MOCK_TREND,
      topPatterns: [],
    },
    isLoading: false,
    refetch: vi.fn(),
  } as ReturnType<typeof useGetOverrideImpact>);

  mockUseGetTrainingSnapshots.mockReturnValue({
    data: { snapshots: MOCK_SNAPSHOTS, total: MOCK_SNAPSHOTS.length },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useGetTrainingSnapshots>);

  mockUseGetTenant.mockReturnValue({
    data: { name: "Acme Corp", plan: "pro", createdAt: new Date().toISOString(), settings: {} },
    isLoading: false,
  } as ReturnType<typeof useGetTenant>);

  mockUseUpdateTenant.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateTenant>);

  mockUseListRuleOverrides.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as ReturnType<typeof useListRuleOverrides>);

  mockUseListCorrections.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as ReturnType<typeof useListCorrections>);

  mockUseListSavedDateRanges.mockReturnValue({
    data: [],
    isLoading: false,
  } as ReturnType<typeof useListSavedDateRanges>);

  mockUseCreateSavedDateRange.mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useCreateSavedDateRange>);

  mockUseDeleteSavedDateRange.mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useDeleteSavedDateRange>);

  mockUseReorderSavedDateRanges.mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useReorderSavedDateRanges>);

  mockUseUpdateSnapshot.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateSnapshot>);

  mockUseDeleteSnapshot.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useDeleteSnapshot>);

  mockUseUpdateRuleOverride.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateRuleOverride>);

  mockUseListJobs.mockReturnValue({
    data: [],
    isLoading: false,
  } as unknown as ReturnType<typeof useListJobs>);

  mockUseRequestUploadUrl.mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useRequestUploadUrl>);
}

describe("ImportHistoryTable — CSV export", () => {
  let capturedBlob: Blob | null = null;
  let capturedAnchor: HTMLAnchorElement | null = null;
  let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let origCreateElement: typeof document.createElement;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
    capturedBlob = null;
    capturedAnchor = null;

    localStorage.removeItem("training.importTab.minConfidence");
    localStorage.removeItem("training.importTab.maxConfidence");

    createObjectURLSpy = vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob) => {
      capturedBlob = blob;
      return "blob:mock-url";
    });
    revokeObjectURLSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string, ...rest: Parameters<typeof document.createElement>[]) => {
      const el = origCreateElement(tag, ...rest);
      if (tag === "a") {
        capturedAnchor = el as HTMLAnchorElement;
        vi.spyOn(capturedAnchor, "click").mockImplementation(() => {});
      }
      return el;
    });
  });

  afterEach(() => {
    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
    vi.mocked(document.createElement).mockRestore();
  });

  describe("button visibility", () => {
    it("shows the Export CSV button when import history rows exist", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);
      expect(screen.getByRole("button", { name: /Export CSV/i })).toBeInTheDocument();
    });

    it("does not show the Export CSV button when there are no rows", async () => {
      mockUseGetTrainingSnapshots.mockReturnValue({
        data: { snapshots: [], total: 0 },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useGetTrainingSnapshots>);
      mockUseGetOverrideImpact.mockReturnValue({
        data: {
          activeOverrides: 0,
          totalOverrides: 0,
          totalCorrections: 0,
          correctionsThisMonth: 0,
          confidenceTrend: [],
          topPatterns: [],
        },
        isLoading: false,
        refetch: vi.fn(),
      } as ReturnType<typeof useGetOverrideImpact>);

      const { default: Training } = await import("@/pages/training");
      render(<Training />);
      expect(screen.queryByRole("button", { name: /Export CSV/i })).not.toBeInTheDocument();
    });
  });

  describe("CSV content", () => {
    it("generates a file with the expected column headers", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);

      fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

      expect(capturedBlob).not.toBeNull();
      const csv = await capturedBlob!.text();
      const headerLine = csv.split("\n")[0];
      expect(headerLine).toBe("Import #,Date,Avg Confidence,Accuracy,Building Type,Active Rules,New Rules,Updated Rules,Batch Label");
    });

    it("generates one data row per trend entry", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);

      fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

      expect(capturedBlob).not.toBeNull();
      const csv = await capturedBlob!.text();
      const lines = csv.split("\n").filter(Boolean);
      expect(lines).toHaveLength(1 + MOCK_TREND.length);
    });

    it("includes the correct avg confidence percentage for each row", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);

      fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

      expect(capturedBlob).not.toBeNull();
      const csv = await capturedBlob!.text();
      expect(csv).toContain("75%");
      expect(csv).toContain("85%");
    });

    it("includes the batch label for each row", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);

      fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

      expect(capturedBlob).not.toBeNull();
      const csv = await capturedBlob!.text();
      expect(csv).toContain("Batch Alpha");
      expect(csv).toContain("Batch Beta");
    });

    it("triggers a download with the filename import-history.csv", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);

      fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

      expect(capturedAnchor).not.toBeNull();
      expect(capturedAnchor!.download).toBe("import-history.csv");
    });

    it("revokes the object URL after triggering the download", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);

      fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

      expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url");
    });
  });

  describe("escape edge cases", () => {
    function mockTrend(overrides: Partial<typeof MOCK_TREND[0]>[]) {
      const entries = overrides.map((o, i) => ({
        snapshotId: `snap-edge-${i}`,
        importDate: "2024-03-01T00:00:00.000Z",
        avgConfidence: 0.8,
        count: 5,
        newRulesCount: 1,
        updatedRulesCount: 0,
        batchLabel: null,
        delta: null,
        week: "2024-W09",
        sourceJobId: null,
        sourceJobName: null,
        correctionCount: 0,
        ...o,
      }));
      mockUseGetOverrideImpact.mockReturnValue({
        data: {
          activeOverrides: 1,
          totalOverrides: 1,
          totalCorrections: 0,
          correctionsThisMonth: 0,
          confidenceTrend: entries,
          topPatterns: [],
        },
        isLoading: false,
        refetch: vi.fn(),
      } as ReturnType<typeof useGetOverrideImpact>);
    }

    it("wraps a batch label containing a comma in double quotes", async () => {
      mockTrend([{ batchLabel: "Label, with comma" }]);
      const { default: Training } = await import("@/pages/training");
      render(<Training />);

      fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

      expect(capturedBlob).not.toBeNull();
      const csv = await capturedBlob!.text();
      expect(csv).toContain('"Label, with comma"');
    });

    it("escapes a double-quote in a batch label by doubling it", async () => {
      mockTrend([{ batchLabel: 'Label "quoted" value' }]);
      const { default: Training } = await import("@/pages/training");
      render(<Training />);

      fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

      expect(capturedBlob).not.toBeNull();
      const csv = await capturedBlob!.text();
      expect(csv).toContain('"Label ""quoted"" value"');
    });

    it("exports an empty field (not the string null) when batch label is null", async () => {
      mockTrend([{ batchLabel: null }]);
      const { default: Training } = await import("@/pages/training");
      render(<Training />);

      fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

      expect(capturedBlob).not.toBeNull();
      const csv = await capturedBlob!.text();
      const dataLine = csv.split("\n")[1];
      expect(dataLine).not.toContain("null");
      expect(dataLine.endsWith(",")).toBe(true);
    });

    it("falls back to the week field when importDate is absent", async () => {
      mockTrend([{ importDate: null as unknown as string, week: "2024-W42" }]);
      const { default: Training } = await import("@/pages/training");
      render(<Training />);

      fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

      expect(capturedBlob).not.toBeNull();
      const csv = await capturedBlob!.text();
      expect(csv).toContain("2024-W42");
    });
  });

  describe("filtering reflected in export", () => {
    it("exports only rows matching a batch label search query", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);

      fireEvent.click(screen.getByText("Import History"));

      const searchInput = screen.getByPlaceholderText(/Filter by batch label or date/i);
      fireEvent.change(searchInput, { target: { value: "Alpha" } });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Export CSV/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

      expect(capturedBlob).not.toBeNull();
      const csv = await capturedBlob!.text();
      const lines = csv.split("\n").filter(Boolean);
      expect(lines).toHaveLength(2);
      expect(csv).toContain("Batch Alpha");
      expect(csv).not.toContain("Batch Beta");
    });

    it("hides the Export CSV button when filters exclude all rows", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);

      fireEvent.click(screen.getByText("Import History"));

      const searchInput = screen.getByPlaceholderText(/Filter by batch label or date/i);
      fireEvent.change(searchInput, { target: { value: "zzz-no-match-zzz" } });

      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /Export CSV/i })).not.toBeInTheDocument();
      });
    });

    it("exports only rows matching a date search query", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);

      fireEvent.click(screen.getByText("Import History"));

      const searchInput = screen.getByPlaceholderText(/Filter by batch label or date/i);
      fireEvent.change(searchInput, { target: { value: "Feb" } });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Export CSV/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

      expect(capturedBlob).not.toBeNull();
      const csv = await capturedBlob!.text();
      const lines = csv.split("\n").filter(Boolean);
      expect(lines).toHaveLength(2);
      expect(csv).toContain("Batch Beta");
      expect(csv).not.toContain("Batch Alpha");
    });

    it("exports only rows within the confidence range filter", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);

      fireEvent.click(screen.getByText("Import History"));

      const minInput = screen.getByLabelText(/Minimum confidence percentage/i);
      const maxInput = screen.getByLabelText(/Maximum confidence percentage/i);

      fireEvent.change(minInput, { target: { value: "80" } });
      fireEvent.change(maxInput, { target: { value: "100" } });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Export CSV/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

      expect(capturedBlob).not.toBeNull();
      const csv = await capturedBlob!.text();
      const lines = csv.split("\n").filter(Boolean);
      expect(lines).toHaveLength(2);
      expect(csv).toContain("85%");
      expect(csv).not.toContain("75%");
    });
  });
});
