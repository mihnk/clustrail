import { expect, test } from "@playwright/test";
import { openDesktop, type FakeBackend } from "./fake-backend";

// First-run setup in the desktop app, its Go side faked at the Wails transport.

const loc = (path: string, state: string, contexts: number) => ({ path, via: "default", state, contexts });
const ctx = (id: string, env: string, server: string, hint?: { word: string; field: string }) => ({
  id,
  name: id,
  cluster: id,
  server,
  auth: "exec · gcloud",
  source: "~/.kube/config",
  current: id === "prod-eu-west-1",
  env,
  hint,
  stored: false,
  protected: env === "prod",
  readOnly: false,
  known: true,
});
const contexts = [ctx("prod-eu-west-1", "prod", "https://34.90.1.1", { word: "prod", field: "context" }), ctx("acme-main", "", "https://k8s.acme.internal:6443")];
const ok = (name: string, detail = "") => ({ name, result: "ok", detail, ms: 12 });
const skipped = (name: string) => ({ name, result: "skipped", detail: "skipped" });
const tests: Record<string, unknown> = {
  "prod-eu-west-1": {
    state: "connected",
    steps: [ok("DNS"), ok("TCP 443"), ok("TLS"), ok("Authentication", "sre-oncall"), ok("API discovery", "v1.30.4 · 20 API groups"), ok("Permissions")],
  },
  "acme-main": {
    state: "auth",
    hint: "gcloud auth login",
    steps: [ok("DNS"), ok("TCP 6443"), ok("TLS"), { name: "Authentication", result: "failed", detail: "Reauthentication failed" }, skipped("API discovery"), skipped("Permissions")],
  },
};

let backend: FakeBackend;
test.afterEach(() => {
  expect(backend.errors, "console errors").toEqual([]);
});

test("first run: contexts, protection, connection test, then the workspace with tips", async ({ page }) => {
  let completed: unknown[] = [];
  backend = await openDesktop(page, {
    answers: {
      Setup: () => ({ needed: true, locations: [loc("~/.kube/config", "found", 2)], contexts }),
      SetupTest: (args) => tests[args[0] as string],
      CompleteSetup: (args) => {
        completed = args;
        return null;
      },
    },
  });
  await expect(page.getByRole("heading", { name: "Welcome to Clustrail" })).toBeVisible();
  await expect(page.getByText("~/.kube/config")).toBeVisible();
  await page.getByRole("button", { name: "Choose contexts" }).click();

  await expect(page.getByRole("heading", { name: "Which clusters do you work with?" })).toBeVisible();
  await expect(page.getByText("2 of 2 selected")).toBeVisible();
  await page.getByRole("button", { name: "Set up protection" }).click();

  // acme-main has no environment word: the user must choose before testing.
  await expect(page.getByText("1 context needs an environment")).toBeVisible();
  await expect(page.getByRole("button", { name: "Test connections" })).toBeDisabled();
  await page.getByRole("radiogroup", { name: "Environment for acme-main" }).getByRole("radio", { name: "PROD" }).click();
  await expect(page.getByRole("combobox", { name: "Protection for acme-main" })).toHaveValue("protected");
  await page.getByRole("button", { name: "Test connections" }).click();

  await expect(page.getByText("Credentials expired")).toBeVisible();
  await expect(page.getByText("gcloud auth login")).toBeVisible();
  await expect(page.getByText("Connected · v1.30.4 · 12ms")).toBeVisible();
  await page.getByRole("button", { name: "Finish with 1 connected" }).click();

  await expect(page.getByText("Setup complete.")).toBeVisible();
  expect(completed).toEqual([
    [
      { id: "prod-eu-west-1", env: "prod", protected: true, readOnly: false },
      { id: "acme-main", env: "prod", protected: true, readOnly: false },
    ],
    ["prod-eu-west-1"],
  ]);
  expect(backend.calls).toContain("Connect");
  await expect(page.getByRole("note", { name: /^Tip 1 of/ })).toBeVisible();
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(page.getByRole("note", { name: /^Tip 2 of/ })).toBeVisible();
  await page.getByRole("button", { name: "Hide all tips" }).click();
  await expect(page.getByText("Setup complete.")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /^Clusters/ })).toBeVisible();
});

test("no kubeconfig yet: a pasted one continues the setup", async ({ page }) => {
  let pasted = "";
  backend = await openDesktop(page, {
    answers: {
      Setup: () =>
        pasted
          ? { needed: true, locations: [loc("~/.kube/clustrail-pasted.yaml", "found", 2)], contexts }
          : { needed: true, locations: [{ path: "$KUBECONFIG", via: "env", state: "unset", contexts: 0 }, loc("~/.kube/config", "missing", 0)], contexts: [] },
      PasteKubeconfig: (args) => {
        pasted = args[0] as string;
        return "~/.kube/clustrail-pasted.yaml";
      },
    },
  });
  await expect(page.getByRole("heading", { name: "No kubeconfig found yet" })).toBeVisible();
  await expect(page.getByText("not set for this app")).toBeVisible();
  await expect(page.getByText("does not exist")).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose contexts" })).toBeDisabled();
  await page.getByRole("button", { name: "Paste…" }).click();
  await page.getByRole("textbox", { name: "Kubeconfig YAML" }).fill("apiVersion: v1\nkind: Config\n");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Welcome to Clustrail" })).toBeVisible();
  expect(pasted).toContain("kind: Config");
});

test("skipping setup opens the workspace", async ({ page }) => {
  backend = await openDesktop(page, { answers: { Setup: () => ({ needed: true, locations: [loc("~/.kube/config", "found", 2)], contexts }) } });
  await page.getByRole("button", { name: "Skip setup" }).click();
  await expect(page.getByRole("tab", { name: /^Pods/ })).toBeVisible();
  expect(backend.calls).toContain("SkipSetup");
});
