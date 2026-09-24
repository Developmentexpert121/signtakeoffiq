import { customFetch } from "@workspace/api-client-react";

export interface ManagedUser {
  id: string;
  tenantId: string;
  email: string;
  fullName: string | null;
  role: "super_admin" | "owner" | "user";
  ownerId: string | null;
  createdAt: string;
  pending: boolean;
}

export interface UpdateUserInput {
  fullName?: string | null;
  role?: "super_admin" | "owner" | "user";
}

export async function listUsers(): Promise<ManagedUser[]> {
  return customFetch<ManagedUser[]>("/api/users", { method: "GET" });
}

export async function updateUser(id: string, input: UpdateUserInput): Promise<ManagedUser> {
  return customFetch<ManagedUser>(`/api/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteUser(id: string): Promise<void> {
  await customFetch<void>(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
}
