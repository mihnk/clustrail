import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowLeftRight,
  Check,
  ChevronDown,
  Copy,
  Diff,
  Download,
  ExternalLink,
  FileText,
  GitBranch,
  Layers,
  Lightbulb,
  Link2,
  Lock,
  PanelLeft,
  Pin as PinIcon,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { usePersistentState } from "@/app/preferences";
import {
  checkoutInvestigation,
  initialHypotheses,
  initialNotes,
  steps,
  symptoms,
  type Hypothesis,
  type InvolvedObject,
} from "@/data/investigation";
import { Button, IconButton } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Segmented } from "@/components/ui/segmented";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph, healthTone } from "@/components/status/StatusGlyph";
import { ModifyMenuButton } from "@/components/resource-actions/ResourceActions";
import { useConfirm } from "@/components/safety/ConfirmationDialog";
import { restartDeploymentRequest } from "@/features/deployments/requests";
import { cn } from "@/lib/cn";

type View = "evidence" | "timeline";
type InvStatus = "Open" | "Monitoring" | "Resolved";

const POD_PREFIX = "prod-eu-west-1/payments/checkout-api-7d9f8b6c4-";

interface Evidence {
  id: string;
  source: string;
  title: string;
  at: string;
  /** Plain text for the Markdown export. */
  plain: string;
  body: ReactNode;
  open?: { label: string; run: () => void };
}

