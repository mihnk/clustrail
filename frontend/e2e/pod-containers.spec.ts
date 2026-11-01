import { expect, test } from "@playwright/test";
import { openDesktop } from "./fake-backend";

const visible = (page: import("@playwright/test").Page, text: string | RegExp) => page.getByText(text).filter({ visible: true }).first();

// The Containers tab reads the live pod: env with references, mounts, probes.
test("pod containers from the live pod", async ({ page }) => {
  const backend = await openDesktop(page, {
    answers: {
      PodContainers: () => ({
        serviceAccount: "checkout-api", qosClass: "Burstable", node: "ip-10-42-3-17",
        containers: [
          { name: "migrate", type: "init", image: "migrate:1", command: ["./migrate", "up"], args: [], ports: [], requests: {}, limits: {}, env: [], envFrom: [], mounts: [], probes: [], security: [] },
          {
            name: "api", type: "main", image: "ghcr.io/acme/checkout-api:2.14.1", imageID: "ghcr.io/acme/checkout-api@sha256:9f1c0000000000000000000000000000a71e",
            command: ["java"], args: ["-jar", "/app/app.jar"], ports: [{ name: "http", port: 8080, protocol: "TCP" }],
            requests: { cpu: "250m", memory: "256Mi" }, limits: { memory: "256Mi" },
            env: [
              { name: "PROFILE", value: "prod" },
              { name: "API_TOKEN", hidden: true },
              { name: "DB_PASSWORD", from: "Secret", ref: "ledger-db", key: "password" },
              { name: "POD_IP", from: "field", ref: "status.podIP" },
            ],
            envFrom: [{ kind: "ConfigMap", name: "checkout-config", prefix: "APP_" }],
            mounts: [
              { path: "/etc/checkout", volume: "config", source: "ConfigMap checkout-config", kind: "ConfigMap", ref: "checkout-config", readOnly: true },
              { path: "/tmp", volume: "tmp", source: "emptyDir (Memory, 64Mi)" },
            ],
            probes: [{ kind: "liveness", action: "GET :8080/healthz", initialDelay: 20, period: 10, timeout: 1, failureThreshold: 3, successThreshold: 1 }],
            security: ["runAsNonRoot", "drop ALL"],
          },
        ],
      }),
    },
  });
  await page.getByRole("tab", { name: /^Pods/ }).click();
  await visible(page, "checkout-api-7d9f8b6c4-x2kqp").click();
  await page.getByRole("tab", { name: /^Containers/ }).click();
  await expect(visible(page, "ServiceAccount checkout-api · QoS Burstable")).toBeVisible();
  // The main container is shown first.
  await expect(visible(page, "ghcr.io/acme/checkout-api:2.14.1")).toBeVisible();
  await expect(visible(page, "sha256:9f1c…a71e")).toBeVisible();
  await expect(visible(page, "java")).toBeVisible();
  await expect(visible(page, "cpu 250m / — · memory 256Mi / 256Mi")).toBeVisible();
  await expect(visible(page, "•••••• (name looks secret)")).toBeVisible();
  await expect(visible(page, "field status.podIP")).toBeVisible();
  await expect(visible(page, "emptyDir (Memory, 64Mi)")).toBeVisible();
  await expect(visible(page, "GET :8080/healthz · delay 20s · every 10s · timeout 1s · 3 failures")).toBeVisible();
  await expect(visible(page, "runAsNonRoot · drop ALL")).toBeVisible();

  // A Secret reference opens the Secret.
  await page.getByRole("button", { name: "Secret ledger-db / password" }).click();
  await expect(page.getByRole("tab", { name: /ledger-db/ })).toBeVisible();

  // The init container.
  await page.getByRole("tab", { name: /^Pods/ }).click();
  await page.getByRole("tab", { name: /init:\s*migrate/ }).click();
  await expect(visible(page, "./migrate up")).toBeVisible();
  await expect(visible(page, "None: the kubelet treats the container as ready once it runs.")).toBeVisible();
  expect(backend.argsOf("PodContainers")[0]).toEqual(["prod-eu-west-1", "payments", "checkout-api-7d9f8b6c4-x2kqp"]);
  expect(backend.errors).toEqual([]);
});
