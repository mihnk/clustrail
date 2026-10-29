import type { ReactNode } from "react";
import { Info, Lock } from "lucide-react";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { cn } from "@/lib/cn";

export type BannerTone = "protected" | "info" | "warning" | "critical";

const toneClass: Record<BannerTone, string> = {
  protected: "bg-env-prod-soft p-0 overflow-hidden",
  info: "bg-status-progressing-soft",
  warning: "bg-status-warning-soft",
  critical: "bg-status-critical-soft",
};

/**
 * Inline status message: protected context, unavailable capability, lost
 * watch, permission denied. Always pairs a shape with the color.
 */
export function Banner({
  tone,
  title,
  children,
  action,
  className,
}: {
  tone: BannerTone;
  /** Protected banners: the bold lead, e.g. "prod-eu-west-1 · Protected". */
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "critical" || tone === "warning" ? "alert" : "status"}
      className={cn("flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-cell text-fg", toneClass[tone], className)}
    >
      {tone === "protected" ? (
        <>
          <span className="hatch-prod w-4 self-stretch" aria-hidden />
          <span className="flex items-center gap-2 py-2 font-medium text-env-prod-ink">
            <Lock className="size-3.5" aria-hidden />
            {title}
          </span>
          <span className="min-w-0 flex-1 py-2 pr-2.5 text-fg-secondary">{children}</span>
        </>
      ) : (
        <>
          {tone === "info" ? (
            <Info className="size-3.5 shrink-0 text-status-progressing" aria-hidden />
          ) : (
            <StatusGlyph health={tone === "warning" ? "warning" : "failed"} />
          )}
          <span className="min-w-0 flex-1">
            {title && <b className="font-semibold">{title} </b>}
            {children}
          </span>
        </>
      )}
      {action}
    </div>
  );
}
