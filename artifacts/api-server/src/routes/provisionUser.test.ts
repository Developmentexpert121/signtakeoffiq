import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import {
  db,
  usersTable,
  tenantsTable,
  authCredentialsTable,
  passwordResetTokensTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import provisionUserRouter from "./provisionUser";
import authRouter from "./auth";
import { verifyPassword, hashResetToken, newId } from "../lib/sessionAuth";
import { cleanupTenants, uid } from "../__tests__/fixtures";

const APP_SECRET = "test-signsuite-secret-0123456789";

function createApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  // Minimal pino-style logger so route handlers can call req.log.*
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
      fatal: () => {},
      trace: () => {},
    };
    next();
  });
  app.use("/api", provisionUserRouter);
  app.use("/api", authRouter);
  return app;
}

const app = createApp();

function provision(body: Record<string, unknown>, secret: string | null = APP_SECRET) {
  const r = request(app).post("/api/internal/provision-user").send(body);
  return secret === null ? r : r.set("X-App-Secret", secret);
}

const trackedTenantIds: string[] = [];

async function trackUserTenant(userId: string): Promise<void> {
  const [row] = await db
    .select({ tenantId: usersTable.tenantId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (row) trackedTenantIds.push(row.tenantId);
}

beforeAll(() => {
  process.env.SIGNSUITE_SSO_SECRET = APP_SECRET;
});

afterEach(async () => {
  await cleanupTenants([...trackedTenantIds]);
  trackedTenantIds.length = 0;
});

describe("POST /api/internal/provision-user — auth guard", () => {
  it("rejects a request with no X-App-Secret", async () => {
    const res = await provision({ action: "upsert", email: "x@test.com" }, null);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid app secret");
  });

  it("rejects a request with a wrong secret", async () => {
    const res = await provision({ action: "upsert", email: "x@test.com" }, "wrong-secret");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid app secret");
  });
});

describe("POST /api/internal/provision-user — upsert lifecycle", () => {
  let email: string;

  beforeEach(() => {
    email = `${uid("newuser")}@test.com`.toLowerCase();
  });

  it("creates a brand-new user with a working password and signsuiteiq_user_id", async () => {
    const externalId = Math.floor(Math.random() * 1_000_000) + 1;
    const res = await provision({
      action: "upsert",
      external_id: externalId,
      email,
      username: "newuser",
      name: "New User",
      role: "user",
      password: "Tmp123!x",
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe("upsert");
    const userId = res.body.user_id as string;
    await trackUserTenant(userId);

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    expect(user.signsuiteiqUserId).toBe(externalId);
    expect(user.email).toBe(email);

    const [cred] = await db
      .select()
      .from(authCredentialsTable)
      .where(eq(authCredentialsTable.userId, userId))
      .limit(1);
    expect(await verifyPassword("Tmp123!x", cred.passwordHash)).toBe(true);

    // Native login works with the provisioned password.
    const login = await request(app).post("/api/auth/sign-in").send({ email, password: "Tmp123!x" });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(userId);
  });

  it("appends a numeric suffix when the username collides", async () => {
    const first = await provision({
      action: "upsert",
      external_id: Math.floor(Math.random() * 1_000_000) + 1,
      email,
      username: "collide",
      name: "First",
      role: "user",
      password: "Pw123456",
    });
    await trackUserTenant(first.body.user_id);

    const email2 = `${uid("other")}@test.com`.toLowerCase();
    const second = await provision({
      action: "upsert",
      external_id: Math.floor(Math.random() * 1_000_000) + 1,
      email: email2,
      username: "collide",
      name: "Second",
      role: "user",
      password: "Pw123456",
    });
    expect(second.status).toBe(200);
    await trackUserTenant(second.body.user_id);

    const [u2] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, second.body.user_id))
      .limit(1);
    expect(u2.username).toBe("collide1");
  });

  it("updates profile fields without a password and leaves the hash intact", async () => {
    const create = await provision({
      action: "upsert",
      email,
      username: uid("u"),
      name: "Before",
      role: "user",
      password: "Keep123!",
    });
    const userId = create.body.user_id as string;
    await trackUserTenant(userId);
    const [credBefore] = await db
      .select()
      .from(authCredentialsTable)
      .where(eq(authCredentialsTable.userId, userId))
      .limit(1);

    const update = await provision({ action: "upsert", email, name: "After Name" });
    expect(update.status).toBe(200);
    expect(update.body.user_id).toBe(userId);

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    expect(user.fullName).toBe("After Name");

    const [credAfter] = await db
      .select()
      .from(authCredentialsTable)
      .where(eq(authCredentialsTable.userId, userId))
      .limit(1);
    expect(credAfter.passwordHash).toBe(credBefore.passwordHash);

    const login = await request(app).post("/api/auth/sign-in").send({ email, password: "Keep123!" });
    expect(login.status).toBe(200);
  });

  it("resets the password so the old one stops working and the new one works", async () => {
    const create = await provision({
      action: "upsert",
      email,
      username: uid("u"),
      name: "Reset Me",
      role: "user",
      password: "OldPass1!",
    });
    await trackUserTenant(create.body.user_id);

    const reset = await provision({ action: "upsert", email, password: "Reset999!" });
    expect(reset.status).toBe(200);

    const oldLogin = await request(app).post("/api/auth/sign-in").send({ email, password: "OldPass1!" });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app).post("/api/auth/sign-in").send({ email, password: "Reset999!" });
    expect(newLogin.status).toBe(200);
  });

  it("updates the existing row (no duplicate) when the email changes for the same external_id", async () => {
    const externalId = Math.floor(Math.random() * 1_000_000) + 1;
    const create = await provision({
      action: "upsert",
      external_id: externalId,
      email,
      username: uid("u"),
      name: "Renamer",
      role: "user",
      password: "Pw123456",
    });
    const userId = create.body.user_id as string;
    await trackUserTenant(userId);

    const renamedEmail = `${uid("renamed")}@test.com`.toLowerCase();
    const rename = await provision({
      action: "upsert",
      external_id: externalId,
      email: renamedEmail,
    });
    expect(rename.status).toBe(200);
    expect(rename.body.user_id).toBe(userId);

    const rows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.signsuiteiqUserId, externalId));
    expect(rows.length).toBe(1);
    expect(rows[0].email).toBe(renamedEmail);
  });

  it("returns 409 and mutates neither row when email and external_id resolve to different users", async () => {
    // User A: matched by email.
    const externalIdA = Math.floor(Math.random() * 1_000_000) + 1;
    const userA = await provision({
      action: "upsert",
      external_id: externalIdA,
      email,
      username: uid("u"),
      name: "User A",
      role: "user",
      password: "Pw123456",
    });
    const userIdA = userA.body.user_id as string;
    await trackUserTenant(userIdA);

    // User B: owns a different external_id.
    const externalIdB = externalIdA + 1;
    const emailB = `${uid("userb")}@test.com`.toLowerCase();
    const userB = await provision({
      action: "upsert",
      external_id: externalIdB,
      email: emailB,
      username: uid("u"),
      name: "User B",
      role: "user",
      password: "Pw123456",
    });
    const userIdB = userB.body.user_id as string;
    await trackUserTenant(userIdB);

    // Conflicting request: email of A but external_id of B.
    const conflict = await provision({
      action: "upsert",
      external_id: externalIdB,
      email,
      name: "Should Not Apply",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("email and external_id resolve to different users");

    // Neither row was mutated.
    const [a] = await db.select().from(usersTable).where(eq(usersTable.id, userIdA)).limit(1);
    expect(a.signsuiteiqUserId).toBe(externalIdA);
    expect(a.fullName).toBe("User A");

    const [b] = await db.select().from(usersTable).where(eq(usersTable.id, userIdB)).limit(1);
    expect(b.signsuiteiqUserId).toBe(externalIdB);
    expect(b.email).toBe(emailB);
    expect(b.fullName).toBe("User B");
  });

  it("links and upserts a tenant when one is supplied", async () => {
    const companyId = Math.floor(Math.random() * 1_000_000) + 1;
    const res = await provision({
      action: "upsert",
      email,
      username: uid("u"),
      name: "Has Company",
      role: "owner",
      password: "Pw123456",
      tenant: {
        external_id: companyId,
        name: "Acme Signs Inc.",
        slug: `acme-${companyId}`,
        email: "billing@acme.com",
      },
    });
    expect(res.status).toBe(200);
    await trackUserTenant(res.body.user_id);

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, res.body.user_id)).limit(1);
    const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, user.tenantId)).limit(1);
    expect(tenant.signsuiteiqCompanyId).toBe(companyId);
    expect(tenant.name).toBe("Acme Signs Inc.");
  });
});

