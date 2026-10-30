import { useState, type ReactNode } from "react";
import {
  Box,
  Check,
  Copy,
  ExternalLink,
  Layers,
  Lock,
  Route,
  ScrollText,
  SquareTerminal,
  X,
} from "lucide-react";
import type { Cluster, ContainerStatus, Health, PodDetail, ResourceEvent } from "@/data/types";
import { Button, IconButton } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabCount } from "@/components/ui/tabs";
import { Segmented } from "@/components/ui/segmented";
import { ModifyMenuButton, type ResourceAction } from "@/components/resource-actions/ResourceActions";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph, healthTone } from "@/components/status/StatusGlyph";
import { MetricsChart } from "@/components/charts/MetricsChart";
import { EmptyState } from "@/components/EmptyState";
import { formatMemory } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/app/workspace";

export type InspectorTab = "overview" | "containers" | "events" | "logs" | "yaml" | "metrics" | "related";

export function PodInspector({
  detail,
  cluster,
  tab,
  onTabChange,
  onClose,
  actions,
  onInvestigate,
  onOpenOwner,
  themeKey,
}: {
  detail: PodDetail;
  cluster: Cluster | undefined;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onClose: () => void;
  actions: ResourceAction[];
  onInvestigate: (target: string) => void;
  onOpenOwner: (kind: string, name: string) => void;
  themeKey: string;
}) {
  const ws = useWorkspace();
  const { pod } = detail;
  const investigateTarget = detail.ownerChain.find((o) => o.kind === "Deployment")?.name ?? pod.name;

  return (
    <>
      <div className="flex flex-col gap-2 pl-3.5 pr-3 pt-2.5">
        <div className="flex items-center gap-1.5 text-ui text-fg-muted">
          <Box className="size-3.5" aria-hidden />
          <span>Pod</span>
          <EnvironmentBadge env={pod.env} className="ml-1" />
          {cluster?.protected && (
            <span className="flex items-center gap-1.5 whitespace-nowrap text-env-prod-ink">
              <Lock className="size-3.5" aria-hidden />
              Protected
            </span>
          )}
          <div className="flex-1" />
          <IconButton aria-label="Open in new tab" className="[&_svg]:size-3.5">
            <ExternalLink />
          </IconButton>
          <IconButton aria-label="Close inspector" onClick={onClose} className="[&_svg]:size-3.5">
            <X />
          </IconButton>
        </div>

        <div className="flex min-w-0 items-center gap-1.5">
          <h1 className="selectable m-0 truncate font-mono text-mono-title font-semibold text-fg" title={pod.name}>
            {pod.name}
          </h1>
          <CopyButton value={pod.name} />
        </div>
        <div className="truncate text-ui text-fg-secondary">
          {pod.namespace} · {pod.cluster} · <span className="font-mono">{pod.node}</span>
        </div>

        {detail.problem && <ProblemSummary health={pod.health} problem={detail.problem} />}

        <div className="flex items-center gap-1.5">
          <Button onClick={() => actions.find((a) => a.id === "logs")?.onSelect?.()}>
            <ScrollText aria-hidden />
            Logs
          </Button>
          <Button
            disabled={actions.find((a) => a.id === "shell")?.disabled}
            onClick={() => actions.find((a) => a.id === "shell")?.onSelect?.()}
          >
            <SquareTerminal aria-hidden />
            Shell
          </Button>
          <Button disabled={!pod.owner}>
            <Layers aria-hidden />
            Owner
          </Button>
          <div className="flex-1" />
          <ModifyMenuButton
            actions={actions}
            target={{ env: pod.env, protected: cluster?.protected ?? false }}
            cluster={pod.cluster}
          />
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => onTabChange(v as InspectorTab)} className="flex min-h-0 flex-1 flex-col">
        <TabsList aria-label="Inspector sections" className="mt-1 px-3.5 pt-1.5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="containers">
            Containers <TabCount>{detail.containers.length}</TabCount>
          </TabsTrigger>
          <TabsTrigger value="events">
            Events <TabCount>{detail.events.length}</TabCount>
          </TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="yaml">YAML</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="related">Related</TabsTrigger>
        </TabsList>

        <TabPanel value="overview">
          <Section title="Containers">
            <ContainerList containers={detail.containers} expandFirstOnly />
          </Section>
          <MemorySection detail={detail} themeKey={themeKey} />
          {detail.events.length > 0 && (
            <section className="flex flex-col">
              <div className="flex items-baseline justify-between pb-1.5">
                <span className="section-label">Latest events</span>
                <button
                  type="button"
                  onClick={() => onTabChange("events")}
                  className="focus-ring rounded-sm border-0 bg-transparent p-0 text-ui text-accent hover:text-fg"
                >
                  All {detail.events.length}
                </button>
              </div>
              <EventList events={detail.events.filter((e) => e.object === "pod").slice(0, 3)} />
            </section>
          )}
          {detail.ownerChain.length > 0 && (
            <Section title="Owned by" gap="gap-1.5">
              {detail.ownerChain.map((o, i) => (
                <div key={o.name} className={cn("flex items-center gap-2 text-cell", i > 0 && "pl-3.5")}>
                  {i === 0 ? (
                    <Layers className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
                  ) : (
                    <span className="text-fg-muted">└</span>
                  )}
                  {i === 0 ? (
                    <button
                      type="button"
                      onClick={() => onOpenOwner(o.kind, o.name)}
                      className="focus-ring truncate rounded-sm border-0 bg-transparent p-0 font-mono text-cell text-accent hover:text-fg"
                    >
                      {o.name}
                    </button>
                  ) : (
                    <span className="truncate font-mono text-fg-secondary">{o.name}</span>
                  )}
                  <span className="whitespace-nowrap text-fg-muted">{o.kind === "ReplicaSet" && i > 0 ? `ReplicaSet · ${o.note}` : o.kind}</span>
                  {i === 0 && o.note && (
                    <span className={cn("ml-auto font-mono text-ui", o.tone && healthTone[o.tone])}>{o.note}</span>
                  )}
                </div>
              ))}
            </Section>
          )}
        </TabPanel>

        <TabPanel value="containers">
          <ContainerList containers={detail.containers} />
        </TabPanel>

        <TabsContent value="events" className="focus-ring flex min-h-0 flex-1 flex-col">
          <EventsPanel events={detail.events} />
        </TabsContent>

        <TabPanel value="related">
          <RelatedList relations={detail.relations} />
        </TabPanel>

        <TabPanel value="logs">
          <EmptyState
            title="Logs open in their own tab"
            action={
              <Button
                onClick={() =>
                  ws.openView({
                    kind: "logs",
                    title: `Logs · ${pod.owner?.name ?? pod.name}`,
                    cluster: pod.cluster,
                    params: { namespace: pod.namespace, workload: pod.owner?.name ?? pod.name, pod: pod.name },
                  })
                }
              >
                Open logs
              </Button>
            }
          >
            Follow, search and pin lines from every container of this pod.
          </EmptyState>
        </TabPanel>
        <TabPanel value="yaml">
          <EmptyState
            title="YAML opens in its own tab"
            action={
              <Button
                onClick={() =>
                  ws.openView({ kind: "yaml", title: `YAML · ${pod.name}`, cluster: pod.cluster, params: { kind: "Pod", namespace: pod.namespace, name: pod.name } })
                }
              >
                Open YAML
              </Button>
            }
          />
        </TabPanel>
        <TabPanel value="metrics">
          <MemorySection detail={detail} themeKey={themeKey} />
        </TabPanel>
      </Tabs>

      <div className="border-t border-line px-3.5 py-2.5">
        <Button variant="primary" className="h-[30px] w-full justify-center" onClick={() => onInvestigate(investigateTarget)}>
          <Route aria-hidden />
          Investigate {investigateTarget}
        </Button>
      </div>
    </>
  );
}

