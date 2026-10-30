import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeftRight, Check, ChevronDown, ChevronRight, Code, KeyRound, Layers, Plus, X } from "lucide-react";
import { useWorkspace, type WorkspaceTab } from "@/app/workspace";
import { compareSnapshots, hunks, lineDiff, snapshotFor, specYaml, type DiffLine, type DiffRow, type DiffSection } from "@/data/compare";
import type { Cluster, Environment } from "@/data/types";
import { Banner } from "@/components/ui/banner";
import { Button, IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Segmented } from "@/components/ui/segmented";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FilterToken } from "@/components/ui/filter-token";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { cn } from "@/lib/cn";

const MAX_COLUMNS = 3;
const ENV_ORDER: Record<Environment, number> = { dev: 0, stg: 1, prod: 2 };
const ENV_WORD: Record<Environment, string> = { dev: "dev", stg: "staging", prod: "prod" };

/** ConfigMap keys of the referenced config, for the inline key comparison. Not secrets. */
const CONFIG_KEYS: Record<string, [string, string, string][]> = {
  "checkout-api-config": [
    ["pricing.cache.refresh", "60s", "15s"],
    ["pricing.cache.maxEntries", "50000", "250000"],
  ],
};

export function CompareWorkspace({ tab, active }: { tab: WorkspaceTab; active: boolean }) {
  const ws = useWorkspace();
  const kind = tab.params?.kind ?? "Deployment";
  const namespace = tab.params?.namespace ?? "payments";
  const name = tab.params?.name ?? "checkout-api";

  const initial = useMemo(() => {
    const ids = (tab.params?.clusters ?? "").split(",").filter(Boolean);
    const known = ids.map((id) => ws.clusterById(id)).filter((c): c is Cluster => !!c);
    // Lower environments on the left, so the reference reads "staging → prod".
    return known.sort((a, b) => ENV_ORDER[a.env] - ENV_ORDER[b.env]).slice(0, MAX_COLUMNS).map((c) => c.id);
  }, []);
  const [clusterIds, setClusterIds] = useState<string[]>(initial);
  const [diffOnly, setDiffOnly] = useState(true);
  const [include, setInclude] = useState<"spec+status" | "spec">("spec+status");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(["img", "yaml"]));
  const [openConfig, setOpenConfig] = useState<string | null>(null);
  const [yamlLayout, setYamlLayout] = useState<"unified" | "side">("unified");
  const [activeSection, setActiveSection] = useState("sum");
  const [comparedAt, setComparedAt] = useState(() => new Date());
  const scrollRef = useRef<HTMLDivElement>(null);

  const clusters = clusterIds.map((id) => ws.clusterById(id)).filter((c): c is Cluster => !!c);
  const objects = clusters.map((c) => ws.deployments.find((d) => d.cluster === c.id && d.namespace === namespace && d.name === name));
  const snaps = objects.filter((o) => !!o).map(snapshotFor);
  const comparable = snaps.length >= 2 && snaps.length === clusters.length;
  const sections = useMemo(() => {
    if (!comparable) return [];
    const all = compareSnapshots(snaps);
    return include === "spec" ? all.filter((s) => !s.status) : all;
  }, [comparable, JSON.stringify(snaps), include]);

  // Objects are watched: a change in either cluster updates the comparison.
  useEffect(() => setComparedAt(new Date()), [JSON.stringify(snaps)]);

  const counted = (s: DiffSection) => s.rows.filter((r) => r.kind !== "ref" && r.kind !== "status").length;
  const total = sections.reduce((n, s) => n + counted(s), 0);
  const identical = sections.reduce((n, s) => n + s.identical.length, 0);
  const yamlDiff = useMemo(() => (comparable ? lineDiff(specYaml(snaps[0]!), specYaml(snaps[snaps.length - 1]!)) : []), [comparable, JSON.stringify(snaps)]);
  const yamlHunks = useMemo(() => hunks(yamlDiff), [yamlDiff]);
  const yamlChanged = yamlDiff.filter((l) => l.op !== " ").length;

  const onlyLabel = (i: number) => {
    const env = clusters[i]!.env;
    const unique = clusters.filter((c) => c.env === env).length === 1;
    return `${unique ? ENV_WORD[env] : clusters[i]!.name} only`;
  };

  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };

  const jump = (id: string) => {
    setActiveSection(id);
    if (id !== "sum" && collapsed.has(id)) toggle(id);
    requestAnimationFrame(() => {
      const el = id === "sum" ? scrollRef.current : scrollRef.current?.querySelector(`[data-section="${id}"]`);
      if (id === "sum") scrollRef.current?.scrollTo({ top: 0 });
      else (el as HTMLElement | null)?.scrollIntoView({ block: "start" });
    });
  };

  const openYaml = (cluster: string) =>
    ws.openView({ kind: "yaml", title: `YAML · ${name}`, cluster, params: { kind, namespace, name } });

  // J / K move between differences.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable], [role=menu]")) return;
      if (e.key !== "j" && e.key !== "k") return;
      const rows = [...(scrollRef.current?.querySelectorAll<HTMLElement>("[data-diff]") ?? [])];
      if (!rows.length) return;
      e.preventDefault();
      const cur = rows.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "j" ? Math.min(rows.length - 1, cur + 1) : Math.max(0, cur < 0 ? 0 : cur - 1);
      rows[next]!.focus();
      rows[next]!.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const candidates = ws.clusters.filter(
    (c) => !clusterIds.includes(c.id) && ws.deployments.some((d) => d.cluster === c.id && d.namespace === namespace && d.name === name),
  );
  const grid = cn(
    "grid items-center gap-x-3 px-4",
    clusters.length === 3
      ? "grid-cols-[96px_200px_repeat(3,minmax(0,1fr))_30px] max-[1360px]:grid-cols-[90px_170px_repeat(3,minmax(0,1fr))_30px]"
      : "grid-cols-[96px_230px_repeat(2,minmax(0,1fr))_30px] max-[1360px]:grid-cols-[90px_190px_repeat(2,minmax(0,1fr))_30px]",
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* Section navigation */}
      <aside aria-label="Sections" className="flex w-[210px] shrink-0 flex-col gap-2.5 border-r border-line bg-surface-panel px-2 py-3 max-[1360px]:hidden">
        <div className="flex flex-col gap-1 px-2">
          <span className="section-label">Comparing</span>
          <span className="flex items-center gap-1.5 text-cell">
            <Layers className="size-3.5 text-fg-muted" aria-hidden />
            <span className="font-mono font-semibold">{name}</span>
          </span>
          <span className="text-meta text-fg-muted">
            {kind} · {namespace} · matched by kind, namespace and name
          </span>
        </div>
        <nav className="flex flex-col gap-px" aria-label="Difference sections">
          <SectionLink active={activeSection === "sum"} onClick={() => jump("sum")} label="Summary" trailing={<Count>{total}</Count>} />
          {sections.map((s) => (
            <SectionLink
              key={s.id}
              active={activeSection === s.id}
              onClick={() => jump(s.id)}
              label={s.id.startsWith("res-") && sections.filter((x) => x.id.startsWith("res-")).length > 1 ? `${s.title} · ${s.scope?.replace("container ", "")}` : s.title}
              trailing={s.status ? <Count>status</Count> : counted(s) ? <WarnPill>{counted(s)}</WarnPill> : <Count>0</Count>}
            />
          ))}
          {comparable && (
            <SectionLink active={activeSection === "yaml"} onClick={() => jump("yaml")} label="YAML diff" trailing={<Count>{yamlChanged} lines</Count>} />
          )}
        </nav>
        <div className="flex-1" />
        <Banner tone="info" className="items-start text-ui">
          Secret values are never read for comparison — only key names and references.
        </Banner>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
          <span className="text-title font-semibold">Differences</span>
          <span className="truncate text-meta text-fg-muted">
            {comparable ? `${total} found · ${identical} identical fields ${diffOnly ? "hidden" : "shown"}` : "nothing to compare"}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            aria-pressed={diffOnly}
            onClick={() => setDiffOnly(!diffOnly)}
            className={cn(
              "focus-ring flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-md border border-line-strong px-2 text-ui text-fg",
              diffOnly && "border-line-selected bg-accent-soft",
            )}
          >
            {diffOnly && <Check className="size-3.5" aria-hidden />}
            Differences only
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FilterToken k="include" value={include === "spec" ? "spec only" : "spec + status"} className="max-[1360px]:hidden" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={include} onValueChange={(v) => setInclude(v as typeof include)}>
                <DropdownMenuRadioItem value="spec+status">Spec + status</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="spec">Spec only</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="ghost" disabled={clusters.length < 2} onClick={() => setClusterIds([...clusterIds].reverse())}>
            <ArrowLeftRight aria-hidden />
            Swap
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" disabled={clusterIds.length >= MAX_COLUMNS || candidates.length === 0} title={clusterIds.length >= MAX_COLUMNS ? `At most ${MAX_COLUMNS} clusters side by side` : candidates.length === 0 ? `No other connected cluster has ${namespace}/${name}` : undefined}>
                <Plus aria-hidden />
                Add cluster
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Clusters with {name}</DropdownMenuLabel>
              {candidates.map((c) => (
                <DropdownMenuItem key={c.id} onSelect={() => setClusterIds([...clusterIds, c.id])}>
                  <EnvironmentBadge env={c.env} />
                  <span className="font-mono">{c.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Column headers */}
        <div className={cn(grid, "h-11 shrink-0 border-b border-line text-ui text-fg-muted")}>
          <span>Difference</span>
          <span>Field</span>
          {clusters.map((c, i) => (
            <span key={c.id} className="flex min-w-0 items-center gap-2">
              <EnvironmentBadge env={c.env} />
              <span className="truncate font-mono font-semibold text-fg">{c.name}</span>
              {objects[i] ? (
                <span className={cn("flex items-center gap-1 font-mono", objects[i]!.health === "healthy" ? "text-status-healthy" : "text-status-critical")}>
                  <StatusGlyph health={objects[i]!.health} />
                  {objects[i]!.readyReplicas}/{objects[i]!.replicas}
                </span>
              ) : (
                <span className="text-fg-muted">not found</span>
              )}
              {clusters.length > 2 && (
                <IconButton aria-label={`Remove ${c.name}`} className="ml-auto size-5" onClick={() => setClusterIds(clusterIds.filter((id) => id !== c.id))}>
                  <X aria-hidden />
                </IconButton>
              )}
            </span>
          ))}
          <span />
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {!comparable ? (
            <div className="p-6 text-cell text-fg-secondary">
              {clusters.length < 2
                ? "Pick at least two clusters to compare."
                : `${kind} ${namespace}/${name} was not found in ${clusters.filter((_, i) => !objects[i]).map((c) => c.name).join(", ")}. Objects are matched by kind, namespace and name.`}
            </div>
          ) : (
            <>
              {sections.map((s) => {
                const rows = diffOnly ? s.rows : [...s.rows, ...s.identical];
                const isCollapsed = collapsed.has(s.id) || rows.length === 0;
                return (
                  <section key={s.id} data-section={s.id} aria-label={s.title}>
                    <SectionHeader
                      title={s.title}
                      collapsed={isCollapsed}
                      onToggle={() => (rows.length ? toggle(s.id) : undefined)}
                      scope={s.scope}
                      count={counted(s)}
                      note={s.note}
                      noteLeft={rows.length === 0 || s.id === "img"}
                    />
                    {!isCollapsed &&
                      rows.map((r) => (
                        <Fragment key={r.field}>
                          <DiffRowView
                            row={r}
                            grid={grid}
                            identical={s.identical.includes(r)}
                            onlyLabel={r.onlyIn !== undefined ? onlyLabel(r.onlyIn) : "differs"}
                            onlyEnv={r.onlyIn !== undefined ? clusters[r.onlyIn]!.env : undefined}
                            action={
                              r.kind === "content" ? (
                                <IconButton
                                  aria-label="Compare ConfigMaps"
                                  aria-expanded={openConfig === r.field}
                                  onClick={() => setOpenConfig(openConfig === r.field ? null : r.field)}
                                  className="size-6"
                                >
                                  <ArrowLeftRight aria-hidden />
                                </IconButton>
                              ) : r.path && r.kind !== "ref" ? (
                                <IconButton aria-label="Show in YAML" title={`Open YAML in ${clusters[clusters.length - 1]!.name}`} onClick={() => openYaml(clusters[clusters.length - 1]!.id)} className="size-6">
                                  <Code aria-hidden />
                                </IconButton>
                              ) : null
                            }
                          />
                          {r.kind === "content" && openConfig === r.field && (
                            <ConfigKeys grid={grid} name={r.field.replace("ConfigMap ", "")} columns={clusters.length} />
                          )}
                        </Fragment>
                      ))}
                  </section>
                );
              })}

              <section data-section="yaml" aria-label="YAML diff">
                <SectionHeader
                  title="YAML diff"
                  collapsed={collapsed.has("yaml")}
                  onToggle={() => toggle("yaml")}
                  note={`spec only · ${yamlChanged} changed lines in ${yamlHunks.length} hunks · metadata.managedFields and status excluded`}
                  noteLeft
                  trailing={
                    <Segmented
                      aria-label="Diff layout"
                      value={yamlLayout}
                      onValueChange={(v) => {
                        setYamlLayout(v);
                        if (collapsed.has("yaml")) toggle("yaml");
                      }}
                      options={[
                        { value: "unified", label: "Unified" },
                        { value: "side", label: "Side by side" },
                      ]}
                    />
                  }
                />
                {!collapsed.has("yaml") && (
                  <YamlDiff hunks={yamlHunks} layout={yamlLayout} left={clusters[0]!.name} right={clusters[clusters.length - 1]!.name} />
                )}
              </section>
            </>
          )}
        </div>

        <div className="flex h-7 shrink-0 items-center gap-2 border-t border-line px-4 text-meta text-fg-muted">
          <span>
            Compared at {comparedAt.toLocaleTimeString([], { hour12: false })} · {clusters.length === 2 ? "both" : "all"} objects watched · differences update live
          </span>
          <span className="flex-1" />
          <span className="flex items-center gap-1 max-[1360px]:hidden">
            <Kbd>J</Kbd> / <Kbd>K</Kbd> next / previous difference
          </span>
        </div>
      </main>
    </div>
  );
}

function Count({ children }: { children: ReactNode }) {
  return <span className="ml-auto font-mono text-label text-fg-muted">{children}</span>;
}

function WarnPill({ children }: { children: ReactNode }) {
  return <span className="ml-auto rounded-[4px] bg-status-warning-soft px-1.5 font-mono text-label font-semibold text-status-warning">{children}</span>;
}

function SectionLink({ label, trailing, active, onClick }: { label: string; trailing: ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "focus-ring flex h-7 items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-cell text-fg-secondary hover:bg-surface-hover hover:text-fg",
        active && "bg-surface-hover text-fg",
      )}
    >
      <span className="truncate">{label}</span>
      {trailing}
    </button>
  );
}

