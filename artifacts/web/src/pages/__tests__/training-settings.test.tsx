import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

vi.mock("@/hooks/useIsAdmin");
vi.mock("@/hooks/usePersistedTab", () => ({
  usePersistedTab: vi.fn(),
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
  useInvalidateSnapshotsCache: vi.fn(() => vi.fn()),
  useListJobs: vi.fn(),
  useRequestUploadUrl: vi.fn(),
  useInvalidateSnapshotsCache: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  customFetch: vi.fn(),
  getListRuleOverridesQueryKey: vi.fn(() => ["ruleOverrides"]),
  getGetOverrideImpactQueryKey: vi.fn(() => ["overrideImpact"]),
  getListSavedDateRangesQueryKey: vi.fn(() => ["savedDateRanges"]),
  createSavedDateRange: vi.fn(),
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
  useInvalidateSnapshotsCache,
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
const mockUseInvalidateSnapshotsCache = vi.mocked(useInvalidateSnapshotsCache);

function setupDefaultMocks() {
  mockUsePersistedTab.mockReturnValue(["settings", vi.fn()]);

  mockUseGetOverrideImpact.mockReturnValue({
    data: { activeOverrides: 0, totalOverrides: 0, totalCorrections: 0, correctionsThisMonth: 0, confidenceTrend: [], topPatterns: [] },
    isLoading: false,
    refetch: vi.fn(),
  } as ReturnType<typeof useGetOverrideImpact>);

  mockUseGetTrainingSnapshots.mockReturnValue({
    data: { snapshots: [], total: 0 },
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

  mockUseInvalidateSnapshotsCache.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useInvalidateSnapshotsCache>);
}

describe("Training page — Settings tab admin gate", () => {
  beforeAll(async () => {
    await import("@/pages/training");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  describe("when the user IS an admin", () => {
    beforeEach(() => {
      mockUseIsAdmin.mockReturnValue({ isAdmin: true, isLoading: false, isResolved: true });
    });

    it("shows the Save button for the overwrite threshold setting", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);
      expect(screen.getByRole("button", { name: /^Save$/i })).toBeInTheDocument();
    });

    it("does not show the 'Only owners can change this setting' message", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);
      expect(screen.queryByText(/Only owners can change this setting/i)).not.toBeInTheDocument();
    });

    it("renders the overwrite threshold input as enabled", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);
      const input = screen.getByRole("spinbutton", { name: /Overwrite Warning Threshold/i });
      expect(input).not.toBeDisabled();
    });
  });

  describe("when the user is NOT an admin", () => {
    beforeEach(() => {
      mockUseIsAdmin.mockReturnValue({ isAdmin: false, isLoading: false, isResolved: true });
    });

    it("does not show the Save button for the overwrite threshold setting", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);
      expect(screen.queryByRole("button", { name: /^Save$/i })).not.toBeInTheDocument();
    });

    it("shows the 'Only owners can change this setting' message", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);
      expect(screen.getByText(/Only owners can change this setting/i)).toBeInTheDocument();
    });

    it("renders the overwrite threshold input as disabled", async () => {
      const { default: Training } = await import("@/pages/training");
      render(<Training />);
      const input = screen.getByRole("spinbutton", { name: /Overwrite Warning Threshold/i });
      expect(input).toBeDisabled();
    });
  });
});