function TabPanel({ value, children }: { value: InspectorTab; children: ReactNode }) {
  return (
    <TabsContent value={value} className="focus-ring flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3.5 py-3">
      {children}
    </TabsContent>
  );
}

function Section({ title, children, gap = "gap-2" }: { title: ReactNode; children: ReactNode; gap?: string }) {
  return (
    <section className={cn("flex flex-col", gap)}>
      <div className="section-label">{title}</div>
      {children}
    </section>
  );
}

const problemBg: Partial<Record<Health, string>> = {
  failed: "bg-status-critical-soft",
  warning: "bg-status-warning-soft",
  progressing: "bg-status-progressing-soft",
};

function ProblemSummary({ health, problem }: { health: Health; problem: NonNullable<PodDetail["problem"]> }) {
  return (
    <div className={cn("flex gap-[9px] rounded-lg px-2.5 py-[9px]", problemBg[health] ?? "bg-surface-elevated")}>
      <StatusGlyph health={health} className="mt-0.5" />
      <div className="flex min-w-0 flex-col gap-[3px] text-ui text-fg">
        <span className="font-semibold">
          <span className={healthTone[health]}>{problem.title}</span>
          {problem.container && (
            <>
              {" "}
              · container <span className="font-mono">{problem.container}</span>
            </>
          )}
        </span>
        <span className="text-fg-secondary">{problem.detail}</span>
      </div>
    </div>
  );
}

