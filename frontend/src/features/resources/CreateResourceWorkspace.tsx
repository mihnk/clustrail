import { useEffect, useMemo, useRef, useState } from "react";
import { parseAllDocuments } from "yaml";
import { FlaskConical, Plus } from "lucide-react";
import { useWorkspace, type WorkspaceTab } from "@/app/workspace";
import { backend, errorText, type CreateResult } from "@/backend/client";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { FilterToken } from "@/components/ui/filter-token";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { useConfirm } from "@/components/safety/ConfirmationDialog";
import { useToast } from "@/components/ui/toast";
import { EmptyState } from "@/components/EmptyState";
import { applyClustrailTheme, monaco } from "@/features/yaml/monaco";
import { cn } from "@/lib/cn";
import { kindName, templateFor } from "./kinds";

interface ParsedDoc {
  kind: string;
  apiVersion: string;
  name: string;
  namespace?: string;
}

/** Every document of the manifest, or the first problem found. */
function parseManifest(text: string): { docs: ParsedDoc[]; error?: string } {
  const docs: ParsedDoc[] = [];
  const all = parseAllDocuments(text).filter((d) => d.contents !== null);
  for (const [i, doc] of all.entries()) {
    const where = all.length > 1 ? `Document ${i + 1}: ` : "";
    if (doc.errors.length) return { docs, error: where + doc.errors[0]!.message.split("\n")[0] };
    const obj = doc.toJS() as { kind?: string; apiVersion?: string; metadata?: { name?: string; namespace?: string } } | null;
    if (!obj?.kind || !obj.apiVersion) return { docs, error: `${where}apiVersion and kind are required.` };
    if (!obj.metadata?.name) return { docs, error: `${where}metadata.name is required.` };
    docs.push({ kind: obj.kind, apiVersion: obj.apiVersion, name: obj.metadata.name, namespace: obj.metadata.namespace });
  }
  return docs.length ? { docs } : { docs, error: "Empty document." };
}

const STATUS_TONE: Record<CreateResult["status"], string> = {
  created: "text-status-healthy",
  valid: "text-status-healthy",
  exists: "text-status-warning",
  failed: "text-status-critical",
  skipped: "text-fg-muted",
};

