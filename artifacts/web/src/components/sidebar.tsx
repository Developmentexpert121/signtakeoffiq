import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import {
  LogOut,
  UserRound,
  Clock,
  UserPlus,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useGuestAuth } from "@/contexts/GuestAuthContext";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useNavItems } from "@/hooks/use-nav-items";
import { useEffect, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const ROLE_LABEL: Record<"super_admin" | "owner" | "user" | "guest", string> = {
  super_admin: "Super Admin",
  owner: "Owner",
  user: "User",
  guest: "Guest",
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const COLLAPSED_KEY = "sidebar-collapsed";

function useGuestTimeRemaining(expiresAt: number | undefined): number | null {
  const [remaining, setRemaining] = useState<number | null>(() =>
    expiresAt != null ? Math.max(0, expiresAt - Date.now()) : null
  );

  useEffect(() => {
    if (expiresAt == null) {
      setRemaining(null);
      return;
    }
    const tick = () => setRemaining(Math.max(0, expiresAt - Date.now()));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return remaining;
}

function formatTimeRemaining(ms: number): string {
  const totalMinutes = Math.ceil(ms / 60_000);
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${totalMinutes}m`;
}

export function Sidebar() {
  const [location, setLocation] = useLocation();
  const { signOut, user: authUser } = useAuth();
  const { isGuest, guestSession } = useGuestAuth();
  const { currentUser, role } = useCurrentUser();

  const displayName =
    currentUser?.fullName?.trim() ||
    authUser?.fullName?.trim() ||
    authUser?.email ||
    (isGuest ? "Guest" : "Account");
  const displayEmail = currentUser?.email || authUser?.email;
  const roleLabel = ROLE_LABEL[isGuest ? "guest" : role];

  // Persistent collapse preference (non-job pages)
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });

  // On job detail pages the sidebar auto-collapses to give maximum canvas space.
  // The user can still manually re-expand it by clicking the toggle — that
  // override is tracked in manuallyExpanded and resets on navigation away.
  const isJobDetail = /^\/jobs\/job_/.test(location);
  const [manuallyExpanded, setManuallyExpanded] = useState(false);

  useEffect(() => {
    if (!isJobDetail) setManuallyExpanded(false);
  }, [isJobDetail]);

  // Effective state: job detail pages default to collapsed unless overridden
  const isCollapsed = isJobDetail ? !manuallyExpanded : collapsed;

  const toggleCollapsed = () => {
    if (isJobDetail) {
      setManuallyExpanded((prev) => !prev);
    } else {
      setCollapsed((prev) => {
        const next = !prev;
        try { localStorage.setItem(COLLAPSED_KEY, String(next)); } catch {}
        return next;
      });
    }
  };

  const timeRemaining = useGuestTimeRemaining(guestSession?.expiresAt);
  const isNearingExpiry =
    timeRemaining != null && timeRemaining > 0 && timeRemaining < ONE_HOUR_MS;

  const navItems = useNavItems();

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className={cn(
          "hidden md:flex flex-col bg-sidebar border-r border-sidebar-border min-h-screen text-sidebar-foreground flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out",
          isCollapsed ? "w-14" : "w-64"
        )}
      >
        {/* ── Header ── */}
        <div className="h-16 flex items-center border-b border-sidebar-border flex-shrink-0 shrink-0">
          {isCollapsed ? (
            /* Collapsed: logo + expand button stacked vertically */
            <div className="flex flex-col items-center justify-center gap-1 w-full py-1">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <svg viewBox="0 0 32 32" fill="none" className="w-4 h-4" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <rect width="32" height="32" rx="4" fill="currentColor" fillOpacity="0.15"/>
                  <rect x="4" y="4" width="14" height="10" rx="1" stroke="currentColor" strokeWidth="1.5"/>
                  <line x1="4" y1="9" x2="7" y2="9" stroke="currentColor" strokeWidth="1.5"/>
                  <circle cx="11" cy="9" r="2.5" fill="currentColor"/>
                  <line x1="13.5" y1="7" x2="20" y2="4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  <rect x="20" y="2" width="10" height="6" rx="1" fill="currentColor" fillOpacity="0.3" stroke="currentColor" strokeWidth="1"/>
                  <line x1="22" y1="4.5" x2="28" y2="4.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                  <line x1="22" y1="6" x2="26" y2="6" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                  <rect x="4" y="18" width="10" height="10" rx="1" stroke="currentColor" strokeWidth="1.5"/>
                  <circle cx="9" cy="23" r="2" fill="currentColor"/>
                  <line x1="18" y1="18" x2="28" y2="18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  <line x1="18" y1="21" x2="28" y2="21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  <line x1="18" y1="24" x2="24" y2="24" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={toggleCollapsed}
                    aria-label="Expand sidebar"
                    className="flex h-6 w-6 items-center justify-center rounded-md transition-colors text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                  >
                    <PanelLeftOpen className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Expand sidebar</TooltipContent>
              </Tooltip>
            </div>
          ) : (
            /* Expanded: logo image + collapse button */
            <div className="flex items-center gap-2 px-3 w-full">
              <div className="flex-1 min-w-0 flex items-center">
                <img src="/logo.png" alt="Sign Takeoff IQ" className="h-8 object-contain object-left" />
              </div>
              <button
                onClick={toggleCollapsed}
                aria-label="Collapse sidebar"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        {/* Guest mode banner */}
        {isGuest && !isCollapsed && (
          <div className="mx-3 mt-4 flex items-center gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs font-medium text-amber-600 dark:text-amber-400">
            <UserRound className="h-3.5 w-3.5 shrink-0" />
            Guest Mode
          </div>
        )}

        {/* Guest expiry warning */}
        {isGuest && isNearingExpiry && timeRemaining != null && !isCollapsed && (
          <div className="mx-3 mt-2 rounded-md bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs font-medium text-red-600 dark:text-red-400">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="h-3.5 w-3.5 shrink-0" />
              <span>Session expires in {formatTimeRemaining(timeRemaining)}</span>
            </div>
            <button
              onClick={() => setLocation("/sign-in")}
              className="flex items-center gap-1 underline underline-offset-2 hover:opacity-80 transition-opacity"
            >
              <UserPlus className="h-3 w-3" />
              Save your work — create an account
            </button>
          </div>
        )}

        {/* ── Nav items ── */}
        <nav className={cn("flex-1 py-6 space-y-1", isCollapsed ? "px-1.5" : "px-3")}>
          {navItems.map((item) => {
            const isActive = item.href === "/jobs/new"
              ? location === "/jobs/new"
              : location.startsWith(item.href);

            const linkContent = (
              <div
                className={cn(
                  "flex items-center rounded-md transition-colors cursor-pointer text-sm font-medium",
                  isCollapsed ? "justify-center h-9 w-9 mx-auto" : "gap-3 px-3 py-2",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "hover:bg-sidebar-accent/50 text-sidebar-foreground/70 hover:text-sidebar-foreground"
                )}
                data-testid={`nav-${item.label.toLowerCase()}`}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {!isCollapsed && item.label}
              </div>
            );

            if (isCollapsed) {
              return (
                <Tooltip key={item.href}>
                  <TooltipTrigger asChild>
                    <Link href={item.href}>{linkContent}</Link>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="font-medium">
                    {item.label}
                  </TooltipContent>
                </Tooltip>
              );
            }

            return (
              <Link key={item.href} href={item.href}>
                {linkContent}
              </Link>
            );
          })}
        </nav>

        {/* ── User identity + role badge ── */}
        {(!isGuest && authUser) && !isCollapsed && (
          <div className="mx-3 mb-2 mt-2 rounded-md border border-sidebar-border bg-sidebar-accent/30 px-3 py-2.5" data-testid="sidebar-user-card">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                <UserRound className="h-3.5 w-3.5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-sidebar-foreground truncate" data-testid="sidebar-user-name">
                  {displayName}
                </div>
                {displayEmail && displayEmail !== displayName && (
                  <div className="text-[10px] text-sidebar-foreground/60 truncate">{displayEmail}</div>
                )}
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-sidebar-foreground/50">Role</span>
              <span
                className="inline-flex items-center rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary"
                data-testid="sidebar-user-role"
              >
                {roleLabel}
              </span>
            </div>
          </div>
        )}

        {/* Collapsed: compact role pill */}
        {(!isGuest && authUser) && isCollapsed && (
          <div className="mx-auto mb-2 mt-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary"
                  data-testid="sidebar-user-role-collapsed"
                  aria-label={`Signed in as ${roleLabel}`}
                >
                  <UserRound className="h-3.5 w-3.5" />
                </div>
              </TooltipTrigger>
              <TooltipContent side="right">
                <div className="font-medium">{displayName}</div>
                <div className="text-xs opacity-80">{roleLabel}</div>
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        {/* ── Sign out ── */}
        {!isGuest && (
          <div className={cn("border-t border-sidebar-border", isCollapsed ? "p-1.5" : "p-3")}>
            {isCollapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => signOut()}
                    className="flex h-9 w-9 mx-auto items-center justify-center rounded-md transition-colors text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                    data-testid="btn-sign-out"
                    aria-label="Sign out"
                  >
                    <LogOut className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Sign Out</TooltipContent>
              </Tooltip>
            ) : (
              <button
                onClick={() => signOut()}
                className="flex items-center gap-3 px-3 py-2 w-full rounded-md transition-colors text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                data-testid="btn-sign-out"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
