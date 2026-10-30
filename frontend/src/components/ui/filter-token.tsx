import type { ComponentProps, ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

/**
 * A filter rendered as "key value". Tokens read as a sentence; each one is
 * also typeable in the filter field (ns:payments status:attention).
 */
export function FilterToken({
  k,
  value,
  active,
  className,
  ...props
}: { k: string; value: ReactNode; active?: boolean } & ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "focus-ring flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-line-strong bg-surface-panel px-2 text-ui text-fg dark:bg-transparent",
        active && "border-line-selected bg-accent-soft dark:bg-accent-soft",
        className,
      )}
    >
      <span className="text-fg-muted">{k}</span>
      {/* "any", "all", "none": the unset filter, in the UI language. */}
      {value === "any" || value === "all" || value === "none" ? t(value) : value}
      <ChevronDown className="size-3.5 text-fg-muted" aria-hidden />
    </button>
  );
}

/** An applied filter that is removed with its close button. */
export function RemovableFilterToken({ k, value, onRemove }: { k: string; value: ReactNode; onRemove: () => void }) {
  return (
    <span className="flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-line-selected bg-accent-soft pl-2 pr-1 text-ui text-fg">
      <span className="text-fg-muted">{k}</span>
      {value}
      <button
        type="button"
        aria-label={t("Remove {k} filter", { k })}
        onClick={onRemove}
        className="focus-ring inline-flex size-[18px] items-center justify-center rounded border-0 bg-transparent p-0 text-fg-muted hover:bg-surface-hover hover:text-fg"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
}
