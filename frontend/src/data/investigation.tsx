// Mock investigation document. Investigations are local documents: the
// facts come from the Kubernetes API (via the Go backend), while notes and
// checklist state are the operator's and are stored on this machine.

import type { ReactNode } from "react";
import type { Health } from "./types";

export interface InvolvedObject {
  id: string;
  depth: 0 | 1 | 2;
  /** Status glyph, or a kind icon for objects without a health state. */
  marker: { health: Health } | { icon: "deployment" | "configmap" };
  name: string;
  kind?: string;
  /** Right-aligned fact, e.g. "2/4", "14 ↻", "0 allowed". */
  fact?: string;
  factTone?: Health;
  muted?: boolean;
}

export interface RestartLane {
  pod: string;
  /** Minutes ago of each container restart. */
  restarts: number[];
}

export interface TimelineEntry {
  id: string;
  ago: string;
  kind: "warning" | "failed" | "rollout";
  title: string;
  detail: ReactNode;
  /** Plain text for summaries. */
  plain: string;
  scope: string;
  note?: string;
}

export interface Observation {
  id: string;
  text: ReactNode;
  plain: string;
  source: string;
  warning?: boolean;
}

export interface NextCheck {
  id: string;
  text: ReactNode;
  plain: string;
  action?: "previous-logs" | "metrics" | "compare";
}

export interface Investigation {
  id: string;
  title: string;
  openedAgo: string;
  target: { kind: string; name: string; namespace: string; cluster: string };
  objects: InvolvedObject[];
  lanes: RestartLane[];
  timeline: TimelineEntry[];
  observations: Observation[];
  checks: NextCheck[];
  initiallyDone: string[];
}

const m = (s: string) => <span className="font-mono text-ui">{s}</span>;

