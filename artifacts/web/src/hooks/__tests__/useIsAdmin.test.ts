import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useIsAdmin } from "@/hooks/useIsAdmin";

vi.mock("@/hooks/use-current-user");

import { useCurrentUser } from "@/hooks/use-current-user";

const mockUseCurrentUser = vi.mocked(useCurrentUser);

describe("useIsAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns isAdmin=false and isLoading=true while loading", () => {
    mockUseCurrentUser.mockReturnValue({
      currentUser: undefined,
      isMember: false,
      isAdmin: false,
      isLoading: true,
    });

    const { result } = renderHook(() => useIsAdmin());

    expect(result.current.isAdmin).toBe(false);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isResolved).toBe(false);
  });

  it("returns isAdmin=true and isResolved=true for an admin user", () => {
    mockUseCurrentUser.mockReturnValue({
      currentUser: { id: "1", email: "admin@example.com", role: "admin", fullName: "Admin User" } as Parameters<typeof mockUseCurrentUser>[0],
      isMember: true,
      isAdmin: true,
      isLoading: false,
    });

    const { result } = renderHook(() => useIsAdmin());

    expect(result.current.isAdmin).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isResolved).toBe(true);
  });

  it("returns isAdmin=false and isResolved=true for a non-admin member", () => {
    mockUseCurrentUser.mockReturnValue({
      currentUser: { id: "2", email: "member@example.com", role: "member", fullName: "Regular User" } as Parameters<typeof mockUseCurrentUser>[0],
      isMember: true,
      isAdmin: false,
      isLoading: false,
    });

    const { result } = renderHook(() => useIsAdmin());

    expect(result.current.isAdmin).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isResolved).toBe(true);
  });

  it("returns isAdmin=false and isResolved=true for a guest user", () => {
    mockUseCurrentUser.mockReturnValue({
      currentUser: undefined,
      isMember: false,
      isAdmin: false,
      isLoading: false,
    });

    const { result } = renderHook(() => useIsAdmin());

    expect(result.current.isAdmin).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isResolved).toBe(true);
  });
});