export function InvestigationWorkspace() {
  const inv = checkoutInvestigation;
  const ws = useWorkspace();
  const { clusterById, deployments, restartDeployment, pins, openTab, openView, revealResource } = ws;
  const { confirm } = useConfirm();
  const cluster = clusterById(inv.target.cluster);
  const deployment = deployments.find((d) => d.cluster === inv.target.cluster && d.name === inv.target.name);

  const key = (k: string) => `investigation.${inv.id}.${k}`;
  const [status, setStatus] = usePersistentState<InvStatus>(key("status"), "Open");
  const [hypotheses, setHypotheses] = usePersistentState<Hypothesis[]>(key("hypotheses"), initialHypotheses);
  const [notes, setNotes] = usePersistentState<string>(key("notes-md"), initialNotes);
  const [done, setDone] = usePersistentState<string[]>(key("steps"), ["p1", "p2"]);
  const [view, setView] = useState<View>("evidence");
  // At 1280 the symptoms column collapses into a toggle.
  const [symptomsOpen, setSymptomsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const evidence = useMemo<Evidence[]>(() => {
    const showPod = (suffix: string) => {
      openTab("pods");
      revealResource("pod", POD_PREFIX + suffix);
    };
    const builtIn: Evidence[] = [
      {
        id: "E1",
        source: "Pod status",
        title: "Last termination of container api",
        at: "12:00:19",
        plain: "x2kqp: 14 restarts, OOMKilled, exit 137, finished 11:59:02; m8vtn: 11 restarts, OOMKilled, exit 137, finished 12:00:19",
        body: <PodStatusTable />,
        open: { label: "Open pod", run: () => showPod("x2kqp") },
      },
      {
        id: "E2",
        source: "Events + restartCount",
        title: "Restart history · last 60m",
        at: "Event TTL on this cluster: 1h",
        plain: "x2kqp restarted 14 times in the last 52 minutes; m8vtn 11 times in the last 48 minutes",
        body: <RestartLanes lanes={inv.lanes} />,
      },
      {
        id: "E3",
        source: "metrics-server",
        title: "Memory working set vs limit · container api",
        at: "15s samples · since Clustrail opened",
        plain: "Failing pods climb to the 256Mi limit and reset; healthy pods stay near 230Mi (9rkzd 231Mi, h2pqs 226Mi)",
        body: <MemoryChart />,
      },
      {
        id: "E4",
        source: "Log excerpt",
        title: "x2kqp · api · previous instance",
        at: "11:58:43 → 11:58:47",
        plain: "java.lang.OutOfMemoryError: Java heap space at PriceCache.rebuild after G1 Full GC (heap 379/384 MB)",
        body: (
          <Excerpt>
            <span className="text-status-warning">WARN </span> GcMonitor - GC pause 1.8s (G1 Evacuation Pause), heap 361/384 MB{"\n"}
            <span className="text-status-warning">WARN </span> GcMonitor - GC pause 3.2s (G1 Full GC), heap 379/384 MB{"\n"}
            <span className="text-status-critical">ERROR</span> java.lang.OutOfMemoryError: Java heap space{"\n"}
            <span className="text-status-critical">ERROR</span>{"     "}at c.a.checkout.pricing.PriceCache.rebuild(PriceCache.java:214)
          </Excerpt>
        ),
        open: {
          label: "Open in Logs",
          run: () =>
            openView({
              kind: "logs",
              title: `Logs · ${inv.target.name}`,
              cluster: inv.target.cluster,
              params: { namespace: inv.target.namespace, workload: inv.target.name, previous: "1" },
            }),
        },
      },
      {
        id: "E5",
        source: "Shell output",
        title: "9rkzd · api · read by you",
        at: "12:05",
        plain: "memory.max = 268435456 (256Mi), JAVA_TOOL_OPTIONS = -Xmx384m -XX:+UseG1GC",
        body: <Excerpt>memory.max = 268435456 (256Mi)   JAVA_TOOL_OPTIONS = -Xmx384m -XX:+UseG1GC</Excerpt>,
      },
    ];
    // Lines pinned from Logs or Shell become evidence of their own.
    const pinned = pins.map<Evidence>((p, i) => ({
      id: `E${builtIn.length + 1 + i}`,
      source: p.source.split(" · ")[0] === "Shell" ? "Shell output" : "Log excerpt",
      title: p.source,
      at: new Date(p.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      plain: p.text,
      body: <Excerpt>{p.text}</Excerpt>,
    }));
    return [...builtIn, ...pinned];
  }, [inv, pins, openTab, openView, revealResource]);

  const copySummary = () => {
    void navigator.clipboard?.writeText(summaryMarkdown({ status, evidence, hypotheses, notes, done })).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const exportMarkdown = () => {
    const blob = new Blob([summaryMarkdown({ status, evidence, hypotheses, notes, done })], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `investigation-${inv.target.name}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const backToPods = () => {
    openTab("pods");
    revealResource("filter", "pods:cluster:prod-eu-west-1 ns:payments status:crashloop");
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-end gap-4 border-b border-line px-4 pb-3 pt-2.5">
        <div className="flex min-w-0 flex-col gap-[5px]">
          <button
            type="button"
            onClick={backToPods}
            className="focus-ring flex w-fit items-center gap-1.5 rounded-sm border-0 bg-transparent p-0 text-ui text-fg-muted hover:text-fg"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Back to Pods · {inv.target.cluster} · {inv.target.namespace} · CrashLoop filter
          </button>
          <h1 className="m-0 truncate text-heading font-semibold tracking-[-.01em]">{inv.title}</h1>
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-cell text-fg-secondary">
            <Layers className="size-3.5" aria-hidden />
            <button
              type="button"
              onClick={() => openTab("deploy-checkout-api")}
              className="focus-ring rounded-sm border-0 bg-transparent p-0 font-mono text-fg-secondary underline-offset-2 hover:text-fg hover:underline"
            >
              {inv.target.kind}/{inv.target.name}
            </button>
            <span>·</span>
            <span>
              {inv.target.namespace} · {inv.target.cluster}
            </span>
            {cluster && <EnvironmentBadge env={cluster.env} />}
            {cluster?.protected && (
              <span className="flex items-center gap-1.5 text-ui text-env-prod-ink">
                <Lock className="size-3" aria-hidden />
                Protected
              </span>
            )}
            <span className="max-[1360px]:hidden">· opened 40m ago by you · saved locally</span>
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="focus-ring flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-md border border-line-strong bg-surface-panel px-2 text-ui dark:bg-transparent"
              >
                <span className="text-fg-muted">status</span>
                <span className={status === "Resolved" ? "text-status-healthy" : status === "Open" ? "text-status-warning" : "text-status-progressing"}>
                  {status}
                </span>
                <ChevronDown className="size-3.5 text-fg-muted" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={status} onValueChange={(v) => setStatus(v as InvStatus)}>
                {(["Open", "Monitoring", "Resolved"] as const).map((s) => (
                  <DropdownMenuRadioItem key={s} value={s}>
                    {s}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button onClick={copySummary}>
            {copied ? <Check className="text-status-healthy" aria-hidden /> : <Copy aria-hidden />}
            {copied ? "Copied" : "Copy summary"}
          </Button>
          <Button onClick={exportMarkdown} className="max-[1360px]:hidden">
            <Download aria-hidden />
            Export .md
          </Button>
          {cluster && deployment && (
            <ModifyMenuButton
              cluster={cluster.name}
              target={{ env: cluster.env, protected: cluster.protected }}
              actions={[
                {
                  id: "restart",
                  group: "modify",
                  label: "Restart deployment…",
                  icon: <RotateCcw />,
                  shortcut: "⇧R",
                  onSelect: () => confirm(restartDeploymentRequest(deployment, cluster, () => restartDeployment(deployment.id))),
                },
              ]}
            />
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Symptoms and related objects */}
        <section
          aria-label="Symptoms and objects"
          className={cn("flex w-[288px] shrink-0 flex-col overflow-y-auto border-r border-line", !symptomsOpen && "max-[1360px]:hidden", symptomsOpen && "max-[1360px]:w-[260px]")}
        >
          <ColumnHeader title="Observed symptoms" trailing={<span className="text-meta text-fg-muted">live</span>} />
          <div className="px-3.5 pb-2.5 pt-1">
            {symptoms.map((s, i) => (
              <div
                key={s.plain}
                className={cn("grid grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-x-2 py-1.5 text-cell", i > 0 && "border-t border-line-row")}
              >
                <StatusGlyph health={s.health} className="mt-[3px]" />
                <span>{s.text}</span>
                <span className="font-mono text-meta text-fg-muted">{s.fact}</span>
              </div>
            ))}
          </div>
          <ColumnHeader title="Related objects" border trailing={<span className="font-mono text-label text-fg-muted">{inv.objects.length}</span>} />
          <div className="flex flex-col px-2 pb-2.5 pt-1">
            {inv.objects.map((o) => (
              <RelatedObject key={o.id} object={o} onOpen={o.depth === 2 ? () => (openTab("pods"), revealResource("pod", POD_PREFIX + o.id)) : undefined} />
            ))}
          </div>
        </section>

        {/* Observed facts */}
        <section aria-label="Observed facts" className="flex min-w-0 flex-1 flex-col">
          <ColumnHeader
            lead={
              <IconButton
                aria-label={symptomsOpen ? "Hide symptoms and objects" : "Show symptoms and objects"}
                aria-pressed={symptomsOpen}
                title="Symptoms and related objects"
                onClick={() => setSymptomsOpen(!symptomsOpen)}
                className="-ml-1 hidden max-[1360px]:inline-flex"
              >
                <PanelLeft aria-hidden />
              </IconButton>
            }
            title="Observed facts"
            note="captured from the cluster · each links to its source"
            trailing={
              <Segmented<View>
                aria-label="View"
                value={view}
                onValueChange={setView}
                options={[
                  { value: "evidence", label: `Evidence ${evidence.length}` },
                  { value: "timeline", label: "Timeline" },
                ]}
              />
            }
          />
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3.5 py-3">
            {view === "evidence" ? (
              <>
                {evidence.map((e) => (
                  <EvidenceCard key={e.id} evidence={e} />
                ))}
                {pins.length === 0 && (
                  <p className="m-0 flex items-center gap-1.5 text-meta text-fg-muted">
                    <PinIcon className="size-3" aria-hidden />
                    Lines you pin from Logs or a shell are added here as evidence.
                  </p>
                )}
              </>
            ) : (
              <Timeline />
            )}
          </div>
        </section>

        {/* Hypotheses and notes */}
        <section aria-label="Hypotheses and notes" className="flex w-[372px] shrink-0 flex-col border-l border-line bg-surface-panel max-[1360px]:w-[340px]">
          <ColumnHeader title="Hypotheses & notes" trailing={<span className="text-meta text-fg-muted">written by people</span>} />
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3.5 py-3">
            {hypotheses.map((h) => (
              <HypothesisCard
                key={h.id}
                hypothesis={h}
                evidenceIds={evidence.map((e) => e.id)}
                onChange={(next) => setHypotheses(hypotheses.map((x) => (x.id === h.id ? next : x)))}
                onRemove={() => setHypotheses(hypotheses.filter((x) => x.id !== h.id))}
              />
            ))}
            <AddHypothesis
              onAdd={(text) =>
                setHypotheses([
                  ...hypotheses,
                  {
                    id: `H${Math.max(0, ...hypotheses.map((h) => Number(h.id.slice(1)))) + 1}`,
                    text,
                    status: "Open",
                    evidence: [],
                    author: "you",
                    at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                  },
                ])
              }
            />
            <Notes value={notes} onChange={setNotes} />
            <NextSteps
              done={done}
              onToggle={(id, on) => setDone(on ? [...done, id] : done.filter((d) => d !== id))}
              onCompare={() =>
                openView({
                  kind: "compare",
                  title: `Compare · ${inv.target.name}`,
                  params: { kind: "Deployment", namespace: inv.target.namespace, name: inv.target.name, clusters: "staging-eu-1,prod-eu-west-1" },
                })
              }
              onSource={() => openView({ kind: "gitops", title: "GitOps" })}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function ColumnHeader({ title, note, trailing, border, lead }: { title: string; note?: string; trailing?: ReactNode; border?: boolean; lead?: ReactNode }) {
  return (
    <div className={cn("flex h-[38px] shrink-0 items-center gap-2 border-b border-line px-3.5 text-ui", border && "border-t")}>
      {lead}
      <span className="section-label">{title}</span>
      {note && <span className="truncate text-meta text-fg-muted max-[1360px]:hidden">{note}</span>}
      <span className="flex-1" />
      {trailing}
    </div>
  );
}

function RelatedObject({ object: o, onOpen }: { object: InvolvedObject; onOpen?: () => void }) {
  const crashing = o.depth === 2 && o.marker && "health" in o.marker && o.marker.health === "failed";
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      style={{ paddingLeft: 6 + o.depth * 12 }}
      className="focus-ring grid h-[26px] grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-[5px] border-0 bg-transparent pr-1.5 text-left text-ui text-fg enabled:hover:bg-surface-hover disabled:cursor-default"
    >
      {"health" in o.marker ? (
        <StatusGlyph health={o.marker.health} />
      ) : o.marker.icon === "deployment" ? (
        <Layers className="size-3.5 text-fg-muted" aria-hidden />
      ) : (
        <FileText className="size-3.5 text-fg-muted" aria-hidden />
      )}
      <span className="truncate">
        <span className={cn("font-mono", o.muted && "text-fg-secondary")}>{o.name}</span>
        {crashing ? (
          <span className="ml-1.5 text-fg-muted">api ✕ · envoy ✓</span>
        ) : (
          o.kind && <span className="ml-1.5 text-fg-muted">{o.kind}</span>
        )}
      </span>
      <span className={cn("font-mono text-fg-muted", o.factTone && healthTone[o.factTone])}>{o.fact?.replace(" ↻", "↻")}</span>
    </button>
  );
}

function EvidenceCard({ evidence: e }: { evidence: Evidence }) {
  return (
    <article aria-label={`${e.id} ${e.title}`} className="flex flex-col rounded-lg border border-line bg-surface-panel">
      <div className="flex min-w-0 items-center gap-2 border-b border-line px-2.5 py-[7px] text-ui">
        <span className="font-mono text-[11px] font-semibold leading-none text-accent">{e.id}</span>
        <span className="shrink-0 rounded-[4px] px-[5px] py-[3px] font-mono text-[10px] font-semibold uppercase leading-none tracking-[.05em] text-fg-secondary shadow-[inset_0_0_0_1px_var(--line-strong)]">
          {e.source}
        </span>
        <span className="min-w-0 flex-1 truncate font-semibold">{e.title}</span>
        <span className={cn("shrink-0 truncate text-meta text-fg-muted", /^\d/.test(e.at) && "font-mono")}>{e.at}</span>
        {e.open && (
          <IconButton aria-label={e.open.label} title={e.open.label} onClick={e.open.run} className="size-[22px]">
            <ExternalLink aria-hidden />
          </IconButton>
        )}
      </div>
      <div className="flex flex-col gap-1.5 px-2.5 py-2 text-cell">{e.body}</div>
    </article>
  );
}

function Excerpt({ children }: { children: ReactNode }) {
  return (
    <div className="selectable overflow-x-auto whitespace-pre rounded-md bg-term-bg px-2 py-1.5 font-mono text-[11.5px] leading-[17px] text-term-fg">
      {children}
    </div>
  );
}

function PodStatusTable() {
  const rows = [
    ["…7d9f8b6c4-x2kqp", "14", "OOMKilled", "137", "11:59:02"],
    ["…7d9f8b6c4-m8vtn", "11", "OOMKilled", "137", "12:00:19"],
  ];
  const grid = "grid grid-cols-[minmax(0,1fr)_54px_92px_40px_64px] gap-x-2 py-[3px] text-ui";
  return (
    <div role="table" aria-label="Last termination per pod" className="-my-1">
      <div role="row" className={cn(grid, "text-fg-muted")}>
        {["Pod", "Restarts", "Reason", "Exit", "Finished"].map((h, i) => (
          <span key={h} role="columnheader" className={cn(i !== 0 && i !== 2 && "text-right")}>
            {h}
          </span>
        ))}
      </div>
      {rows.map(([pod, restarts, reason, exit, finished]) => (
        <div key={pod} role="row" className={grid}>
          <span role="cell" className="truncate font-mono">
            {pod}
          </span>
          <span role="cell" className="text-right font-mono text-status-critical">
            {restarts}
          </span>
          <span role="cell">{reason}</span>
          <span role="cell" className="text-right font-mono">
            {exit}
          </span>
          <span role="cell" className="text-right font-mono">
            {finished}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Restart times come from Events (kept ~1h by the API server); older restarts only exist as restartCount. */
function RestartLanes({ lanes }: { lanes: typeof checkoutInvestigation.lanes }) {
  const windowMin = 60;
  return (
    <div className="flex flex-col gap-0.5">
      {lanes
        .filter((l) => l.restarts.length > 0)
        .map((lane) => {
          const short = lane.pod.slice(-5);
          const oldest = Math.ceil(Math.max(...lane.restarts));
          return (
            <div key={lane.pod} className="grid h-5 grid-cols-[64px_minmax(0,1fr)] items-center gap-x-2">
              <span className="font-mono text-ui text-fg-muted">{short}</span>
              <svg
                viewBox="0 0 466 18"
                width="100%"
                height="18"
                preserveAspectRatio="none"
                role="img"
                aria-label={`${short}: ${lane.restarts.length} restarts in the last ${oldest} minutes`}
              >
                <line x1="0" y1="9" x2="466" y2="9" stroke="var(--line-strong)" vectorEffect="non-scaling-stroke" />
                {lane.restarts.map((ago) => (
                  <rect key={ago} x={((windowMin - ago) / windowMin) * 463} y="2" width="3" height="14" rx="1" fill="var(--status-critical)" />
                ))}
              </svg>
            </div>
          );
        })}
      <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-2">
        <span />
        <div className="flex justify-between font-mono text-2xs text-fg-muted">
          {["60m", "45m", "30m", "15m", "now"].map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      </div>
      <span className="pt-1 text-meta text-fg-muted">Restarts older than the Event TTL appear only in restartCount, without timestamps.</span>
    </div>
  );
}

/** Samples collected by Clustrail while it runs. metrics-server keeps no history, so nothing earlier is drawn. */
function MemoryChart() {
  return (
    <>
      <svg
        viewBox="0 0 560 64"
        width="100%"
        height="64"
        preserveAspectRatio="none"
        role="img"
        aria-label="Failing pods climb to the 256Mi limit and reset; healthy pods stay near 230Mi"
      >
        <line x1="0" y1="8" x2="560" y2="8" stroke="var(--status-critical)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        <path
          d="M0 40L60 26L95 12L98 54L160 34L196 14L199 54L262 33L300 12L303 54L364 34L400 13L403 54L466 34L500 13L503 54L560 40"
          fill="none"
          stroke="var(--status-critical)"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        <path d="M0 18L80 16L160 17L240 15L320 16L400 15L480 16L560 15" fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <line x1="0" y1="63.5" x2="560" y2="63.5" stroke="var(--line)" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex flex-wrap items-center gap-3.5 text-meta text-fg-muted">
        <Legend swatch="w-3 border-t-[1.5px] border-dashed border-status-critical" label="limit 256Mi" />
        <Legend swatch="h-0.5 w-3 bg-status-critical" label="x2kqp, m8vtn" />
        <Legend swatch="h-0.5 w-3 bg-accent" label="9rkzd 231Mi, h2pqs 226Mi" />
      </div>
    </>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <i className={swatch} aria-hidden />
      {label}
    </span>
  );
}

function Timeline() {
  return (
    <div className="flex flex-col">
      {checkoutInvestigation.timeline.map((t) =>
        t.kind === "rollout" ? (
          <div
            key={t.id}
            className="grid grid-cols-[54px_14px_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-md border-t border-line-row bg-surface-panel px-2.5 py-2 text-cell"
          >
            <span className="font-mono text-meta text-fg-muted">{t.ago}</span>
            <Layers className="mt-px size-3.5 text-accent" aria-hidden />
            <span className="flex flex-col gap-[3px]">
              <span>
                <b className="font-semibold">{t.title}</b> <span className="text-fg-secondary">{t.detail}</span>
              </span>
              {t.note && <span className="text-ui text-fg-muted">{t.note}</span>}
            </span>
            <Button size="sm" disabled title="Revision diffs open from the Deployment's history.">
              <Diff aria-hidden />
              rev 13 → 14
            </Button>
          </div>
        ) : (
          <div key={t.id} className="grid grid-cols-[54px_14px_minmax(0,1fr)_auto] items-start gap-x-2.5 border-t border-line-row px-2.5 py-2 text-cell first:border-t-0">
            <span className="font-mono text-meta text-fg-muted">{t.ago}</span>
            <StatusGlyph health={t.kind} className="mt-[3px]" />
            <span className="selectable">
              <b className="font-semibold">{t.title}</b> <span className="text-fg-secondary">{t.detail}</span>
            </span>
            <span className="whitespace-nowrap font-mono text-label text-fg-muted">{t.scope}</span>
          </div>
        ),
      )}
    </div>
  );
}

const STATUS_PILL: Record<Hypothesis["status"], string> = {
  Supported: "bg-accent-soft text-accent",
  Open: "bg-surface-hover text-fg-secondary",
  Refuted: "bg-surface-hover text-fg-muted line-through",
};

function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("rounded-[4px] px-1.5 py-px font-mono text-label font-medium", className ?? "bg-surface-hover text-fg-secondary")}>{children}</span>;
}

function HypothesisCard({
  hypothesis: h,
  evidenceIds,
  onChange,
  onRemove,
}: {
  hypothesis: Hypothesis;
  evidenceIds: string[];
  onChange: (h: Hypothesis) => void;
  onRemove: () => void;
}) {
  return (
    <div className="group flex flex-col gap-[7px] rounded-lg border border-dashed border-line-strong p-2.5 text-cell">
      <div className="flex items-center gap-2">
        <Lightbulb className="size-3.5 text-fg-muted" aria-hidden />
        <span className="font-mono text-[11px] font-semibold leading-none text-accent">{h.id}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={`Status: ${h.status}`} className="focus-ring rounded-[4px] border-0 bg-transparent p-0">
              <Pill className={STATUS_PILL[h.status]}>{h.status}</Pill>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={h.status} onValueChange={(v) => onChange({ ...h, status: v as Hypothesis["status"] })}>
              {(["Open", "Supported", "Refuted"] as const).map((s) => (
                <DropdownMenuRadioItem key={s} value={s}>
                  {s}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="flex-1" />
        <span className="text-meta text-fg-muted">
          {h.author} · {h.at}
        </span>
        <IconButton aria-label={`Remove ${h.id}`} onClick={onRemove} className="size-5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          <X aria-hidden />
        </IconButton>
      </div>
      <span className="selectable">{h.text}</span>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-meta text-fg-muted">Evidence</span>
        {h.evidence.length === 0 && <span className="text-meta text-fg-muted">none linked</span>}
        {h.evidence.map((id) => (
          <Pill key={id}>{id}</Pill>
        ))}
        <span className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost">
              <Link2 aria-hidden />
              Link
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Evidence for {h.id}</DropdownMenuLabel>
            {evidenceIds.map((id) => (
              <DropdownMenuCheckboxItem
                key={id}
                checked={h.evidence.includes(id)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(on) =>
                  onChange({ ...h, evidence: on ? [...h.evidence, id].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))) : h.evidence.filter((x) => x !== id) })
                }
              >
                {id}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

const textareaClass =
  "resize-none rounded-lg border border-line-strong bg-surface-app px-2.5 py-2 text-cell leading-normal text-fg outline-none placeholder:text-fg-muted focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]";

function AddHypothesis({ onAdd }: { onAdd: (text: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft?.trim()) onAdd(draft.trim());
    setDraft(null);
  };
  if (draft === null)
    return (
      <Button size="sm" variant="ghost" className="self-start" onClick={() => setDraft("")}>
        <Plus aria-hidden />
        Add hypothesis
      </Button>
    );
  return (
    <div className="flex flex-col gap-1.5">
      <label className="sr-only" htmlFor="inv-hypothesis">
        Hypothesis
      </label>
      <textarea
        id="inv-hypothesis"
        autoFocus
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          if (e.key === "Escape") setDraft(null);
        }}
        placeholder="What might explain the symptoms? Link evidence after saving."
        className={textareaClass}
      />
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={save}>
          Add
        </Button>
      </div>
    </div>
  );
}

function Notes({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex flex-col pt-1">
      <div className="flex items-center pb-1">
        <span className="section-label flex-1">Notes</span>
        <span className="text-meta text-fg-muted">Markdown</span>
      </div>
      {editing ? (
        <textarea
          aria-label="Notes"
          autoFocus
          rows={Math.max(4, value.split("\n").length + 1)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
          className={cn(textareaClass, "font-mono text-ui")}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="Edit notes"
          className="focus-ring selectable rounded-lg border border-line-strong bg-surface-app px-2.5 py-[9px] text-left text-cell leading-normal text-fg"
        >
          {value.trim() ? (
            value.split("\n").map((line, i) => {
              const m = line.match(/^(\d{1,2}:\d{2})\s+(.*)$/);
              return (
                <span key={i} className="block">
                  {m ? (
                    <>
                      <span className="font-mono text-meta text-fg-muted">{m[1]}</span> {m[2]}
                    </>
                  ) : (
                    line || " "
                  )}
                </span>
              );
            })
          ) : (
            <span className="text-fg-muted">What did you check or decide?</span>
          )}
        </button>
      )}
    </div>
  );
}

function NextSteps({
  done,
  onToggle,
  onCompare,
  onSource,
}: {
  done: string[];
  onToggle: (id: string, on: boolean) => void;
  onCompare: () => void;
  onSource: () => void;
}) {
  return (
    <div className="flex flex-col pt-1">
      <div className="flex items-center pb-1">
        <span className="section-label flex-1">Next steps</span>
        <span className="font-mono text-label text-fg-muted">
          {done.length} of {steps.length}
        </span>
      </div>
      {steps.map((s, i) => {
        const isDone = done.includes(s.id);
        return (
          <div key={s.id} className={cn("grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-2 py-1.5 text-cell", i > 0 && "border-t border-line-row")}>
            <Checkbox checked={isDone} onCheckedChange={(on) => onToggle(s.id, on === true)} aria-label={isDone ? `Mark "${s.text}" not done` : `Mark "${s.text}" done`} />
            <span className={cn(isDone && "text-fg-muted line-through")}>{s.text}</span>
            {s.action === "compare" ? (
              <Button size="sm" onClick={onCompare}>
                <ArrowLeftRight aria-hidden />
                Compare
              </Button>
            ) : s.action === "source" ? (
              <Button size="sm" onClick={onSource}>
                <GitBranch aria-hidden />
                Source
              </Button>
            ) : (
              <span />
            )}
          </div>
        );
      })}
      <span className="pt-1.5 text-meta text-fg-muted">First two are standard checks Clustrail offers for OOMKilled containers; edit or remove freely.</span>
    </div>
  );
}

function summaryMarkdown({
  status,
  evidence,
  hypotheses,
  notes,
  done,
}: {
  status: InvStatus;
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  notes: string;
  done: string[];
}) {
  const inv = checkoutInvestigation;
  const t = inv.target;
  return [
    `# ${inv.title}`,
    `${t.kind}/${t.name} · ${t.namespace} · ${t.cluster} · status: ${status}`,
    "",
    "## Observed symptoms",
    ...symptoms.map((s) => `- ${s.plain} (${s.fact})`),
    "",
    "## Evidence (captured from the cluster)",
    ...evidence.map((e) => `- **${e.id}** [${e.source}] ${e.title} — ${e.plain}`),
    "",
    "## Hypotheses",
    ...hypotheses.map((h) => `- **${h.id}** (${h.status}) ${h.text}${h.evidence.length ? ` — evidence: ${h.evidence.join(", ")}` : ""}`),
    "",
    "## Notes",
    notes,
    "",
    "## Next steps",
    ...steps.map((s) => `- [${done.includes(s.id) ? "x" : " "}] ${s.text}`),
    "",
    "_Facts are from the Kubernetes API and metrics-server; hypotheses and notes are written by people._",
  ].join("\n");
}
