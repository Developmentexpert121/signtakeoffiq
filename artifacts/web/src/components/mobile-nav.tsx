import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Menu, LogOut, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/contexts/AuthContext";
import { useGuestAuth } from "@/contexts/GuestAuthContext";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useNavItems } from "@/hooks/use-nav-items";

const ROLE_LABEL: Record<"super_admin" | "owner" | "user" | "guest", string> = {
  super_admin: "Super Admin",
  owner: "Owner",
  user: "User",
  guest: "Guest",
};

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const [location] = useLocation();
  const { signOut, user: authUser } = useAuth();
  const { isGuest } = useGuestAuth();
  const { currentUser, role } = useCurrentUser();
  const navItems = useNavItems();

  const displayName =
    currentUser?.fullName?.trim() ||
    authUser?.fullName?.trim() ||
    authUser?.email ||
    (isGuest ? "Guest" : "Account");
  const displayEmail = currentUser?.email || authUser?.email;
  const roleLabel = ROLE_LABEL[isGuest ? "guest" : role];

  return (
    <header className="md:hidden flex h-14 items-center gap-3 border-b border-sidebar-border bg-sidebar px-3 text-sidebar-foreground flex-shrink-0">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button
            aria-label="Open menu"
            data-testid="btn-open-mobile-nav"
            className="flex h-9 w-9 items-center justify-center rounded-md transition-colors text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <Menu className="h-5 w-5" />
          </button>
        </SheetTrigger>
        <SheetContent side="left" className="w-72 max-w-[85vw] bg-sidebar text-sidebar-foreground border-sidebar-border p-0 flex flex-col">
          <SheetTitle className="sr-only">Navigation menu</SheetTitle>

          <div className="h-14 flex items-center border-b border-sidebar-border px-4 flex-shrink-0">
            <img src="/logo.png" alt="Sign Takeoff IQ" className="h-8 object-contain object-left" />
          </div>

          {isGuest && (
            <div className="mx-3 mt-4 flex items-center gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs font-medium text-amber-600 dark:text-amber-400">
              <UserRound className="h-3.5 w-3.5 shrink-0" />
              Guest Mode
            </div>
          )}

          <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
            {navItems.map((item) => {
              const isActive =
                item.href === "/jobs/new"
                  ? location === "/jobs/new"
                  : location.startsWith(item.href);
              return (
                <Link key={item.href} href={item.href}>
                  <div
                    onClick={() => setOpen(false)}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors cursor-pointer",
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                    )}
                    data-testid={`mobile-nav-${item.label.toLowerCase()}`}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    {item.label}
                  </div>
                </Link>
              );
            })}
          </nav>

          {!isGuest && authUser && (
            <div className="mx-3 mb-2 rounded-md border border-sidebar-border bg-sidebar-accent/30 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <UserRound className="h-3.5 w-3.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-sidebar-foreground truncate">{displayName}</div>
                  {displayEmail && displayEmail !== displayName && (
                    <div className="text-[10px] text-sidebar-foreground/60 truncate">{displayEmail}</div>
                  )}
                </div>
                <span className="inline-flex shrink-0 items-center rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">
                  {roleLabel}
                </span>
              </div>
            </div>
          )}

          {!isGuest && (
            <div className="border-t border-sidebar-border p-3">
              <button
                onClick={() => {
                  setOpen(false);
                  signOut();
                }}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                data-testid="btn-mobile-sign-out"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <img src="/logo.png" alt="Sign Takeoff IQ" className="h-7 object-contain" />
    </header>
  );
}
