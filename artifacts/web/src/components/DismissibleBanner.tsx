import { useEffect, useRef, useState } from "react";

const DISMISS_DURATION_MS = 250;

interface DismissibleBannerProps {
  show: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * Wraps any dismissible banner with the standard 250ms fade + slide-up exit
 * animation. Pass `show={false}` to trigger the exit animation; the element
 * unmounts automatically after the transition completes.
 *
 * Respects the `prefers-reduced-motion` media query — users who prefer reduced
 * motion see an instant dismissal instead.
 */
export function DismissibleBanner({
  show,
  children,
  className,
}: DismissibleBannerProps) {
  const [mounted, setMounted] = useState(show);
  const [dismissing, setDismissing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevShowRef = useRef(show);

  useEffect(() => {
    const wasShown = prevShowRef.current;
    prevShowRef.current = show;

    if (show) {
      setMounted(true);
      setDismissing(false);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    } else if (wasShown) {
      const prefersReducedMotion =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (prefersReducedMotion) {
        setMounted(false);
        return;
      }
      setDismissing(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setMounted(false);
        setDismissing(false);
        timerRef.current = null;
      }, DISMISS_DURATION_MS);
    }

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [show]);

  if (!mounted) return null;

  return (
    <div
      className={className}
      style={{
        opacity: dismissing ? 0 : 1,
        transform: dismissing ? "translateY(-4px)" : "translateY(0)",
        transition: `opacity ${DISMISS_DURATION_MS}ms ease-in-out, transform ${DISMISS_DURATION_MS}ms ease-in-out`,
      }}
    >
      {children}
    </div>
  );
}
