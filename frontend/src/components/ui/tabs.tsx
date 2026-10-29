import type { ComponentProps } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "@/lib/cn";

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

/** Underlined panel tabs used in inspectors and detail views. */
export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  // Scrolls horizontally when the panel is narrower than its tabs; arrow keys
  // move focus and bring the focused tab into view.
  return (
    <TabsPrimitive.List
      className={cn("flex shrink-0 gap-3.5 overflow-x-auto border-b border-line [scrollbar-width:none]", className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "focus-ring inline-flex h-[34px] items-center gap-1.5 whitespace-nowrap border-0 bg-transparent px-0.5 text-cell font-medium leading-none text-fg-muted",
        "shadow-[inset_0_-2px_0_transparent] hover:text-fg-secondary",
        "data-[state=active]:text-fg data-[state=active]:shadow-[inset_0_-2px_0_var(--accent)]",
        className,
      )}
      {...props}
    />
  );
}

/** Mono count next to a tab label: "Events 6". */
export function TabCount({ children }: { children: number }) {
  return <span className="font-mono text-label font-normal text-fg-muted">{children}</span>;
}
