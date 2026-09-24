import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { getGuestSession, saveGuestSession, clearGuestSession, type GuestSession } from "@/lib/guest-auth";
import { setAuthTokenGetter, setOnGuestUnauthorized } from "@workspace/api-client-react";

interface GuestAuthContextValue {
  guestSession: GuestSession | null;
  isGuest: boolean;
  loginAsGuest: () => Promise<void>;
  logoutGuest: () => void;
}

const GuestAuthContext = createContext<GuestAuthContextValue | null>(null);

const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");

export function GuestAuthProvider({ children }: { children: ReactNode }) {
  const [guestSession, setGuestSession] = useState<GuestSession | null>(() => getGuestSession());

  const logoutGuest = useCallback(() => {
    clearGuestSession();
    setAuthTokenGetter(null);
    setOnGuestUnauthorized(null);
    setGuestSession(null);
  }, []);

  // Sync the bearer token getter and 401 handler whenever guest session changes.
  // Only sets them when a guest session is active; always clears on Clerk sign-in
  // (ClerkGuestSync below calls logoutGuest).
  // When the server rejects the guest token (401), logoutGuest is called
  // automatically so the user is redirected to the sign-in page instead of
  // seeing a flood of "Unauthorized" errors.
  useEffect(() => {
    if (guestSession) {
      setAuthTokenGetter(() => guestSession.token);
      setOnGuestUnauthorized(logoutGuest);
    } else {
      setAuthTokenGetter(null);
      setOnGuestUnauthorized(null);
    }
  }, [guestSession, logoutGuest]);

  const loginAsGuest = useCallback(async () => {
    const res = await fetch(`${BASE_URL}/api/auth/guest`, { method: "POST" });
    if (!res.ok) throw new Error("Failed to create guest session");
    const { token } = await res.json();
    const session = saveGuestSession(token);
    setGuestSession(session);
  }, []);

  return (
    <GuestAuthContext.Provider value={{ guestSession, isGuest: guestSession !== null, loginAsGuest, logoutGuest }}>
      {children}
    </GuestAuthContext.Provider>
  );
}

export function useGuestAuth(): GuestAuthContextValue {
  const ctx = useContext(GuestAuthContext);
  if (!ctx) throw new Error("useGuestAuth must be used within GuestAuthProvider");
  return ctx;
}
