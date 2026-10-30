import { cn } from "@/lib/cn";
import { t } from "@/i18n";
import type { ConnectionState, Environment } from "@/data/types";

const badgeLabel: Record<Environment, string> = { prod: "PROD", stg: "STG", dev: "DEV" };

const badgeClass: Record<Environment, string> = {
  prod: "bg-env-prod-soft text-env-prod-ink shadow-[inset_0_0_0_1px_var(--env-prod)]",
  stg: "text-env-stg shadow-[inset_0_0_0_1px_var(--env-stg)]",
  dev: "text-fg-secondary shadow-[inset_0_0_0_1px_var(--line-strong)]",
};

/** Environment tag. Environments are never conveyed by color alone. */
export function EnvironmentBadge({
  env,
  size = "md",
  label,
  className,
}: {
  env: Environment;
  /** sm: inside tabs and menu headers. */
  size?: "sm" | "md";
  /** Override the short label, e.g. "PRODUCTION". */
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1.5 font-mono font-semibold leading-none tracking-[.05em]",
        size === "sm" ? "h-4 text-[10px]" : "h-[18px] text-2xs",
        badgeClass[env],
        className,
      )}
    >
      {label ?? badgeLabel[env]}
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

export const connectionLabel: Record<ConnectionState, string> = {
  connected: "Connected",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  disconnected: "Not connected",
  "auth-expired": "Credentials expired",
  unreachable: "Unreachable",
};

export function ConnectionDot({ state, className }: { state: ConnectionState; className?: string }) {
  return (
    <span
      role="img"
      aria-label={t(connectionLabel[state])}
      title={t(connectionLabel[state])}
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        state === "connected" && "bg-status-healthy",
        (state === "reconnecting" || state === "auth-expired") && "shadow-[inset_0_0_0_1.5px_var(--status-warning)]",
        state === "connecting" && "shadow-[inset_0_0_0_1.5px_var(--status-progressing)]",
        state === "disconnected" && "shadow-[inset_0_0_0_1.5px_var(--fg-muted)]",
        state === "unreachable" && "rounded-[1px] bg-status-critical",
        className,
      )}
    />
  );
}
