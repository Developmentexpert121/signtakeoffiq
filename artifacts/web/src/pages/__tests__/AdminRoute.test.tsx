import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("@/contexts/GuestAuthContext", () => ({
  useGuestAuth: vi.fn(),
}));

vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock("wouter", () => ({
  useLocation: vi.fn(() => ["/admin", mockNavigate]),
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect" data-to={to} />,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/components/layout", () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-layout">{children}</div>
  ),
}));

import { useAuth } from "@/contexts/AuthContext";
import { useGuestAuth } from "@/contexts/GuestAuthContext";
import { useCurrentUser } from "@/hooks/use-current-user";
import { toast } from "sonner";

const mockUseAuth = vi.mocked(useAuth);
const mockUseGuestAuth = vi.mocked(useGuestAuth);
const mockUseCurrentUser = vi.mocked(useCurrentUser);
const mockToast = vi.mocked(toast);

function FakeAdminPage() {
  return <div data-testid="admin-page-content">Admin Content</div>;
}

describe("AdminRoute — route-level guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
  });

  describe("when the user is a signed-in admin", () => {
    beforeEach(() => {
      mockUseAuth.mockReturnValue({
        isSignedIn: true,
        isLoaded: true,
      } as ReturnType<typeof useAuth>);
      mockUseGuestAuth.mockReturnValue({
        isGuest: false,
        guestSession: null,
        loginAsGuest: vi.fn(),
        logoutGuest: vi.fn(),
      });
      mockUseCurrentUser.mockReturnValue({
        isAdmin: true,
        isLoading: false,
        isMember: true,
        currentUser: { id: "u1", email: "admin@example.com", fullName: "Admin", role: "super_admin" },
      } as ReturnType<typeof useCurrentUser>);
    });

    it("renders the wrapped component", async () => {
      const { AdminRoute } = await import("@/components/AdminRoute");
      render(<AdminRoute component={FakeAdminPage} />);
      expect(screen.getByTestId("admin-page-content")).toBeInTheDocument();
    });

    it("renders the component inside AppLayout", async () => {
      const { AdminRoute } = await import("@/components/AdminRoute");
      render(<AdminRoute component={FakeAdminPage} />);
      expect(screen.getByTestId("app-layout")).toBeInTheDocument();
      expect(screen.getByTestId("admin-page-content")).toBeInTheDocument();
    });

    it("does not show an access-denied toast", async () => {
      const { AdminRoute } = await import("@/components/AdminRoute");
      render(<AdminRoute component={FakeAdminPage} />);
      await waitFor(() => {
        expect(mockToast.error).not.toHaveBeenCalled();
      });
    });

    it("does not navigate away", async () => {
      const { AdminRoute } = await import("@/components/AdminRoute");
      render(<AdminRoute component={FakeAdminPage} />);
      await waitFor(() => {
        expect(mockNavigate).not.toHaveBeenCalled();
      });
    });
  });

  describe("when the user is signed in but NOT an admin", () => {
    beforeEach(() => {
      mockUseAuth.mockReturnValue({
        isSignedIn: true,
        isLoaded: true,
      } as ReturnType<typeof useAuth>);
      mockUseGuestAuth.mockReturnValue({
        isGuest: false,
        guestSession: null,
        loginAsGuest: vi.fn(),
        logoutGuest: vi.fn(),
      });
      mockUseCurrentUser.mockReturnValue({
        isAdmin: false,
        isLoading: false,
        isMember: true,
        currentUser: { id: "u2", email: "user@example.com", fullName: "Regular User", role: "user" },
      } as ReturnType<typeof useCurrentUser>);
    });

    it("fires an access-denied toast", async () => {
      const { AdminRoute } = await import("@/components/AdminRoute");
      render(<AdminRoute component={FakeAdminPage} />);
      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith(
          "Access denied. Admin privileges required."
        );
      });
    });

    it("navigates to /dashboard", async () => {
      const { AdminRoute } = await import("@/components/AdminRoute");
      render(<AdminRoute component={FakeAdminPage} />);
      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith("/dashboard");
      });
    });

    it("does not render the wrapped component", async () => {
      const { AdminRoute } = await import("@/components/AdminRoute");
      render(<AdminRoute component={FakeAdminPage} />);
      expect(screen.queryByTestId("admin-page-content")).not.toBeInTheDocument();
    });
  });

  describe("when the user is a guest", () => {
    beforeEach(() => {
      mockUseAuth.mockReturnValue({
        isSignedIn: false,
        isLoaded: true,
      } as ReturnType<typeof useAuth>);
      mockUseGuestAuth.mockReturnValue({
        isGuest: true,
        guestSession: null,
        loginAsGuest: vi.fn(),
        logoutGuest: vi.fn(),
      });
      mockUseCurrentUser.mockReturnValue({
        isAdmin: false,
        isLoading: false,
        isMember: false,
        currentUser: undefined,
      } as ReturnType<typeof useCurrentUser>);
    });

    it("shows a redirect to /", async () => {
      const { AdminRoute } = await import("@/components/AdminRoute");
      render(<AdminRoute component={FakeAdminPage} />);
      const redirect = screen.getByTestId("redirect");
      expect(redirect).toHaveAttribute("data-to", "/");
    });

    it("does not render the wrapped component", async () => {
      const { AdminRoute } = await import("@/components/AdminRoute");
      render(<AdminRoute component={FakeAdminPage} />);
      expect(screen.queryByTestId("admin-page-content")).not.toBeInTheDocument();
    });
  });

  describe("when auth is still loading", () => {
    beforeEach(() => {
      mockUseAuth.mockReturnValue({
        isSignedIn: false,
        isLoaded: false,
      } as ReturnType<typeof useAuth>);
      mockUseGuestAuth.mockReturnValue({
        isGuest: false,
        guestSession: null,
        loginAsGuest: vi.fn(),
        logoutGuest: vi.fn(),
      });
      mockUseCurrentUser.mockReturnValue({
        isAdmin: false,
        isLoading: true,
        isMember: false,
        currentUser: undefined,
      } as ReturnType<typeof useCurrentUser>);
    });

    it("renders nothing while loading", async () => {
      const { AdminRoute } = await import("@/components/AdminRoute");
      const { container } = render(<AdminRoute component={FakeAdminPage} />);
      expect(container).toBeEmptyDOMElement();
    });
  });
});
