import { useState, type ReactNode } from "react";
import {
  Activity,
  ArrowLeftRight,
  Check,
  Copy,
  Diff,
  FileText,
  Layers,
  Lock,
  Plus,
  RotateCcw,
  Route,
  ScrollText,
  StickyNote,
} from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { usePersistentState } from "@/app/preferences";
import { checkoutInvestigation, type Investigation, type InvolvedObject, type NextCheck } from "@/data/investigation";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Segmented } from "@/components/ui/segmented";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph, healthTone } from "@/components/status/StatusGlyph";
import { ModifyMenuButton } from "@/components/resource-actions/ResourceActions";
import { useConfirm } from "@/components/safety/ConfirmationDialog";
import { restartDeploymentRequest } from "@/features/deployments/requests";
import { cn } from "@/lib/cn";

type Range = "15m" | "1h" | "6h" | "3d";
const RANGE_MINUTES: Record<Range, number> = { "15m": 15, "1h": 60, "6h": 360, "3d": 4320 };
/** Default Event TTL of the API server; restart history older than this comes only from restartCount. */
const EVENT_RETENTION_MINUTES = 60;

interface Note {
  id: string;
  at: string;
  text: string;
}

export function InvestigationWorkspace() {
  const inv = checkoutInvestigation;
  const { clusterById, deployments, restartDeployment, pins } = useWorkspace();
  const { confirm } = useConfirm();
  const cluster = clusterById(inv.target.cluster);
  const deployment = deployments.find((d) => d.cluster === inv.target.cluster && d.name === inv.target.name);

  const [done, setDone] = usePersistentState<string[]>(`investigation.${inv.id}.done`, inv.initiallyDone);
  const [notes, setNotes] = usePersistentState<Note[]>(`investigation.${inv.id}.notes`, []);
  const [selectedObject, setSelectedObject] = useState("x2kqp");
  const [range, setRange] = useState<Range>("1h");
  const [warningsOnly, setWarningsOnly] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copySummary = () => {
    void navigator.clipboard?.writeText(summaryMarkdown(inv, done, notes)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const saveNote = () => {
    if (!draft?.trim()) return setDraft(null);
    setNotes([{ id: crypto.randomUUID(), at: new Date().toISOString(), text: draft.trim() }, ...notes]);
    setDraft(null);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-start gap-4 border-b border-line px-[18px] pb-3 pt-3.5">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-2 text-ui text-fg-muted">
            <Route className="size-3.5" aria-hidden />
            Investigation<span>·</span>
            <span>opened {inv.openedAgo} ago by you</span>
          </div>
          <h1 className="m-0 text-heading font-semibold tracking-[-.01em]">{inv.title}</h1>
          <div className="flex flex-wrap items-center gap-2 text-cell text-fg-secondary">
            <Layers className="size-3.5" aria-hidden />
            <span className="font-mono">
              {inv.target.kind}/{inv.target.name}
            </span>
            <span>·</span>
            <span>{inv.target.namespace}</span>
            <span>·</span>
            <span>{inv.target.cluster}</span>
            {cluster && <EnvironmentBadge env={cluster.env} />}
            {cluster?.protected && (
              <span className="flex items-center gap-1.5 text-ui text-env-prod-ink">
                <Lock className="size-3" aria-hidden />
                Protected
              </span>
            )}
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 pt-[18px]">
          <Button onClick={copySummary}>
            {copied ? <Check className="text-status-healthy" aria-hidden /> : <Copy aria-hidden />}
            {copied ? "Copied" : "Copy summary"}
          </Button>
          <Button onClick={() => setDraft(draft ?? "")}>
            <StickyNote aria-hidden />
            Add note
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
                  onSelect: () =>
                    confirm(restartDeploymentRequest(deployment, cluster, () => restartDeployment(deployment.id))),
                },
              ]}
            />
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <InvolvedObjects objects={inv.objects} selected={selectedObject} onSelect={setSelectedObject} />

        {/* Restarts and timeline */}
        <section aria-label="Timeline" className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-[18px] py-3.5">
          <div className="flex items-center gap-2">
            <span className="section-label">Restarts per pod</span>
            <div className="flex-1" />
            <Segmented<Range>
              aria-label="Time range"
              value={range}
              onValueChange={setRange}
              options={(["15m", "1h", "6h", "3d"] as const).map((r) => ({ value: r, label: r }))}
            />
          </div>
          <RestartLanes lanes={inv.lanes} range={range} highlight={selectedObject} />

          <div className="flex items-center gap-2 pt-1">
            <span className="section-label">Timeline</span>
            <span className="text-meta text-fg-muted">Events + status changes across involved objects</span>
            <div className="flex-1" />
            <Button size="sm" aria-pressed={warningsOnly} onClick={() => setWarningsOnly(!warningsOnly)} className={cn(warningsOnly && "border-line-selected bg-accent-soft")}>
              <StatusGlyph health="warning" />
              Warnings only
            </Button>
          </div>
          <div className="flex flex-col">
            {inv.timeline
              .filter((t) => !warningsOnly || t.kind !== "rollout")
              .map((t) =>
                t.kind === "rollout" ? (
                  <div
                    key={t.id}
                    className="-mx-2.5 grid grid-cols-[54px_14px_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-md border-t border-line-row bg-surface-panel px-2.5 py-2 text-cell"
                  >
                    <span className="font-mono text-meta text-fg-muted">{t.ago}</span>
                    <Layers className="mt-px size-3.5 text-accent" aria-hidden />
                    <span className="flex flex-col gap-[3px]">
                      <span>
                        <b className="font-semibold">{t.title}</b> <span className="text-fg-secondary">{t.detail}</span>
                      </span>
                      {t.note && <span className="text-ui text-fg-muted">{t.note}</span>}
                    </span>
                    <Button size="sm" disabled title="The YAML diff view is not implemented in this build.">
                      <Diff aria-hidden />
                      Diff rev 13 → 14
                    </Button>
                  </div>
                ) : (
                  <div
                    key={t.id}
                    className="grid grid-cols-[54px_14px_minmax(0,1fr)_auto] items-start gap-x-2.5 border-t border-line-row py-2 text-cell first:border-t-0"
                  >
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
        </section>

        {/* Observations and checks */}
        <section
          aria-label="Observations and next checks"
          className="flex w-[380px] shrink-0 flex-col overflow-y-auto border-l border-line bg-surface-panel px-4 py-3.5"
        >
          {(draft !== null || notes.length > 0 || pins.length > 0) && (
            <div className="flex flex-col gap-2 pb-3.5">
              <span className="section-label">Notes</span>
              {draft !== null && (
                <div className="flex flex-col gap-1.5">
                  <label className="sr-only" htmlFor="inv-note">
                    Note
                  </label>
                  <textarea
                    id="inv-note"
                    autoFocus
                    rows={3}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveNote();
                      if (e.key === "Escape") setDraft(null);
                    }}
                    placeholder="What did you check or decide?"
                    className="resize-none rounded-md border border-line-strong bg-surface-app px-2 py-1.5 text-cell text-fg outline-none placeholder:text-fg-muted focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
                  />
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="primary" onClick={saveNote}>
                      Save note
                    </Button>
                  </div>
                </div>
              )}
              {pins.map((p) => (
                <div key={p.id} className="flex flex-col gap-[5px] border-t border-line-row pt-2 text-cell first:border-t-0">
                  <span className="selectable truncate font-mono text-ui" title={p.text}>
                    {p.text}
                  </span>
                  <span className="font-mono text-label text-fg-muted">
                    Pinned · {p.source} · {p.cluster} · {new Date(p.at).toLocaleTimeString()}
                  </span>
                </div>
              ))}
              {notes.map((n) => (
                <div key={n.id} className="flex flex-col gap-[5px] border-t border-line-row pt-2 text-cell first:border-t-0">
                  <span className="selectable whitespace-pre-wrap">{n.text}</span>
                  <span className="font-mono text-label text-fg-muted">Note · you · {new Date(n.at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-baseline justify-between">
            <span className="section-label">Observations</span>
            <span className="text-meta text-fg-muted">from the Kubernetes API</span>
          </div>
          {inv.observations.map((o, i) => (
            <div key={o.id} className={cn("flex flex-col gap-[5px] py-2.5 text-cell", i > 0 && "border-t border-line-row")}>
              {o.warning ? (
                <span className="flex gap-2">
                  <StatusGlyph health="warning" className="mt-[3px]" />
                  <span>{o.text}</span>
                </span>
              ) : (
                <span>{o.text}</span>
              )}
              <span className="font-mono text-label text-fg-muted">{o.source}</span>
            </div>
          ))}

          <div className="flex items-baseline justify-between pt-3.5">
            <span className="section-label">Next checks</span>
            <span className="font-mono text-label text-fg-muted">
              {done.length} of {inv.checks.length}
            </span>
          </div>
          {inv.checks.map((c, i) => (
            <CheckRow
              key={c.id}
              check={c}
              first={i === 0}
              done={done.includes(c.id)}
              onToggle={(on) => setDone(on ? [...done, c.id] : done.filter((d) => d !== c.id))}
            />
          ))}
          <div className="flex-1" />
          <p className="m-0 mt-3 border-t border-line pt-2.5 text-meta text-fg-muted">
            Observations list what the cluster reports. Clustrail does not assert a root cause.
          </p>
        </section>
      </div>
    </div>
  );
}

function InvolvedObjects({
  objects,
  selected,
  onSelect,
}: {
  objects: InvolvedObject[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section aria-label="Involved objects" className="flex w-[330px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line px-2.5 py-3.5">
      <div className="flex justify-between px-2 pb-1.5">
        <span className="section-label">Involved objects</span>
        <span className="font-mono text-label text-fg-muted">{objects.length}</span>
      </div>
      <div role="listbox" aria-label="Involved objects" className="flex flex-col gap-0.5">
        {objects.map((o, i) => {
          const sep = o.depth === 0 && i > 0 && objects[i - 1]!.depth > 0;
          return (
            <div key={o.id} className="contents">
              {sep && <div className="mx-2 my-2 h-px bg-line" role="presentation" />}
              <button
                type="button"
                role="option"
                aria-selected={o.id === selected}
                onClick={() => onSelect(o.id)}
                style={{ paddingLeft: 8 + o.depth * 14 }}
                className={cn(
                  "focus-ring grid h-[30px] grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md border-0 bg-transparent pr-2 text-left text-cell text-fg hover:bg-surface-hover",
                  o.id === selected && "bg-surface-selected shadow-[inset_0_0_0_1px_var(--line-selected)] hover:bg-surface-selected",
                )}
              >
                {"health" in o.marker ? (
                  <StatusGlyph health={o.marker.health} />
                ) : o.marker.icon === "deployment" ? (
                  <Layers className="size-3.5 text-fg-muted" aria-hidden />
                ) : (
                  <FileText className="size-3.5 text-fg-muted" aria-hidden />
                )}
                <span className={cn("truncate", o.muted && "text-fg-secondary")}>
                  <span className="font-mono">{o.name}</span>
                  {o.kind && <span className="ml-1.5 text-label text-fg-muted">{o.kind}</span>}
                </span>
                <span className={cn("font-mono text-ui text-fg-muted", o.factTone && healthTone[o.factTone])}>{o.fact}</span>
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex-1" />
      <Button
        variant="ghost"
        disabled
        title="Adding objects is not implemented in this build."
        className="justify-start text-fg-muted disabled:opacity-70"
      >
        <Plus aria-hidden />
        Add object to investigation
      </Button>
    </section>
  );
}

function RestartLanes({ lanes, range, highlight }: { lanes: Investigation["lanes"]; range: Range; highlight: string }) {
  const minutes = RANGE_MINUTES[range];
  const ticks = [minutes, (minutes * 3) / 4, minutes / 2, minutes / 4, 0];
  return (
    <div className="flex flex-col gap-0.5">
      {lanes.map((lane) => {
        const inRange = lane.restarts.filter((r) => r <= minutes);
        const active = lane.pod.endsWith(highlight);
        return (
          <div key={lane.pod} className="grid h-6 grid-cols-[184px_minmax(0,1fr)] items-center gap-x-2.5">
            <span className={cn("truncate font-mono text-ui", lane.restarts.length === 0 && "text-fg-secondary", active && "font-semibold text-fg")}>
              {lane.pod}
            </span>
            <svg
              viewBox="0 0 1000 20"
              width="100%"
              height="20"
              preserveAspectRatio="none"
              role="img"
              aria-label={`${lane.pod}: ${inRange.length === 0 ? "no restarts" : `${inRange.length} restarts`} in the last ${range}`}
            >
              <line x1="0" y1="10" x2="1000" y2="10" stroke="var(--line-strong)" vectorEffect="non-scaling-stroke" />
              {inRange.map((ago) => (
                <rect key={ago} x={((minutes - ago) / minutes) * 993} y="3" width="6.4" height="14" rx="1" fill="var(--status-critical)" />
              ))}
            </svg>
          </div>
        );
      })}
      <div className="grid h-[18px] grid-cols-[184px_minmax(0,1fr)] gap-x-2.5">
        <span />
        <div className="flex justify-between font-mono text-2xs text-fg-muted">
          {ticks.map((t, i) => (
            <span key={i}>{i === 0 ? `${tickLabel(t)} ago` : t === 0 ? "now" : tickLabel(t)}</span>
          ))}
        </div>
      </div>
      {minutes > EVENT_RETENTION_MINUTES && (
        <p className="m-0 text-meta text-fg-muted">
          Restart times come from Events, which the API server keeps for about 1 hour by default. Earlier restarts are
          counted in restartCount but have no time.
        </p>
      )}
    </div>
  );
}

function tickLabel(min: number) {
  if (min >= 1440) return `${+(min / 1440).toFixed(1)}d`;
  if (min >= 60) return `${+(min / 60).toFixed(1)}h`;
  return `${+min.toFixed(1)}m`;
}

function CheckRow({ check, done, first, onToggle }: { check: NextCheck; done: boolean; first: boolean; onToggle: (on: boolean) => void }) {
  const action: Record<NonNullable<NextCheck["action"]>, { label: string; icon: ReactNode }> = {
    "previous-logs": { label: "Previous", icon: <ScrollText aria-hidden /> },
    metrics: { label: "Metrics", icon: <Activity aria-hidden /> },
    compare: { label: "Compare", icon: <ArrowLeftRight aria-hidden /> },
  };
  const a = check.action ? action[check.action] : null;
  return (
    <div className={cn("grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2 py-2 text-cell", !first && "border-t border-line-row")}>
      <Checkbox checked={done} onCheckedChange={onToggle} aria-label={done ? "Mark not done" : "Mark done"} />
      <span className={cn(done && "text-fg-muted line-through")}>{check.text}</span>
      {a && (
        <Button size="sm" disabled title="Not implemented in this build.">
          {a.icon}
          {a.label}
        </Button>
      )}
    </div>
  );
}

function summaryMarkdown(inv: Investigation, done: string[], notes: Note[]) {
  const t = inv.target;
  const lines = [
    `## ${inv.title}`,
    `${t.kind}/${t.name} · ${t.namespace} · ${t.cluster}`,
    "",
    "### Observations (from the Kubernetes API)",
    ...inv.observations.map((o) => `- ${o.plain} _(${o.source})_`),
    "",
    "### Timeline",
    ...inv.timeline.map((e) => `- ${e.ago}: ${e.title} — ${e.plain}${e.scope ? ` (${e.scope})` : ""}`),
    "",
    "### Next checks",
    ...inv.checks.map((c) => `- [${done.includes(c.id) ? "x" : " "}] ${c.plain}`),
  ];
  if (notes.length > 0) lines.push("", "### Notes", ...notes.map((n) => `- ${n.text} (${n.at})`));
  return lines.join("\n");
}
