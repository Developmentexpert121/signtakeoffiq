import { useEffect } from "react";
import { Redirect, useLocation } from "wouter";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { useGuestAuth } from "@/contexts/GuestAuthContext";
import { useCurrentUser } from "@/hooks/use-current-user";
import { AppLayout } from "@/components/layout";

const DEV_BYPASS =
  import.meta.env.VITE_DEV_BYPASS_AUTH === "true" &&
  import.meta.env.MODE !== "test";

export function OwnerRoute({ component: Component }: { component: React.ComponentType }) {
  const { isSignedIn, isLoaded } = useAuth();
  const { isGuest } = useGuestAuth();
  const { isOwnerOrAbove, isLoading: loadingUser } = useCurrentUser();
  const [, navigate] = useLocation();

  const denied = isLoaded && !loadingUser && isSignedIn && !isGuest && !isOwnerOrAbove;

  useEffect(() => {
    if (!DEV_BYPASS && denied) {
      toast.error("Access denied. Owner or Super Admin privileges required.");
      navigate("/dashboard");
    }
  }, [denied, navigate]);

  if (DEV_BYPASS) {
    return (
      <AppLayout>
        <Component />
      </AppLayout>
    );
  }

  if (!isLoaded || loadingUser) return null;

  if (!isSignedIn || isGuest) {
    return <Redirect to="/" />;
  }

  if (!isOwnerOrAbove) {
    return null;
  }

  return (
    <AppLayout>
      <Component />
    </AppLayout>
  );
}
