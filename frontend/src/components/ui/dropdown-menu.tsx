import type { ComponentProps, ReactNode } from "react";
import { DropdownMenu as Menu } from "radix-ui";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

export const menuContentClass =
  "z-50 min-w-56 overflow-y-auto rounded-lg border border-line-strong bg-surface-elevated p-1 shadow-menu";

export const menuItemClass =
  "relative flex h-7 w-full cursor-default select-none items-center gap-2 rounded-[5px] px-2 text-cell text-fg outline-none data-[highlighted]:bg-accent-soft data-[disabled]:text-fg-muted [&_svg]:size-3.5 [&_svg]:shrink-0";

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

export function DropdownMenuContent({ className, ...props }: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={4}
        collisionPadding={8}
        className={cn(menuContentClass, "max-h-[var(--radix-dropdown-menu-content-available-height)]", className)}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Menu.Item>) {
  return <Menu.Item className={cn(menuItemClass, className)} {...props} />;
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem className={cn(menuItemClass, "pl-7", className)} {...props}>
      <Menu.ItemIndicator className="absolute left-2 inline-flex text-accent">
        <Check strokeWidth={2.2} />
      </Menu.ItemIndicator>
      {children}
    </Menu.CheckboxItem>
  );
}

export function DropdownMenuRadioGroup(props: ComponentProps<typeof Menu.RadioGroup>) {
  return <Menu.RadioGroup {...props} />;
}

export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof Menu.RadioItem>) {
  return (
    <Menu.RadioItem className={cn(menuItemClass, "pl-7", className)} {...props}>
      <Menu.ItemIndicator className="absolute left-2 inline-flex text-accent">
        <Check strokeWidth={2.2} />
      </Menu.ItemIndicator>
      {children}
    </Menu.RadioItem>
  );
}

export function DropdownMenuLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Menu.Label className={cn("section-label flex items-center gap-1.5 px-2 pb-1 pt-2 text-2xs", className)}>
      {children}
    </Menu.Label>
  );
}

export function DropdownMenuSeparator() {
  return <Menu.Separator className="my-1 h-px bg-line" />;
}

export function DropdownMenuShortcut({ children }: { children: ReactNode }) {
  return <span className="ml-auto font-mono text-label text-fg-muted">{children}</span>;
}
