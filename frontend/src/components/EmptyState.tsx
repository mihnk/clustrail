import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-10 text-center", className)}>
      {icon && <div className="text-fg-muted [&_svg]:size-5">{icon}</div>}
      <div className="text-body font-medium text-fg">{title}</div>
      {children && <div className="max-w-80 text-ui text-fg-secondary">{children}</div>}
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}
