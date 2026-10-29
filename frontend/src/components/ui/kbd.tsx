import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "rounded border border-b-2 border-line-strong px-[5px] py-[3px] font-mono text-2xs font-medium leading-none text-fg-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
