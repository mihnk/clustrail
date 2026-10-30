import { History, Pause, Play, RotateCcw, Scaling, Trash2 } from "lucide-react";
import type { ConfirmationRequest } from "@/components/safety/ConfirmationDialog";
import type { Cluster, DeploymentRow } from "@/data/types";
import { getDeploymentState } from "@/data/mock";

const mono = "font-mono text-ui";

/** Confirmation content for `kubectl rollout restart deployment/<name>`. */
export function restartDeploymentRequest(
  d: DeploymentRow,
  cluster: Cluster | undefined,
  onConfirm: () => void,
): ConfirmationRequest {
  const s = d.strategy;
  return {
    action: "Restart deployment",
    targetName: d.name,
    icon: <RotateCcw />,
    env: d.env,
    cluster: d.cluster,
    namespace: d.namespace,
    meta: `${d.replicas} ${d.replicas === 1 ? "replica" : "replicas"}`,
    protected: cluster?.protected ?? false,
    destructive: true,
    whatHappens:
      s.type === "RollingUpdate" ? (
        <>
          All {d.replicas} pods are replaced using the Deployment’s RollingUpdate strategy (
          <span className={mono}>maxSurge {s.maxSurge}</span>, <span className={mono}>maxUnavailable {s.maxUnavailable}</span>
          ). Clustrail sets the <span className={mono}>restartedAt</span> annotation on the pod template; nothing else in the
          spec changes.
        </>
      ) : (
        <>
          The Deployment uses the <span className={mono}>Recreate</span> strategy: all {d.replicas} pods are stopped before
          new ones start, so the workload is unavailable during the restart. Clustrail sets the{" "}
          <span className={mono}>restartedAt</span> annotation on the pod template; nothing else in the spec changes.
        </>
      ),
    currentState: getDeploymentState(d).map((f) => ({
      health: f.health,
      text: f.mono ? (
        <>
          {f.mono.split(" ")[0]} <span className={mono}>{f.mono.split(" ").slice(1).join(" ")}</span> {f.text}
        </>
      ) : (
        f.text
      ),
    })),
    command: `kubectl --context ${d.cluster} -n ${d.namespace} rollout restart deployment/${d.name}`,
    confirmLabel: "Restart deployment",
    onConfirm,
  };
}

export function scaleDeploymentRequest(
  d: DeploymentRow,
  cluster: Cluster | undefined,
  replicas: number,
  onConfirm: () => void,
): ConfirmationRequest {
  const hpaOverrides = d.hpa && (replicas < d.hpa.min || replicas > d.hpa.max);
  return {
    action: `Scale to ${replicas}`,
    targetName: d.name,
    icon: <Scaling />,
    env: d.env,
    cluster: d.cluster,
    namespace: d.namespace,
    meta: `${d.replicas} → ${replicas} replicas`,
    protected: cluster?.protected ?? false,
    destructive: replicas < d.replicas,
    whatHappens:
      replicas < d.replicas ? (
        <>
          {d.replicas - replicas} {d.replicas - replicas === 1 ? "pod is" : "pods are"} terminated. Clustrail patches{" "}
          <span className={mono}>spec.replicas</span> only.
        </>
      ) : (
        <>
          {replicas - d.replicas} new {replicas - d.replicas === 1 ? "pod is" : "pods are"} scheduled. Clustrail patches{" "}
          <span className={mono}>spec.replicas</span> only.
        </>
      ),
    currentState: [
      { health: d.readyReplicas < d.replicas ? "warning" : "healthy", text: `${d.readyReplicas} of ${d.replicas} replicas ready.` },
      ...(d.hpa
        ? [
            {
              health: hpaOverrides ? ("warning" as const) : ("progressing" as const),
              text: hpaOverrides ? (
                <>
                  HPA <span className={mono}>{d.hpa.name}</span> keeps replicas between {d.hpa.min} and {d.hpa.max} and will
                  override this change. Edit the HPA instead.
                </>
              ) : (
                <>
                  HPA <span className={mono}>{d.hpa.name}</span> manages replicas ({d.hpa.min}–{d.hpa.max}) and may change
                  this value again.
                </>
              ),
            },
          ]
        : []),
    ],
    command: `kubectl --context ${d.cluster} -n ${d.namespace} scale deployment/${d.name} --replicas=${replicas}`,
    confirmLabel: `Scale to ${replicas}`,
    onConfirm,
  };
}

