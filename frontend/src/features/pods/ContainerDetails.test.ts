import { describe, expect, it } from "vitest";
import { probeText, resourcesText, shortDigest } from "./ContainerDetails";

describe("container details", () => {
  it("pairs requests and limits per resource", () => {
    expect(resourcesText({ requests: { cpu: "250m", memory: "256Mi" }, limits: { memory: "512Mi" } })).toBe("cpu 250m / — · memory 256Mi / 512Mi");
    expect(resourcesText({ requests: {}, limits: {} })).toBe("");
  });

  it("states a probe with the kubelet's defaults filled in", () => {
    expect(probeText({ kind: "readiness", action: "TCP :5432", initialDelay: 0, period: 0, timeout: 0, failureThreshold: 0, successThreshold: 0 })).toBe("TCP :5432 · every 10s · timeout 1s · 3 failures");
    expect(probeText({ kind: "liveness", action: "GET :8080/healthz", initialDelay: 20, period: 5, timeout: 2, failureThreshold: 6, successThreshold: 2 })).toBe("GET :8080/healthz · delay 20s · every 5s · timeout 2s · 6 failures · 2 successes");
  });

  it("shortens digests", () => {
    expect(shortDigest("ghcr.io/acme/api@sha256:9f1c0000000000000000a71e")).toBe("sha256:9f1c…a71e");
    expect(shortDigest("docker-pullable://nginx@sha256:abcd")).toBe("sha256:abcd");
    expect(shortDigest("")).toBe("");
  });
});
