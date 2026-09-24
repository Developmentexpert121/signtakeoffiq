import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";

const BASE_URL = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export default function ForgotPasswordPage() {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await fetch(`${BASE_URL}/api/auth/forgot-password`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
    } finally {
      setSubmitting(false);
      setSent(true);
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
        <h1 className="mt-6 text-center text-2xl font-semibold text-white">Forgot password</h1>

        {sent ? (
          <div className="mt-6 space-y-4 text-sm text-slate-300 text-center">
            <p>If an account exists for that email address, a reset link is on its way.</p>
            <p className="text-slate-400 text-xs">Check your inbox (and spam folder). The link is valid for 1 hour.</p>
            <button
              onClick={() => setLocation("/sign-in")}
              className="mt-2 w-full rounded-md bg-amber-400 hover:bg-amber-300 text-[#0a1729] font-semibold py-2.5 text-sm transition"
            >
              Back to sign in
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-8 space-y-5">
            <p className="text-sm text-slate-300 text-center">
              Enter your email and we'll send you a link to reset your password.
            </p>
            <div className="space-y-2">
              <label htmlFor="email" className="block text-sm font-semibold text-white">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="input-forgot-email"
                className="w-full rounded-md bg-[#0a1729] border border-white/10 px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-400/50"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              data-testid="btn-forgot-submit"
              className="w-full rounded-md bg-amber-400 hover:bg-amber-300 text-[#0a1729] font-semibold py-2.5 text-sm transition disabled:opacity-60"
            >
              {submitting ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
