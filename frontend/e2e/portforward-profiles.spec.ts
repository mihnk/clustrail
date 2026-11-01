import { expect, test } from "@playwright/test";
import { openDesktop } from "./fake-backend";

// Port forwards: saved profiles start with one click; a new profile is saved with what was typed.
test("port-forward profiles: start one, save a new one", async ({ page }) => {
  const saved: unknown[] = [];
  const backend = await openDesktop(page, {
    answers: {
      PortForwardProfiles: () => [
        { id: "pfp-1", name: "ledger DB", group: "payments dev", cluster: "prod-eu-west-1", namespace: "payments", kind: "Service", target: "ledger-db", port: 5432, localPort: 15432, reconnect: true },
        {
          id: "pfp-2", name: "checkout API", cluster: "prod-eu-west-1", namespace: "payments", kind: "Deployment", target: "checkout-api", port: 8080, localPort: 8080, reconnect: true,
          forward: { id: "pf-1", cluster: "prod-eu-west-1", namespace: "payments", kind: "Deployment", name: "checkout-api", port: 8080, localPort: 8080, state: "reconnecting", attempt: 3, error: "pod restarted", started: "", profileId: "pfp-2" },
        },
      ],
      StartPortForwardProfile: (args) => ({ id: "pf-2", profileId: args[0], state: "active" }),
      SavePortForwardProfile: (args) => (saved.push(args[0]), { ...(args[0] as object), id: "pfp-3" }),
    },
  });
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Port forwards");
  await page.keyboard.press("Enter");
  const table = page.getByRole("table", { name: "Profiles" });
  await expect(table.getByText("ledger DB")).toBeVisible();
  await expect(table.getByText("Reconnecting · attempt 3")).toBeVisible();
  await table.getByRole("row", { name: /ledger DB/ }).getByRole("button", { name: "Start" }).click();
  await expect.poll(() => backend.argsOf("StartPortForwardProfile")[0]?.[0]).toBe("pfp-1");

  await page.getByRole("button", { name: "New profile" }).click();
  const editor = page.getByRole("complementary", { name: "New profile" });
  await editor.getByLabel("Name", { exact: true }).fill("Grafana");
  await editor.getByLabel("Namespace").fill("monitoring");
  await editor.getByLabel("Target name").fill("grafana");
  await editor.getByLabel("Port", { exact: true }).fill("80");
  await editor.getByLabel("Local port").fill("3000");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toMatchObject({ id: "", name: "Grafana", kind: "Service", namespace: "monitoring", target: "grafana", port: 80, localPort: 3000, reconnect: true });
  expect(backend.errors).toEqual([]);
});
