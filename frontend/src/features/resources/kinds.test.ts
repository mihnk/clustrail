import { describe, expect, it } from "vitest";
import type { KindInfo } from "@/backend/client";
import { customGroups, LISTED_KINDS, NAV_GROUPS, served } from "./kinds";

const k = (group: string, kind: string, custom = true): KindInfo => ({ group, kind, version: "v1", resource: kind.toLowerCase() + "s", namespaced: true, delete: true, custom });

describe("sidebar kinds", () => {
  it("every list entry has a label", () => {
    const keys = new Set(LISTED_KINDS.map((x) => x.key));
    for (const g of NAV_GROUPS) for (const e of g.entries) if ("list" in e) expect(keys.has(e.list), e.list).toBe(true);
  });

  it("shows every entry until a cluster reports its kinds", () => {
    expect(served("coordination.k8s.io/Lease", null)).toBe(true);
    expect(served("coordination.k8s.io/Lease", new Set(["Pod"]))).toBe(false);
    expect(served("Pod", new Set(["Pod"]))).toBe(true);
  });

  it("groups custom kinds by API group, once each", () => {
    const groups = customGroups([k("monitoring.coreos.com", "ServiceMonitor"), k("cert-manager.io", "Issuer"), k("cert-manager.io", "Certificate"), k("cert-manager.io", "Certificate"), k("apps", "Deployment", false)]);
    expect(groups.map((g) => g.group)).toEqual(["cert-manager.io", "monitoring.coreos.com"]);
    expect(groups[0]!.kinds.map((x) => x.kind)).toEqual(["Certificate", "Issuer"]);
  });
});