function SectionHeader({
  title,
  collapsed,
  onToggle,
  scope,
  count,
  note,
  noteLeft,
  trailing,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  scope?: string;
  count?: number;
  note?: string;
  noteLeft?: boolean;
  trailing?: ReactNode;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div className="sticky top-0 z-[1] flex h-[34px] items-center gap-2 border-b border-line bg-surface-side px-4 text-cell">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="focus-ring flex min-w-0 items-center gap-2 rounded-sm border-0 bg-transparent p-0 text-left text-fg"
      >
        <Chevron className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
        <span className="font-semibold">{title}</span>
      </button>
      {scope && <span className={cn("truncate text-meta text-fg-muted", scope.startsWith("container") && "font-mono")}>{scope}</span>}
      {!!count && <WarnPill>{count}</WarnPill>}
      {note && noteLeft && <span className="min-w-0 truncate text-meta text-fg-muted">{note}</span>}
      <span className="flex-1" />
      {note && !noteLeft && <span className="truncate text-meta text-fg-muted">{note}</span>}
      {trailing}
    </div>
  );
}

const ONLY_TONE: Record<Environment, string> = {
  prod: "text-env-prod-ink shadow-[inset_0_0_0_1px_var(--env-prod)]",
  stg: "text-env-stg shadow-[inset_0_0_0_1px_var(--env-stg)]",
  dev: "text-env-dev shadow-[inset_0_0_0_1px_var(--env-dev)]",
};

