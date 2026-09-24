import { Button } from "@/components/ui/button";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { GuestAuthProvider, useGuestAuth } from "@/contexts/GuestAuthContext";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { lazy, Suspense, useEffect, useRef } from "react";
import { Redirect, Route, Switch, Router as WouterRouter } from "wouter";

import { AdminRoute } from "@/components/AdminRoute";
import { AppLayout } from "@/components/layout";
import { OwnerRoute } from "@/components/OwnerRoute";
import { useCurrentUser } from "@/hooks/use-current-user";
import NotFound from "@/pages/not-found";

import Home from "@/pages/home";
const Dashboard = lazy(() => import("@/pages/dashboard"));
const Jobs = lazy(() => import("@/pages/jobs"));
const JobsNew = lazy(() => import("@/pages/jobs-new"));
const JobDetail = lazy(() => import("@/pages/job-detail"));
const Training = lazy(() => import("@/pages/training"));
const Admin = lazy(() => import("@/pages/admin"));
const Users = lazy(() => import("@/pages/users"));
const SignInPage = lazy(() => import("@/pages/sign-in"));
const AcceptInvitePage = lazy(() => import("@/pages/accept-invite"));
const ForgotPasswordPage = lazy(() => import("@/pages/forgot-password"));
const ResetPasswordPage = lazy(() => import("@/pages/reset-password"));
const PricingSetup = lazy(() => import("@/pages/settings/pricing"));

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const DEV_BYPASS =
  import.meta.env.VITE_DEV_BYPASS_AUTH === "true" &&
  import.meta.env.MODE !== "test";

// When a user signs in (cookie session), clear any lingering guest session so
// they are never accidentally treated as a guest user.
function AuthGuestSync() {
  const { isSignedIn } = useAuth();
  const { isGuest, logoutGuest } = useGuestAuth();

  useEffect(() => {
    if (isSignedIn && isGuest) {
      logoutGuest();
    }
  }, [isSignedIn, isGuest, logoutGuest]);

  return null;
}

// Clear React Query cache whenever the auth user identity changes.
function AuthCacheInvalidator() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const prevIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const currentId = user?.id ?? null;
    if (prevIdRef.current !== undefined && prevIdRef.current !== currentId) {
      queryClient.clear();
    }
    prevIdRef.current = currentId;
  }, [user?.id, queryClient]);

  return null;
}

function GuestCacheInvalidator() {
  const { guestSession } = useGuestAuth();
  const queryClient = useQueryClient();
  const prevIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const currentId = guestSession?.userId ?? null;
    if (prevIdRef.current !== undefined && prevIdRef.current !== currentId) {
      queryClient.clear();
    }
    prevIdRef.current = currentId;
  }, [guestSession?.userId, queryClient]);

  return null;
}

function RoleLandingRedirect() {
  const { isLoading } = useCurrentUser();
  if (isLoading) return null;
  return <Redirect to="/dashboard" />;
}

function HomeRedirect() {
  const { isSignedIn, isLoaded } = useAuth();
  const { isGuest } = useGuestAuth();

  if (DEV_BYPASS) return <Redirect to="/dashboard" />;
  if (!isLoaded) return null;

  if (isSignedIn) return <RoleLandingRedirect />;
  if (isGuest) return <Redirect to="/dashboard" />;

  return <Home />;
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { isSignedIn, isLoaded } = useAuth();
  const { isGuest } = useGuestAuth();

  if (DEV_BYPASS) {
    return (
      <AppLayout>
        <Component />
      </AppLayout>
    );
  }

  if (!isLoaded) return null;

  if (isSignedIn || isGuest) {
    return (
      <AppLayout>
        <Component />
      </AppLayout>
    );
  }

  return <Redirect to="/" />;
}

export function MembersOnlyCTA({
  featureName,
  description,
}: {
  featureName?: string;
  description?: string;
}) {
  const heading = featureName ? `${featureName} is for members only` : "Members only";
  const body =
    description ??
    "This feature is available to members only. Sign in or ask your account owner for an invitation.";

  return (
    <AppLayout>
      <div className="flex flex-col items-center justify-center h-full gap-6 py-24 text-center px-6">
        <div className="rounded-full bg-primary/10 p-4">
          <UserPlus className="h-8 w-8 text-primary" />
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-2xl font-semibold tracking-tight">{heading}</p>
          <p className="text-sm text-muted-foreground max-w-sm">{body}</p>
        </div>
        <div className="flex flex-col items-center gap-3">
          <Button asChild size="lg" className="w-56">
            <a href={`${basePath}/sign-in`}>Sign in</a>
          </Button>
        </div>
      </div>
    </AppLayout>
  );
}

interface MemberRouteProps {
  component: React.ComponentType;
  featureName: string;
  description: string;
}

export function MemberRoute({
  component: Component,
  featureName,
  description,
}: MemberRouteProps) {
  const { isSignedIn, isLoaded } = useAuth();
  const { isGuest } = useGuestAuth();

  if (DEV_BYPASS) {
    return (
      <AppLayout>
        <Component />
      </AppLayout>
    );
  }

  if (!isLoaded) return null;

  if (isSignedIn && !isGuest) {
    return (
      <AppLayout>
        <Component />
      </AppLayout>
    );
  }

  return <MembersOnlyCTA featureName={featureName} description={description} />;
}

function Router() {
  return (
    <Suspense fallback={null}>
      <Switch>
        <Route path="/" component={HomeRedirect} />
        <Route path="/sign-in">
          <SignInPage />
        </Route>
        <Route path="/forgot-password" component={ForgotPasswordPage} />
        <Route path="/reset-password/:token" component={ResetPasswordPage} />
        <Route path="/accept-invite/:token" component={AcceptInvitePage} />

        <Route path="/dashboard">
          <ProtectedRoute component={Dashboard} />
        </Route>
        <Route path="/jobs/new">
          <ProtectedRoute component={JobsNew} />
        </Route>
        <Route path="/jobs/:jobId">
          <ProtectedRoute component={JobDetail} />
        </Route>
        <Route path="/jobs">
          <ProtectedRoute component={Jobs} />
        </Route>
        <Route path="/training">
          <ProtectedRoute component={Training} />
        </Route>
        <Route path="/activity">
          <ProtectedRoute component={() => (
            <div className="p-8 text-center text-muted-foreground">
              <p className="text-lg font-medium">Activity</p>
              <p className="text-sm mt-2">Recent extraction and training activity will appear here.</p>
            </div>
          )} />
        </Route>
        <Route path="/admin">
          <AdminRoute component={Admin} />
        </Route>
        <Route path="/users">
          <OwnerRoute component={Users} />
        </Route>
        <Route path="/settings/pricing">
          <ProtectedRoute component={PricingSetup} />
        </Route>

        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <GuestAuthProvider>
            <AuthGuestSync />
            <AuthCacheInvalidator />
            <GuestCacheInvalidator />
            <WouterRouter base={basePath}>
              <Router />
            </WouterRouter>
          </GuestAuthProvider>
        </AuthProvider>
        <Toaster />
        <SonnerToaster richColors position="bottom-right" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
