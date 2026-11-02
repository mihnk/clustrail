import { useState } from "react";
import { KeyRound, Plus, TriangleAlert, Undo2 } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { backend, errorText, type SecretEditInfo, type SecretUpdate } from "@/backend/client";
import { useConfirm } from "@/components/safety/ConfirmationDialog";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { useQuery } from "@/lib/useQuery";
import { t } from "@/i18n";

const KEY_RE = /^[-._a-zA-Z0-9]+$/;

/** One key in the editor. original: the value as revealed (undefined while not opened). */
export interface EditRow {
  key: string;
  bytes?: number;
  added?: boolean;
  removed?: boolean;
  original?: string;
  value?: string;
  binary?: boolean;
}

/** What a save sends: only keys whose value differs from what was revealed, new keys, and removals. */
export function editPlan(rows: EditRow[], resourceVersion: string, target: { cluster: string; namespace: string; name: string }): SecretUpdate {
  const u: SecretUpdate = { ...target, resourceVersion, set: {}, remove: [] };
  for (const r of rows) {
    if (r.removed) {
      if (!r.added) u.remove.push(r.key);
    } else if (r.added || (r.value !== undefined && r.value !== r.original)) u.set[r.key] = { value: r.value ?? "", binary: r.binary || undefined };
  }
  return u;
}

/** Problems that keep a save from starting. */
export function editProblems(rows: EditRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.removed) continue;
    if (!KEY_RE.test(r.key)) out.push(t("Key “{k}”: letters, digits, “-”, “_” and “.” only", { k: r.key }));
    if (seen.has(r.key)) out.push(t("Key “{k}” appears twice", { k: r.key }));
    seen.add(r.key);
    if (r.binary && r.value !== undefined && !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(r.value)) out.push(t("Key “{k}”: not valid base64", { k: r.key }));
  }
  return out;
}

/**
 * Edits a Secret with decoded values. Values stay hidden until a key is
 * opened; only changed, added and removed keys are saved. The save carries
 * the version that was opened, so a change made meanwhile is refused.
 */
