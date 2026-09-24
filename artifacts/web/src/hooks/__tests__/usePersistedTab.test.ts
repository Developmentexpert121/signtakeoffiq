import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePersistedTab } from "@/hooks/usePersistedTab";

const VALID_TABS = ["overview", "rooms", "settings"];
const DEFAULT_TAB = "overview";
const STORAGE_KEY = "test-tab";
const QUERY_PARAM = "tab";

function setSearchParam(param: string, value: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(param, value);
  window.history.replaceState(null, "", url.toString());
}

function clearSearchParam(param: string) {
  const url = new URL(window.location.href);
  url.searchParams.delete(param);
  window.history.replaceState(null, "", url.toString());
}

describe("usePersistedTab", () => {
  beforeEach(() => {
    localStorage.clear();
    clearSearchParam(QUERY_PARAM);
  });

  afterEach(() => {
    localStorage.clear();
    clearSearchParam(QUERY_PARAM);
  });

  describe("initial tab selection", () => {
    it("returns the default tab when no URL param or localStorage value exists", () => {
      const { result } = renderHook(() =>
        usePersistedTab(STORAGE_KEY, VALID_TABS, DEFAULT_TAB, QUERY_PARAM)
      );

      expect(result.current[0]).toBe(DEFAULT_TAB);
    });

    it("returns the tab from the URL query param when it is valid", () => {
      setSearchParam(QUERY_PARAM, "rooms");

      const { result } = renderHook(() =>
        usePersistedTab(STORAGE_KEY, VALID_TABS, DEFAULT_TAB, QUERY_PARAM)
      );

      expect(result.current[0]).toBe("rooms");
    });

    it("ignores an invalid URL query param and falls back to the default tab", () => {
      setSearchParam(QUERY_PARAM, "nonexistent");

      const { result } = renderHook(() =>
        usePersistedTab(STORAGE_KEY, VALID_TABS, DEFAULT_TAB, QUERY_PARAM)
      );

      expect(result.current[0]).toBe(DEFAULT_TAB);
    });

    it("returns the tab stored in localStorage when no URL param is present", () => {
      localStorage.setItem(STORAGE_KEY, "settings");

      const { result } = renderHook(() =>
        usePersistedTab(STORAGE_KEY, VALID_TABS, DEFAULT_TAB, QUERY_PARAM)
      );

      expect(result.current[0]).toBe("settings");
    });

    it("prefers the URL query param over the localStorage value", () => {
      localStorage.setItem(STORAGE_KEY, "settings");
      setSearchParam(QUERY_PARAM, "rooms");

      const { result } = renderHook(() =>
        usePersistedTab(STORAGE_KEY, VALID_TABS, DEFAULT_TAB, QUERY_PARAM)
      );

      expect(result.current[0]).toBe("rooms");
    });

    it("returns the tab from localStorage when no queryParam argument is provided", () => {
      localStorage.setItem(STORAGE_KEY, "rooms");

      const { result } = renderHook(() =>
        usePersistedTab(STORAGE_KEY, VALID_TABS, DEFAULT_TAB)
      );

      expect(result.current[0]).toBe("rooms");
    });
  });

  describe("handleTabChange", () => {
    it("updates the active tab to the newly selected value", () => {
      const { result } = renderHook(() =>
        usePersistedTab(STORAGE_KEY, VALID_TABS, DEFAULT_TAB, QUERY_PARAM)
      );

      act(() => {
        result.current[1]("rooms");
      });

      expect(result.current[0]).toBe("rooms");
    });

    it("persists the new tab to localStorage", () => {
      const { result } = renderHook(() =>
        usePersistedTab(STORAGE_KEY, VALID_TABS, DEFAULT_TAB, QUERY_PARAM)
      );

      act(() => {
        result.current[1]("settings");
      });

      expect(localStorage.getItem(STORAGE_KEY)).toBe("settings");
    });

    it("updates the URL query param when queryParam is provided", () => {
      const { result } = renderHook(() =>
        usePersistedTab(STORAGE_KEY, VALID_TABS, DEFAULT_TAB, QUERY_PARAM)
      );

      act(() => {
        result.current[1]("rooms");
      });

      const params = new URLSearchParams(window.location.search);
      expect(params.get(QUERY_PARAM)).toBe("rooms");
    });

    it("does not update the URL when no queryParam is provided", () => {
      clearSearchParam(QUERY_PARAM);

      const { result } = renderHook(() =>
        usePersistedTab(STORAGE_KEY, VALID_TABS, DEFAULT_TAB)
      );

      act(() => {
        result.current[1]("rooms");
      });

      const params = new URLSearchParams(window.location.search);
      expect(params.get(QUERY_PARAM)).toBeNull();
    });
  });

  describe("popstate (browser back/forward navigation)", () => {
    it("updates the active tab when a valid popstate URL param is received", () => {
      const { result } = renderHook(() =>
        usePersistedTab(STORAGE_KEY, VALID_TABS, DEFAULT_TAB, QUERY_PARAM)
      );

      act(() => {
        setSearchParam(QUERY_PARAM, "settings");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      expect(result.current[0]).toBe("settings");
    });

    it("persists the tab to localStorage on popstate", () => {
      const { result } = renderHook(() =>
        usePersistedTab(STORAGE_KEY, VALID_TABS, DEFAULT_TAB, QUERY_PARAM)
      );

      act(() => {
        setSearchParam(QUERY_PARAM, "rooms");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      expect(result.current[0]).toBe("rooms");
      expect(localStorage.getItem(STORAGE_KEY)).toBe("rooms");
    });

    it("does not change the active tab when the popstate URL param is invalid", () => {
      const { result } = renderHook(() =>
        usePersistedTab(STORAGE_KEY, VALID_TABS, DEFAULT_TAB, QUERY_PARAM)
      );

      act(() => {
        result.current[1]("rooms");
      });

      act(() => {
        setSearchParam(QUERY_PARAM, "nonexistent");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      expect(result.current[0]).toBe("rooms");
    });

    it("does not change the active tab when the popstate URL has no tab param", () => {
      const { result } = renderHook(() =>
        usePersistedTab(STORAGE_KEY, VALID_TABS, DEFAULT_TAB, QUERY_PARAM)
      );

      act(() => {
        result.current[1]("rooms");
      });

      act(() => {
        clearSearchParam(QUERY_PARAM);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      expect(result.current[0]).toBe("rooms");
    });

    it("does not listen to popstate when no queryParam is provided", () => {
      const addSpy = vi.spyOn(window, "addEventListener");

      renderHook(() =>
        usePersistedTab(STORAGE_KEY, VALID_TABS, DEFAULT_TAB)
      );

      const popstateCalls = addSpy.mock.calls.filter(
        ([event]) => event === "popstate"
      );
      expect(popstateCalls).toHaveLength(0);

      addSpy.mockRestore();
    });

    it("removes the popstate listener on unmount", () => {
      const removeSpy = vi.spyOn(window, "removeEventListener");

      const { unmount } = renderHook(() =>
        usePersistedTab(STORAGE_KEY, VALID_TABS, DEFAULT_TAB, QUERY_PARAM)
      );

      unmount();

      const popstateCalls = removeSpy.mock.calls.filter(
        ([event]) => event === "popstate"
      );
      expect(popstateCalls).toHaveLength(1);

      removeSpy.mockRestore();
    });
  });
});