function ContainerList({ containers, expandFirstOnly }: { containers: ContainerStatus[]; expandFirstOnly?: boolean }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      {containers.map((c, i) => {
        const expanded = !expandFirstOnly || i === 0;
        return (
          <div key={c.name} className={cn("flex flex-col gap-1.5 px-2.5", expanded ? "py-[9px]" : "py-2", i > 0 && "border-t border-line")}>
            <div className="flex items-center gap-2">
              <StatusGlyph health={c.health} />
              <span className="font-mono text-cell font-semibold">{c.name}</span>
              <span className="truncate text-ui text-fg-secondary">{c.state}</span>
              <span
                className={cn(
                  "ml-auto whitespace-nowrap font-mono text-ui",
                  c.restarts >= 5 ? "text-status-critical" : c.restarts > 0 ? "text-status-warning" : "text-fg-muted",
                )}
              >
                {c.restarts} ↻
              </span>
            </div>
            {expanded && (c.image || c.lastState || c.memory) && (
              <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-2.5 gap-y-[5px] text-ui">
                {c.image && <KV k="Image" v={<span className="selectable block truncate font-mono text-meta">{c.image}</span>} />}
                {c.lastState && <KV k="Last state" v={c.lastState} />}
                {c.memory && <KV k="Memory" v={<span className="font-mono text-meta">{c.memory}</span>} />}
              </dl>
            )}
          </div>
        );
      })}
    </div>
  );
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{k}</dt>
      <dd className="m-0 min-w-0 text-fg">{v}</dd>
    </>
  );
}

/**
 * Related objects as a list, not a graph: it scales to hundreds of objects
 * and reads well with a screen reader. Each line says how it was found.
 */
