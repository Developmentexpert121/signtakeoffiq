import { customFetch } from "@workspace/api-client-react";

export type InviteRole = "super_admin" | "owner" | "user";

export interface Invitation {
  id: string;
  email: string;
  role: InviteRole;
  expiresAt: string;
  createdAt: string;
  createdByName: string | null;
  acceptedAt: string | null;
}

export interface CreateInvitationInput {
  email: string;
  role: InviteRole;
}

export async function listInvitations(): Promise<Invitation[]> {
  return customFetch<Invitation[]>("/api/invitations", { method: "GET" });
}

export async function createInvitation(input: CreateInvitationInput): Promise<Invitation> {
  return customFetch<Invitation>("/api/invitations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function revokeInvitation(id: string): Promise<void> {
  await customFetch<void>(`/api/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export interface InvitationLookup {
  emailMasked: string;
  role: InviteRole;
  roleLabel: string;
  inviterName: string | null;
  tenantName: string;
  expiresAt: string;
}

// Public — no auth headers required.
export async function lookupInvitation(token: string): Promise<InvitationLookup> {
  const basePath = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  const url = `${basePath}/api/invitations/by-token/${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface AcceptInvitationInput {
  password: string;
  fullName: string;
}

export interface AcceptedInvitationUser {
  id: string;
  tenantId: string;
  email: string;
  fullName: string | null;
  role: "super_admin" | "owner" | "user" | "guest";
}

export async function acceptInvitation(
  token: string,
  input: AcceptInvitationInput,
): Promise<{ ok: true; user?: AcceptedInvitationUser }> {
  const basePath = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  const url = `${basePath}/api/invitations/accept/${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}
