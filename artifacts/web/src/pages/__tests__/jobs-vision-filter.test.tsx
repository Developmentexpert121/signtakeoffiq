import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import React from "react";

vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  useListJobs: vi.fn(),
  useDeleteJob: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

let mockSearchString = "";
const mockSetLocation = vi.fn((path: string) => {
  const qIdx = typeof path === "string" ? path.indexOf("?") : -1;
  mockSearchString = qIdx >= 0 ? path.slice(qIdx + 1) : "";
});

vi.mock("wouter", () => ({
  useLocation: vi.fn(() => ["/jobs", mockSetLocation]),
  useSearch: vi.fn(() => mockSearchString),
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { useCurrentUser } from "@/hooks/use-current-user";
import { useListJobs } from "@workspace/api-client-react";
import { useSearch } from "wouter";

const mockUseCurrentUser = vi.mocked(useCurrentUser);
const mockUseListJobs = vi.mocked(useListJobs);
const mockUseSearch = vi.mocked(useSearch);

const JOB_DEFAULT = {
  id: "job-default",
  name: "Job Default Vision",
  location: "NYC",
  status: "completed",
  totalSigns: 10,
  needsReview: 0,
  visionThreshold: null,
  buildingType: null,
  metadata: null,
  createdAt: new Date().toISOString(),
};

const JOB_OFF = {
  id: "job-off",
  name: "Job Vision Off",
  location: "LA",
  status: "completed",
  totalSigns: 5,
  needsReview: 0,
  visionThreshold: 0,
  buildingType: null,
  metadata: null,
  createdAt: new Date().toISOString(),
};

const JOB_CUSTOM = {
  id: "job-custom",
  name: "Job Custom Threshold",
  location: "Chicago",
  status: "completed",
  totalSigns: 8,
  needsReview: 0,
  visionThreshold: 75,
  buildingType: null,
  metadata: null,
  createdAt: new Date().toISOString(),
};

function setupMocks(searchString = "") {
  mockSearchString = searchString;
  mockUseSearch.mockImplementation(() => mockSearchString);
  mockUseCurrentUser.mockReturnValue({
    isMember: true,
    isAdmin: false,
    isLoading: false,
    currentUser: { id: "u1", email: "test@example.com", fullName: "Test User", role: "member" },
  } as ReturnType<typeof useCurrentUser>);
  mockUseListJobs.mockReturnValue({
    data: [JOB_DEFAULT, JOB_OFF, JOB_CUSTOM],
    isLoading: false,
  } as ReturnType<typeof useListJobs>);
}

async function renderJobs() {
  const { default: Jobs } = await import("@/pages/jobs");
  render(<Jobs />);
}

describe("AI Vision filter — Jobs page component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetLocation.mockClear();
  });

  describe("filter button initial state", () => {
    it("shows 'All AI Vision' when no vision filter is active", async () => {
      setupMocks("");
      await renderJobs();
      expect(screen.getByTestId("btn-vision-filter")).toHaveTextContent("All AI Vision");
    });

    it("shows the option label when a single filter is active", async () => {
      setupMocks("vision=default");
      await renderJobs();
      expect(screen.getByTestId("btn-vision-filter")).toHaveTextContent("Default");
    });

    it("shows '{n} selected' when multiple filters are active", async () => {
      setupMocks("vision=default,off");
      await renderJobs();
      expect(screen.getByTestId("btn-vision-filter")).toHaveTextContent("2 selected");
    });
  });

  describe("popover content", () => {
    it("opens the popover and shows all three options", async () => {
      setupMocks("");
      await renderJobs();
      fireEvent.click(screen.getByTestId("btn-vision-filter"));
      expect(screen.getByTestId("vision-option-default")).toBeInTheDocument();
      expect(screen.getByTestId("vision-option-off")).toBeInTheDocument();
      expect(screen.getByTestId("vision-option-custom")).toBeInTheDocument();
    });

    it("shows 'Default' label for the default option", async () => {
      setupMocks("");
      await renderJobs();
      fireEvent.click(screen.getByTestId("btn-vision-filter"));
      expect(screen.getByTestId("vision-option-default")).toHaveTextContent("Default");
    });

    it("shows 'Off' label for the off option", async () => {
      setupMocks("");
      await renderJobs();
      fireEvent.click(screen.getByTestId("btn-vision-filter"));
      expect(screen.getByTestId("vision-option-off")).toHaveTextContent("Off");
    });

    it("shows 'Custom Threshold' label for the custom option", async () => {
      setupMocks("");
      await renderJobs();
      fireEvent.click(screen.getByTestId("btn-vision-filter"));
      expect(screen.getByTestId("vision-option-custom")).toHaveTextContent("Custom Threshold");
    });

    it("does not show the clear filter button when no filters are active", async () => {
      setupMocks("");
      await renderJobs();
      fireEvent.click(screen.getByTestId("btn-vision-filter"));
      expect(screen.queryByTestId("btn-clear-vision-filters")).not.toBeInTheDocument();
    });

    it("shows the clear filter button when a filter is active", async () => {
      setupMocks("vision=default");
      await renderJobs();
      fireEvent.click(screen.getByTestId("btn-vision-filter"));
      expect(screen.getByTestId("btn-clear-vision-filters")).toBeInTheDocument();
    });
  });

  describe("checkbox state reflects active filters", () => {
    it("checks the 'Default' checkbox when vision=default is in the URL", async () => {
      setupMocks("vision=default");
      await renderJobs();
      fireEvent.click(screen.getByTestId("btn-vision-filter"));
      const defaultOption = screen.getByTestId("vision-option-default");
      const checkbox = within(defaultOption).getByRole("checkbox");
      expect(checkbox).toBeChecked();
    });

    it("leaves the 'Off' checkbox unchecked when only vision=default is active", async () => {
      setupMocks("vision=default");
      await renderJobs();
      fireEvent.click(screen.getByTestId("btn-vision-filter"));
      const offOption = screen.getByTestId("vision-option-off");
      const checkbox = within(offOption).getByRole("checkbox");
      expect(checkbox).not.toBeChecked();
    });

    it("checks both 'Default' and 'Off' checkboxes when vision=default,off is active", async () => {
      setupMocks("vision=default,off");
      await renderJobs();
      fireEvent.click(screen.getByTestId("btn-vision-filter"));
      const defaultCheckbox = within(screen.getByTestId("vision-option-default")).getByRole("checkbox");
      const offCheckbox = within(screen.getByTestId("vision-option-off")).getByRole("checkbox");
      expect(defaultCheckbox).toBeChecked();
      expect(offCheckbox).toBeChecked();
    });
  });

  describe("filter interactions — selecting options", () => {
    it("calls navigation with the selected option when clicking an unchecked option", async () => {
      setupMocks("");
      await renderJobs();
      fireEvent.click(screen.getByTestId("btn-vision-filter"));
      fireEvent.click(screen.getByTestId("vision-option-default"));
      expect(mockSetLocation).toHaveBeenCalledWith(
        expect.stringContaining("vision=default"),
        expect.anything()
      );
    });

    it("calls navigation with comma-separated values when adding a second option", async () => {
      setupMocks("vision=default");
      await renderJobs();
      fireEvent.click(screen.getByTestId("btn-vision-filter"));
      fireEvent.click(screen.getByTestId("vision-option-off"));
      const calledWith = mockSetLocation.mock.calls[0][0] as string;
      expect(calledWith).toContain("vision=");
      const visionParam = new URLSearchParams(calledWith.includes("?") ? calledWith.split("?")[1] : calledWith).get("vision");
      expect(visionParam?.split(",")).toContain("default");
      expect(visionParam?.split(",")).toContain("off");
    });

    it("calls navigation removing an option when clicking a checked option", async () => {
      setupMocks("vision=default,off");
      await renderJobs();
      fireEvent.click(screen.getByTestId("btn-vision-filter"));
      fireEvent.click(screen.getByTestId("vision-option-default"));
      const calledWith = mockSetLocation.mock.calls[0][0] as string;
      const visionParam = new URLSearchParams(calledWith.includes("?") ? calledWith.split("?")[1] : calledWith).get("vision");
      expect(visionParam?.split(",")).not.toContain("default");
      expect(visionParam?.split(",")).toContain("off");
    });
  });

  describe("filter interactions — clear filter", () => {
    it("calls navigation removing the vision param when clear is clicked", async () => {
      setupMocks("vision=default");
      await renderJobs();
      fireEvent.click(screen.getByTestId("btn-vision-filter"));
      fireEvent.click(screen.getByTestId("btn-clear-vision-filters"));
      const calledWith = mockSetLocation.mock.calls[0][0] as string;
      const visionParam = new URLSearchParams(calledWith.includes("?") ? calledWith.split("?")[1] : calledWith).get("vision");
      expect(visionParam == null || visionParam === "").toBe(true);
    });
  });

  describe("job filtering — OR logic on visionThreshold", () => {
    it("shows all jobs when no vision filter is active", async () => {
      setupMocks("");
      await renderJobs();
      expect(screen.getByTestId("row-job-job-default")).toBeInTheDocument();
      expect(screen.getByTestId("row-job-job-off")).toBeInTheDocument();
      expect(screen.getByTestId("row-job-job-custom")).toBeInTheDocument();
    });

    it("shows only the default-vision job when vision=default", async () => {
      setupMocks("vision=default");
      await renderJobs();
      expect(screen.getByTestId("row-job-job-default")).toBeInTheDocument();
      expect(screen.queryByTestId("row-job-job-off")).not.toBeInTheDocument();
      expect(screen.queryByTestId("row-job-job-custom")).not.toBeInTheDocument();
    });

    it("shows only the off-vision job when vision=off", async () => {
      setupMocks("vision=off");
      await renderJobs();
      expect(screen.queryByTestId("row-job-job-default")).not.toBeInTheDocument();
      expect(screen.getByTestId("row-job-job-off")).toBeInTheDocument();
      expect(screen.queryByTestId("row-job-job-custom")).not.toBeInTheDocument();
    });

    it("shows only the custom-threshold job when vision=custom", async () => {
      setupMocks("vision=custom");
      await renderJobs();
      expect(screen.queryByTestId("row-job-job-default")).not.toBeInTheDocument();
      expect(screen.queryByTestId("row-job-job-off")).not.toBeInTheDocument();
      expect(screen.getByTestId("row-job-job-custom")).toBeInTheDocument();
    });

    it("shows default and off jobs when vision=default,off (OR logic)", async () => {
      setupMocks("vision=default,off");
      await renderJobs();
      expect(screen.getByTestId("row-job-job-default")).toBeInTheDocument();
      expect(screen.getByTestId("row-job-job-off")).toBeInTheDocument();
      expect(screen.queryByTestId("row-job-job-custom")).not.toBeInTheDocument();
    });

    it("shows all jobs when all three options are selected", async () => {
      setupMocks("vision=default,off,custom");
      await renderJobs();
      expect(screen.getByTestId("row-job-job-default")).toBeInTheDocument();
      expect(screen.getByTestId("row-job-job-off")).toBeInTheDocument();
      expect(screen.getByTestId("row-job-job-custom")).toBeInTheDocument();
    });

    it("restores all jobs after clearing the filter (navigates to no-filter URL)", async () => {
      setupMocks("vision=default");
      await renderJobs();
      fireEvent.click(screen.getByTestId("btn-vision-filter"));
      fireEvent.click(screen.getByTestId("btn-clear-vision-filters"));
      const clearedPath = mockSetLocation.mock.calls[0][0] as string;
      const clearedVision = new URLSearchParams(
        clearedPath.includes("?") ? clearedPath.split("?")[1] : clearedPath
      ).get("vision");
      expect(clearedVision == null || clearedVision === "").toBe(true);
    });
  });
});
