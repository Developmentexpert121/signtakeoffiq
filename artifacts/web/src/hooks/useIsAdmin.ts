import { useCurrentUser } from "@/hooks/use-current-user";

export function useIsAdmin() {
  const { isAdmin, isLoading } = useCurrentUser();
  return { isAdmin, isLoading, isResolved: !isLoading };
}
