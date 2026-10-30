import type { ComponentProps } from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/cn";

/** On/off setting. Always paired with a visible label; the thumb position carries the state, not only the color. */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "focus-ring relative inline-flex h-[18px] w-8 shrink-0 cursor-default items-center rounded-full border border-line-strong bg-surface-hover p-0 transition-colors",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-3 translate-x-[2px] rounded-full bg-fg-muted transition-transform data-[state=checked]:translate-x-[15px] data-[state=checked]:bg-white" />
    </SwitchPrimitive.Root>
  );
}
