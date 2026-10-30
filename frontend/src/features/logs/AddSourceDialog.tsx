import { useMemo, useState } from "react";
import { Dialog } from "radix-ui";
import { Info, X } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import type { LogSourceSpec } from "@/backend/client";
import { Button, IconButton } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Segmented } from "@/components/ui/segmented";
import { TextField } from "@/components/ui/text-field";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { cn } from "@/lib/cn";
import { matches, parseSelector } from "./selector";
import { t as tt, tn } from "@/i18n";

type Mode = "workload" | "selector" | "pods";

/** Kinds the backend can turn into a pod selector (internal/kube/logsources.go). */
const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"]);

/**
 * Adds a source to a log stream: a workload, a label selector or pods, in one
 * namespace of the tab's cluster. The preview uses the pods Clustrail already
 * watches; the backend matches again on the API server.
 */
export function AddSourceDialog({
  cluster,
  namespace: initialNamespace,
  maxPods,
  onAdd,
  onClose,
}: {
  cluster: string;
  namespace: string;
  maxPods: number;
  onAdd: (spec: LogSourceSpec) => void;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const [mode, setMode] = useState<Mode>("workload");
  const [namespace, setNamespace] = useState(initialNamespace);
  const [workload, setWorkload] = useState("");
  const [selector, setSelector] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const clusterPods = useMemo(() => ws.allPods.filter((p) => p.cluster === cluster), [ws.allPods, cluster]);
  const namespaces = useMemo(() => [...new Set(clusterPods.map((p) => p.namespace))].sort(), [clusterPods]);
  const pods = useMemo(() => clusterPods.filter((p) => p.namespace === namespace), [clusterPods, namespace]);
  const workloads = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pods) {
      if (p.owner && WORKLOAD_KINDS.has(p.owner.kind)) {
        const key = `${p.owner.kind}/${p.owner.name}`;
        m.set(key, (m.get(key) ?? 0) + 1);
      }
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [pods]);

  const parsed = useMemo(() => (selector.trim() ? parseSelector(selector) : null), [selector]);
  const selectorError = typeof parsed === "string" ? parsed : undefined;
  const preview = useMemo(() => {
    if (mode === "workload") {
      const [kind, name] = [workload.slice(0, workload.indexOf("/")), workload.slice(workload.indexOf("/") + 1)];
      return workload ? pods.filter((p) => p.owner?.kind === kind && p.owner.name === name) : [];
    }
    if (mode === "selector") return parsed && typeof parsed !== "string" ? pods.filter((p) => matches(parsed, p.labels)) : [];
    return pods.filter((p) => picked.has(p.name));
  }, [mode, workload, parsed, pods, picked]);

  const valid = mode === "workload" ? !!workload : mode === "selector" ? !!parsed && !selectorError : picked.size > 0;
  const add = () => {
    if (!valid) return;
    if (mode === "workload") onAdd({ namespace, workload });
    else if (mode === "selector") onAdd({ namespace, selector: selector.trim() });
    else onAdd({ namespace, pods: [...picked] });
    onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[90px] z-50 flex max-h-[calc(100vh-120px)] w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-3.5 rounded-xl border border-line-strong bg-surface-elevated p-5 text-fg shadow-dialog"
        >
          <div className="flex items-center gap-2">
            <Dialog.Title className="m-0 text-title font-semibold">{tt("Add log source")}</Dialog.Title>
            <div className="flex-1" />
            <Dialog.Close asChild>
              <IconButton aria-label={tt("Close")}>
                <X />
              </IconButton>
            </Dialog.Close>
          </div>
          <span className="-mt-2 text-meta text-fg-muted">{tt("Lines from every source are merged by timestamp. {cluster}", { cluster })}</span>
          <Segmented
            aria-label={tt("Source type")}
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "workload", label: tt("Workload") },
              { value: "selector", label: tt("Label selector") },
              { value: "pods", label: tt("Pods") },
            ]}
          />
          <label className="flex flex-col gap-[5px] text-ui text-fg-secondary">
            {tt("Namespace")}
            <select
              value={namespace}
              onChange={(e) => {
                setNamespace(e.target.value);
                setWorkload("");
                setPicked(new Set());
              }}
              className="focus-ring h-7 rounded-md border border-line-strong bg-surface-app px-2 text-cell text-fg"
            >
              {!namespaces.includes(namespace) && <option value={namespace}>{namespace}</option>}
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>
                  {ns}
                </option>
              ))}
            </select>
          </label>

          {mode === "workload" && (
            <label className="flex flex-col gap-[5px] text-ui text-fg-secondary">
              {tt("Workload")}
              <select value={workload} onChange={(e) => setWorkload(e.target.value)} className="focus-ring h-7 rounded-md border border-line-strong bg-surface-app px-2 font-mono text-cell text-fg">
                <option value="">{tt("Choose…")}</option>
                {workloads.map(([key, n]) => (
                  <option key={key} value={key}>
                    {key} ({n})
                  </option>
                ))}
              </select>
              {workloads.length === 0 && <span className="text-meta text-fg-muted">{tt("No workload pods in this namespace right now; a label selector also follows pods that start later.")}</span>}
            </label>
          )}
          {mode === "selector" && (
            <TextField
              label={tt("Selector")}
              mono
              autoFocus
              value={selector}
              placeholder="app=checkout-api,tier in (web,api)"
              error={selectorError}
              onChange={(e) => setSelector(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
          )}
          {mode === "selector" && !selectorError && (
            <span className="-mt-2 text-meta text-fg-muted">{tn("kubectl syntax: {v0}, {v1}, {v2}", { v0: <code className="font-mono">key=value</code>, v1: <code className="font-mono">key in (a,b)</code>, v2: <code className="font-mono">!key</code> })}</span>
          )}

          {mode === "pods" ? (
            <div className="flex max-h-[240px] flex-col overflow-y-auto rounded-lg border border-line">
              {pods.length === 0 && <span className="px-3 py-2 text-meta text-fg-muted">{tt("No pods in this namespace.")}</span>}
              {pods.map((p) => (
                <label key={p.id} className="flex h-7 shrink-0 cursor-pointer items-center gap-2 border-b border-line-row px-2.5 last:border-b-0">
                  <Checkbox
                    checked={picked.has(p.name)}
                    aria-label={tt("Include {pod}", { pod: p.name })}
                    onCheckedChange={(on) => {
                      const next = new Set(picked);
                      if (on) next.add(p.name);
                      else next.delete(p.name);
                      setPicked(next);
                    }}
                  />
                  <StatusGlyph health={p.health} />
                  <span className="min-w-0 flex-1 truncate font-mono text-cell">{p.name}</span>
                  <span className="text-meta text-fg-muted">{p.status}</span>
                </label>
              ))}
            </div>
          ) : (
            <div className="flex flex-col overflow-hidden rounded-lg border border-line">
              <div className="flex h-8 items-center gap-2 bg-surface-panel px-2.5 text-meta text-fg-secondary">
                <span className={cn("size-1.5 rounded-full", preview.length ? "bg-status-healthy" : "bg-fg-muted")} />
                <span>
                  <b className="font-semibold text-fg">{tt("{n} pods", { n: preview.length })}</b> {tt("match now")}
                </span>
                <span className="ml-auto text-fg-muted">{tt("pods that start later join the stream")}</span>
              </div>
              {preview.slice(0, 5).map((p) => (
                <div key={p.id} className="flex h-7 items-center gap-2 border-t border-line px-2.5 font-mono text-cell">
                  <StatusGlyph health={p.health} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="font-sans text-meta text-fg-muted">{p.status}</span>
                </div>
              ))}
              {preview.length > 5 && <div className="border-t border-line px-2.5 py-1.5 text-meta text-fg-muted">{tt("+ {n} more", { n: preview.length - 5 })}</div>}
            </div>
          )}

          <div className="flex items-start gap-2 rounded-lg bg-status-progressing-soft px-3 py-2 text-meta leading-[1.45] text-fg-secondary">
            <Info className="mt-px size-3.5 shrink-0 text-status-progressing" aria-hidden />
            <span>{tt("Up to {n} pods are followed at once (Settings › Logs). When more match, the newest are followed and the source says how many were skipped.", { n: maxPods })}</span>
          </div>
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>{tt("Cancel")}</Button>
            </Dialog.Close>
            <Button variant="primary" disabled={!valid} onClick={add}>
              {mode === "pods" ? tt("Add {n} pods", { n: picked.size }) : tt("Add source")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
