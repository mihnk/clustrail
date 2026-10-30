import { Cable, Code, Layers, RotateCcw, ScrollText, SquareTerminal, Trash2 } from "lucide-react";
import { backend } from "@/backend/client";
import { openPortForward } from "@/features/portforward/PortForward";
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
  openShell: (pod: PodRow) => void;
  openYaml: (pod: PodRow) => void;
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
    {
      id: "shell",
      group: "observe",
      label: deps.cluster?.readOnly ? "Shell · read-only context" : "Shell…",
      icon: <SquareTerminal />,
      shortcut: "S",
      // A shell can change the workload: it confirms like a mutation and is blocked in read-only contexts.
      disabled: deps.cluster?.readOnly || pod.readyContainers === 0,
      onSelect: () => deps.confirm(shellRequest(pod, deps.cluster, () => deps.openShell(pod))),
    },
    { id: "yaml", group: "observe", label: "View YAML", icon: <Code />, shortcut: "Y", onSelect: () => deps.openYaml(pod) },
    {
      id: "forward",
      group: "observe",
      label: "Port forward…",
      icon: <Cable />,
      disabled: !backend || pod.status !== "Running",
      onSelect: () => openPortForward({ cluster: pod.cluster, namespace: pod.namespace, kind: "Pod", name: pod.name }),
    },
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

function shellRequest(pod: PodRow, cluster: Cluster | undefined, onConfirm: () => void): ConfirmationRequest {
  return {
    action: "Open a shell in",
    targetName: pod.name,
    icon: <SquareTerminal />,
    env: pod.env,
    cluster: pod.cluster,
    namespace: pod.namespace,
    meta: "container app",
    protected: cluster?.protected ?? false,
    destructive: false,
    whatHappens: (
      <>
        Starts <span className="font-mono text-ui">/bin/sh</span> in the container through the API server (pods/exec). Commands run as the
        container’s user; Clustrail does not filter or undo them, and protected mode does not apply inside the shell.
      </>
    ),
    command: `kubectl --context ${pod.cluster} -n ${pod.namespace} exec -it ${pod.name} -- /bin/sh`,
    confirmLabel: "Open shell",
    onConfirm,
  };
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
