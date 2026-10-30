import { ArrowLeftRight, Code, History, Pause, Play, RotateCcw, Scaling, Trash2 } from "lucide-react";
import type { ResourceAction } from "@/components/resource-actions/ResourceActions";
import type { ConfirmationRequest } from "@/components/safety/ConfirmationDialog";
import type { Cluster, DeploymentRow } from "@/data/types";
import {
  deleteDeploymentRequest,
  pauseDeploymentRequest,
  restartDeploymentRequest,
} from "./requests";

export interface DeploymentActionDeps {
  cluster: Cluster | undefined;
  confirm: (r: ConfirmationRequest) => void;
  restartDeployment: (id: string) => void;
  setDeploymentPaused: (id: string, paused: boolean) => void;
  deleteDeployment: (id: string) => void;
  /** Inspector navigation: History tab, scale stepper. */
  showHistory: () => void;
  focusScale: () => void;
  openYaml: (edit: boolean) => void;
  compare: () => void;
}

/** Observe, then Modify, then Delete — the same order for every kind. */
export function deploymentActions(d: DeploymentRow, deps: DeploymentActionDeps): ResourceAction[] {
  const paused = d.rollout === "Paused";
  return [
    { id: "history", group: "observe", label: "Rollout history", icon: <History />, shortcut: "H", onSelect: deps.showHistory },
    { id: "yaml", group: "observe", label: "View YAML", icon: <Code />, shortcut: "Y", onSelect: () => deps.openYaml(false) },
    { id: "compare", group: "observe", label: "Compare with…", icon: <ArrowLeftRight />, shortcut: "C", onSelect: deps.compare },
    {
      id: "scale",
      group: "modify",
      label: d.hpa ? "Scale… · HPA" : "Scale…",
      icon: <Scaling />,
      shortcut: "⇧S",
      onSelect: deps.focusScale,
    },
    {
      id: "restart",
      group: "modify",
      label: "Restart rollout…",
      icon: <RotateCcw />,
      shortcut: "⇧R",
      disabled: d.rollout === "Progressing",
      onSelect: () => deps.confirm(restartDeploymentRequest(d, deps.cluster, () => deps.restartDeployment(d.id))),
    },
    { id: "rollback", group: "modify", label: "Roll back to revision…", icon: <History />, onSelect: deps.showHistory },
    {
      id: "pause",
      group: "modify",
      label: paused ? "Resume rollout" : "Pause rollout",
      icon: paused ? <Play /> : <Pause />,
      onSelect: () =>
        deps.confirm(pauseDeploymentRequest(d, deps.cluster, !paused, () => deps.setDeploymentPaused(d.id, !paused))),
    },
    { id: "edit", group: "modify", label: "Edit YAML…", icon: <Code />, shortcut: "E", onSelect: () => deps.openYaml(true) },
    {
      id: "delete",
      group: "modify",
      danger: true,
      label: "Delete…",
      icon: <Trash2 />,
      shortcut: "⌘⌫",
      onSelect: () => deps.confirm(deleteDeploymentRequest(d, deps.cluster, () => deps.deleteDeployment(d.id))),
    },
  ];
}
