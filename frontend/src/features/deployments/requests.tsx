import { RotateCcw } from "lucide-react";
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