export function RelatedList({ relations }: { relations: PodDetail["relations"] }) {
  return (
    <dl className="m-0 flex flex-col">
      {relations.map((r) => (
        <div key={r.label} className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-x-2.5 py-1.5 text-ui">
          <dt className="pt-px text-meta text-fg-muted">{r.label}</dt>
          <dd className="m-0 flex min-w-0 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-1.5 font-mono">
              {r.objects.map((o, i) => (
                <span key={o.kind + o.name} className="flex items-center gap-1.5">
                  {i > 0 && <span className="text-fg-muted">{r.label === "Owned by" ? "›" : "·"}</span>}
                  <span className="text-fg-muted">{o.kind}/</span>
                  <span className="truncate">{o.name}</span>
                </span>
              ))}
              {r.pill && (
                <span
                  className={cn(
                    "rounded px-[5px] py-[3px] text-2xs font-semibold leading-none",
                    r.pill.tone === "warning" ? "bg-status-warning-soft text-status-warning" : "bg-status-progressing-soft text-status-progressing",
                  )}
                >
                  {r.pill.text}
                </span>
              )}
            </span>
            <span className="text-label text-fg-muted">via {r.via}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Events of the pod, optionally with its owners', newest first. */
export function EventsPanel({ events }: { events: ResourceEvent[] }) {
  const [type, setType] = useState<"all" | "warnings">("all");
  const [includeOwners, setIncludeOwners] = useState(true);
  const warnings = events.filter((e) => e.type === "Warning" && (includeOwners || e.object === "pod")).length;
  const shown = events.filter(
    (e) => (includeOwners || e.object === "pod") && (type === "all" || e.type === "Warning"),
  );
  return (
    <>
      <div className="flex items-center gap-1.5 px-3.5 pb-1.5 pt-2.5">
        <Segmented
          aria-label="Event type"
          value={type}
          onValueChange={setType}
          options={[
            { value: "all", label: "All" },
            { value: "warnings", label: <>Warnings <span className="font-mono">{warnings}</span></> },
          ]}
        />
        <div className="flex-1" />
        <button
          type="button"
          aria-pressed={includeOwners}
          onClick={() => setIncludeOwners(!includeOwners)}
          className={cn(
            "focus-ring flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-md border border-line-strong bg-transparent px-2 text-ui text-fg",
            includeOwners && "border-line-selected bg-accent-soft",
          )}
        >
          {includeOwners && <Check className="size-3" aria-hidden />}
          Include owners
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5">
        {shown.length === 0 ? (
          <EmptyState title="No events">
            The API server keeps events for a limited time (1 hour by default), so older events may be gone.
          </EmptyState>
        ) : (
          shown.map((e) => (
            <div
              key={e.object + e.reason + e.message}
              className="grid grid-cols-[44px_14px_minmax(0,1fr)] gap-x-2 border-t border-line-row py-2 text-ui first:border-t-0"
            >
              <span className="font-mono text-meta text-fg-muted">{e.lastSeen}</span>
              <StatusGlyph health={e.type === "Warning" ? "warning" : "completed"} className="mt-0.5" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-baseline gap-1.5">
                  <b className="font-semibold">{e.reason}</b>
                  <span className="truncate font-mono text-label text-fg-muted">{e.object}</span>
                  {e.count > 1 && <span className="ml-auto font-mono text-label text-fg-muted">×{e.count}</span>}
                </div>
                <span className="selectable text-fg-secondary">{e.message}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function EventList({ events }: { events: ResourceEvent[] }) {
  return (
    <div>
      {events.map((e) => (
        <div
          key={e.reason + e.message}
          className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-x-2 border-t border-line-row py-[7px] text-ui"
        >
          <StatusGlyph health={e.type === "Warning" ? "warning" : "completed"} className="mt-0.5" />
          {/* One line each in the overview; the Events tab shows full messages. */}
          <span className="truncate" title={e.message}>
            <b className="font-semibold">{e.reason}</b> <span className="text-fg-secondary">{e.message}</span>
          </span>
          <span className="whitespace-nowrap font-mono text-meta text-fg-muted">
            ×{e.count} · {e.lastSeen}
          </span>
        </div>
      ))}
    </div>
  );
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function MemorySection({ detail, themeKey }: { detail: PodDetail; themeKey: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const mem = detail.memory;

  if (!mem) {
    const current = detail.pod.memoryMiB;
    return (
      <Section title="Memory" gap="gap-1.5">
        {current === null ? (
          <p className="m-0 text-ui text-fg-secondary">No metrics: the pod has no running containers.</p>
        ) : (
          <>
            <div className="flex items-baseline gap-2 text-ui">
              <span className="font-mono text-cell text-fg">{formatMemory(current)}</span>
              <span className="text-fg-muted">now · metrics-server</span>
            </div>
            <p className="m-0 text-meta text-fg-muted">
              metrics-server reports current usage only. History builds up while this pod is open (sampled every 15s, kept in
              memory).
            </p>
          </>
        )}
      </Section>
    );
  }

  const { series } = mem;
  const idx = hover ?? series.values.length - 1;
  const at = series.timestamps[idx];
  const kills = series.markers?.length ?? 0;

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="section-label">Memory · {mem.container} · 1h</span>
        {hover === null ? (
          <span className="truncate font-mono text-label text-fg-muted">{series.source}</span>
        ) : (
          <span className="font-mono text-label text-fg">
            {formatMemory(series.values[idx] ?? null)} · {at ? timeFmt.format(at * 1000) : ""}
          </span>
        )}
      </div>
      <MetricsChart
        series={series}
        themeKey={themeKey}
        onHover={setHover}
        label={`Memory of container ${mem.container} over the last hour${kills ? `, reaching the ${series.limit}Mi limit ${kills} times` : ""}`}
      />
      <div className="flex flex-wrap gap-3 text-meta text-fg-muted">
        {series.limit !== undefined && (
          <Legend swatch={<span className="w-3 border-t-[1.5px] border-dashed border-status-critical" />}>limit {series.limit}Mi</Legend>
        )}
        {series.request !== undefined && (
          <Legend swatch={<span className="w-3 border-t-[1.5px] border-dashed border-line-strong" />}>request {series.request}Mi</Legend>
        )}
        {kills > 0 && (
          <Legend swatch={<span className="size-1.5 rounded-full bg-status-critical" />}>OOMKilled ×{kills}</Legend>
        )}
      </div>
    </section>
  );
}

function Legend({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      {swatch}
      {children}
    </span>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      aria-label={copied ? "Copied" : "Copy name"}
      className="size-[22px] [&_svg]:size-3.5"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check className="text-status-healthy" /> : <Copy />}
    </IconButton>
  );
}