export function rollbackDeploymentRequest(
  d: DeploymentRow,
  cluster: Cluster | undefined,
  rev: number,
  onConfirm: () => void,
): ConfirmationRequest {
  const target = d.revisions.find((r) => r.rev === rev);
  return {
    action: `Roll back to revision ${rev}`,
    targetName: d.name,
    icon: <History />,
    env: d.env,
    cluster: d.cluster,
    namespace: d.namespace,
    meta: `${d.replicas} replicas`,
    protected: cluster?.protected ?? false,
    destructive: true,
    whatHappens: (
      <>
        The pod template of revision {rev} becomes current and pods roll out again: image{" "}
        <span className={mono}>
          {d.image} → {target?.image}
        </span>
        . This creates a new revision; nothing else in the spec changes.
      </>
    ),
    currentState: [
      ...getDeploymentState(d).slice(0, 1).map((f) => ({ health: f.health, text: f.text })),
      ...(d.argoApp
        ? [
            {
              health: "warning" as const,
              text: (
                <>
                  Managed by Argo CD app <span className={mono}>{d.argoApp}</span>: with auto-sync on, the controller restores
                  the revision in Git. Roll back in Git to keep it.
                </>
              ),
            },
          ]
        : []),
    ],
    command: `kubectl --context ${d.cluster} -n ${d.namespace} rollout undo deployment/${d.name} --to-revision=${rev}`,
    confirmLabel: "Roll back",
    onConfirm,
  };
}

export function pauseDeploymentRequest(
  d: DeploymentRow,
  cluster: Cluster | undefined,
  pause: boolean,
  onConfirm: () => void,
): ConfirmationRequest {
  return {
    action: pause ? "Pause rollout of" : "Resume rollout of",
    targetName: d.name,
    icon: pause ? <Pause /> : <Play />,
    env: d.env,
    cluster: d.cluster,
    namespace: d.namespace,
    protected: cluster?.protected ?? false,
    destructive: false,
    whatHappens: pause
      ? "Changes to the pod template stop rolling out until the Deployment is resumed. Running pods are not touched."
      : "Pending pod template changes start rolling out with the Deployment's strategy.",
    command: `kubectl --context ${d.cluster} -n ${d.namespace} rollout ${pause ? "pause" : "resume"} deployment/${d.name}`,
    confirmLabel: pause ? "Pause rollout" : "Resume rollout",
    onConfirm,
  };
}

export function deleteDeploymentRequest(d: DeploymentRow, cluster: Cluster | undefined, onConfirm: () => void): ConfirmationRequest {
  return {
    action: "Delete deployment",
    targetName: d.name,
    icon: <Trash2 />,
    env: d.env,
    cluster: d.cluster,
    namespace: d.namespace,
    meta: `${d.replicas} replicas`,
    protected: cluster?.protected ?? false,
    destructive: true,
    whatHappens: (
      <>
        The Deployment, its ReplicaSets and all {d.replicas} pods are deleted. Services and ConfigMaps it uses stay.
        {d.argoApp ? " Argo CD recreates it on the next sync if it is still in Git." : ""}
      </>
    ),
    command: `kubectl --context ${d.cluster} -n ${d.namespace} delete deployment/${d.name}`,
    confirmLabel: "Delete deployment",
    onConfirm,
  };
}

/** "RollingUpdate · surge 1 · unavail 1" */
export function strategyText(d: DeploymentRow): string {
  const s = d.strategy;
  return s.type === "Recreate" ? "Recreate" : `RollingUpdate · surge ${s.maxSurge} · unavail ${s.maxUnavailable}`;
}