function DiffRowView({
  row: r,
  grid,
  identical,
  onlyLabel,
  onlyEnv,
  action,
}: {
  row: DiffRow;
  grid: string;
  identical: boolean;
  onlyLabel: string;
  onlyEnv?: Environment;
  action: ReactNode;
}) {
  const marker =
    identical ? (
      <Marker className="text-fg-muted shadow-[inset_0_0_0_1px_var(--line)]">= same</Marker>
    ) : r.kind === "changed" ? (
      <Marker className="bg-diff-chg-bg text-diff-chg-fg">≠ changed</Marker>
    ) : r.kind === "content" ? (
      <Marker className="bg-diff-chg-bg text-diff-chg-fg">≠ content</Marker>
    ) : r.kind === "only" ? (
      <Marker className={onlyEnv ? ONLY_TONE[onlyEnv] : "text-fg-secondary"}>{onlyEnv === "stg" ? "◧" : "◨"} {onlyLabel}</Marker>
    ) : r.kind === "ref" ? (
      <Marker className="text-fg-secondary shadow-[inset_0_0_0_1px_var(--line-strong)]">
        <KeyRound className="size-3" aria-hidden />
        ref only
      </Marker>
    ) : (
      <Marker className="text-fg-secondary shadow-[inset_0_0_0_1px_var(--line-strong)]">status</Marker>
    );
  return (
    <div
      data-diff={identical ? undefined : ""}
      tabIndex={identical ? undefined : -1}
      className={cn(grid, "min-h-8 border-b border-line-row py-1.5 text-cell outline-none focus-visible:bg-surface-selected")}
    >
      <span>{marker}</span>
      <span className="truncate font-mono text-fg-secondary" title={r.field}>
        {r.field}
      </span>
      {r.values.map((v, i) => (
        <span
          key={i}
          title={v ?? undefined}
          className={cn(
            "max-w-full justify-self-start truncate rounded-[4px] px-1.5 py-0.5 font-mono text-ui leading-[1.4]",
            v === null
              ? "font-sans text-fg-muted"
              : identical || r.kind === "ref" || r.kind === "status"
                ? ""
                : r.kind === "only"
                  ? "bg-diff-add-bg"
                  : "bg-diff-chg-bg",
          )}
        >
          {v ?? (r.path?.includes(".env[") ? "— not set" : "— none")}
        </span>
      ))}
      <span>{action}</span>
    </div>
  );
}

