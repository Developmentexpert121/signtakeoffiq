import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";

if (!process.env.GUEST_JWT_SECRET && process.env.NODE_ENV === "production") {
  throw new Error(
    "GUEST_JWT_SECRET environment variable must be set in production. " +
    "Generate a long random string and add it as a secret before starting the server."
  );
}

// Use the env var if set; otherwise fall back to a random per-process secret
// (development only). A random secret means tokens are invalidated on every
// server restart, which is acceptable for development but not production.
const GUEST_JWT_SECRET =
  process.env.GUEST_JWT_SECRET ?? randomBytes(32).toString("hex");

export const GUEST_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
export const GUEST_SESSION_TTL_MS = GUEST_TOKEN_TTL_SECONDS * 1000;

export const GUEST_EMAIL_SUFFIX = "@guest.local";
export const GUEST_TENANT_PREFIX = "tenant_guest_";

export interface GuestTokenPayload {
  sub: string;
  tenantId: string;
  role: "guest";
  iat?: number;
  exp?: number;
}

export function newGuestId(): string {
  return `guest_${randomBytes(8).toString("hex")}`;
}

export function signGuestToken(userId: string, tenantId: string): string {
  const payload: Omit<GuestTokenPayload, "iat" | "exp"> = {
    sub: userId,
    tenantId,
    role: "guest",
  };
  return jwt.sign(payload, GUEST_JWT_SECRET, { expiresIn: GUEST_TOKEN_TTL_SECONDS });
}

export function verifyGuestToken(token: string): GuestTokenPayload | null {
  try {
    const decoded = jwt.verify(token, GUEST_JWT_SECRET) as GuestTokenPayload;
    if (decoded.role !== "guest") return null;
    return decoded;
  } catch {
    return null;
  }
}

export function isGuestEmail(email: string): boolean {
  return email.endsWith(GUEST_EMAIL_SUFFIX);
}

export function isGuestTenantId(tenantId: string): boolean {
  return tenantId.startsWith(GUEST_TENANT_PREFIX);
}
