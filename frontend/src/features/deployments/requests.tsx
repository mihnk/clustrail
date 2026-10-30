import { History, Pause, Play, RotateCcw, Scaling, Trash2 } from "lucide-react";
import type { ConfirmationRequest } from "@/components/safety/ConfirmationDialog";
import type { Cluster, DeploymentRow } from "@/data/types";
import { getDeploymentState } from "@/data/mock";
import { t, tn } from "@/i18n";

const mono = "font-mono text-ui";

/** Confirmation content for `kubectl rollout restart deployment/<name>`. */
export function restartDeploymentRequest(
  d: DeploymentRow,
  cluster: Cluster | undefined,
  onConfirm: () => void,
): ConfirmationRequest {
  const s = d.strategy;
  return {
    action: t("Restart deployment"),
    targetName: d.name,
    icon: <RotateCcw />,
    env: d.env,
    cluster: d.cluster,
    namespace: d.namespace,
    meta: d.replicas === 1 ? t("1 replica") : t("{n} replicas", { n: d.replicas }),
    protected: cluster?.protected ?? false,
    destructive: true,
    whatHappens:
      s.type === "RollingUpdate" ? (
        <>{tn("All {replicas} pods are replaced using the Deployment’s RollingUpdate strategy ({v1}, {v2}). Clustrail sets the {v3} annotation on the pod template; nothing else in the spec changes.", { replicas: d.replicas, v1: <span className={mono}>maxSurge {s.maxSurge}</span>, v2: <span className={mono}>maxUnavailable {s.maxUnavailable}</span>, v3: <span className={mono}>restartedAt</span> })}</>
      ) : (
        <>{tn("The Deployment uses the {v0} strategy: all {replicas} pods are stopped before new ones start, so the workload is unavailable during the restart. Clustrail sets the {v2} annotation on the pod template; nothing else in the spec changes.", { v0: <span className={mono}>Recreate</span>, replicas: d.replicas, v2: <span className={mono}>restartedAt</span> })}</>
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
    confirmLabel: t("Restart deployment"),
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
    action: t("Scale to {replicas}", { replicas }),
    targetName: d.name,
    icon: <Scaling />,
    env: d.env,
    cluster: d.cluster,
    namespace: d.namespace,
    meta: t("{from} → {to} replicas", { from: d.replicas, to: replicas }),
    protected: cluster?.protected ?? false,
    destructive: replicas < d.replicas,
    whatHappens:
      replicas < d.replicas ? (
        <>
          {tn(d.replicas - replicas === 1 ? "{n} pod is terminated. Clustrail patches {field} only." : "{n} pods are terminated. Clustrail patches {field} only.", {
            n: d.replicas - replicas,
            field: <span className={mono}>spec.replicas</span>,
          })}
        </>
      ) : (
        <>
          {tn(replicas - d.replicas === 1 ? "{n} new pod is scheduled. Clustrail patches {field} only." : "{n} new pods are scheduled. Clustrail patches {field} only.", {
            n: replicas - d.replicas,
            field: <span className={mono}>spec.replicas</span>,
          })}
        </>
      ),
    currentState: [
      { health: d.readyReplicas < d.replicas ? "warning" : "healthy", text: t("{readyReplicas} of {replicas} replicas ready.", { readyReplicas: d.readyReplicas, replicas: d.replicas }) },
      ...(d.hpa
        ? [
            {
              health: hpaOverrides ? ("warning" as const) : ("progressing" as const),
              text: hpaOverrides ? (
                <>{tn("HPA {name} keeps replicas between {min} and {max} and will override this change. Edit the HPA instead.", { name: <span className={mono}>{d.hpa.name}</span>, min: d.hpa.min, max: d.hpa.max })}</>
              ) : (
                <>{tn("HPA {name} manages replicas ({min}–{max}) and may change this value again.", { name: <span className={mono}>{d.hpa.name}</span>, min: d.hpa.min, max: d.hpa.max })}</>
              ),
            },
          ]
        : []),
    ],
    command: `kubectl --context ${d.cluster} -n ${d.namespace} scale deployment/${d.name} --replicas=${replicas}`,
    confirmLabel: t("Scale to {replicas}", { replicas }),
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
    action: t("Roll back to revision {rev}", { rev }),
    targetName: d.name,
    icon: <History />,
    env: d.env,
    cluster: d.cluster,
    namespace: d.namespace,
    meta: t("{n} replicas", { n: d.replicas }),
    protected: cluster?.protected ?? false,
    destructive: true,
    whatHappens: (
      <>{tn("The pod template of revision {rev} becomes current and pods roll out again: image {v1}. This creates a new revision; nothing else in the spec changes.", { rev, v1: <span className={mono}>
          {d.image} → {target?.image}
        </span> })}</>
    ),
    currentState: [
      ...getDeploymentState(d).slice(0, 1).map((f) => ({ health: f.health, text: f.text })),
      ...(d.argoApp
        ? [
            {
              health: "warning" as const,
              text: (
                <>{tn("Managed by Argo CD app {argoApp}: with auto-sync on, the controller restores the revision in Git. Roll back in Git to keep it.", { argoApp: <span className={mono}>{d.argoApp}</span> })}</>
              ),
            },
          ]
        : []),
    ],
    command: `kubectl --context ${d.cluster} -n ${d.namespace} rollout undo deployment/${d.name} --to-revision=${rev}`,
    confirmLabel: t("Roll back"),
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
    action: pause ? t("Pause rollout of") : t("Resume rollout of"),
    targetName: d.name,
    icon: pause ? <Pause /> : <Play />,
    env: d.env,
    cluster: d.cluster,
    namespace: d.namespace,
    protected: cluster?.protected ?? false,
    destructive: false,
    whatHappens: pause
      ? t("Changes to the pod template stop rolling out until the Deployment is resumed. Running pods are not touched.")
      : t("Pending pod template changes start rolling out with the Deployment's strategy."),
    command: `kubectl --context ${d.cluster} -n ${d.namespace} rollout ${pause ? "pause" : "resume"} deployment/${d.name}`,
    confirmLabel: pause ? t("Pause rollout") : t("Resume rollout"),
    onConfirm,
  };
}

export function deleteDeploymentRequest(d: DeploymentRow, cluster: Cluster | undefined, onConfirm: () => void): ConfirmationRequest {
  return {
    action: t("Delete deployment"),
    targetName: d.name,
    icon: <Trash2 />,
    env: d.env,
    cluster: d.cluster,
    namespace: d.namespace,
    meta: t("{n} replicas", { n: d.replicas }),
    protected: cluster?.protected ?? false,
    destructive: true,
    whatHappens: (
      <>
        {t("The Deployment, its ReplicaSets and all {n} pods are deleted. Services and ConfigMaps it uses stay.", { n: d.replicas })}
        {d.argoApp ? ` ${t("Argo CD recreates it on the next sync if it is still in Git.")}` : ""}
      </>
    ),
    command: `kubectl --context ${d.cluster} -n ${d.namespace} delete deployment/${d.name}`,
    confirmLabel: t("Delete deployment"),
    onConfirm,
  };
}

/** "RollingUpdate · surge 1 · unavail 1" */
export function strategyText(d: DeploymentRow): string {
  const s = d.strategy;
  return s.type === "Recreate" ? "Recreate" : `RollingUpdate · surge ${s.maxSurge} · unavail ${s.maxUnavailable}`;
}
