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
];

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
