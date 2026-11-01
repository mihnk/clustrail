import { expect, test } from "@playwright/test";
import { openDesktop } from "./fake-backend";

// Settings › Notifications saves the namespaces to watch; an alert in front shows as a toast that opens the pod.
test("notifications: pick a namespace, get a toast, open the pod", async ({ page }) => {
  const saved: unknown[] = [];
  const backend = await openDesktop(page, {
    answers: {
      NotificationSettings: () => ({ enabled: true, scopes: {}, crashLoop: true, oomKilled: true, rollout: true }),
      SetNotificationSettings: (args) => (saved.push(args[0]), null),
      Alerts: () => [{ id: "a1", kind: "rollout", cluster: "prod-eu-west-1", namespace: "payments", objectKind: "Deployment", object: "checkout-api", title: "Rollout stuck · checkout-api rev 42", detail: "ProgressDeadlineExceeded", at: Date.now() }],
      TestNotification: () => false,
    },
  });
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Settings");
  await page.keyboard.press("Enter");
  const section = page.getByRole("region", { name: "Notifications" });
  await expect(section.getByText("Rollout stuck · checkout-api rev 42")).toBeVisible();
  const add = section.getByLabel("Add a namespace on prod-eu-west-1");
  await add.fill("payments");
  await add.press("Enter");
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toMatchObject({ enabled: true, scopes: { "prod-eu-west-1": ["payments"] } });
  await expect(section.getByRole("button", { name: "Stop watching payments on prod-eu-west-1" })).toBeVisible();

  // The window is in front: the alert is a toast; Open reveals the pod.
  await page.evaluate(() => window.focus());
  await backend.emit("clustrail:alert", {
    id: "a2", kind: "crashloop", cluster: "prod-eu-west-1", namespace: "payments", objectKind: "Pod", object: "checkout-api-7d9f8b6c4-x2kqp",
    title: "CrashLoopBackOff · checkout-api-7d9f8b6c4-x2kqp", detail: "container api keeps restarting (7 restarts)", at: Date.now(),
  });
  const toast = page.getByRole("listitem").filter({ hasText: "CrashLoopBackOff · checkout-api-7d9f8b6c4-x2kqp" });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("tab", { name: /^Pods/ })).toHaveAttribute("aria-selected", "true");
  expect(backend.errors).toEqual([]);
});
