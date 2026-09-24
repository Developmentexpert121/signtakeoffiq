import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type Role = "super_admin" | "owner" | "user" | "guest";

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  fullName: string | null;
  role: Role;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoaded: boolean;
  isSignedIn: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  setUser: (user: AuthUser | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const BASE_URL = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

async function fetchJson(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(init?.headers || {}) },
    ...init,
  });
}

interface ApiError extends Error {
  status?: number;
}

async function asError(res: Response, fallback: string): Promise<ApiError> {
  let msg = fallback;
  try {
    const data = await res.json();
    if (data?.error && typeof data.error === "string") msg = data.error;
  } catch {
    // ignore
  }
  const err = new Error(msg) as ApiError;
  err.status = res.status;
  return err;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<AuthUser | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetchJson("/api/auth/me");
      if (!mountedRef.current) return;
      if (res.ok) {
        const data = await res.json();
        setUserState(data.user as AuthUser);
      } else {
        setUserState(null);
      }
    } catch {
      if (mountedRef.current) setUserState(null);
    } finally {
      if (mountedRef.current) setIsLoaded(true);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await fetchJson("/api/auth/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      throw await asError(res, "Invalid email or password.");
    }
    const data = await res.json();
    setUserState(data.user as AuthUser);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await fetchJson("/api/auth/sign-out", { method: "POST" });
    } catch {
      // ignore network failures — we still clear local state.
    }
    setUserState(null);
  }, []);

  const setUser = useCallback((u: AuthUser | null) => {
    setUserState(u);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoaded,
      isSignedIn: !!user,
      signIn,
      signOut,
      refresh,
      setUser,
    }),
    [user, isLoaded, signIn, signOut, refresh, setUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
