import { cn } from "@/lib/cn";

/** Thin usage bar. Tone follows the value: accent, then warning from 80%, critical from 95%. */
export function Meter({ value, label, className }: { value: number; label: string; className?: string }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct * 100)}
      className={cn("flex h-1 min-w-6 flex-1 overflow-hidden rounded-sm bg-line-strong", className)}
    >
      <i
        className={cn("block h-full", pct >= 0.95 ? "bg-status-critical" : pct >= 0.8 ? "bg-status-warning" : "bg-accent")}
        style={{ width: `${pct * 100}%` }}
      />
    </span>
  );
}

/** Used vs requested against allocatable, as in the cluster and node inspectors. */
export function CapacityBar({ used, requested, allocatable, label }: { used: number | null; requested: number; allocatable: number; label: string }) {
  const pct = (v: number) => `${Math.min(100, (v / Math.max(allocatable, 1e-9)) * 100)}%`;
  return (
    <span role="img" aria-label={label} className="relative block h-2 overflow-hidden rounded-[3px] bg-line-strong">
      <i className="absolute inset-y-0 left-0 bg-fg-muted opacity-45" style={{ width: pct(requested) }} />
      {used !== null && <i className="absolute inset-y-0 left-0 bg-accent" style={{ width: pct(used) }} />}
    </span>
  );
}
