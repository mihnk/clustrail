import { Code, Layers, RotateCcw, ScrollText, SquareTerminal, Trash2 } from "lucide-react";
import type { ResourceAction } from "@/components/resource-actions/ResourceActions";
import type { ConfirmationRequest } from "@/components/safety/ConfirmationDialog";
import type { Cluster, DeploymentRow, PodRow } from "@/data/types";
import { restartDeploymentRequest } from "@/features/deployments/requests";

interface PodActionDeps {
  cluster: Cluster | undefined;
  deployments: DeploymentRow[];
  confirm: (r: ConfirmationRequest) => void;
  deletePod: (id: string) => void;
  restartDeployment: (id: string) => void;
  openTab: (id: string) => boolean;
  hasTab: (id: string) => boolean;
  openLogs: (pod: PodRow) => void;
}

/** Owning Deployment name for a ReplicaSet-owned pod ("app-7d9f8b6c4" -> "app"). */
export function deploymentNameOf(pod: PodRow): string | null {
  if (pod.owner?.kind !== "ReplicaSet") return null;
  return pod.owner.name.replace(/-[a-z0-9]{8,10}$/, "");
}

export function podActions(pod: PodRow, deps: PodActionDeps): ResourceAction[] {
  const deploymentName = deploymentNameOf(pod);
  const deployment = deps.deployments.find(
    (d) => d.cluster === pod.cluster && d.namespace === pod.namespace && d.name === deploymentName,
  );
  const ownerTab = deploymentName ? `deploy-${deploymentName}` : "";

  return [
    // Observe: nothing here changes the cluster.
    { id: "logs", group: "observe", label: "Logs", icon: <ScrollText />, shortcut: "L", onSelect: () => deps.openLogs(pod) },
    { id: "shell", group: "observe", label: "Shell", icon: <SquareTerminal />, shortcut: "S", disabled: true },
    { id: "yaml", group: "observe", label: "View YAML", icon: <Code />, shortcut: "Y", disabled: true },
    {
      id: "owner",
      group: "observe",
      label: "Open owner",
      icon: <Layers />,
      shortcut: "O",
      disabled: !deps.hasTab(ownerTab),
      onSelect: () => deps.openTab(ownerTab),
    },
    // Modify: always goes through the confirmation for the cluster's environment.
    {
      id: "restart-owner",
      group: "modify",
      label: "Restart owner…",
      icon: <RotateCcw />,
      shortcut: "⇧R",
      disabled: !deployment,
      onSelect: () =>
        deployment &&
        deps.confirm(restartDeploymentRequest(deployment, deps.cluster, () => deps.restartDeployment(deployment.id))),
    },
    {
      id: "delete",
      group: "modify",
      label: "Delete pod…",
      icon: <Trash2 />,
      shortcut: "⌘⌫",
      danger: true,
      disabled: pod.health === "terminating",
      onSelect: () => deps.confirm(deletePodRequest(pod, deps.cluster, () => deps.deletePod(pod.id))),
    },
  ];
}

function deletePodRequest(pod: PodRow, cluster: Cluster | undefined, onConfirm: () => void): ConfirmationRequest {
  const replaced = pod.owner && pod.owner.kind !== "Job";
  return {
    action: "Delete pod",
    targetName: pod.name,
    icon: <Trash2 />,
    env: pod.env,
    cluster: pod.cluster,
    namespace: pod.namespace,
    protected: cluster?.protected ?? false,
    destructive: true,
    whatHappens: replaced ? (
      <>
        The pod is deleted with its default grace period. {pod.owner!.kind}{" "}
        <span className="font-mono text-ui">{pod.owner!.name}</span> creates a replacement; logs of this pod are lost.
      </>
    ) : (
      <>The pod is deleted with its default grace period and is not replaced: no controller owns it.</>
    ),
    currentState:
      pod.health === "healthy"
        ? [{ health: "healthy", text: `The pod is running and ${pod.readyContainers}/${pod.totalContainers} ready.` }]
        : [{ health: pod.health, text: `${pod.reason}${pod.restarts ? ` · ${pod.restarts} restarts` : ""}.` }],
    command: `kubectl --context ${pod.cluster} -n ${pod.namespace} delete pod ${pod.name}`,
    confirmLabel: "Delete pod",
    onConfirm,
  };
}
