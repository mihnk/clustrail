import type { ReactNode } from "react";
import { ChevronDown, Eye, Lock } from "lucide-react";
import type { Environment } from "@/data/types";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { cn } from "@/lib/cn";
import { formatShortcut } from "@/lib/shortcuts";

export interface ResourceAction {
  id: string;
  label: string;
  icon: ReactNode;
  /** Observe never changes the cluster; Modify does. */
  group: "observe" | "modify";
  shortcut?: string;
  /** Not possible here (not implemented, forbidden by RBAC, read-only context). */
  disabled?: boolean;
  onSelect?: () => void;
}

export interface ActionTarget {
  env: Environment;
  /** Clustrail protection: Modify items stay selectable and open the unlock flow. */
  protected: boolean;
}

/** Right-click menu for a resource. Groups are always Observe, then Modify. */
export function ResourceContextMenu({
  actions,
  target,
  children,
}: {
  actions: ResourceAction[];
  target: ActionTarget;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-[248px]" aria-label="Resource actions">
        <ActionGroups actions={actions} target={target} kind="context" />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Menu body for a ContextMenu whose trigger is managed elsewhere (e.g. one menu for a whole table). */
export function ResourceContextMenuContent({ actions, target }: { actions: ResourceAction[]; target: ActionTarget }) {
  return (
    <ContextMenuContent className="w-[248px]" aria-label="Resource actions">
      <ActionGroups actions={actions} target={target} kind="context" />
    </ContextMenuContent>
  );
}

/** The "Modify ▾" button. Rendered dashed with a lock in a protected context. */
export function ModifyMenuButton({
  actions,
  target,
  cluster,
  size,
}: {
  actions: ResourceAction[];
  target: ActionTarget;
  cluster: string;
  size?: "md" | "lg";
}) {
  const modify = actions.filter((a) => a.group === "modify");
  const button = (
    <Button variant={target.protected ? "locked" : "default"} size={size}>
      {target.protected && <Lock aria-hidden />}
      Modify
      <ChevronDown aria-hidden />
    </Button>
  );
  return (
    <DropdownMenu>
      {target.protected ? (
        <Tooltip content={`${cluster} is protected. Each change asks for confirmation.`}>
          <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="end" className="w-[248px]">
        <ActionGroups actions={modify} target={target} kind="dropdown" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActionGroups({ actions, target, kind }: { actions: ResourceAction[]; target: ActionTarget; kind: "context" | "dropdown" }) {
  const Item = kind === "context" ? ContextMenuItem : DropdownMenuItem;
  const Label = kind === "context" ? ContextMenuLabel : DropdownMenuLabel;
  const Separator = kind === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
  const observe = actions.filter((a) => a.group === "observe");
  const modify = actions.filter((a) => a.group === "modify");

  const items = (list: ResourceAction[], locked: boolean) =>
    list.map((a) => (
      <Item
        key={a.id}
        disabled={a.disabled}
        onSelect={a.onSelect}
        className={cn(locked && "text-fg-muted data-[highlighted]:text-fg")}
      >
        {a.icon}
        {a.label}
        {a.shortcut && <DropdownMenuShortcut>{formatShortcut(a.shortcut)}</DropdownMenuShortcut>}
      </Item>
    ));

  return (
    <>
      {observe.length > 0 && (
        <>
          <Label>
            <Eye className="size-3" aria-hidden />
            Observe
          </Label>
          {items(observe, false)}
        </>
      )}
      {observe.length > 0 && modify.length > 0 && <Separator />}
      {modify.length > 0 && (
        <>
          <Label>
            {target.protected && <Lock className="size-3 text-env-prod-ink" aria-label="Protected" />}
            Modify
            <EnvironmentBadge env={target.env} size="sm" className="ml-auto text-[9.5px] tracking-[.05em]" />
          </Label>
          {items(modify, target.protected)}
        </>
      )}
    </>
  );
}
