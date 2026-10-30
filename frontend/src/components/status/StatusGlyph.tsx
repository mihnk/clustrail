import { cn } from "@/lib/cn";
import type { Health } from "@/data/types";

export const healthTone: Record<Health, string> = {
  failed: "text-status-critical",
  warning: "text-status-warning",
  progressing: "text-status-progressing",
  healthy: "text-status-healthy",
  completed: "text-status-neutral",
  terminating: "text-status-neutral",
  unknown: "text-status-neutral",
  idle: "text-status-neutral",
  paused: "text-status-neutral",
};

/**
 * Health glyph. Shape first, color second: every state has a distinct
 * silhouette so it survives color blindness, grayscale and 12px sizes.
 */
export function StatusGlyph({ health, className }: { health: Health; className?: string }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className={cn("size-3 shrink-0", healthTone[health], className)}>
      {glyph(health)}
    </svg>
  );
}

function glyph(health: Health) {
  switch (health) {
    case "healthy":
      return <circle cx="6" cy="6" r="4" fill="currentColor" />;
    case "failed":
      return (
        <>
          <path d="M4 .8h4L11.2 4v4L8 11.2H4L.8 8V4z" fill="currentColor" />
          <path d="M4.2 4.2l3.6 3.6M7.8 4.2L4.2 7.8" stroke="var(--on-status)" strokeWidth="1.5" strokeLinecap="round" />
        </>
      );
    case "warning":
      return (
        <>
          <path d="M6 .9l5.4 9.8H.6z" fill="currentColor" stroke="currentColor" strokeWidth=".8" strokeLinejoin="round" />
          <path d="M6 4.4v2.8" stroke="var(--on-status)" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="6" cy="8.9" r=".8" fill="var(--on-status)" />
        </>
      );
    case "progressing":
      return (
        <>
          <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 1.6a4.4 4.4 0 0 1 0 8.8z" fill="currentColor" />
        </>
      );
    case "completed":
      return (
        <>
          <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M4 6.2l1.4 1.4L8.1 4.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "terminating":
      return <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 1.6" />;
    case "unknown":
      return (
        <>
          <rect x="1.6" y="1.6" width="8.8" height="8.8" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M4 6h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      );
    case "idle":
      return <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.4" />;
    case "paused":
      return (
        <>
          <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M4.8 4.2v3.6M7.2 4.2v3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      );
  }
}
