import { useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import { Lock, Search } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import type { Environment } from "@/data/types";
import { Checkbox } from "@/components/ui/checkbox";
import { EnvironmentBadge, connectionLabel } from "@/components/status/EnvironmentBadge";
import { cn } from "@/lib/cn";
import { locale, t } from "@/i18n";

const GROUPS: { env: Environment; label: string }[] = [
  { env: "prod", label: t("Production") },
  { env: "stg", label: t("Staging") },
  { env: "dev", label: t("Development") },
];

/** Quick selections by group: every cluster of one environment. */
function groupSets(clusters: { id: string; env: Environment }[]): { name: string; ids: string[] }[] {
  return GROUPS.map((g) => ({ name: t("All {group}", { group: g.label.toLocaleLowerCase(locale()) }), ids: clusters.filter((c) => c.env === g.env).map((c) => c.id) })).filter((s) => s.ids.length > 1);
}

/**
 * Multi-cluster picker (⌘⇧C). Same selection as the sidebar. Clusters that
 * cannot connect are shown but can't be picked until they are fixed.
 */
export function ClusterPicker({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The trigger, e.g. the toolbar's cluster chips. */
  children: ReactNode;
}) {
  const { clusters, selectedClusterIds, setSelectedClusterIds, toggleCluster } = useWorkspace();
  const [filter, setFilter] = useState("");
  const selected = new Set(selectedClusterIds);
  const usable = (c: (typeof clusters)[number]) => c.connection !== "auth-expired" && c.connection !== "unreachable";
  const visible = clusters.filter((c) => c.name.includes(filter.trim().toLowerCase()));

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          aria-label={t("Clusters")}
          className="z-50 w-[300px] rounded-lg border border-line-strong bg-surface-elevated p-1.5 text-fg shadow-menu"
        >
          <label className="mb-1 flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-surface-panel px-2 text-fg-muted focus-within:border-accent">
            <Search className="size-3.5" aria-hidden />
            <span className="sr-only">{t("Filter clusters")}</span>
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("Filter clusters…")}
              className="min-w-0 flex-1 border-0 bg-transparent text-cell text-fg outline-none placeholder:text-fg-muted"
            />
          </label>
          {GROUPS.map(({ env, label }) => {
            const group = visible.filter((c) => c.env === env);
            if (!group.length) return null;
            const pickable = group.filter(usable);
            const on = pickable.filter((c) => selected.has(c.id)).length;
            return (
              <div key={env}>
                <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-[.06em] text-fg-muted">
                  <Checkbox
                    aria-label={t("Select all {label}", { label })}
                    checked={on === 0 ? false : on === pickable.length ? true : "indeterminate"}
                    onCheckedChange={(v) => {
                      const ids = new Set(selectedClusterIds);
                      for (const c of pickable) {
                        if (v) ids.add(c.id);
                        else ids.delete(c.id);
                      }
                      setSelectedClusterIds([...ids]);
                    }}
                  />
                  <EnvironmentBadge env={env} />
                  {label}
                  <span className="flex-1" />
                  {group.some((c) => c.protected) && <Lock className="size-3 text-env-prod-ink" aria-label={t("Protected")} />}
                </div>
                {group.map((c) => {
                  const ok = usable(c);
                  return (
                    <div
                      key={c.id}
                      className={cn(
                        "group flex h-7 items-center gap-2 rounded-[5px] px-2 text-cell",
                        ok ? "hover:bg-accent-soft" : "text-fg-muted",
                      )}
                    >
                      <Checkbox
                        aria-label={t("Include {name}", { name: c.name })}
                        checked={selected.has(c.id)}
                        onCheckedChange={(v) => ok && toggleCluster(c.id, v)}
                        className={ok ? undefined : "pointer-events-none opacity-50"}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono">{c.name}</span>
                      {ok ? (
                        <>
                          <span className="font-mono text-label text-fg-muted group-hover:hidden">
                            {c.latencyMs !== null ? `${c.latencyMs}ms` : t(connectionLabel[c.connection]).toLocaleLowerCase(locale())}
                          </span>
                          <button
                            type="button"
                            onClick={() => setSelectedClusterIds([c.id])}
                            className="focus-ring hidden rounded-sm border-0 bg-transparent p-0 font-mono text-label text-accent group-hover:inline"
                          >{t("Only this")}</button>
                        </>
                      ) : (
                        <span className="font-mono text-label text-status-warning">
                          {c.connection === "auth-expired" ? "expired" : "unreachable"}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div className="my-1 h-px bg-line" />
          <div className="flex items-center gap-2 px-2 py-0.5 text-meta text-fg-muted">
            <span className="flex-1">
              {t("{selected} selected · {groups} groups", { selected: selected.size, groups: new Set(clusters.filter((c) => selected.has(c.id)).map((c) => c.env)).size })}
            </span>
            <span>{t("Saved:")}</span>
            {groupSets(clusters).map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => setSelectedClusterIds(s.ids)}
                className="focus-ring rounded-sm border-0 bg-transparent p-0 text-meta text-fg hover:text-accent"
              >
                {s.name}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
