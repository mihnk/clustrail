import type { ComponentProps } from "react";
import { ContextMenu as Menu } from "radix-ui";
import { cn } from "@/lib/cn";
import { menuContentClass, menuItemClass } from "./dropdown-menu";

export const ContextMenu = Menu.Root;
export const ContextMenuTrigger = Menu.Trigger;

export function ContextMenuContent({ className, ...props }: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        collisionPadding={8}
        className={cn(menuContentClass, "max-h-[var(--radix-context-menu-content-available-height)]", className)}
        {...props}
      />
    </Menu.Portal>
  );
}

export function ContextMenuItem({ className, ...props }: ComponentProps<typeof Menu.Item>) {
  return <Menu.Item className={cn(menuItemClass, className)} {...props} />;
}

export function ContextMenuLabel({ className, ...props }: ComponentProps<typeof Menu.Label>) {
  return <Menu.Label className={cn("section-label flex items-center gap-1.5 px-2 pb-1 pt-2 text-2xs", className)} {...props} />;
}

export function ContextMenuSeparator() {
  return <Menu.Separator className="my-1 h-px bg-line" />;
}
