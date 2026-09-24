import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Eye, EyeOff, Loader2, Zap } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

interface SignInPageProps {
  feature?: string | null;
}

export default function SignInPage({ feature }: SignInPageProps) {
  const { signIn } = useAuth();
  const [, setLocation] = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ssoNotice, setSsoNotice] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      setLocation("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid email or password.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center px-4 py-10 bg-background overflow-hidden">
      {/* Branded ambient glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 h-[34rem] w-[34rem] rounded-full bg-primary/15 blur-[120px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(to right, hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--foreground)) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse 60% 50% at 50% 30%, black, transparent)",
          WebkitMaskImage: "radial-gradient(ellipse 60% 50% at 50% 30%, black, transparent)",
        }}
      />

      <div className="relative w-full max-w-md">
        {feature && (
          <div className="mb-6 rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-center">
            <p className="text-sm font-medium text-primary">
              Sign in to access {feature}
            </p>
          </div>
        )}

        {/* Brand mark */}
        <div className="flex flex-col items-center text-center">
          <img src="/logo.png" alt="Sign Takeoff IQ" className="h-9 object-contain" />
          <div className="mt-5 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            <Zap className="h-3.5 w-3.5" />
            Precision Signage Extraction Engine
          </div>
        </div>

        <div className="mt-6 rounded-xl bg-card border border-card-border shadow-2xl shadow-black/40 px-8 py-9">
          <h1
            className="text-center text-2xl font-bold tracking-tight text-foreground"
            style={{ fontFamily: "'Chakra Petch', sans-serif" }}
          >
            Welcome back
          </h1>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            Use the email and password you were given.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-5">
            <div className="space-y-2">
              <label htmlFor="email" className="block text-sm font-semibold text-foreground">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                data-testid="input-signin-email"
                className="w-full rounded-md bg-background border border-border px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 transition focus:outline-none focus:ring-2 focus:ring-ring/60 focus:border-ring/60"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="password" className="block text-sm font-semibold text-foreground">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  data-testid="input-signin-password"
                  className="w-full rounded-md bg-background border border-border px-3 py-2.5 pr-10 text-sm text-foreground placeholder:text-muted-foreground/60 transition focus:outline-none focus:ring-2 focus:ring-ring/60 focus:border-ring/60"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="signin-error">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              data-testid="btn-signin"
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-primary hover:bg-primary/90 active:bg-primary/80 text-primary-foreground font-semibold py-2.5 text-sm transition disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? "Signing in…" : "Sign in"}
            </button>

            <div className="text-center">
              <a
                href={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/forgot-password`}
                className="text-xs text-muted-foreground hover:text-primary underline-offset-2 hover:underline transition-colors"
              >
                Forgot password?
              </a>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <button
              type="button"
              onClick={() => setSsoNotice(true)}
              data-testid="btn-signin-signsuiteiq"
              className="w-full rounded-md border border-primary/40 bg-transparent hover:bg-primary/10 text-primary font-semibold py-2.5 text-sm transition"
            >
              Sign in with SignSuiteIQ
            </button>

            {ssoNotice && (
              <p
                className="text-center text-xs text-muted-foreground"
                data-testid="signsuiteiq-notice"
              >
                SignSuiteIQ sign in is coming soon.
              </p>
            )}
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground/70">
          Sign Takeoff IQ · Secure sign in
        </p>
      </div>
    </div>
  );
}
