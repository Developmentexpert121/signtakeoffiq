import * as argon2 from "argon2";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import type { Request, Response } from "express";

const SESSION_COOKIE = "stiq_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
// When the cookie has less than this much life left, re-issue it on activity.
export const SESSION_REFRESH_THRESHOLD_SECONDS = 24 * 60 * 60; // 1 day

const ARGON2_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 1 << 16, // 64 MiB
  timeCost: 3,
  parallelism: 1,
};

let cachedSecret: string | null = null;
function sessionSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET environment variable is required in production (>= 16 chars).",
    );
  }
  cachedSecret = crypto.randomBytes(32).toString("hex");
  console.warn(
    "[sessionAuth] SESSION_SECRET not set — using ephemeral dev secret. Sessions will be invalidated on restart.",
  );
  return cachedSecret;
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export interface SessionPayload {
  sub: string; // user id
  tid: string; // tenant id
}

export interface VerifiedSession extends SessionPayload {
  /** Unix seconds when this token was issued (iat). */
  iat: number;
  /** Unix seconds when this token expires (exp). */
  exp: number;
}

export function signSession(payload: SessionPayload): string {
  return jwt.sign(payload, sessionSecret(), {
    algorithm: "HS256",
    expiresIn: SESSION_TTL_SECONDS,
  });
}

export function verifySession(token: string): SessionPayload | null {
  const full = verifySessionFull(token);
  return full ? { sub: full.sub, tid: full.tid } : null;
}

export function verifySessionFull(token: string): VerifiedSession | null {
  try {
    const decoded = jwt.verify(token, sessionSecret()) as jwt.JwtPayload;
    if (
      typeof decoded.sub !== "string" ||
      typeof decoded.tid !== "string" ||
      typeof decoded.iat !== "number" ||
      typeof decoded.exp !== "number"
    ) {
      return null;
    }
    return { sub: decoded.sub, tid: decoded.tid, iat: decoded.iat, exp: decoded.exp };
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, token: string): void {
  // Use SameSite=None + Secure so the cookie is delivered when the web app
  // is loaded inside a third-party iframe (e.g. the Replit canvas preview).
  // Replit dev domains are always HTTPS, so Secure is safe in dev too.
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
  });
}

export function readSessionCookie(req: Request): string | null {
  const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * Sliding refresh: if the given session has less than
 * SESSION_REFRESH_THRESHOLD_SECONDS of life remaining, re-issue a new cookie
 * with a fresh 7-day TTL.
 */
export function maybeRefreshSession(res: Response, session: VerifiedSession): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const remaining = session.exp - nowSec;
  if (remaining <= 0) return;
  if (remaining < SESSION_REFRESH_THRESHOLD_SECONDS) {
    const fresh = signSession({ sub: session.sub, tid: session.tid });
    setSessionCookie(res, fresh);
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

export function genResetToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export function validatePassword(p: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof p !== "string") return { ok: false, error: "Password is required." };
  if (p.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` };
  }
  if (p.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, error: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.` };
  }
  return { ok: true, value: p };
}
