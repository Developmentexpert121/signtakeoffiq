import { useAuth } from "@/contexts/AuthContext";
import { useGuestAuth } from "@/contexts/GuestAuthContext";

const DEV_BYPASS =
  import.meta.env.VITE_DEV_BYPASS_AUTH === "true" &&
  import.meta.env.MODE !== "test";

function normalizeRole(role: string | null | undefined): "super_admin" | "owner" | "user" | "guest" {
  if (!role) return "user";
  if (role === "admin" || role === "super_admin") return "super_admin";
  if (role === "owner") return "owner";
  if (role === "guest") return "guest";
  return "user";
}

export function useCurrentUser() {
  const { user, isLoaded } = useAuth();
  const { isGuest } = useGuestAuth();

  if (DEV_BYPASS) {
    return {
      currentUser: undefined,
      role: "super_admin" as const,
      isMember: true,
      isAdmin: true,
      isSuperAdmin: true,
      isOwner: false,
      isOwnerOrAbove: true,
      isGuest: false,
      isLoading: false,
    };
  }

  const role = normalizeRole(user?.role);
  const isLoading = !isLoaded;
  const isMember = !isGuest && !!user;
  const isSuperAdmin = !isGuest && role === "super_admin";
  const isOwner = !isGuest && role === "owner";
  const isOwnerOrAbove = isSuperAdmin || isOwner;
  const isAdmin = isSuperAdmin;

  // currentUser is shaped to remain backwards-compatible with components that
  // read `.email`, `.fullName`, `.role`, etc.
  const currentUser = user
    ? {
        id: user.id,
        tenantId: user.tenantId,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
      }
    : undefined;

  return {
    currentUser,
    role,
    isMember,
    isAdmin,
    isSuperAdmin,
    isOwner,
    isOwnerOrAbove,
    isGuest,
    isLoading,
  };
}
