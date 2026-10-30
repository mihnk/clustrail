import { useEffect, useMemo, useRef, useState } from "react";
import { parseAllDocuments } from "yaml";
import { FlaskConical, Plus } from "lucide-react";
import { useWorkspace, type WorkspaceTab } from "@/app/workspace";
import { backend, errorText } from "@/backend/client";
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

interface Parsed {
  error?: string;
  kind?: string;
  apiVersion?: string;
  name?: string;
  namespace?: string;
}

function parseOne(text: string): Parsed {
  const docs = parseAllDocuments(text).filter((d) => d.contents !== null);
  if (docs.length !== 1) return { error: docs.length ? "One object at a time: remove the other documents (---)." : "Empty document." };
  const doc = docs[0]!;
  if (doc.errors.length) return { error: doc.errors[0]!.message.split("\n")[0] };
  const obj = doc.toJS() as { kind?: string; apiVersion?: string; metadata?: { name?: string; namespace?: string } } | null;
  if (!obj?.kind || !obj.apiVersion) return { error: "apiVersion and kind are required." };
  if (!obj.metadata?.name) return { error: "metadata.name is required." };
  return { kind: obj.kind, apiVersion: obj.apiVersion, name: obj.metadata.name, namespace: obj.metadata.namespace };
}

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
  const [dry, setDry] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseOne(text), [text]);
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
      setDry(null);
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
  const target = parsed.name ? `${parsed.kind}/${parsed.name}` : "";
  const ready = !parsed.error && !!cluster && cluster.connection === "connected";

  const dryRun = () => {
    setBusy(true);
    api
      .applyYaml(clusterId, text, "", true, false)
      .then((r) => setDry({ ok: true, text: `Server accepted ${target}${r.warnings.length ? ` · ${r.warnings.join("; ")}` : ""}` }))
      .catch((e) => setDry({ ok: false, text: errorText(e) }))
      .finally(() => setBusy(false));
  };

  const create = async () => {
    if (!cluster || !parsed.kind || !parsed.name) return;
    // Server-side apply would quietly change an existing object: creating must not.
    const kindArg = parsed.apiVersion?.includes("/") ? `${parsed.apiVersion.split("/")[0]}/${parsed.kind}` : parsed.kind;
    const exists = await api.getObject(clusterId, kindArg, parsed.namespace ?? "", parsed.name).then(
      () => true,
      () => false,
    );
    if (exists) {
      toast.show({ kind: "error", title: "Already exists", target: `${target} · ${clusterId}`, detail: "Open it from its list and use Edit YAML to change it." });
      return;
    }
    confirm({
      action: `Create ${parsed.kind}`,
      targetName: parsed.name,
      icon: <Plus />,
      env: cluster.env,
      cluster: clusterId,
      namespace: parsed.namespace,
      protected: cluster.protected,
      destructive: false,
      whatHappens: <>The object is created with server-side apply (field manager clustrail).</>,
      command: `kubectl --context ${cluster.context} apply --server-side --field-manager=clustrail -f ${parsed.name}.yaml`,
      confirmLabel: "Create",
      onConfirm: () =>
        void api
          .applyYaml(clusterId, text, "", false, false)
          .then(() => {
            toast.show({ kind: "success", title: `${parsed.kind} created`, target: `${parsed.name} · ${clusterId}`, env: cluster.env });
            ws.openView({ kind: "yaml", title: `YAML · ${parsed.name}`, cluster: clusterId, params: { kind: kindArg, namespace: parsed.namespace ?? "", name: parsed.name! } });
          })
          .catch((e) => toast.show({ kind: "error", title: "Create failed", target: `${parsed.name} · ${clusterId}`, detail: errorText(e), copyText: errorText(e) })),
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
            <DropdownMenuRadioGroup value={clusterId} onValueChange={(v) => (setClusterId(v), setDry(null))}>
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
        <Button onClick={dryRun} disabled={!ready || busy}>
          <FlaskConical aria-hidden />
          Dry run
        </Button>
        <Button variant="primary" onClick={() => void create()} disabled={!ready || busy || cluster?.readOnly}>
          Create…
        </Button>
      </div>
      {parsed.error && (
        <Banner tone="warning" className="shrink-0 rounded-none">
          {parsed.error}
        </Banner>
      )}
      {dry && (
        <Banner tone={dry.ok ? "info" : "critical"} className="shrink-0 rounded-none">
          <b className="font-semibold">Dry run:</b> <span className={cn("selectable", !dry.ok && "font-mono")}>{dry.text}</span>
        </Banner>
      )}
      <div ref={hostRef} className="min-h-0 flex-1" />
      <div className="flex h-7 shrink-0 items-center gap-3.5 border-t border-line px-3.5 text-meta text-fg-muted">
        <span>{target || "—"}</span>
        <div className="flex-1" />
        <span>Namespace defaults to the context’s namespace when left out</span>
      </div>
    </main>
  );
}
