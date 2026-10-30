import type { HelmRelease } from "@/data/helm";
import { t } from "@/i18n";

/** The Helm upgrade tab of one release; opening it again focuses the same tab. */
export function upgradeTab(r: Pick<HelmRelease, "cluster" | "namespace" | "name">) {
  return {
    id: `helm-upgrade:${r.cluster}/${r.namespace}/${r.name}`,
    kind: "helm-upgrade" as const,
    title: t("Upgrade · {name}", { name: r.name }),
    cluster: r.cluster,
    params: { namespace: r.namespace, name: r.name },
  };
}