export const checkoutInvestigation: Investigation = {
  id: "checkout-api-restarts",
  title: "checkout-api is running with 2 of 4 pods unhealthy",
  openedAgo: "12m",
  target: { kind: "deployment", name: "checkout-api", namespace: "payments", cluster: "prod-eu-west-1" },
  objects: [
    { id: "deploy", depth: 0, marker: { icon: "deployment" }, name: "checkout-api", kind: "Deployment", fact: "2/4", factTone: "warning" },
    { id: "rs14", depth: 1, marker: { health: "warning" }, name: "…7d9f8b6c4", kind: "RS · rev 14", fact: "3d" },
    { id: "x2kqp", depth: 2, marker: { health: "failed" }, name: "…x2kqp", fact: "14 ↻", factTone: "failed" },
    { id: "m8vtn", depth: 2, marker: { health: "failed" }, name: "…m8vtn", fact: "11 ↻", factTone: "failed" },
    { id: "9rkzd", depth: 2, marker: { health: "healthy" }, name: "…9rkzd", fact: "0 ↻", muted: true },
    { id: "h2pqs", depth: 2, marker: { health: "healthy" }, name: "…h2pqs", fact: "0 ↻", muted: true },
    { id: "rs13", depth: 1, marker: { health: "unknown" }, name: "…5f6b9d8c7", kind: "RS · rev 13 · 0 pods", muted: true },
    { id: "svc", depth: 0, marker: { health: "warning" }, name: "checkout-api", kind: "Service", fact: "2/4 ep", factTone: "warning" },
    { id: "pdb", depth: 0, marker: { health: "warning" }, name: "checkout-api", kind: "PodDisruptionBudget", fact: "0 allowed", factTone: "warning" },
    { id: "hpa", depth: 0, marker: { health: "healthy" }, name: "checkout-api", kind: "HPA", fact: "4 / 4–8" },
    { id: "cm", depth: 0, marker: { icon: "configmap" }, name: "checkout-api-config", kind: "ConfigMap", fact: "3d" },
    { id: "nodes", depth: 0, marker: { health: "healthy" }, name: "4 nodes", kind: "all Ready · no pressure" },
  ],
  lanes: [
    { pod: "…7d9f8b6c4-x2kqp", restarts: [52.1, 50.6, 48.2, 45, 41, 36.2, 31.2, 26.1, 21.1, 16.1, 12.1, 8.1, 5.2, 2.2] },
    { pod: "…7d9f8b6c4-m8vtn", restarts: [48.2, 46.1, 43.1, 39.1, 34.1, 29.1, 24.1, 19.2, 14.2, 9.1, 5.2] },
    { pod: "…7d9f8b6c4-9rkzd", restarts: [] },
    { pod: "…7d9f8b6c4-h2pqs", restarts: [] },
  ],
  timeline: [
    { id: "t1", ago: "1m", kind: "warning", title: "BackOff", detail: "Back-off restarting failed container api", plain: "Back-off restarting failed container api", scope: "2 pods · ×71" },
    { id: "t2", ago: "2m", kind: "failed", title: "Terminated · OOMKilled", detail: "container api, exit code 137, limit 256Mi", plain: "container api, exit code 137, limit 256Mi", scope: "…x2kqp" },
    { id: "t3", ago: "3m", kind: "warning", title: "Unhealthy", detail: "Readiness probe failed: HTTP probe failed with statuscode: 503", plain: "Readiness probe failed: HTTP probe failed with statuscode: 503", scope: "2 pods · ×17" },
    { id: "t4", ago: "48m", kind: "failed", title: "Terminated · OOMKilled", detail: <>first termination of container api on {m("…m8vtn")}</>, plain: "first termination of container api on …m8vtn", scope: "…m8vtn" },
    { id: "t5", ago: "52m", kind: "failed", title: "Terminated · OOMKilled", detail: <>first termination of container api on {m("…x2kqp")}</>, plain: "first termination of container api on …x2kqp", scope: "…x2kqp" },
    {
      id: "t6",
      ago: "3d",
      kind: "rollout",
      title: "Rollout to revision 14",
      detail: <>image {m("v2.30.4 → v2.31.0")}, ConfigMap checkout-api-config changed</>,
      plain: "image v2.30.4 → v2.31.0, ConfigMap checkout-api-config changed",
      scope: "",
      note: "Resources unchanged · memory limit 256Mi in both revisions",
    },
  ],
  observations: [
    {
      id: "o1",
      text: <>Both failing pods last terminated with <b className="font-semibold">OOMKilled</b> (exit 137) in container {m("api")}.</>,
      plain: "Both failing pods last terminated with OOMKilled (exit 137) in container api.",
      source: "Pod status · lastState ×2",
    },
    {
      id: "o2",
      text: <>Healthy pods use {m("231Mi")} and {m("226Mi")} — 90% and 88% of the {m("256Mi")} limit.</>,
      plain: "Healthy pods use 231Mi and 226Mi — 90% and 88% of the 256Mi limit.",
      source: "metrics-server · now",
    },
    {
      id: "o3",
      text: <>Terminations began <b className="font-semibold">52m ago</b>. Revision 14 was rolled out 3d ago.</>,
      plain: "Terminations began 52m ago. Revision 14 was rolled out 3d ago.",
      source: "Events · ReplicaSet history",
    },
    {
      id: "o4",
      text: "Nodes report no MemoryPressure. Failing pods run on different nodes.",
      plain: "Nodes report no MemoryPressure. Failing pods run on different nodes.",
      source: "Node conditions ×4",
    },
    {
      id: "o5",
      text: <>PDB allows <b className="font-semibold">0 disruptions</b> (2 healthy, minAvailable 3). Evicting or restarting more pods will reduce capacity further.</>,
      plain: "PDB allows 0 disruptions (2 healthy, minAvailable 3). Evicting or restarting more pods will reduce capacity further.",
      source: "PodDisruptionBudget status",
      warning: true,
    },
  ],
  checks: [
    { id: "c1", text: "Compare spec of revision 13 and 14", plain: "Compare spec of revision 13 and 14" },
    { id: "c2", text: <>Read logs of the terminated {m("api")} container</>, plain: "Read logs of the terminated api container", action: "previous-logs" },
    { id: "c3", text: "Memory of all 4 pods over 3 days", plain: "Memory of all 4 pods over 3 days", action: "metrics" },
    { id: "c4", text: <>Same Deployment in {m("prod-us-east-1")}</>, plain: "Same Deployment in prod-us-east-1", action: "compare" },
  ],
  initiallyDone: ["c1"],
};
