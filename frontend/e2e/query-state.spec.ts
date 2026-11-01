import { expect, test, type Page } from "@playwright/test";
import { openDesktop } from "./fake-backend";

// Query state (issue E5): the latest answer wins, and a failed request never
// leaves a view waiting.

const sidebar = (page: Page, name: RegExp) => page.locator("nav, aside").getByRole("button", { name }).first();
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a quick cluster switch never shows the older cluster's answer", async ({ page }) => {
  await openDesktop(page, {
    patch: (d) => {
      d.list.selected = ["prod-eu-west-1", "staging-eu-1"];
    },
    answers: {
      // prod answers last, and with an error: neither may touch staging's namespaces.
      Namespaces: async (args) => {
        if (args[0] === "prod-eu-west-1") {
          await later(1500);
          throw new Error("dial tcp 10.0.0.1:443: i/o timeout");
        }
        return ["staging-only", "default"];
      },
    },
  });
  await sidebar(page, /^Access/).click();
  const clusterSelect = page.getByRole("combobox", { name: "Cluster" });
  await expect(clusterSelect).toHaveValue("prod-eu-west-1");
  await clusterSelect.selectOption("staging-eu-1");
  const nsSelect = page.getByRole("combobox", { name: "Namespace" });
  await expect(nsSelect).toHaveValue("default");
  await expect(nsSelect.locator("option", { hasText: "staging-only" })).toHaveCount(1);
  await later(2000); // prod's late failure has come and gone
  await expect(nsSelect.locator("option", { hasText: "staging-only" })).toHaveCount(1);
  await expect(nsSelect).toHaveValue("default");
});

test("a failed drain preflight says so and can be retried, instead of waiting forever", async ({ page }) => {
  let calls = 0;
  const backend = await openDesktop(page, {
    answers: {
      PreviewDrain: () => {
        // The first attempt and its one retry fail; the retry the user asks for works.
        if (++calls <= 2) throw new Error("connection refused");
        return { evict: ["payments/api-1", "payments/api-2"], emptyDir: [], unmanaged: [], daemonSet: [], pdbBlocked: [], pdb: "" };
      },
    },
  });
  await sidebar(page, /^Nodes/).click();
  await page.getByRole("gridcell", { name: /ip-10-42-3-17/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Drain…/ }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText(/Could not check the pods: connection refused/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Drain node" })).toBeDisabled();
  expect(calls).toBe(2); // one retry, not a storm
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.getByText("checked just now")).toBeVisible();
  await expect(dialog.getByText("Preflight · 2 pods on this node")).toBeVisible();
  expect(backend.errors.filter((e) => !/status of 500/.test(e))).toEqual([]);
});
