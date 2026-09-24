import { useEffect, useState } from "react";
import { useRoute, useLocation } from "wouter";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth, type AuthUser } from "@/contexts/AuthContext";
import {
  lookupInvitation,
  acceptInvitation,
  type InvitationLookup,
} from "@/lib/invitations-api";

export default function AcceptInvitePage() {
  const [, params] = useRoute<{ token: string }>("/accept-invite/:token");
  const [, setLocation] = useLocation();
  const token = params?.token ?? "";

  const { isSignedIn, setUser, refresh } = useAuth();

  const [lookup, setLookup] = useState<InvitationLookup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoadError("Missing invitation token.");
      return;
    }
    lookupInvitation(token)
      .then((data) => setLookup(data))
      .catch((err: Error) => setLoadError(err.message || "Invitation not found"));
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!lookup) return;
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      toast.error("Passwords don't match.");
      return;
    }

    setSubmitting(true);
    try {
      const accepted = await acceptInvitation(token, { password, fullName: fullName.trim() });
      // Server set the session cookie. Update auth context immediately.
      if (accepted.user) {
        setUser(accepted.user as AuthUser);
      } else {
        await refresh();
      }
      toast.success("Welcome to Sign Takeoff IQ!");
      setLocation("/");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to accept invitation";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  if (isSignedIn) {
    return (
      <CenteredCard>
        <h1 className="text-xl font-semibold mb-2">You're already signed in</h1>
        <p className="text-sm text-muted-foreground mb-4">
          Sign out of your current account before accepting this invitation.
        </p>
        <Button onClick={() => setLocation("/")}>Go to app</Button>
      </CenteredCard>
    );
  }

  if (loadError) {
    return (
      <CenteredCard>
        <h1 className="text-xl font-semibold mb-2 text-destructive">Invitation unavailable</h1>
        <p className="text-sm text-muted-foreground">{loadError}</p>
      </CenteredCard>
    );
  }

  if (!lookup) {
    return (
      <CenteredCard>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading invitation…
        </div>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard>
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <span className="text-xs font-bold tracking-widest text-primary">SIGN TAKEOFF IQ</span>
      </div>
      <h1 className="text-2xl font-semibold mt-2">You've been invited</h1>
      <p className="text-sm text-muted-foreground mt-2 mb-6">
        {lookup.inviterName ? <strong>{lookup.inviterName}</strong> : "A teammate"}{" "}
        has invited you to join <strong>{lookup.tenantName}</strong> as a{" "}
        <strong>{lookup.roleLabel}</strong>. Set your password to activate your account.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label>Email</Label>
          <Input value={lookup.emailMasked} disabled />
        </div>
        <div>
          <Label htmlFor="ai-name">Full name</Label>
          <Input
            id="ai-name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Jane Doe"
            data-testid="input-accept-name"
          />
        </div>
        <div>
          <Label htmlFor="ai-pw">Password</Label>
          <div className="relative">
            <Input
              id="ai-pw"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              required
              className="pr-10"
              data-testid="input-accept-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
              aria-label={showPassword ? "Hide password" : "Show password"}
              tabIndex={-1}
              data-testid="btn-toggle-password"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <div>
          <Label htmlFor="ai-pw2">Confirm password</Label>
          <div className="relative">
            <Input
              id="ai-pw2"
              type={showConfirm ? "text" : "password"}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              className="pr-10"
              data-testid="input-accept-confirm"
            />
            <button
              type="button"
              onClick={() => setShowConfirm((v) => !v)}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
              aria-label={showConfirm ? "Hide password" : "Show password"}
              tabIndex={-1}
              data-testid="btn-toggle-confirm"
            >
              {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <Button type="submit" className="w-full" disabled={submitting} data-testid="btn-accept-invite">
          {submitting ? "Activating…" : "Accept invitation"}
        </Button>
      </form>
    </CenteredCard>
  );
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 shadow-sm">{children}</div>
    </div>
  );
}
