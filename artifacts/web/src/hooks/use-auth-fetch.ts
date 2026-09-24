import { useCallback } from "react";
import { useGuestAuth } from "@/contexts/GuestAuthContext";

/**
 * Returns a `fetch` wrapper that automatically attaches the guest Bearer
 * token when a guest session is active.  For Clerk-authenticated users the
 * session cookie is sent automatically by the browser, so no header is added.
 */
export function useAuthFetch() {
  const { guestSession } = useGuestAuth();

  return useCallback(
    async (url: string, options: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(options.headers);
      if (guestSession?.token && !headers.has("authorization")) {
        headers.set("authorization", `Bearer ${guestSession.token}`);
      }
      return fetch(url, { ...options, headers });
    },
    [guestSession],
  );
}
