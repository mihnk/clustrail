import { useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import { CirclePause, CirclePlay, Play, RotateCcw, Scaling, ScrollText, X } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { backend, errorText, type JobStatus } from "@/backend/client";
import type { ResourceAction } from "@/components/resource-actions/ResourceActions";
import type { ConfirmationRequest } from "@/components/safety/ConfirmationDialog";
import { Button, IconButton } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { EmptyState } from "@/components/EmptyState";
import type { Environment } from "@/data/types";
import { kindName } from "./kinds";
import { t as tt } from "@/i18n";

// Actions of StatefulSets, DaemonSets, Jobs and CronJobs in the generic lists
// (internal/kube/workloads.go). Deployments have their own workspace.

export const RESTARTABLE = new Set(["apps/StatefulSet", "apps/DaemonSet"]);
export const SCALABLE = new Set(["apps/StatefulSet"]);
/** Kinds whose pods a Logs tab can follow by the workload's selector. */
export const LOGGABLE = new Set(["apps/StatefulSet", "apps/DaemonSet", "batch/Job"]);

export interface WorkloadTarget {
  cluster: string;
  env: Environment;
  protected: boolean;
  namespace: string;
  name: string;
  /** kubectl --context. */
  context: string;
  /** A CronJob's SUSPEND column, when the list has it. */
  suspended?: boolean;
}

interface Deps {
  confirm: (r: ConfirmationRequest) => void;
  openLogs: () => void;
  openScale: () => void;
  done: (title: string, detail?: string) => void;
  failed: (title: string, e: unknown) => void;
}

export function workloadActions(kind: string, w: WorkloadTarget, deps: Deps): ResourceAction[] {
  const out: ResourceAction[] = [];
  const kubectl = (verb: string) => `kubectl --context ${w.context} -n ${w.namespace} ${verb}`;
  const resource = `${kindName(kind).toLowerCase()}/${w.name}`;
  const base = { env: w.env, cluster: w.cluster, namespace: w.namespace, protected: w.protected, targetName: w.name };
  if (LOGGABLE.has(kind)) {
    out.push({ id: "logs", group: "observe", label: tt("Logs"), icon: <ScrollText />, shortcut: "L", onSelect: deps.openLogs });
  }
  if (RESTARTABLE.has(kind)) {
    out.push({
      id: "restart",
      group: "modify",
      label: tt("Restart…"),
      icon: <RotateCcw />,
      disabled: !backend,
      onSelect: () =>
        deps.confirm({
          ...base,
          action: tt("Restart {v0}", { v0: kindName(kind) }),
          icon: <RotateCcw />,
          destructive: false,
          whatHappens:
            kind === "apps/DaemonSet"
              ? tt("The pod template is stamped with the time, like kubectl rollout restart. Pods are replaced node by node, as the update strategy allows.")
              : tt("The pod template is stamped with the time, like kubectl rollout restart. Pods are replaced one at a time, highest ordinal first, each waiting for the previous to be ready."),
          command: kubectl(`rollout restart ${resource}`),
          confirmLabel: tt("Restart"),
          onConfirm: () =>
            backend
              ?.restartWorkload(w.cluster, kind, w.namespace, w.name)
              .then(() => deps.done(tt("{v0} restarted", { v0: kindName(kind) })))
              .catch((e) => deps.failed(tt("Restart failed"), e)),
        }),
    });
  }
  if (SCALABLE.has(kind)) {
    out.push({ id: "scale", group: "modify", label: tt("Scale…"), icon: <Scaling />, disabled: !backend, onSelect: deps.openScale });
  }
  if (kind === "batch/CronJob") {
    out.push({
      id: "trigger",
      group: "modify",
      label: tt("Run now…"),
      icon: <Play />,
      disabled: !backend,
      onSelect: () =>
        deps.confirm({
          ...base,
          action: tt("Run CronJob"),
          icon: <Play />,
          destructive: false,
          whatHappens: tt("A Job is created from the CronJob's template now, like kubectl create job --from. It is owned by the CronJob and counts toward its history; the schedule is unchanged."),
          command: kubectl(`create job --from=cronjob/${w.name} ${w.name}-manual-<time>`),
          confirmLabel: tt("Run now"),
          onConfirm: () =>
            backend
              ?.triggerCronJob(w.cluster, w.namespace, w.name)
              .then((job) => deps.done(tt("Job started"), job))
              .catch((e) => deps.failed(tt("Run failed"), e)),
        }),
    });
    const suspend = !w.suspended;
    out.push({
      id: "suspend",
      group: "modify",
      label: suspend ? tt("Suspend…") : tt("Resume…"),
      icon: suspend ? <CirclePause /> : <CirclePlay />,
      disabled: !backend,
      onSelect: () =>
        deps.confirm({
          ...base,
          action: suspend ? tt("Suspend CronJob") : tt("Resume CronJob"),
          icon: suspend ? <CirclePause /> : <CirclePlay />,
          destructive: false,
          whatHappens: suspend
            ? tt("No new Jobs start on schedule until it is resumed. Jobs already running continue.")
            : tt("Jobs start on schedule again. Runs missed while suspended may start at once, within startingDeadlineSeconds."),
          command: kubectl(`patch cronjob ${w.name} -p '{"spec":{"suspend":${suspend}}}'`),
          confirmLabel: suspend ? tt("Suspend") : tt("Resume"),
          onConfirm: () =>
            backend
              ?.setCronJobSuspended(w.cluster, w.namespace, w.name, suspend)
              .then(() => deps.done(suspend ? tt("CronJob suspended") : tt("CronJob resumed")))
              .catch((e) => deps.failed(suspend ? tt("Suspend failed") : tt("Resume failed"), e)),
        }),
    });
  }
  return out;
}

/** Sets a StatefulSet's replicas through the scale subresource. */
export function ScaleDialog({
  kind,
  target,
  onClose,
  confirm,
  done,
  failed,
}: {
  kind: string;
  target: WorkloadTarget;
  onClose: () => void;
  confirm: (r: ConfirmationRequest) => void;
  done: (title: string, detail?: string) => void;
  failed: (title: string, e: unknown) => void;
}) {
  const [current, setCurrent] = useState<number | null>(null);
  const [value, setValue] = useState("");
  useEffect(() => {
    void backend?.workloadReplicas(target.cluster, kind, target.namespace, target.name).then((n) => {
      setCurrent(n);
      setValue(String(n));
    });
  }, [kind, target.cluster, target.namespace, target.name]);
  const n = Number(value);
  const valid = value !== "" && Number.isInteger(n) && n >= 0 && n <= 1000 && n !== current;
  const submit = () => {
    if (!valid) return;
    onClose();
    confirm({
      env: target.env,
      cluster: target.cluster,
      namespace: target.namespace,
      protected: target.protected,
      targetName: target.name,
      action: tt("Scale {v0}", { v0: kindName(kind) }),
      meta: tt("{from} → {to} replicas", { from: current ?? "?", to: n }),
      icon: <Scaling />,
      destructive: n < (current ?? 0),
      whatHappens:
        n < (current ?? 0)
          ? tt("Pods are removed from the highest ordinal down, one at a time. Their PersistentVolumeClaims are kept.")
          : tt("Pods are added in ordinal order, each after the previous is ready."),
      command: `kubectl --context ${target.context} -n ${target.namespace} scale ${kindName(kind).toLowerCase()}/${target.name} --replicas=${n}`,
      confirmLabel: tt("Scale"),
      onConfirm: () =>
        backend
          ?.scaleWorkload(target.cluster, kind, target.namespace, target.name, n)
          .then(() => done(tt("Scaled to {n}", { n })))
          .catch((e) => failed(tt("Scale failed"), e)),
    });
  };
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[120px] z-50 flex w-[380px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-3.5 rounded-xl border border-line-strong bg-surface-elevated p-5 text-fg shadow-dialog"
        >
          <div className="flex items-center gap-2">
            <Scaling className="size-4 text-fg-secondary" aria-hidden />
            <Dialog.Title className="m-0 text-title font-semibold">{tt("Scale {v0}", { v0: kindName(kind) })}</Dialog.Title>
            <div className="flex-1" />
            <Dialog.Close asChild>
              <IconButton aria-label={tt("Close")}>
                <X />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className="flex items-center gap-1.5 text-ui">
            <EnvironmentBadge env={target.env} />
            <span className="truncate font-mono">{target.name}</span>
            <span className="text-fg-muted">· {target.namespace}</span>
          </div>
          <TextField
            label={current === null ? tt("Replicas") : tt("Replicas (now {n})", { n: current })}
            mono
            inputMode="numeric"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value.trim())}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>{tt("Cancel")}</Button>
            </Dialog.Close>
            <Button variant="primary" disabled={!valid} onClick={submit}>
              {tt("Continue…")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A Job's attempts: each retry is a new pod, with its exit code and reason. */
export function JobAttempts({ cluster, namespace, name }: { cluster: string; namespace: string; name: string }) {
  const ws = useWorkspace();
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!backend) return;
    let cancelled = false;
    const load = () =>
      backend
        ?.jobStatus(cluster, namespace, name)
        .then((s) => !cancelled && (setStatus(s), setError(null)))
        .catch((e) => !cancelled && setError(errorText(e)));
    void load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [cluster, namespace, name]);
  if (!backend) return <EmptyState title={tt("Job attempts come from your clusters in the desktop app.")} />;
  if (error) return <EmptyState title={tt("Could not read the Job")}>{error}</EmptyState>;
  if (!status) return <EmptyState title={tt("Reading attempts…")} />;
  const failedOut = status.condition === "Failed";
  return (
    <div className="flex flex-col gap-3 px-3.5 py-3">
      <dl className="m-0 grid grid-cols-[minmax(90px,auto)_1fr] gap-x-3 gap-y-1.5 text-ui">
        <dt className="text-fg-muted">{tt("Succeeded")}</dt>
        <dd className="m-0 font-mono">
          {status.succeeded} / {status.completions}
        </dd>
        <dt className="text-fg-muted">{tt("Failed")}</dt>
        <dd className="m-0 font-mono">{tt("{n} of {max} retries", { n: status.failed, max: status.backoffLimit })}</dd>
        <dt className="text-fg-muted">{tt("Active")}</dt>
        <dd className="m-0 font-mono">{status.active}</dd>
      </dl>
      {status.condition && (
        <div className={failedOut ? "rounded-md bg-status-critical-soft px-2.5 py-2 text-meta" : "rounded-md bg-surface-panel px-2.5 py-2 text-meta"}>
          <b className="font-semibold">{status.condition}</b>
          {status.reason && <span className="font-mono"> · {status.reason}</span>}
          {status.message && <div className="selectable mt-0.5 text-fg-secondary">{status.message}</div>}
        </div>
      )}
      <div className="flex flex-col">
        <span className="section-label pb-1.5">{tt("Attempts, newest first")}</span>
        {status.attempts.length === 0 && <span className="text-meta text-fg-muted">{tt("No pods left.")}</span>}
        {status.attempts.map((a) => (
          <div key={a.pod} className="flex items-center gap-2 border-b border-line-row py-1.5 text-ui last:border-b-0">
            <StatusGlyph health={a.health} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-mono text-cell" title={a.pod}>
                …{a.pod.split("-").pop()}
              </span>
              <span className="truncate text-meta text-fg-muted">
                {[a.phase, a.exitCode !== undefined && tt("exit {code}", { code: a.exitCode }), a.reason, a.duration, a.node].filter(Boolean).join(" · ")}
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => ws.openView({ kind: "logs", title: tt("Logs · {name}", { name: a.pod }), cluster, params: { namespace, pod: a.pod } })}
            >
              <ScrollText aria-hidden />
              {tt("Logs")}
            </Button>
          </div>
        ))}
        {status.missing > 0 && <span className="pt-1.5 text-meta text-fg-muted">{tt("{n} earlier attempts were deleted (TTL or backoff cleanup).", { n: status.missing })}</span>}
      </div>
    </div>
  );
}
