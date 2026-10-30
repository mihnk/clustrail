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
import { t } from "@/i18n";

export interface ResourceAction {
  id: string;
  label: string;
  icon: ReactNode;
  /** Observe never changes the cluster; Modify does. */
  group: "observe" | "modify";
  shortcut?: string;
  /** Not possible here (not implemented, forbidden by RBAC, read-only context). */
  disabled?: boolean;
  /** Destructive Modify actions (Delete) are listed last, in their own group. */
  danger?: boolean;
  onSelect?: () => void;
}

export interface ActionTarget {
  env: Environment;
  /** Clustrail protection: Modify items stay selectable and open the unlock flow. */
  protected: boolean;
  /** Read-only context: Modify items are shown disabled with the reason, never hidden. */
  readOnly?: boolean;
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
      <ContextMenuContent className="w-[248px]" aria-label={t("Resource actions")}>
        <ActionGroups actions={actions} target={target} kind="context" />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Menu body for a ContextMenu whose trigger is managed elsewhere (e.g. one menu for a whole table). */
export function ResourceContextMenuContent({ actions, target }: { actions: ResourceAction[]; target: ActionTarget }) {
  return (
    <ContextMenuContent className="w-[248px]" aria-label={t("Resource actions")}>
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
  footnote,
  includeObserve,
}: {
  actions: ResourceAction[];
  target: ActionTarget;
  cluster: string;
  size?: "md" | "lg";
  /** One line under the menu, e.g. protection and GitOps ownership. */
  footnote?: string;
  /** Show the Observe group too (the inspector's Modify menu in the explorer design). */
  includeObserve?: boolean;
}) {
  const modify = includeObserve ? actions : actions.filter((a) => a.group === "modify");
  const button = (
    <Button variant={target.protected || target.readOnly ? "locked" : "default"} size={size}>
      {target.protected && <Lock aria-hidden />}{t("Modify")}<ChevronDown aria-hidden />
    </Button>
  );
  return (
    <DropdownMenu>
      {target.protected || target.readOnly ? (
        <Tooltip
          content={
            target.readOnly
              ? `${cluster} is a read-only context in Clustrail. Changes and shell are blocked.`
              : `${cluster} is protected. Each change asks for confirmation.`
          }
        >
          <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="end" className="w-[268px]">
        <ActionGroups actions={modify} target={target} kind="dropdown" />
        {footnote && <p className="m-0 mt-1 border-t border-line px-2 pb-1 pt-1.5 text-meta leading-[1.4] text-fg-muted">{footnote}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActionGroups({ actions, target, kind }: { actions: ResourceAction[]; target: ActionTarget; kind: "context" | "dropdown" }) {
  const Item = kind === "context" ? ContextMenuItem : DropdownMenuItem;
  const Label = kind === "context" ? ContextMenuLabel : DropdownMenuLabel;
  const Separator = kind === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
  const observe = actions.filter((a) => a.group === "observe");
  const modify = actions.filter((a) => a.group === "modify" && !a.danger);
  const danger = actions.filter((a) => a.group === "modify" && a.danger);

  const items = (list: ResourceAction[], locked: boolean, red = false) =>
    list.map((a) => (
      <Item
        key={a.id}
        disabled={a.disabled || target.readOnly}
        onSelect={a.onSelect}
        className={cn(
          locked && "text-fg-muted data-[highlighted]:text-fg",
          red && "text-status-critical data-[highlighted]:text-status-critical data-[disabled]:text-fg-muted",
        )}
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
            <Eye className="size-3" aria-hidden />{t("Observe")}</Label>
          {items(observe, false)}
        </>
      )}
      {observe.length > 0 && modify.length + danger.length > 0 && <Separator />}
      {modify.length + danger.length > 0 && (
        <Label>
          {target.protected && <Lock className="size-3 text-env-prod-ink" aria-label={t("Protected")} />}{t("Modify")}{target.readOnly && <span className="normal-case tracking-normal">{t("· read-only context")}</span>}
          <EnvironmentBadge env={target.env} size="sm" className="ml-auto text-[9.5px] tracking-[.05em]" />
        </Label>
      )}
      {items(modify, target.protected)}
      {danger.length > 0 && (
        <>
          {modify.length > 0 && <Separator />}
          {items(danger, false, true)}
        </>
      )}
    </>
  );
}
