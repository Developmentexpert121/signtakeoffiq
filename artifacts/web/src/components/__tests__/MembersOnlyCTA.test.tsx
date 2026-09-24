import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: vi.fn(),
}));
vi.mock("@/contexts/GuestAuthContext", () => ({
  useGuestAuth: vi.fn(),
}));
vi.mock("@/components/layout", () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { useAuth } from "@/contexts/AuthContext";
import { useGuestAuth } from "@/contexts/GuestAuthContext";
import { MemberRoute, MembersOnlyCTA } from "@/App";

const mockUseAuth = vi.mocked(useAuth);
const mockUseGuestAuth = vi.mocked(useGuestAuth);

const ROUTES = {
  training: {
    featureName: "Training",
    description:
      "See how AI accuracy improves over time — the more corrections members make, the smarter the takeoffs become. Create a free account to start contributing.",
    expectedHeading: "Training is for members only",
  },
  jobsNew: {
    featureName: "New Job",
    description:
      "Create and manage sign takeoff jobs. Create a free account to start your first job and access all member features.",
    expectedHeading: "New Job is for members only",
  },
} as const;

function TrainingStub() {
  return <div data-testid="training-page">Training Content</div>;
}

describe("MemberRoute — /training guest gate", () => {
  describe("when the visitor is unauthenticated", () => {
    beforeEach(() => {
      mockUseAuth.mockReturnValue({ isSignedIn: false, isLoaded: true } as ReturnType<typeof useAuth>);
      mockUseGuestAuth.mockReturnValue({ isGuest: false } as ReturnType<typeof useGuestAuth>);
    });

    it('shows the "Training is for members only" headline', () => {
      const { featureName, description } = ROUTES.training;
      render(<MemberRoute component={TrainingStub} featureName={featureName} description={description} />);
      expect(screen.getByText(ROUTES.training.expectedHeading)).toBeInTheDocument();
    });

    it("shows the Training-specific description", () => {
      const { featureName, description } = ROUTES.training;
      render(<MemberRoute component={TrainingStub} featureName={featureName} description={description} />);
      expect(screen.getByText(ROUTES.training.description)).toBeInTheDocument();
    });

    it("does not render the Training page content", () => {
      const { featureName, description } = ROUTES.training;
      render(<MemberRoute component={TrainingStub} featureName={featureName} description={description} />);
      expect(screen.queryByTestId("training-page")).not.toBeInTheDocument();
    });
  });

  describe("when the visitor is a guest", () => {
    beforeEach(() => {
      mockUseAuth.mockReturnValue({ isSignedIn: false, isLoaded: true } as ReturnType<typeof useAuth>);
      mockUseGuestAuth.mockReturnValue({ isGuest: true } as ReturnType<typeof useGuestAuth>);
    });

    it('shows the "Training is for members only" headline', () => {
      const { featureName, description } = ROUTES.training;
      render(<MemberRoute component={TrainingStub} featureName={featureName} description={description} />);
      expect(screen.getByText(ROUTES.training.expectedHeading)).toBeInTheDocument();
    });

    it("shows the Training-specific description", () => {
      const { featureName, description } = ROUTES.training;
      render(<MemberRoute component={TrainingStub} featureName={featureName} description={description} />);
      expect(screen.getByText(ROUTES.training.description)).toBeInTheDocument();
    });

    it("does not render the Training page content", () => {
      const { featureName, description } = ROUTES.training;
      render(<MemberRoute component={TrainingStub} featureName={featureName} description={description} />);
      expect(screen.queryByTestId("training-page")).not.toBeInTheDocument();
    });
  });

  describe("when the visitor is an authenticated member (non-guest)", () => {
    beforeEach(() => {
      mockUseAuth.mockReturnValue({ isSignedIn: true, isLoaded: true } as ReturnType<typeof useAuth>);
      mockUseGuestAuth.mockReturnValue({ isGuest: false } as ReturnType<typeof useGuestAuth>);
    });

    it("renders the Training page content (not the CTA)", () => {
      const { featureName, description } = ROUTES.training;
      render(<MemberRoute component={TrainingStub} featureName={featureName} description={description} />);
      expect(screen.getByTestId("training-page")).toBeInTheDocument();
    });

    it('does not show the "Training is for members only" headline', () => {
      const { featureName, description } = ROUTES.training;
      render(<MemberRoute component={TrainingStub} featureName={featureName} description={description} />);
      expect(screen.queryByText(ROUTES.training.expectedHeading)).not.toBeInTheDocument();
    });
  });
});

describe("MembersOnlyCTA — headline copy", () => {
  it('shows "Training is for members only" for the /training route', () => {
    const { featureName, description, expectedHeading } = ROUTES.training;
    render(<MembersOnlyCTA featureName={featureName} description={description} />);
    expect(screen.getByText(expectedHeading)).toBeInTheDocument();
  });

  it("shows the Training-specific description for the /training route", () => {
    const { featureName, description } = ROUTES.training;
    render(<MembersOnlyCTA featureName={featureName} description={description} />);
    expect(screen.getByText(description)).toBeInTheDocument();
  });

  it('shows "New Job is for members only" for the /jobs/new route', () => {
    const { featureName, description, expectedHeading } = ROUTES.jobsNew;
    render(<MembersOnlyCTA featureName={featureName} description={description} />);
    expect(screen.getByText(expectedHeading)).toBeInTheDocument();
  });

  it("shows the /jobs/new description", () => {
    const { featureName, description } = ROUTES.jobsNew;
    render(<MembersOnlyCTA featureName={featureName} description={description} />);
    expect(screen.getByText(description)).toBeInTheDocument();
  });

  it('falls back to "Members only" when no featureName is supplied', () => {
    render(<MembersOnlyCTA description="Create a free account." />);
    expect(screen.getByText("Members only")).toBeInTheDocument();
  });
});
