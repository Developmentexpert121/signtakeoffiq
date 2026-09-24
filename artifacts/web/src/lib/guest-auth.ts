const STORAGE_KEY = "guest_token";

export interface GuestSession {
  token: string;
  userId: string;
  tenantId: string;
  expiresAt: number;
}

function decodeBase64Url(str: string): string {
  // base64url uses - and _ instead of + and /; pad to a multiple of 4
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return atob(padded);
}

function parseToken(token: string): { sub: string; tenantId: string; exp: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    if (typeof payload.sub !== "string" || typeof payload.tenantId !== "string" || typeof payload.exp !== "number") {
      return null;
    }
    return { sub: payload.sub, tenantId: payload.tenantId, exp: payload.exp };
  } catch {
    return null;
  }
}

export function getGuestSession(): GuestSession | null {
  try {
    const token = localStorage.getItem(STORAGE_KEY);
    if (!token) return null;
    const parsed = parseToken(token);
    if (!parsed) {
      clearGuestSession();
      return null;
    }
    const expiresAt = parsed.exp * 1000;
    if (Date.now() >= expiresAt) {
      clearGuestSession();
      return null;
    }
    return { token, userId: parsed.sub, tenantId: parsed.tenantId, expiresAt };
  } catch {
    return null;
  }
}

export function saveGuestSession(token: string): GuestSession {
  const parsed = parseToken(token);
  if (!parsed) throw new Error("Invalid guest token received from server");
  localStorage.setItem(STORAGE_KEY, token);
  return { token, userId: parsed.sub, tenantId: parsed.tenantId, expiresAt: parsed.exp * 1000 };
}

export function clearGuestSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
