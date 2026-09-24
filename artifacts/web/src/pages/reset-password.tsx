import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useRoute } from "wouter";
import { Eye, EyeOff } from "lucide-react";
import { useAuth, type AuthUser } from "@/contexts/AuthContext";

const BASE_URL = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export default function ResetPasswordPage() {
  const [, params] = useRoute<{ token: string }>("/reset-password/:token");
  const [, setLocation] = useLocation();
  const { setUser } = useAuth();
  const token = params?.token ?? "";

  const [loading, setLoading] = useState(true);
  const [validEmail, setValidEmail] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setLoadError("Missing reset token.");
      setLoading(false);
      return;
    }
    fetch(`${BASE_URL}/api/auth/reset-password/${encodeURIComponent(token)}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Invalid or expired reset link.");
        }
        return res.json();
      })
      .then((data) => setValidEmail(data.email ?? null))
      .catch((err: Error) => setLoadError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${BASE_URL}/api/auth/reset-password/${encodeURIComponent(token)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to reset password.");
      }
      const data = await res.json();
      if (data.user) {
        setUser(data.user as AuthUser);
      }
      setLocation("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset password.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-10 bg-[#0a1729]">
      <div className="w-full max-w-md rounded-xl bg-[#15243b] border border-white/5 shadow-2xl px-8 py-9">
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-2 rounded-md bg-[#0a1729] px-3 py-2">
            <img src="/logo.png" alt="Sign Takeoff IQ" className="h-7 object-contain" />
          </div>
        </div>
        <h1 className="mt-6 text-center text-2xl font-semibold text-white">Set a new password</h1>

        {loading ? (
          <p className="mt-6 text-center text-sm text-slate-400">Checking link…</p>
        ) : loadError ? (
          <div className="mt-6 space-y-4 text-sm text-center">
            <p className="text-red-300">{loadError}</p>
            <button
              onClick={() => setLocation("/forgot-password")}
              className="w-full rounded-md bg-amber-400 hover:bg-amber-300 text-[#0a1729] font-semibold py-2.5 text-sm"
            >
              Request a new link
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-8 space-y-5">
            {validEmail && (
              <p className="text-center text-sm text-slate-300">
                Resetting password for <strong className="text-white">{validEmail}</strong>
              </p>
            )}
            <div className="space-y-2">
              <label htmlFor="pw" className="block text-sm font-semibold text-white">New password</label>
              <div className="relative">
                <input
                  id="pw"
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="input-reset-password"
                  className="w-full rounded-md bg-[#0a1729] border border-white/10 px-3 py-2.5 pr-10 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-400/50"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-white"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="pw2" className="block text-sm font-semibold text-white">Confirm password</label>
              <input
                id="pw2"
                type={showPassword ? "text" : "password"}
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                data-testid="input-reset-confirm"
                className="w-full rounded-md bg-[#0a1729] border border-white/10 px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-400/50"
              />
            </div>
            {error && (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={submitting}
              data-testid="btn-reset-submit"
              className="w-full rounded-md bg-amber-400 hover:bg-amber-300 text-[#0a1729] font-semibold py-2.5 text-sm transition disabled:opacity-60"
            >
              {submitting ? "Resetting…" : "Reset password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