export function SecretEditor({ cluster, namespace, name, onDone }: { cluster: string; namespace: string; name: string; onDone: () => void }) {
  const ws = useWorkspace();
  const c = ws.clusterById(cluster);
  const { confirm } = useConfirm();
  const toast = useToast();
  const q = useQuery<SecretEditInfo>(backend ? `secretForEdit|${cluster}|${namespace}|${name}` : null, () => backend!.secretForEdit(cluster, namespace, name));
  const [rows, setRows] = useState<EditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const info = q.data;
  const list: EditRow[] = rows ?? info?.keys.map((k) => ({ key: k.key, bytes: k.bytes })) ?? [];
  const update = (i: number, patch: Partial<EditRow>) => setRows(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  if (q.error) return <Banner tone="warning">{q.error}</Banner>;
  if (!info) return <p className="m-0 text-ui text-fg-muted">{t("Reading the Secret…")}</p>;
  if (info.immutable)
    return (
      <Banner tone="info" title={t("Immutable Secret")}>
        {t("It can only be deleted and created again.")} <button type="button" className="focus-ring text-accent hover:underline" onClick={onDone}>{t("Back")}</button>
      </Banner>
    );

  const open = (i: number) => {
    const r = list[i]!;
    void backend!
      .revealSecretKey(cluster, namespace, name, r.key)
      .then((v) => update(i, { original: v.value, value: v.value, binary: v.binary }))
      .catch((e) => setError(errorText(e)));
  };
  const plan = editPlan(list, info.resourceVersion, { cluster, namespace, name });
  const changed = Object.keys(plan.set).filter((k) => !list.find((r) => r.key === k)?.added);
  const added = list.filter((r) => r.added && !r.removed).map((r) => r.key);
  const count = changed.length + added.length + plan.remove.length;
  const problems = editProblems(list);

  const save = () =>
    confirm({
      action: t("Save Secret"),
      targetName: name,
      icon: <KeyRound />,
      env: c?.env ?? "dev",
      cluster,
      namespace,
      protected: c?.protected ?? false,
      destructive: plan.remove.length > 0,
      whatHappens: (
        <>
          {[
            changed.length ? t("changed: {k}", { k: changed.join(", ") }) : "",
            added.length ? t("added: {k}", { k: added.join(", ") }) : "",
            plan.remove.length ? t("removed: {k}", { k: plan.remove.join(", ") }) : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          {". "}
          {t("Values are not shown here. Pods read Secret volumes again within about a minute; environment variables only when the pod restarts.")}
        </>
      ),
      command: `kubectl --context ${c?.context ?? cluster} -n ${namespace} edit secret ${name}`,
      confirmLabel: t("Save"),
      onConfirm: () =>
        backend!
          .updateSecret(plan)
          .then(() => {
            toast.show({ kind: "success", title: t("Secret saved"), target: `${name} · ${cluster}` });
            onDone();
          })
          .catch((e) => setError(errorText(e))),
    });

  return (
    <div className="flex flex-col gap-2.5">
      <Banner tone="info">
        {t("Values are shown decoded and saved base64-encoded. Only the keys you change are sent; keys you never open keep their value without leaving the cluster. If the Secret changes meanwhile, the save is refused.")}
      </Banner>
      {info.warning && (
        <Banner tone="warning" title={t("Managed elsewhere")}>
          {t(info.warning)}
        </Banner>
      )}
      {list.map((r, i) => {
        const dirty = r.added || (r.value !== undefined && r.value !== r.original);
        return (
          <div key={i} className={cn("flex flex-col gap-1.5 rounded-md border px-2.5 py-2", dirty || r.removed ? "border-accent" : "border-line")}>
            <div className="flex items-center gap-2 text-ui">
              {r.added ? (
                <input aria-label={t("Key name")} value={r.key} onChange={(e) => update(i, { key: e.target.value })} className="focus-ring h-6 min-w-0 flex-1 rounded border border-line-strong bg-surface-app px-1.5 font-mono text-cell" />
              ) : (
                <span className={cn("truncate font-mono font-medium", r.removed && "text-fg-muted line-through")}>{r.key}</span>
              )}
              {r.removed ? (
                <span className="rounded-full bg-status-critical/15 px-2 text-meta text-status-critical">{t("removed")}</span>
              ) : r.added ? (
                <span className="rounded-full bg-status-healthy/15 px-2 text-meta text-status-healthy">{t("added")}</span>
              ) : dirty ? (
                <span className="rounded-full bg-status-warning/15 px-2 text-meta text-status-warning">{t("changed")}</span>
              ) : (
                r.value === undefined && r.bytes !== undefined && <span className="text-meta text-fg-muted">{t("{n} bytes · not opened", { n: r.bytes })}</span>
              )}
              <div className="flex-1" />
              {!r.removed && r.value === undefined && !r.added && (
                <Button size="sm" variant="ghost" onClick={() => open(i)}>
                  {t("Show and edit")}
                </Button>
              )}
              {(r.removed || dirty) && !r.added ? (
                <Button size="sm" variant="ghost" onClick={() => update(i, { removed: false, value: r.original })}>
                  <Undo2 aria-hidden />
                  {t("Undo")}
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => (r.added ? setRows(list.filter((_, j) => j !== i)) : update(i, { removed: true }))}>
                  {t("Remove")}
                </Button>
              )}
            </div>
            {!r.removed && r.value !== undefined && (
              <>
                <textarea
                  aria-label={t("Value of {k}", { k: r.key || t("new key") })}
                  value={r.value}
                  onChange={(e) => update(i, { value: e.target.value })}
                  spellCheck={false}
                  rows={Math.min(8, Math.max(2, r.value.split("\n").length))}
                  className="selectable focus-ring resize-y rounded border border-line bg-surface-app px-2 py-1 font-mono text-meta text-fg"
                />
                <label className="flex items-center gap-1.5 text-meta text-fg-secondary">
                  <Checkbox checked={!!r.binary} aria-label={t("Binary value, written as base64")} onCheckedChange={(on) => update(i, { binary: on === true })} />
                  {t("Binary value, written as base64")}
                </label>
              </>
            )}
          </div>
        );
      })}
      <button type="button" className="focus-ring flex w-fit items-center gap-1 text-ui text-accent hover:underline" onClick={() => setRows([...list, { key: "", added: true, value: "", original: undefined }])}>
        <Plus className="size-3.5" aria-hidden />
        {t("Add a key")}
      </button>
      {problems.map((p) => (
        <span key={p} className="flex items-center gap-1.5 text-meta text-status-critical">
          <TriangleAlert className="size-3.5" aria-hidden />
          {p}
        </span>
      ))}
      {error && <span className="selectable font-mono text-meta text-status-critical">{error}</span>}
      <div className="flex gap-2">
        <Button onClick={onDone}>{t("Cancel")}</Button>
        <Button variant="danger" disabled={count === 0 || problems.length > 0 || c?.readOnly} title={c?.readOnly ? t("Read-only context") : undefined} onClick={save}>
          {count === 1 ? t("Save 1 change…") : t("Save {n} changes…", { n: count })}
        </Button>
      </div>
    </div>
  );
}
