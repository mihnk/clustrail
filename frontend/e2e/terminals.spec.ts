import { expect, test, type Page } from "@playwright/test";
import { openDesktop } from "./fake-backend";

const visible = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true }).first();
const POD = "checkout-api-7d9f8b6c4-9rkzd";

test("attaches to a pod's main process, output only without stdin", async ({ page }) => {
  const backend = await openDesktop(page, { answers: { StartAttach: () => ({ id: "exec-attach-1", stdin: false, tty: false }) } });
  await page.getByRole("tab", { name: /^Pods/ }).click();
  await visible(page, POD).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Attach/ }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText(/kubectl --context prod-eu-west-1 -n payments attach -it/)).toBeVisible();
  // Production: the name is typed first.
  await dialog.getByRole("textbox").last().fill(`prod-eu-west-1/${POD}`);
  await dialog.getByRole("button", { name: "Attach" }).click();
  await expect.poll(() => backend.argsOf("StartAttach").length).toBe(1);
  expect(backend.argsOf("StartAttach")[0]![0]).toMatchObject({ cluster: "prod-eu-west-1", namespace: "payments", pod: POD, container: "" });
  await expect(page.locator(".xterm").filter({ visible: true }).first()).toContainText("output only");
  await backend.emit("clustrail:exec", { id: "exec-attach-1", data: btoa("batch 4182 ok\r\n") });
  await expect(page.locator(".xterm").filter({ visible: true }).first()).toContainText("batch 4182 ok");
  await expect(visible(page, "attached")).toBeVisible();
  expect(backend.argsOf("StartExec")).toHaveLength(0);
});

test("opens a local terminal with the cluster's context", async ({ page }) => {
  const backend = await openDesktop(page, { answers: { StartLocalShell: () => ({ id: "exec-local-1", shell: "/bin/zsh", context: "prod-eu-west-1" }) } });
  await page.keyboard.press("Control+k");
  await page.keyboard.type("local terminal");
  await page.getByRole("option", { name: /Local terminal · prod-eu-west-1/ }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText(/temporary file that holds only this context/)).toBeVisible();
  await dialog.getByRole("textbox").last().fill("prod-eu-west-1/prod-eu-west-1");
  await dialog.getByRole("button", { name: "Open terminal" }).click();
  await expect.poll(() => backend.argsOf("StartLocalShell").length).toBe(1);
  expect(backend.argsOf("StartLocalShell")[0]![0]).toMatchObject({ cluster: "prod-eu-west-1" });
  const term = page.locator(".xterm").filter({ visible: true }).first();
  await expect(term).toContainText("/bin/zsh on this machine");
  await expect(term).toContainText("context prod-eu-west-1");
  await expect(visible(page, "this machine")).toBeVisible();
  await page.locator(".xterm-helper-textarea").filter({ visible: true }).first().pressSequentially("kubectl get ns\r");
  await expect.poll(() => backend.argsOf("ExecInput").map((a) => a[1]).join("")).toContain("kubectl get ns");
  expect(backend.argsOf("ExecInput")[0]![0]).toBe("exec-local-1");
});