/** A new object from YAML: server-side dry run first, then create with the usual confirmation. */
export function CreateResourceWorkspace({ tab }: { tab: WorkspaceTab; active: boolean }) {
  const ws = useWorkspace();
  const { confirm } = useConfirm();
  const toast = useToast();
  const connected = ws.clusters.filter((c) => c.connection === "connected");
  const [clusterId, setClusterId] = useState(tab.params?.cluster || tab.cluster || connected[0]?.id || "");
  const cluster = ws.clusterById(clusterId);
  const kindKey = tab.params?.kind ?? "apps/Deployment";
  const [text, setText] = useState(() => templateFor(kindKey, tab.params?.namespace ?? ""));
  const [result, setResult] = useState<{ dryRun: boolean; items: CreateResult[] } | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseManifest(text), [text]);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const model = monaco.editor.createModel(text, "yaml");
    const ed = monaco.editor.create(host, {
      model,
      theme: applyClustrailTheme(ws.theme === "dark"),
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
      fontSize: 12.5,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      tabSize: 2,
      padding: { top: 6 },
    });
    const sub = model.onDidChangeContent(() => {
      setText(model.getValue());
      setResult(null);
    });
    return () => {
      sub.dispose();
      ed.dispose();
      model.dispose();
    };
  }, [ws.theme]);

  if (!backend) {
    return (
      <EmptyState className="flex-1" icon={<Plus />} title="Create from YAML">
        Creating objects needs the desktop app connected to a cluster.
      </EmptyState>
    );
  }
  const api = backend;
  const docs = parsed.docs;
  const target = docs.length === 1 ? `${docs[0]!.kind}/${docs[0]!.name}` : `${docs.length} objects`;
  const ready = !parsed.error && !!cluster && cluster.connection === "connected";

  const run = (dryRun: boolean) => {
    setBusy(true);
    return api
      .createObjects(clusterId, text, dryRun)
      .then((items) => {
        setResult({ dryRun, items });
        return items;
      })
      .catch((e) => {
        setResult({ error: errorText(e) });
        return null;
      })
      .finally(() => setBusy(false));
  };

  const create = () => {
    if (!cluster || !docs.length) return;
    const one = docs.length === 1 ? docs[0]! : null;
    confirm({
      action: one ? `Create ${one.kind}` : `Create ${docs.length} objects`,
      targetName: one ? one.name : "",
      title: one ? undefined : <>Create {docs.length} objects?</>,
      targets: one
        ? undefined
        : [{ cluster: clusterId, env: cluster.env, protected: cluster.protected, items: docs.map((d) => ({ name: `${d.kind}/${d.name}`, health: "progressing" as const, note: d.namespace })) }],
      icon: <Plus />,
      env: cluster.env,
      cluster: clusterId,
      namespace: one?.namespace,
      protected: cluster.protected,
      destructive: false,
      whatHappens: <>Objects are created in order, like kubectl create. Existing objects are not changed; creation stops at the first failure.</>,
      command: `kubectl --context ${cluster.context} create -f manifest.yaml`,
      confirmLabel: "Create",
      phrase: one ? undefined : `${clusterId}/${docs.length}`,
      onConfirm: () =>
        void run(false).then((items) => {
          if (!items) return;
          const created = items.filter((i) => i.status === "created");
          if (created.length === items.length) {
            toast.show({ kind: "success", title: created.length === 1 ? `${created[0]!.kind} created` : `${created.length} objects created`, target: clusterId, env: cluster.env });
            if (created.length === 1) {
              const c = created[0]!;
              const d = docs[0]!;
              const kindArg = d.apiVersion.includes("/") ? `${d.apiVersion.split("/")[0]}/${c.kind}` : c.kind;
              ws.openView({ kind: "yaml", title: `YAML · ${c.name}`, cluster: clusterId, params: { kind: kindArg, namespace: c.namespace ?? "", name: c.name } });
            }
          } else {
            toast.show({ kind: "error", title: `${created.length} of ${items.length} created`, target: clusterId, detail: items.find((i) => i.error)?.error });
          }
        }),
    });
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-app">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line bg-surface-panel pl-3.5 pr-3 dark:bg-transparent">
        <Plus className="size-4 text-fg-secondary" aria-hidden />
        <span className="text-title font-semibold">New {kindName(kindKey)}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <FilterToken k="cluster" value={clusterId || "none"} active />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Create in</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={clusterId} onValueChange={(v) => (setClusterId(v), setResult(null))}>
              {connected.map((c) => (
                <DropdownMenuRadioItem key={c.id} value={c.id}>
                  <EnvironmentBadge env={c.env} /> {c.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {cluster?.readOnly && <span className="text-meta text-status-warning">Read-only context</span>}
        <div className="flex-1" />
        <Button onClick={() => void run(true)} disabled={!ready || busy}>
          <FlaskConical aria-hidden />
          Dry run
        </Button>
        <Button variant="primary" onClick={create} disabled={!ready || busy || cluster?.readOnly}>
          Create…
        </Button>
      </div>
      {parsed.error && (
        <Banner tone="warning" className="shrink-0 rounded-none">
          {parsed.error}
        </Banner>
      )}
      {result && "error" in result && (
        <Banner tone="critical" className="shrink-0 rounded-none">
          <span className="selectable font-mono">{result.error}</span>
        </Banner>
      )}
      {result && "items" in result && (
        <div className="max-h-[180px] shrink-0 overflow-y-auto border-b border-line bg-surface-panel px-3.5 py-2 text-ui">
          <b className="font-semibold">{result.dryRun ? "Dry run" : "Create"}</b>
          <span className="text-fg-muted"> · checked by the API server, in order</span>
          <ul className="m-0 mt-1 list-none p-0">
            {result.items.map((r, i) => (
              <li key={i} className="flex gap-2 py-0.5">
                <span className={cn("w-[64px] shrink-0 font-medium", STATUS_TONE[r.status])}>{r.status}</span>
                <span className="font-mono">
                  {r.kind}/{r.name}
                </span>
                {r.namespace && <span className="text-fg-muted">{r.namespace}</span>}
                {r.error && <span className="selectable min-w-0 truncate font-mono text-meta text-fg-secondary" title={r.error}>{r.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div ref={hostRef} className="min-h-0 flex-1" />
      <div className="flex h-7 shrink-0 items-center gap-3.5 border-t border-line px-3.5 text-meta text-fg-muted">
        <span>{docs.length ? target : "—"}</span>
        <div className="flex-1" />
        <span>Several objects: separate them with ---. Namespace defaults to the context’s namespace.</span>
      </div>
    </main>
  );
}
