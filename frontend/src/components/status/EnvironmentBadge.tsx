import { cn } from "@/lib/cn";
import type { ConnectionState, Environment } from "@/data/types";

const badgeLabel: Record<Environment, string> = { prod: "PROD", stg: "STG", dev: "DEV" };

const badgeClass: Record<Environment, string> = {
  prod: "bg-env-prod-soft text-env-prod-ink shadow-[inset_0_0_0_1px_var(--env-prod)]",
  stg: "text-env-stg shadow-[inset_0_0_0_1px_var(--env-stg)]",
  dev: "text-fg-secondary shadow-[inset_0_0_0_1px_var(--line-strong)]",
};

/** Environment tag. Environments are never conveyed by color alone. */
export function EnvironmentBadge({ env, className }: { env: Environment; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded px-1.5 font-mono text-2xs font-semibold leading-none tracking-[.05em]",
        badgeClass[env],
        className,
      )}
    >
      {badgeLabel[env]}
    </span>
  );
}

const markerClass: Record<Environment, string> = {
  prod: "rounded-[1px] bg-env-prod",
  stg: "rotate-45 scale-[.82] rounded-[1px] bg-env-stg",
  dev: "rounded-full shadow-[inset_0_0_0_1.5px_var(--env-dev)]",
};

/** 8px environment marker: square (prod), diamond (stg), ring (dev). */
export function EnvMarker({ env, className }: { env: Environment; className?: string }) {
  return (
    <span
      role="img"
      aria-label={badgeLabel[env]}
      className={cn("inline-block size-2 shrink-0", markerClass[env], className)}
    />
  );
}

const connectionLabel: Record<ConnectionState, string> = {
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Not connected",
};

export function ConnectionDot({ state, className }: { state: ConnectionState; className?: string }) {
  return (
    <span
      role="img"
      aria-label={connectionLabel[state]}
      title={connectionLabel[state]}
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        state === "connected" && "bg-status-healthy",
        state === "reconnecting" && "bg-status-warning",
        state === "disconnected" && "shadow-[inset_0_0_0_1.5px_var(--fg-muted)]",
        className,
      )}
    />
  );
}
