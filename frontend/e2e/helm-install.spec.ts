import { expect, test, type Page } from "@playwright/test";
import { openDesktop } from "./fake-backend";

const visible = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true }).first();
const palette = async (page: Page, entry: string) => {
  await page.keyboard.press("Control+k");
  await page.keyboard.type(entry);
  await page.keyboard.press("Enter");
};

test("installs a chart after previewing its objects", async ({ page }) => {
  const backend = await openDesktop(page, {
    answers: {
      HelmCharts: (args) => ({
        charts: [
          { repo: "grafana", name: "grafana", version: "8.5.2", appVersion: "11.3.0", description: "Dashboards", versions: [{ repo: "grafana", version: "8.5.2" }, { repo: "grafana", version: "8.4.0" }] },
          { repo: "bitnami", name: "redis", version: "20.0.0", description: "Key-value store", versions: [{ repo: "bitnami", version: "20.0.0" }] },
        ].filter((c) => !args[0] || c.name.includes(String(args[0]))),
      }),
      HelmChartDefaults: () => "replicas: 1\npersistence:\n  enabled: false\n",
      PlanHelmInstall: () => ({
        chart: "grafana", version: "8.4.0", appVersion: "11.2.0", hooks: 1, valueKeys: ["persistence"], renderedOnly: true,
        objects: [
          { kind: "ConfigMap", name: "grafana", namespace: "observability", change: "added", after: "apiVersion: v1\nkind: ConfigMap\n" },
          { kind: "Deployment", name: "grafana", namespace: "observability", change: "added", after: "apiVersion: apps/v1\nkind: Deployment\n" },
        ],
      }),
      InstallRelease: () => "helm-in-1",
    },
  });
  await palette(page, "Helm releases");
  await page.getByRole("button", { name: "Install chart…" }).click();
  const form = page.getByRole("region", { name: "Chart and values" });
  await page.getByRole("textbox", { name: "Search charts" }).fill("graf");
  await page.getByRole("option", { name: /grafana\/grafana/ }).click();
  await expect(form.getByRole("textbox", { name: "Release name" })).toHaveValue("grafana");
  await form.getByLabel("Version").selectOption("8.4.0");
  await form.getByRole("textbox", { name: "Namespace" }).fill("observability");
  await page.getByRole("button", { name: "Show chart defaults" }).click();
  const values = page.getByRole("textbox", { name: "Values" });
  await expect(values).toHaveValue(/persistence:/);
  await values.fill("persistence:\n  enabled: true\n");

  const install = page.getByRole("button", { name: "Install…" });
  await expect(install).toBeDisabled();
  await page.getByRole("button", { name: "Preview objects" }).click();
  await expect(visible(page, "2 added")).toBeVisible();
  await expect(visible(page, /rendered only: the namespace does not exist yet/)).toBeVisible();
  expect(backend.argsOf("PlanHelmInstall")[0]![0]).toMatchObject({ cluster: "prod-eu-west-1", namespace: "observability", name: "grafana", repo: "grafana", chart: "grafana", version: "8.4.0", createNamespace: true, values: "persistence:\n  enabled: true\n" });
  await expect(visible(page, /helm --kube-context .* -n observability install grafana grafana\/grafana --version 8\.4\.0 --create-namespace -f values\.yaml --wait --atomic --timeout 5m/)).toBeVisible();

  // A change after the preview asks for a new one.
  await form.getByRole("textbox", { name: "Release name" }).fill("grafana-2");
  await expect(install).toBeDisabled();
  await form.getByRole("textbox", { name: "Release name" }).fill("Bad_Name");
  await expect(visible(page, "Lowercase letters, digits and dashes")).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview objects" })).toBeDisabled();
  await form.getByRole("textbox", { name: "Release name" }).fill("grafana");
  await page.getByRole("button", { name: "Preview objects" }).click();
  await install.click();
  const confirm = page.getByRole("alertdialog");
  await confirm.getByRole("textbox").fill("prod-eu-west-1/grafana");
  await confirm.getByRole("button", { name: "Install" }).click();
  await expect.poll(() => backend.argsOf("InstallRelease").length).toBe(1);
  expect(backend.errors).toEqual([]);
});

test("uninstalls a release from its menu", async ({ page }) => {
  const backend = await openDesktop(page, { answers: { UninstallRelease: () => "helm-un-1" } });
  await palette(page, "Helm releases");
  await visible(page, "payments-workers").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Uninstall, keep history/ }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByText(/Helm deletes the \d+ objects of the release/)).toBeVisible();
  await expect(confirm.getByText(/Its history stays/)).toBeVisible();
  await expect(confirm.getByText(/uninstall payments-workers --keep-history/)).toBeVisible();
  await confirm.getByRole("textbox").fill("prod-eu-west-1/payments-workers");
  await confirm.getByRole("button", { name: "Uninstall" }).click();
  await expect.poll(() => backend.argsOf("UninstallRelease")[0]).toEqual(["prod-eu-west-1", "payments", "payments-workers", true]);
  expect(backend.errors).toEqual([]);
});
