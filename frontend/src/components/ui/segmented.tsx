import type { ReactNode } from "react";
import { ToggleGroup } from "radix-ui";
import { cn } from "@/lib/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

/** Single-choice segmented control (view modes, health filter). */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  "aria-label": ariaLabel,
  className,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentedOption<T>[];
  "aria-label": string;
  className?: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      // Radix emits "" when the active item is clicked again; keep the selection.
      onValueChange={(v) => v && onValueChange(v as T)}
      aria-label={ariaLabel}
      className={cn("no-drag inline-flex shrink-0 rounded-[7px] border border-line bg-surface-side p-0.5", className)}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          title={o.title}
          className={cn(
            "focus-ring inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-[5px] border-0 bg-transparent px-2.5 text-ui font-medium leading-none text-fg-secondary",
            "data-[state=on]:bg-surface-elevated data-[state=on]:text-fg data-[state=on]:shadow-[0_0_0_1px_var(--line-strong)]",
            "disabled:opacity-50",
          )}
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
