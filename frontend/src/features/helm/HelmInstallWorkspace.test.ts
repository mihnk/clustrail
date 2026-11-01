import { describe, expect, it } from "vitest";
import { durationSeconds, installCommand } from "./HelmInstallWorkspace";

describe("helm install", () => {
  it("reads durations", () => {
    expect(durationSeconds("5m")).toBe(300);
    expect(durationSeconds("90s")).toBe(90);
    expect(durationSeconds("7")).toBe(420);
    expect(durationSeconds("5h")).toBeNaN();
  });

  it("writes the equivalent command", () => {
    const r = { namespace: "obs", name: "g", repo: "grafana", chart: "grafana", version: "8.4.0", createNamespace: false, wait: false, atomic: false };
    expect(installCommand("ctx", r, "5m")).toBe("helm --kube-context ctx -n obs install g grafana/grafana --version 8.4.0 -f values.yaml --timeout 5m");
    expect(installCommand("ctx", { ...r, createNamespace: true, atomic: true }, "")).toBe("helm --kube-context ctx -n obs install g grafana/grafana --version 8.4.0 --create-namespace -f values.yaml --wait --atomic --timeout 5m");
  });
});