describe("POST /api/internal/provision-user — delete", () => {
  it("soft-deletes a user so they can no longer log in, and ignores a second delete", async () => {
    const email = `${uid("del")}@test.com`.toLowerCase();
    const create = await provision({
      action: "upsert",
      email,
      username: uid("u"),
      name: "Delete Me",
      role: "user",
      password: "Pw123456",
    });
    const userId = create.body.user_id as string;
    await trackUserTenant(userId);

    const del = await provision({ action: "delete", email });
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
    expect(del.body.user_id).toBe(userId);

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    expect(user.deletedAt).not.toBeNull();

    const login = await request(app).post("/api/auth/sign-in").send({ email, password: "Pw123456" });
    expect(login.status).toBe(401);

    const secondDelete = await provision({ action: "delete", email });
    expect(secondDelete.status).toBe(200);
    expect(secondDelete.body.ignored).toBe(true);
  });

  it("returns ignored:true for a delete that matches no user", async () => {
    const res = await provision({ action: "delete", email: `${uid("ghost")}@test.com` });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
  });
});

describe("archived users cannot reset their password with a pre-issued token", () => {
  it("rejects reset-password for a user soft-deleted after the token was minted", async () => {
    const email = `${uid("archived")}@test.com`.toLowerCase();
    const create = await provision({
      action: "upsert",
      email,
      username: uid("u"),
      name: "Archive Me",
      role: "user",
      password: "OldPass1!",
    });
    const userId = create.body.user_id as string;
    await trackUserTenant(userId);

    // Mint a reset token BEFORE archival (valid, unused, future expiry).
    const rawToken = `tok_${uid("reset")}`;
    await db.insert(passwordResetTokensTable).values({
      id: newId("prt"),
      userId,
      tokenHash: hashResetToken(rawToken),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const [credBefore] = await db
      .select()
      .from(authCredentialsTable)
      .where(eq(authCredentialsTable.userId, userId))
      .limit(1);

    // Archive the user.
    const del = await provision({ action: "delete", email });
    expect(del.status).toBe(200);

    // The pre-issued token must no longer work.
    const reset = await request(app)
      .post(`/api/auth/reset-password/${rawToken}`)
      .send({ password: "NewPass9!" });
    expect(reset.status).toBe(410);

    // Password hash is untouched and no session cookie was issued.
    expect(reset.headers["set-cookie"]).toBeUndefined();
    const [credAfter] = await db
      .select()
      .from(authCredentialsTable)
      .where(eq(authCredentialsTable.userId, userId))
      .limit(1);
    expect(credAfter.passwordHash).toBe(credBefore.passwordHash);
  });
});

describe("POST /api/internal/provision-user — validation", () => {
  it("returns 400 for an unknown action", async () => {
    const res = await provision({ action: "frobnicate", email: "x@test.com" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when neither email nor external_id is present", async () => {
    const res = await provision({ action: "upsert" });
    expect(res.status).toBe(400);
  });
});
