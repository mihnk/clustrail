import type { KindInfo } from "@/backend/client";
import { t } from "@/i18n";

/** The key the backend resolves: "Kind" for the core group, else "group/Kind". */
export function kindKey(k: Pick<KindInfo, "group" | "kind">): string {
  return k.group ? `${k.group}/${k.kind}` : k.kind;
}

/** "apps/StatefulSet" → "StatefulSet". */
export function kindName(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

/** Lists the sidebar links to directly; everything else is one ⌘J away. */
export const LISTED_KINDS: { key: string; label: string }[] = [
  { key: "apps/StatefulSet", label: t("StatefulSets") },
  { key: "apps/DaemonSet", label: t("DaemonSets") },
  { key: "batch/Job", label: t("Jobs") },
  { key: "batch/CronJob", label: t("CronJobs") },
  { key: "Service", label: t("Services") },
  { key: "networking.k8s.io/Ingress", label: t("Ingresses") },
  { key: "ConfigMap", label: t("ConfigMaps") },
  { key: "Secret", label: t("Secrets") },
  { key: "Event", label: t("Events") },
  { key: "apps/ReplicaSet", label: t("ReplicaSets") },
  { key: "autoscaling/HorizontalPodAutoscaler", label: t("HorizontalPodAutoscalers") },
  { key: "policy/PodDisruptionBudget", label: t("PodDisruptionBudgets") },
  { key: "scheduling.k8s.io/PriorityClass", label: t("PriorityClasses") },
  { key: "node.k8s.io/RuntimeClass", label: t("RuntimeClasses") },
  { key: "coordination.k8s.io/Lease", label: t("Leases") },
  { key: "admissionregistration.k8s.io/MutatingWebhookConfiguration", label: t("Mutating webhooks") },
  { key: "admissionregistration.k8s.io/ValidatingWebhookConfiguration", label: t("Validating webhooks") },
  { key: "discovery.k8s.io/EndpointSlice", label: t("EndpointSlices") },
  { key: "networking.k8s.io/IngressClass", label: t("IngressClasses") },
  { key: "PersistentVolumeClaim", label: t("PersistentVolumeClaims") },
  { key: "PersistentVolume", label: t("PersistentVolumes") },
  { key: "storage.k8s.io/StorageClass", label: t("StorageClasses") },
  { key: "ServiceAccount", label: t("ServiceAccounts") },
  { key: "rbac.authorization.k8s.io/Role", label: t("Roles") },
  { key: "rbac.authorization.k8s.io/RoleBinding", label: t("RoleBindings") },
  { key: "rbac.authorization.k8s.io/ClusterRole", label: t("ClusterRoles") },
  { key: "rbac.authorization.k8s.io/ClusterRoleBinding", label: t("ClusterRoleBindings") },
  { key: "Namespace", label: t("Namespaces") },
  { key: "apiextensions.k8s.io/CustomResourceDefinition", label: t("Definitions") },
];

/** A sidebar entry: a resource list (generic view) or one of Clustrail's own views. */
export type NavEntry = { list: string } | { view: "pods" | "deployments" | "storage" | "network" | "portforwards" | "quotas" | "chain"; label: string };

/** The sidebar's groups, in Lens's order. */
export const NAV_GROUPS: { id: string; title: string; entries: NavEntry[] }[] = [
  {
    id: "workloads",
    title: t("Workloads"),
    entries: [
      { view: "pods", label: t("Pods") },
      { view: "deployments", label: t("Deployments") },
      { list: "apps/StatefulSet" },
      { list: "apps/DaemonSet" },
      { list: "apps/ReplicaSet" },
      { list: "batch/Job" },
      { list: "batch/CronJob" },
    ],
  },
  {
    id: "config",
    title: t("Config"),
    entries: [
      { list: "ConfigMap" },
      { list: "Secret" },
      { list: "autoscaling/HorizontalPodAutoscaler" },
      { list: "policy/PodDisruptionBudget" },
      { view: "quotas", label: t("Quotas and limits") },
      { list: "scheduling.k8s.io/PriorityClass" },
      { list: "node.k8s.io/RuntimeClass" },
      { list: "coordination.k8s.io/Lease" },
      { list: "admissionregistration.k8s.io/MutatingWebhookConfiguration" },
      { list: "admissionregistration.k8s.io/ValidatingWebhookConfiguration" },
    ],
  },
  {
    id: "network",
    title: t("Network"),
    entries: [
      { list: "Service" },
      { list: "discovery.k8s.io/EndpointSlice" },
      { list: "networking.k8s.io/Ingress" },
      { list: "networking.k8s.io/IngressClass" },
      { view: "network", label: t("Network policies") },
      { view: "chain", label: t("Service chain") },
      { view: "portforwards", label: t("Port forwards") },
    ],
  },
  {
    id: "storage",
    title: t("Storage"),
    entries: [{ view: "storage", label: t("Storage") }, { list: "PersistentVolumeClaim" }, { list: "PersistentVolume" }, { list: "storage.k8s.io/StorageClass" }],
  },
  {
    id: "access",
    title: t("Access control"),
    entries: [
      { list: "ServiceAccount" },
      { list: "rbac.authorization.k8s.io/Role" },
      { list: "rbac.authorization.k8s.io/RoleBinding" },
      { list: "rbac.authorization.k8s.io/ClusterRole" },
      { list: "rbac.authorization.k8s.io/ClusterRoleBinding" },
    ],
  },
];

/** Groups folded until opened. */
export const NAV_FOLDED_BY_DEFAULT = ["access", "custom"];

/**
 * Whether a list entry is shown: when no cluster has reported its kinds yet,
 * every entry; otherwise only kinds some selected cluster serves.
 */
export function served(key: string, servedKeys: Set<string> | null): boolean {
  return !servedKeys || servedKeys.has(key);
}

/** Custom kinds by API group, groups and kinds sorted. */
export function customGroups(kinds: KindInfo[]): { group: string; kinds: KindInfo[] }[] {
  const by = new Map<string, Map<string, KindInfo>>();
  for (const k of kinds) {
    if (!k.custom) continue;
    let g = by.get(k.group);
    if (!g) by.set(k.group, (g = new Map()));
    if (!g.has(k.kind)) g.set(k.kind, k);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, m]) => ({ group, kinds: [...m.values()].sort((a, b) => a.kind.localeCompare(b.kind)) }));
}

