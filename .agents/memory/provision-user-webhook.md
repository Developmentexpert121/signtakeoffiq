---
name: provision-user webhook (SignSuiteIQ sync)
description: Durable decisions for POST /api/internal/provision-user that syncs the local users table with SignSuiteIQ.
---

# provision-user webhook

The InstallIQ/SignSuiteIQ provisioning spec prescribes bcrypt cost 10, but this app
hashes native-login passwords with **Argon2** (`hashPassword`/`verifyPassword` in
`sessionAuth`). The webhook MUST reuse `hashPassword`, not bcrypt.
**Why:** provisioned passwords have to verify through the same native sign-in path; a
bcrypt hash would never match Argon2 verification. Unusable-password rows use a
`!unusable!<hex>` sentinel that argon2.verify always rejects.

`users.tenantId` is NOT NULL, so a provisioned user with no SignSuite company gets a
freshly created personal tenant rather than a null link.

**Soft-delete must be enforced at every auth entry point, not just login.** A
`deletedAt`-set (archived) user must be rejected in sign-in, `/auth/me`, requireAuth,
forgot-password, AND reset-password (both GET validate and POST) — otherwise a reset
token minted *before* archival could still set a password and mint a session.
**How to apply:** when adding any new endpoint that authenticates or issues a session,
add a `deletedAt` guard.

Spec defines lookup order as email (case-insensitive) then signsuiteiq_user_id, with
no conflict guard when they resolve to different rows — this matches InstallIQ and is
intentional; do not add a 409 conflict check unless the spec changes.
