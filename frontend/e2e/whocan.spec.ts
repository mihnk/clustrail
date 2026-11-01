import { expect, test } from "@playwright/test";
import { openDesktop } from "./fake-backend";

// Who can? asks the backend and lists subjects with what grants them.
test("who can read a Secret", async ({ page }) => {
  let asked: unknown = null;
  const backend = await openDesktop(page, {
    answers: {
      WhoCan: (args) => {
        asked = args[0];
        return {
          request: args[0], group: "", resource: "secrets", missing: ["ClusterRoleBindings"],
          serviceAccountPods: { "payments/ledger": ["ledger-0"] },
          grants: [
            { subjectKind: "ServiceAccount", subject: "payments/ledger", scope: "payments", binding: "RoleBinding ledger", role: "Role read-ledger", rule: "secrets [ledger-db]: get", ruleYAML: "- apiGroups: [\"\"]\n  resources: [secrets]\n  verbs: [get]", wide: false },
            { subjectKind: "Group", subject: "payments-devs", scope: "payments", binding: "RoleBinding devs", role: "ClusterRole edit", rule: "secrets: get, list, watch", ruleYAML: "", wide: false },
          ],
        };
      },
    },
  });
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Who can");
  await page.keyboard.press("Enter");
  await page.getByLabel("Namespace").fill("payments");
  await page.getByLabel("Name (optional)").fill("ledger-db");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByText("2 subjects can get Secret ledger-db")).toBeVisible();
  expect(asked).toMatchObject({ verb: "get", kind: "Secret", namespace: "payments", name: "ledger-db" });
  await expect(page.getByText("Incomplete: these could not be listed with your access: ClusterRoleBindings.")).toBeVisible();
  // The first subject is selected: its rule and the pods that run as it.
  await expect(page.getByLabel("Selected subject").getByText("ledger-0")).toBeVisible();
  await page.getByRole("row", { name: /payments-devs/ }).click();
  await expect(page.getByLabel("Selected subject").getByText("payments-devs")).toBeVisible();
  expect(backend.errors).toEqual([]);
});
