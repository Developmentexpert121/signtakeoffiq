import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

vi.mock("@/hooks/useIsAdmin");
vi.mock("@workspace/api-client-react", () => ({
  useGetTenant: vi.fn(),
  useUpdateTenant: vi.fn(),
  useListTenantUsers: vi.fn(),
  useGetGuestCleanupStats: vi.fn(),
  useRunGuestCleanup: vi.fn(),
  useGetServerConfig: vi.fn(),
  usePatchAdminConfig: vi.fn(),
  getGetGuestCleanupStatsQueryKey: vi.fn(() => ["guestCleanupStats"]),
  getGetTenantQueryKey: vi.fn(() => ["tenant"]),
  getGetServerConfigQueryKey: vi.fn(() => ["serverConfig"]),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("recharts", () => ({
  BarChart: ({ children }: { children: React.ReactNode }) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { useIsAdmin } from "@/hooks/useIsAdmin";
import {
  useGetTenant,
  useUpdateTenant,
  useListTenantUsers,
  useGetGuestCleanupStats,
  useRunGuestCleanup,
  useGetServerConfig,
  usePatchAdminConfig,
} from "@workspace/api-client-react";

const mockUseIsAdmin = vi.mocked(useIsAdmin);
const mockUseGetTenant = vi.mocked(useGetTenant);
const mockUseUpdateTenant = vi.mocked(useUpdateTenant);
const mockUseListTenantUsers = vi.mocked(useListTenantUsers);
const mockUseGetGuestCleanupStats = vi.mocked(useGetGuestCleanupStats);
const mockUseRunGuestCleanup = vi.mocked(useRunGuestCleanup);
const mockUseGetServerConfig = vi.mocked(useGetServerConfig);
const mockUsePatchAdminConfig = vi.mocked(usePatchAdminConfig);

function setupDefaultMocks() {
  mockUseGetTenant.mockReturnValue({
    data: { name: "Acme Corp", plan: "pro", createdAt: new Date().toISOString(), settings: {} },
    isLoading: false,
  } as ReturnType<typeof useGetTenant>);

  mockUseUpdateTenant.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateTenant>);

  mockUseListTenantUsers.mockReturnValue({
    data: [{ id: "u1", email: "admin@example.com", fullName: "Admin User", role: "admin" }],
    isLoading: false,
  } as ReturnType<typeof useListTenantUsers>);

  mockUseGetGuestCleanupStats.mockReturnValue({
    data: undefined,
    isLoading: false,
  } as ReturnType<typeof useGetGuestCleanupStats>);

  mockUseRunGuestCleanup.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useRunGuestCleanup>);

  mockUseGetServerConfig.mockReturnValue({
    data: undefined,
    isLoading: false,
  } as ReturnType<typeof useGetServerConfig>);

  mockUsePatchAdminConfig.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof usePatchAdminConfig>);
}

describe("Admin page — admin gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  describe("when the user IS an admin", () => {
    beforeEach(() => {
      mockUseIsAdmin.mockReturnValue({ isAdmin: true, isLoading: false, isResolved: true });
    });

    it("shows the AI Retry Limit input", async () => {
      const { default: Admin } = await import("@/pages/admin");
      render(<Admin />);
      expect(screen.getByLabelText(/AI Retry Limit/i)).toBeInTheDocument();
    });

    it("shows the AI Vision Scan Limit input", async () => {
      const { default: Admin } = await import("@/pages/admin");
      render(<Admin />);
      expect(screen.getByLabelText(/AI Vision Scan Limit/i)).toBeInTheDocument();
    });

    it("shows the AI Scan Configuration card", async () => {
      const { default: Admin } = await import("@/pages/admin");
      render(<Admin />);
      expect(screen.getByText(/AI Scan Configuration/i)).toBeInTheDocument();
    });

    it("shows the Guest Session Cleanup card", async () => {
      const { default: Admin } = await import("@/pages/admin");
      render(<Admin />);
      expect(screen.getByText(/Guest Session Cleanup/i)).toBeInTheDocument();
    });
  });

  describe("when the user is NOT an admin", () => {
    beforeEach(() => {
      mockUseIsAdmin.mockReturnValue({ isAdmin: false, isLoading: false, isResolved: true });
    });

    it("does not show the AI Retry Limit input", async () => {
      const { default: Admin } = await import("@/pages/admin");
      render(<Admin />);
      expect(screen.queryByLabelText(/AI Retry Limit/i)).not.toBeInTheDocument();
    });

    it("does not show the AI Vision Scan Limit input", async () => {
      const { default: Admin } = await import("@/pages/admin");
      render(<Admin />);
      expect(screen.queryByLabelText(/AI Vision Scan Limit/i)).not.toBeInTheDocument();
    });

    it("does not show the AI Scan Configuration card", async () => {
      const { default: Admin } = await import("@/pages/admin");
      render(<Admin />);
      expect(screen.queryByText(/AI Scan Configuration/i)).not.toBeInTheDocument();
    });

    it("does not show the Guest Session Cleanup card", async () => {
      const { default: Admin } = await import("@/pages/admin");
      render(<Admin />);
      expect(screen.queryByText(/Guest Session Cleanup/i)).not.toBeInTheDocument();
    });
  });
});
