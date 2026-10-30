import { useState, type ReactNode } from "react";
import { AlertDialog } from "radix-ui";
import { Check, ChevronDown, Copy, Filter, X } from "lucide-react";
import type { Cluster } from "@/data/types";
import type { DrainPreflight, NodeRow } from "@/data/nodes";
import { useDrainPreflight } from "@/backend/hooks";
import { Button, IconButton } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TextField } from "@/components/ui/text-field";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { cn } from "@/lib/cn";
import { t, tn } from "@/i18n";

/**
 * Drain preflight: what happens to every pod before anything runs. The
 * options are named by their consequence and update the equivalent command.
 */
export function DrainDialog({
  node,
  cluster,
  onCancel,
  onDrain,
}: {
  node: NodeRow;
  cluster: Cluster | undefined;
  onCancel: () => void;
  onDrain: (opts: { force: boolean; deleteEmptyDir: boolean; timeoutSec: number }) => void;
}) {
  const loaded = useDrainPreflight(node);
  // While the backend checks the node's pods, the dialog shows zeros and cannot drain.
  const pf: DrainPreflight = loaded ?? {
    evict: 0,
    pdbBlocked: { pods: [], pdb: "" },
    emptyDir: [],
    unmanaged: [],
    daemonSets: [],
    freeAfter: { cpu: 0, memGiB: 0, nodes: 0 },
    evictedRequests: { cpu: 0, memGiB: 0 },
  };
  const short = node.name.split(".")[0]!;
  const typed = cluster?.protected || node.env === "prod";
  const [deleteEmptyDir, setDeleteEmptyDir] = useState(false);
  const [force, setForce] = useState(false);
  const [timeout, setTimeoutText] = useState("5m");
  const [phrase, setPhrase] = useState("");
  const [copied, setCopied] = useState(false);

  const timeoutSec = parseDuration(timeout);
  const blockers = [
    pf.unmanaged.length > 0 && !force ? `${pf.unmanaged.length} pod without a controller (needs Force)` : null,
    pf.emptyDir.length > 0 && !deleteEmptyDir ? `${pf.emptyDir.length} pod with emptyDir data (needs Delete emptyDir data)` : null,
  ].filter(Boolean);
  const command = [
    `kubectl --context ${node.cluster} drain ${node.name} --ignore-daemonsets`,
    deleteEmptyDir && "--delete-emptydir-data",
    force && "--force",
    timeoutSec ? `--timeout=${timeout}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const ready = loaded !== null && blockers.length === 0 && timeoutSec !== null && (!typed || phrase.trim() === short);
  const decisions = [
    ...pf.pdbBlocked.pods.map((p) => ({ pod: p, owner: "ReplicaSet", result: "Blocked · PDB", tone: "warning" as const })),
    ...pf.emptyDir.map((e) => ({ pod: e.pod, owner: "ReplicaSet", result: deleteEmptyDir ? t("Evicted · data lost") : t("Needs emptyDir option"), tone: "warning" as const })),
    ...pf.unmanaged.map((p) => ({ pod: p, owner: "none", result: force ? t("Deleted · not recreated") : "Needs Force", tone: "failed" as const })),
  ];
  const total = pf.evict + pf.pdbBlocked.pods.length + pf.emptyDir.length + pf.unmanaged.length + pf.daemonSets.length;

  return (
    <AlertDialog.Root open onOpenChange={(o) => !o && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <AlertDialog.Content className="fixed left-1/2 top-6 z-50 flex max-h-[calc(100vh-48px)] w-[720px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line-strong bg-surface-elevated text-fg shadow-dialog">
          {typed && <div className="hatch-prod h-1 shrink-0 opacity-90" aria-hidden />}
          <div className="flex items-start gap-3.5 px-5 pt-4">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-env-prod-soft text-env-prod-ink">
              <Filter className="size-[18px]" aria-hidden />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
              <AlertDialog.Title className="m-0 text-[16px] font-semibold">{tn("Drain node {short}?", { short: <span className="font-mono">{short}</span> })}</AlertDialog.Title>
              <AlertDialog.Description asChild>
                <div className="flex flex-wrap items-center gap-2 text-cell text-fg-muted">
                  <EnvironmentBadge env={node.env} />
                  <span className="font-mono text-fg-secondary">{node.cluster}</span>
                  <span>·</span>
                  <span>
                    {node.instanceType} · {node.zone}
                  </span>
                  {node.health === "cordoned" && (
                    <>
                      <span>·</span>
                      <span className="flex items-center gap-1 text-status-progressing">
                        <StatusGlyph health="cordoned" />{t("already cordoned")}</span>
                    </>
                  )}
                </div>
              </AlertDialog.Description>
            </div>
            <AlertDialog.Cancel asChild>
              <IconButton aria-label={t("Close")}>
                <X />
              </IconButton>
            </AlertDialog.Cancel>
          </div>

          <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-5 py-3.5">
            <section className="flex flex-col">
              <div className="flex items-center pb-1.5">
                <span className="section-label flex-1">{t("Preflight · {total} pods on this node", { total })}</span>
                <span className="text-meta text-fg-muted">{t("checked just now")}</span>
              </div>
              <Pre glyph="completed" count={pf.evict} first>{tn("will be {evicted} and recreated by their controllers on other nodes.", { evicted: <b className="font-semibold">{t("evicted")}</b> })}</Pre>
              {pf.pdbBlocked.pods.length > 0 && (
                <Pre glyph="warning" count={pf.pdbBlocked.pods.length}>
                  {tn("{blocked} {pdb} (0 disruptions allowed). Drain retries these until the timeout; it will not finish while {name} is degraded.", {
                    blocked: <b className="font-semibold">{t("Blocked by PodDisruptionBudget")}</b>,
                    pdb: <span className="font-mono">{pf.pdbBlocked.pdb}</span>,
                    name: pf.pdbBlocked.pdb,
                  })}
                </Pre>
              )}
              {pf.emptyDir.map((e) => (
                <Pre key={e.pod} glyph="warning" count={1}>
                  {tn("{label} — {pod} has a {size} volume that will be lost.", {
                    label: <b className="font-semibold">{t("Uses emptyDir")}</b>,
                    pod: <span className="font-mono">{e.pod.split("/")[1]}</span>,
                    size: e.size,
                  })}
                </Pre>
              ))}
              {pf.unmanaged.length > 0 && (
                <Pre glyph="failed" count={pf.unmanaged.length}>
                  {tn("{label} — {pods} will be deleted permanently and not recreated.", {
                    label: <b className="font-semibold">{t("Not managed by a controller")}</b>,
                    pods: <span className="font-mono">{pf.unmanaged.join(", ")}</span>,
                  })}
                </Pre>
              )}
              <Pre glyph="idle" count={pf.daemonSets.length} muted>{t("DaemonSet pods are left in place ({v0}).", { v0: pf.daemonSets.join(", ") })}</Pre>
            </section>

            {decisions.length > 0 && (
              <details className="group shrink-0 overflow-hidden rounded-lg border border-line text-ui">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-[7px] text-fg-secondary">
                  <ChevronDown className="size-3.5 -rotate-90 transition-transform group-open:rotate-0" aria-hidden />{tn("Pods that need a decision{v0}", { v0: <span className="font-mono text-label text-fg-muted">
                    {decisions.length}{" "}{t("of")}{" "}{total}
                  </span> })}
                </summary>
                <div className="grid h-[26px] grid-cols-[minmax(0,1fr)_110px_160px] items-center gap-x-2.5 border-t border-line-row px-2.5 text-label text-fg-muted">
                  <span>{t("Pod")}</span>
                  <span>{t("Owner")}</span>
                  <span>{t("Result")}</span>
                </div>
                {decisions.map((d) => (
                  <div key={d.pod} className="grid h-[26px] grid-cols-[minmax(0,1fr)_110px_160px] items-center gap-x-2.5 border-t border-line-row px-2.5">
                    <span className="truncate font-mono">{d.pod}</span>
                    <span className={cn("truncate", d.owner === "none" ? "text-fg-muted" : "text-fg-secondary")}>{d.owner}</span>
                    <span className={d.tone === "failed" ? "text-status-critical" : "text-status-warning"}>{d.result}</span>
                  </div>
                ))}
              </details>
            )}

            <section className="flex flex-col gap-2">
              <div className="section-label">{t("Options")}</div>
              <Opt checked disabled label={t("Leave DaemonSet pods")} note={t("(required to drain)")} />
              {pf.emptyDir.length > 0 && (
                <Opt
                  checked={deleteEmptyDir}
                  onChange={setDeleteEmptyDir}
                  label={t("Delete emptyDir data")}
                  note={t("— {length} pod loses its local data", { length: pf.emptyDir.length })}
                />
              )}
              {pf.unmanaged.length > 0 && (
                <Opt
                  checked={force}
                  onChange={setForce}
                  label={t("Force — delete pods without a controller")}
                  note={t("— {length} pod is gone for good", { length: pf.unmanaged.length })}
                />
              )}
              <div className="flex items-end gap-4">
                <TextField label={t("Timeout")} value={timeout} onChange={(e) => setTimeoutText(e.target.value)} mono className="w-[96px]" error={timeoutSec === null ? "e.g. 5m" : undefined} />
                <span className="pb-1.5 text-ui text-fg-muted">{t("Grace period: pod default")}</span>
              </div>
            </section>

            <div className="flex gap-2.5 rounded-lg bg-status-healthy-soft px-2.5 py-2.5 text-cell">
              <StatusGlyph health="completed" className="mt-0.5 text-status-healthy" />
              <span>{tn("Remaining {nodes} Ready nodes have {v1} and {v2} unrequested — more than the evicted pods request ({v3}, {v4}). Based on requests, not usage.", { nodes: pf.freeAfter.nodes, v1: <span className="font-mono">{pf.freeAfter.cpu}{" "}{t("cores")}</span>, v2: <span className="font-mono">{pf.freeAfter.memGiB} GiB</span>, v3: <span className="font-mono">{pf.evictedRequests.cpu}{" "}{t("cores")}</span>, v4: <span className="font-mono">{pf.evictedRequests.memGiB} GiB</span> })}</span>
            </div>

            <div className="flex items-center gap-2 rounded-md border border-line bg-surface-app py-[7px] pl-2.5 pr-1.5">
              <code className="selectable min-w-0 flex-1 truncate font-mono text-ui text-fg-secondary" title={command}>
                {command}
              </code>
              <IconButton
                aria-label={copied ? t("Copied") : t("Copy command")}
                className="size-6 [&_svg]:size-3.5"
                onClick={() =>
                  void navigator.clipboard?.writeText(command).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  })
                }
              >
                {copied ? <Check /> : <Copy />}
              </IconButton>
            </div>

            {typed && (
              <TextField
                size="lg"
                mono
                autoComplete="off"
                label={
                  <>
                    {tn("{cluster} is protected. Type {short} to confirm", { cluster: node.cluster, short: <span className="font-mono font-semibold text-fg">{short}</span> })}</>
                }
                placeholder={short}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                trailing={phrase.trim() === short ? <Check className="size-3.5 text-status-healthy" aria-label={t("Matches")} /> : undefined}
              />
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-line bg-surface-panel px-5 py-3">
            <span className="text-meta leading-[1.4] text-fg-muted">
              {blockers.length > 0
                ? t("kubectl stops at: {v0}.", { v0: blockers.join("; ") })
                : t("Runs in the background. Cancel stops further evictions; the node stays cordoned.")}
            </span>
            <div className="flex-1" />
            <AlertDialog.Cancel asChild>
              <Button size="lg">{t("Cancel")}</Button>
            </AlertDialog.Cancel>
            <Button
              size="lg"
              variant="danger"
              disabled={!ready}
              onClick={() => onDrain({ force, deleteEmptyDir, timeoutSec: timeoutSec ?? 300 })}
            >
              <Filter aria-hidden />{t("Drain node")}</Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function Pre({ glyph, count, children, first, muted }: { glyph: "completed" | "warning" | "failed" | "idle"; count: number; children: ReactNode; first?: boolean; muted?: boolean }) {
  return (
    <div className={cn("grid grid-cols-[16px_34px_minmax(0,1fr)] items-start gap-x-2 py-[7px] text-cell", !first && "border-t border-line-row")}>
      <StatusGlyph health={glyph} className="mt-[3px]" />
      <span
        className={cn(
          "font-mono font-semibold",
          glyph === "warning" && "text-status-warning",
          glyph === "failed" && "text-status-critical",
          glyph === "idle" && "text-fg-muted",
        )}
      >
        {count}
      </span>
      <span className={muted ? "text-fg-secondary" : undefined}>{children}</span>
    </div>
  );
}

function Opt({ checked, onChange, disabled, label, note }: { checked: boolean; onChange?: (v: boolean) => void; disabled?: boolean; label: string; note: string }) {
  return (
    <label className={cn("flex items-start gap-2.5 text-cell", disabled ? "cursor-default" : "cursor-pointer")}>
      <Checkbox checked={checked} onCheckedChange={(v) => !disabled && onChange?.(v)} aria-label={label} className={cn("mt-0.5", disabled && "opacity-60")} />
      <span>
        {label} <span className="text-meta text-fg-muted">{note}</span>
      </span>
    </label>
  );
}

/** "5m", "90s", "1h" → seconds. */
function parseDuration(text: string): number | null {
  const m = text.trim().match(/^(\d+)(s|m|h)$/);
  if (!m) return null;
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] as "s" | "m" | "h"];
}
