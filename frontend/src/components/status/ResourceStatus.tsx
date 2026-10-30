import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { Health } from "@/data/types";
import { StatusGlyph, healthTone } from "./StatusGlyph";

/** Glyph + always-visible status text, as used in table cells. */
export function ResourceStatus({
  health,
  label,
  title,
  className,
}: {
  health: Health;
  label: string;
  title?: string;
  className?: string;
}) {
  return (
    <span title={title} className={cn("flex min-w-0 items-center gap-[7px] text-ui font-medium", healthTone[health], className)}>
      <StatusGlyph health={health} />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** Filled count pill. Only error and warning counts are filled. */
export function CountPill({ tone, children, className, title }: { tone: "critical" | "warning"; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "rounded px-[5px] py-[3px] font-mono text-2xs font-semibold leading-none",
        tone === "critical" ? "bg-status-critical-soft text-status-critical" : "bg-status-warning-soft text-status-warning",
        className,
      )}
    >
      {children}
    </span>
  );
}