function Marker({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-[5px] whitespace-nowrap rounded-[4px] px-1.5 py-[3px] font-mono text-[10.5px] font-semibold leading-none", className)}>
      {children}
    </span>
  );
}

function ConfigKeys({ grid, name, columns }: { grid: string; name: string; columns: number }) {
  const keys = CONFIG_KEYS[name] ?? [];
  return (
    <div className="border-b border-line-row bg-surface-panel py-1">
      {keys.map(([k, a, b]) => (
        <div key={k} className={cn(grid, "min-h-7 text-ui")}>
          <span />
          <span className="truncate pl-3 font-mono text-fg-muted">{k}</span>
          {Array.from({ length: columns }, (_, i) => (
            <span key={i} className="justify-self-start rounded-[4px] bg-diff-chg-bg px-1.5 font-mono">
              {i === 0 ? a : b}
            </span>
          ))}
          <span />
        </div>
      ))}
      <div className={cn(grid, "text-meta text-fg-muted")}>
        <span />
        <span className="col-span-full col-start-2 pl-3">{keys.length} keys differ · 10 identical</span>
      </div>
    </div>
  );
}

function YamlDiff({ hunks, layout, left, right }: { hunks: DiffLine[][]; layout: "unified" | "side"; left: string; right: string }) {
  const lineCls = "flex min-h-[18px] whitespace-pre font-mono text-[11.5px] leading-[18px]";
  const tone = (op: string) => (op === "+" ? "bg-diff-add-bg text-diff-add-fg" : op === "-" ? "bg-diff-del-bg text-diff-del-fg" : "text-term-fg");
  const gutter = "w-10 shrink-0 select-none pr-2 text-right text-fg-muted";
  return (
    <div className="flex flex-col gap-2 bg-term-bg px-4 py-3">
      {layout === "unified" ? (
        <div className="grid grid-cols-[auto_minmax(0,1fr)] font-mono text-meta text-fg-muted">
          <span className="pb-1">
            --- {left} · +++ {right}
          </span>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 font-mono text-meta text-fg-muted">
          <span>{left}</span>
          <span>{right}</span>
        </div>
      )}
      {hunks.map((h, hi) => (
        <div key={hi} className="selectable overflow-x-auto rounded-md border border-line">
          {layout === "unified"
            ? h.map((l, i) => (
                <div key={i} className={cn(lineCls, tone(l.op))}>
                  <span className={gutter}>{l.a ?? ""}</span>
                  <span className={gutter}>{l.b ?? ""}</span>
                  <span className="w-4 shrink-0 select-none">{l.op}</span>
                  <span>{l.text}</span>
                </div>
              ))
            : sideBySide(h).map(([a, b], i) => (
                <div key={i} className="grid grid-cols-2">
                  <div className={cn(lineCls, a ? tone(a.op) : "")}>
                    <span className={gutter}>{a?.a ?? ""}</span>
                    <span>{a?.text ?? ""}</span>
                  </div>
                  <div className={cn(lineCls, "border-l border-line", b ? tone(b.op) : "")}>
                    <span className={gutter}>{b?.b ?? ""}</span>
                    <span>{b?.text ?? ""}</span>
                  </div>
                </div>
              ))}
        </div>
      ))}
    </div>
  );
}

type Line = DiffLine;

/** Pairs removed and added lines of a hunk into left/right rows. */
function sideBySide(h: Line[]): [Line | null, Line | null][] {
  const out: [Line | null, Line | null][] = [];
  let i = 0;
  while (i < h.length) {
    if (h[i]!.op === " ") {
      out.push([h[i]!, h[i]!]);
      i++;
      continue;
    }
    const del: Line[] = [];
    const add: Line[] = [];
    while (i < h.length && h[i]!.op === "-") del.push(h[i++]!);
    while (i < h.length && h[i]!.op === "+") add.push(h[i++]!);
    for (let k = 0; k < Math.max(del.length, add.length); k++) out.push([del[k] ?? null, add[k] ?? null]);
  }
  return out;
}
