import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("@/contexts/GuestAuthContext");
vi.mock("@/hooks/use-auth-fetch");

import { useGuestAuth } from "@/contexts/GuestAuthContext";
import { useAuthFetch } from "@/hooks/use-auth-fetch";

const mockUseGuestAuth = vi.mocked(useGuestAuth);
const mockUseAuthFetch = vi.mocked(useAuthFetch);

const FAKE_BLOB_URL = "blob:http://localhost/fake-object-url";

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", {
    writable: true,
    value: vi.fn(() => FAKE_BLOB_URL),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function importHook() {
  const mod = await import("@/hooks/use-authed-img-url");
  return mod.useAuthedImgUrl;
}

describe("useAuthedImgUrl — non-guest (Clerk session)", () => {
  beforeEach(() => {
    mockUseGuestAuth.mockReturnValue({ guestSession: null } as ReturnType<typeof useGuestAuth>);
    mockUseAuthFetch.mockReturnValue(vi.fn() as ReturnType<typeof useAuthFetch>);
  });

  it("returns the direct API URL immediately without fetching", async () => {
    const useAuthedImgUrl = await importHook();
    const apiUrl = "/api/storage/objects/tenants/t1/rasterized/job1/A-001.png";
    const { result } = renderHook(() => useAuthedImgUrl(apiUrl));

    expect(result.current.displayUrl).toBe(apiUrl);
    expect(result.current.fetching).toBe(false);
    expect(result.current.fetchFailed).toBe(false);
  });

  it("returns null displayUrl when apiUrl is null", async () => {
    const useAuthedImgUrl = await importHook();
    const { result } = renderHook(() => useAuthedImgUrl(null));

    expect(result.current.displayUrl).toBeNull();
    expect(result.current.fetching).toBe(false);
    expect(result.current.fetchFailed).toBe(false);
  });
});

describe("useAuthedImgUrl — guest session", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockUseGuestAuth.mockReturnValue({
      guestSession: { token: "guest-bearer-token", expiresAt: new Date(Date.now() + 86400000).toISOString() },
    } as ReturnType<typeof useGuestAuth>);
    mockUseAuthFetch.mockReturnValue(mockFetch as ReturnType<typeof useAuthFetch>);
  });

  it("fetches the image and returns a blob URL on success", async () => {
    const fakeBlob = new Blob(["fake-png-data"], { type: "image/png" });
    mockFetch.mockResolvedValue({ ok: true, blob: () => Promise.resolve(fakeBlob) });

    const useAuthedImgUrl = await importHook();
    const apiUrl = "/api/storage/objects/tenants/t-guest/rasterized/job1/A-001.png";
    const { result } = renderHook(() => useAuthedImgUrl(apiUrl));

    await waitFor(() => {
      expect(result.current.fetching).toBe(false);
    });

    expect(result.current.displayUrl).toBe(FAKE_BLOB_URL);
    expect(result.current.fetchFailed).toBe(false);
    expect(URL.createObjectURL).toHaveBeenCalledWith(fakeBlob);
  });

  it("sets fetchFailed when the server responds with a non-ok status", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });

    const useAuthedImgUrl = await importHook();
    const apiUrl = "/api/storage/objects/tenants/t-guest/rasterized/job1/A-001.png";
    const { result } = renderHook(() => useAuthedImgUrl(apiUrl));

    await waitFor(() => {
      expect(result.current.fetchFailed).toBe(true);
    });

    expect(result.current.displayUrl).toBeNull();
    expect(result.current.fetching).toBe(false);
  });

  it("sets fetchFailed when the fetch rejects (network error)", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const useAuthedImgUrl = await importHook();
    const apiUrl = "/api/storage/objects/tenants/t-guest/rasterized/job1/A-001.png";
    const { result } = renderHook(() => useAuthedImgUrl(apiUrl));

    await waitFor(() => {
      expect(result.current.fetchFailed).toBe(true);
    });

    expect(result.current.displayUrl).toBeNull();
    expect(result.current.fetching).toBe(false);
  });

  it("starts in fetching=true state when apiUrl is provided", async () => {
    let resolveFetch!: (value: unknown) => void;
    mockFetch.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));

    const useAuthedImgUrl = await importHook();
    const apiUrl = "/api/storage/objects/tenants/t-guest/rasterized/job1/A-001.png";
    const { result } = renderHook(() => useAuthedImgUrl(apiUrl));

    expect(result.current.fetching).toBe(true);
    expect(result.current.displayUrl).toBeNull();

    resolveFetch({ ok: false, status: 500 });
  });

  it("revokes the old blob URL when apiUrl changes", async () => {
    const fakeBlob = new Blob(["data"], { type: "image/png" });
    mockFetch.mockResolvedValue({ ok: true, blob: () => Promise.resolve(fakeBlob) });

    const useAuthedImgUrl = await importHook();
    let apiUrl = "/api/storage/objects/tenants/t-guest/rasterized/job1/A-001.png";
    const { result, rerender } = renderHook(({ url }) => useAuthedImgUrl(url), {
      initialProps: { url: apiUrl },
    });

    await waitFor(() => {
      expect(result.current.displayUrl).toBe(FAKE_BLOB_URL);
    });

    apiUrl = "/api/storage/objects/tenants/t-guest/rasterized/job1/A-002.png";
    rerender({ url: apiUrl });

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(FAKE_BLOB_URL);
  });
});