export function plural(kind: string): string {
  if (/(s|x|ch|sh)$/.test(kind)) return `${kind}es`;
  if (/[^aeiou]y$/.test(kind)) return `${kind.slice(0, -1)}ies`;
  return `${kind}s`;
}

export function listLabel(key: string): string {
  return LISTED_KINDS.find((k) => k.key === key)?.label ?? plural(kindName(key));
}

/** kubectl's resource argument for a kind, e.g. "cronjobs.batch". */
export function kubectlResource(key: string): string {
  const slash = key.lastIndexOf("/");
  const name = plural(kindName(key)).toLowerCase();
  return slash < 0 || key.startsWith("apps/") ? name : `${name}.${key.slice(0, slash)}`;
}

/** Starting YAML for "Create from YAML". */
export function templateFor(key: string, namespace: string): string {
  const ns = namespace || "default";
  switch (key) {
    case "ConfigMap":
      return `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n  namespace: ${ns}\ndata:\n  KEY: value\n`;
    case "Service":
      return `apiVersion: v1\nkind: Service\nmetadata:\n  name: my-service\n  namespace: ${ns}\nspec:\n  selector:\n    app: my-app\n  ports:\n    - port: 80\n      targetPort: 8080\n`;
    case "networking.k8s.io/Ingress":
      return `apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: my-ingress\n  namespace: ${ns}\nspec:\n  rules:\n    - host: example.internal\n      http:\n        paths:\n          - path: /\n            pathType: Prefix\n            backend:\n              service:\n                name: my-service\n                port:\n                  number: 80\n`;
    case "batch/Job":
      return `apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: my-job\n  namespace: ${ns}\nspec:\n  backoffLimit: 2\n  template:\n    spec:\n      restartPolicy: Never\n      containers:\n        - name: main\n          image: busybox:1.36\n          command: ["sh", "-c", "echo done"]\n`;
    case "batch/CronJob":
      return `apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: my-cronjob\n  namespace: ${ns}\nspec:\n  schedule: "0 * * * *"\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          restartPolicy: Never\n          containers:\n            - name: main\n              image: busybox:1.36\n              command: ["sh", "-c", "date"]\n`;
    default:
      return `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: my-app\n  namespace: ${ns}\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: my-app\n  template:\n    metadata:\n      labels:\n        app: my-app\n    spec:\n      containers:\n        - name: app\n          image: nginx:1.27-alpine\n`;
  }
}

/** The detail tab of one object; opening it again focuses the same tab. */
export function resourceTab(cluster: string, kind: string, namespace: string, name: string) {
  return {
    id: `res:${cluster}/${kind}/${namespace}/${name}`,
    kind: "resource" as const,
    title: name,
    subtitle: kindName(kind),
    cluster,
    params: { kind, namespace, name },
  };
}
