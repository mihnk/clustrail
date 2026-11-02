import { expect, test, type Page } from "@playwright/test";
import { openDesktop } from "./fake-backend";

const visible = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true }).first();
const sidebar = (page: Page, name: RegExp) => page.locator("nav, aside").getByRole("button", { name }).first();

test("edits a Secret: only changed, added and removed keys are sent", async ({ page }) => {
  const backend = await openDesktop(page, {
    answers: {
      SecretForEdit: () => ({ resourceVersion: "81423", type: "Opaque", keys: [{ key: "password", bytes: 7 }, { key: "username", bytes: 3 }, { key: "legacy", bytes: 40 }] }),
      UpdateSecret: () => "81424",
    },
  });
  await sidebar(page, /^Secrets/).click();
  await visible(page, "Opaque").click();
  await page.getByRole("tab", { name: "Data" }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(visible(page, "3 bytes · not opened")).toBeVisible();
  const save = page.getByRole("button", { name: /^Save \d+ changes?…$/ });
  await expect(save).toBeDisabled();

  // Open and change the password; username is never opened.
  const row = (key: string) => page.locator("div.rounded-md").filter({ hasText: key }).filter({ visible: true }).first();
  await row("password").getByRole("button", { name: "Show and edit" }).click();
  const pw = page.getByRole("textbox", { name: "Value of password" });
  await expect(pw).toHaveValue("hunter2");
  await pw.fill("n3w-secret");
  await row("legacy").getByRole("button", { name: "Remove" }).click();
  await page.getByRole("button", { name: "Add a key" }).click();
  await page.getByRole("textbox", { name: "Key name" }).fill("bad key");
  await expect(visible(page, /letters, digits, “-”, “_” and “\.” only/)).toBeVisible();
  await expect(save).toBeDisabled();
  await page.getByRole("textbox", { name: "Key name" }).fill("ca.crt");
  await page.getByRole("textbox", { name: "Value of ca.crt" }).fill("-----BEGIN CERTIFICATE-----");
  await expect(page.getByRole("button", { name: "Save 3 changes…" })).toBeEnabled();
  await page.getByRole("button", { name: "Save 3 changes…" }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText(/changed: password · added: ca\.crt · removed: legacy/)).toBeVisible();
  await expect(dialog.getByText("n3w-secret")).toHaveCount(0);
  await dialog.getByRole("textbox").last().fill("prod-eu-west-1/db");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => backend.argsOf("UpdateSecret").length).toBe(1);
  expect(backend.argsOf("UpdateSecret")[0]![0]).toEqual({
    cluster: "prod-eu-west-1", namespace: "payments", name: "db", resourceVersion: "81423",
    set: { password: { value: "n3w-secret" }, "ca.crt": { value: "-----BEGIN CERTIFICATE-----" } },
    remove: ["legacy"],
  });
  // Only the opened key was read.
  expect(backend.argsOf("RevealSecretKey").map((a) => a[3])).toEqual(["password"]);
  expect(backend.errors).toEqual([]);
});

test("an immutable Secret is not editable", async ({ page }) => {
  await openDesktop(page, { answers: { SecretForEdit: () => ({ resourceVersion: "1", type: "Opaque", keys: [], immutable: true }) } });
  await sidebar(page, /^Secrets/).click();
  await visible(page, "Opaque").click();
  await page.getByRole("tab", { name: "Data" }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(visible(page, "It can only be deleted and created again.")).toBeVisible();
});
