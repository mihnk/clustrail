import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseDocument, parse } from "yaml";
import { Code, Copy, Download, FoldVertical, GitBranch, Lock, Play, Search, Upload } from "lucide-react";
import { useWorkspace, type WorkspaceTab } from "@/app/workspace";
import { liveObject, suggestedEdit, type LiveObject } from "@/data/yaml";
import { backend, errorText } from "@/backend/client";
import { Banner } from "@/components/ui/banner";
import { Button, IconButton } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabCount } from "@/components/ui/tabs";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { StatusGlyph } from "@/components/status/StatusGlyph";
import { useConfirm } from "@/components/safety/ConfirmationDialog";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { applyClustrailTheme, monaco } from "./monaco";

type Mode = "view" | "edit";
type DiffMode = "none" | "inline" | "side";

interface Check {
  health: "completed" | "warning" | "failed";
  text: ReactNode;
  action?: ReactNode;
}

/** Leaf paths that differ between two parsed objects; list items keyed by name. */
function changedPaths(a: unknown, b: unknown, path = ""): string[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    const keyed = (xs: unknown[]) =>
      new Map(xs.map((x, i) => [x && typeof x === "object" && "name" in x ? String((x as { name: unknown }).name) : String(i), x]));
    const ma = keyed(a);
    const mb = keyed(b);
    return [...new Set([...ma.keys(), ...mb.keys()])].flatMap((k) => changedPaths(ma.get(k), mb.get(k), `${path}[${k}]`));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) =>
      changedPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k),
    );
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [path];
}

/**
 * YAML of one object: view, edit with live diff, validation, server-side
 * dry run and server-side apply. GitOps ownership is stated before editing.
 */
export function YamlWorkspace({ tab, active }: { tab: WorkspaceTab; active: boolean }) {
  const ws = useWorkspace();
  const { confirm } = useConfirm();
  const toast = useToast();
  const params = tab.params ?? {};
  const kindOnly = (params.kind ?? "").slice((params.kind ?? "").lastIndexOf("/") + 1);
  const cluster = tab.cluster ? ws.clusterById(tab.cluster) : undefined;
  // Mock: a fixed object (with the investigation's suggested edit). Desktop: loaded from the API server below.
  const initial = useMemo<LiveObject>(
    () => (backend ? { yaml: "", resourceVersion: "", owners: {} } : liveObject(params, tab.cluster ?? "")),
    [tab.id],
  );

  const [live, setLive] = useState<LiveObject>(initial);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openedVersion, setOpenedVersion] = useState(initial.resourceVersion);
  const [liveChanges, setLiveChanges] = useState(0);
  const [mode, setMode] = useState<Mode>(params.mode === "edit" || initial.gitops ? "edit" : "view");
  const [diff, setDiff] = useState<DiffMode>("side");
  const [edited, setEdited] = useState(() => (initial.gitops ? suggestedEdit(initial.yaml) : initial.yaml));

  // Desktop: load the live object, then poll so concurrent changes show up as a conflict.
  useEffect(() => {
    if (!backend || !tab.cluster) return;
    const api = backend;
    let first = true;
    let cancelled = false;
    const load = () =>
      api
        .getObject(tab.cluster!, params.kind ?? "Deployment", params.namespace ?? "", params.name ?? "")
        .then((obj) => {
          if (cancelled) return;
          setLoadError(null);
          const next: LiveObject = { yaml: obj.yaml, resourceVersion: obj.resourceVersion, owners: obj.owners, gitops: obj.gitops };
          if (first) {
            first = false;
            setLive(next);
            setOpenedVersion(obj.resourceVersion);
            setEdited(obj.yaml);
            if (obj.gitops) setMode("edit");
            return;
          }
          setLive((cur) => {
            if (cur.resourceVersion === obj.resourceVersion) return cur;
            setLiveChanges((n) => n + 1);
            return next;
          });
        })
        .catch((e) => !cancelled && setLoadError(errorText(e)));
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [tab.id]);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [dryRun, setDryRun] = useState<{ at: string; ms: number; checks: Check[] } | null>(null);
  const [panel, setPanel] = useState("dryrun");
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor | null>(null);
  const modifiedRef = useRef<monaco.editor.ITextModel | null>(null);

  // Syntax problems as you type.
  const problems = useMemo(() => {
    const doc = parseDocument(edited);
    return doc.errors.map((e) => ({ message: e.message.split("\n")[0]!, line: e.linePos?.[0]?.line ?? 1, col: e.linePos?.[0]?.col ?? 1 }));
  }, [edited]);
  const changes = useMemo(() => {
    if (problems.length) return [];
    try {
      return changedPaths(parse(live.yaml), parse(edited)).filter((p) => !p.startsWith("status"));
    } catch {
      return [];
    }
  }, [live.yaml, edited, problems.length]);
  const ownership = changes
    .map((p) => {
      const owned = Object.entries(live.owners).find(([field]) => p.startsWith(field));
      return owned ? { path: p, manager: owned[1] } : null;
    })
    .filter((x): x is { path: string; manager: string } => !!x);

  // Monaco: one editor in view or "no diff" mode, a diff editor otherwise.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const theme = applyClustrailTheme(ws.theme === "dark");
    const common: monaco.editor.IEditorOptions = {
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
      fontSize: 12.5,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      folding: true,
      renderLineHighlight: "line",
      tabSize: 2,
      padding: { top: 6 },
      stickyScroll: { enabled: false },
    } as monaco.editor.IEditorOptions;
    const original = monaco.editor.createModel(live.yaml, "yaml");
    const modified = monaco.editor.createModel(edited, "yaml");
    modifiedRef.current = modified;
    const sub = modified.onDidChangeContent(() => setEdited(modified.getValue()));
    let editors: monaco.editor.ICodeEditor[];

    if (mode === "view" || diff === "none") {
      const ed = monaco.editor.create(host, { ...common, model: mode === "view" ? original : modified, readOnly: mode === "view", theme });
      editorRef.current = ed;
      editors = [ed];
    } else {
      const de = monaco.editor.createDiffEditor(host, {
        ...common,
        theme,
        renderSideBySide: diff === "side",
        originalEditable: false,
        readOnly: false,
        renderOverviewRuler: false,
        // Identical sections collapse; the changed fields stay in view.
        hideUnchangedRegions: { enabled: true, contextLineCount: 4, minimumLineCount: 6, revealLineCount: 20 },
      } as monaco.editor.IStandaloneDiffEditorConstructionOptions);
      de.setModel({ original, modified });
      editorRef.current = de;
      editors = [de.getOriginalEditor(), de.getModifiedEditor()];
    }
    const modifiedEditor = editors[editors.length - 1]!;
    const cur = modifiedEditor.onDidChangeCursorPosition((e) => setCursor({ line: e.position.lineNumber, col: e.position.column }));
    // status and managedFields are folded by default (once folding ranges are computed).
    const foldTimer = setTimeout(() => {
      for (const ed of editors) {
        const model = ed.getModel();
        if (!model) continue;
        const lines = model.getLinesContent().flatMap((l, i) => (/^status:|^  managedFields:/.test(l) ? [i] : []));
        if (lines.length) ed.trigger("clustrail", "editor.fold", { selectionLines: lines, levels: 1, direction: "down" });
      }
    }, 350);
    return () => {
      clearTimeout(foldTimer);
      sub.dispose();
      cur.dispose();
      editorRef.current?.dispose();
      original.dispose();
      modified.dispose();
      editorRef.current = null;
    };
  }, [mode, diff, live.yaml, ws.theme, tab.id]);

  // Markers for syntax problems.
  useEffect(() => {
    const model = modifiedRef.current;
    if (!model || model.isDisposed()) return;
    monaco.editor.setModelMarkers(
      model,
      "clustrail",
      problems.map((p) => ({
        severity: monaco.MarkerSeverity.Error,
        message: p.message,
        startLineNumber: p.line,
        startColumn: p.col,
        endLineNumber: p.line,
        endColumn: p.col + 1,
      })),
    );
  }, [problems]);

  const runDryRun = () => {
    const started = performance.now();
    if (backend && tab.cluster) {
      // Server-side dry run: the API server runs validation and admission without persisting.
      void backend
        .applyYaml(tab.cluster, edited, openedVersion, true, ownership.length > 0)
        .then((r) => {
          const checks: Check[] = r.conflict
            ? [{ health: "failed", text: <>The API server reported a conflict: <span className="font-mono">{r.conflict}</span></> }]
            : [{ health: "completed", text: "API server accepted the change in dry-run mode (validation and admission ran)." }, ...r.warnings.map((w) => ({ health: "warning" as const, text: w }))];
          setDryRun({ at: new Date().toTimeString().slice(0, 8), ms: Math.round(performance.now() - started), checks });
        })
        .catch((e) =>
          setDryRun({ at: new Date().toTimeString().slice(0, 8), ms: Math.round(performance.now() - started), checks: [{ health: "failed", text: <span className="selectable font-mono">{errorText(e)}</span> }] }),
        );
      setPanel("dryrun");
      return;
    }
    const doc = parse(edited) as { apiVersion?: string; kind?: string; metadata?: { name?: string } } | null;
    const checks: Check[] = [];
    // params.kind may be "group/Kind" (generic lists); the document carries only the Kind.
    if (!doc || doc.kind !== kindOnly || doc.metadata?.name !== params.name) {
      checks.push({ health: "failed", text: <>The object must keep its kind and name (<span className="font-mono">{kindOnly}/{params.name}</span>).</> });
    } else {
      checks.push({
        health: "completed",
        text: (
          <>
            Schema valid against <span className="font-mono">{doc.apiVersion} {doc.kind}</span> (cluster OpenAPI v1.30)
          </>
        ),
      });
      checks.push({
        health: "completed",
        text: (
          <>
            API server accepted the change in dry-run mode. Admission webhooks ran: <span className="font-mono">kyverno-resource-policy</span> (allowed)
          </>
        ),
      });
    }
    setDryRun({ at: new Date().toTimeString().slice(0, 8), ms: Math.round(150 + Math.random() * 60 + (performance.now() - started)), checks });
    setPanel("dryrun");
  };

  // Dry run again shortly after typing stops.
  useEffect(() => {
    if (mode !== "edit" || problems.length || !changes.length) return;
    const t = setTimeout(runDryRun, 700);
    return () => clearTimeout(t);
  }, [edited, mode]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "e" && !e.metaKey && !e.ctrlKey && !(e.target as HTMLElement | null)?.closest("input, textarea, .monaco-editor")) {
        setMode((m) => (m === "view" ? "edit" : m));
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const conflict = live.resourceVersion !== openedVersion;
  const blocked = problems.length > 0 || dryRun?.checks.some((c) => c.health === "failed") || !changes.length;

  const apply = () =>
    confirm({
      action: live.gitops ? "Apply anyway to" : "Apply changes to",
      targetName: params.name ?? "",
      icon: <Upload />,
      env: cluster?.env ?? "dev",
      cluster: tab.cluster ?? "",
      namespace: params.namespace,
      meta: `${changes.length} ${changes.length === 1 ? "field" : "fields"}`,
      protected: cluster?.protected ?? false,
      destructive: true,
      whatHappens: (
        <>
          Server-side apply as field manager <span className="font-mono text-ui">clustrail</span> with these fields:{" "}
          <span className="font-mono text-ui">{changes.join(", ")}</span>.
        </>
      ),
      currentState: [
        ...(live.gitops
          ? [
              {
                health: "warning" as const,
                text: (
                  <>
                    Managed by {live.gitops.tool} <span className="font-mono text-ui">{live.gitops.app}</span> with self-heal: the change is
                    reverted at the next reconciliation. Change the source in Git to keep it.
                  </>
                ),
              },
            ]
          : []),
        ...ownership.map((o) => ({
          health: "warning" as const,
          text: (
            <>
              <span className="font-mono text-ui">{o.path}</span> is owned by <span className="font-mono text-ui">{o.manager}</span>; applying takes
              ownership (force-conflicts).
            </>
          ),
        })),
        ...(conflict
          ? [{ health: "failed" as const, text: `The live object changed since you opened it (resourceVersion ${openedVersion} → ${live.resourceVersion}).` }]
          : []),
      ],
      command: `kubectl --context ${tab.cluster} apply --server-side --field-manager=clustrail${ownership.length ? " --force-conflicts" : ""} -f ${params.name}.yaml`,
      confirmLabel: live.gitops ? "Apply anyway" : "Apply",
      onConfirm: () => {
        if (backend && tab.cluster) {
          const api = backend;
          void api
            .applyYaml(tab.cluster, edited, openedVersion, false, ownership.length > 0)
            .then(async (r) => {
              if (r.conflict) {
                toast.show({ kind: "error", title: "Not applied: conflict", target: `${params.name} · ${tab.cluster}`, detail: r.conflict, copyText: r.conflict });
                return;
              }
              const obj = await api.getObject(tab.cluster!, params.kind ?? "Deployment", params.namespace ?? "", params.name ?? "");
              setLive({ yaml: obj.yaml, resourceVersion: obj.resourceVersion, owners: obj.owners, gitops: obj.gitops });
              setOpenedVersion(obj.resourceVersion);
              setEdited(obj.yaml);
              toast.show({ kind: "success", title: "Applied", target: `${params.name} · ${tab.cluster}`, env: cluster?.env, detail: `server-side apply · resourceVersion ${r.resourceVersion}` });
            })
            .catch((e) => toast.show({ kind: "error", title: "Apply failed", target: `${params.name} · ${tab.cluster}`, detail: errorText(e), copyText: errorText(e) }));
          return;
        }
        const nextVersion = String(Number(live.resourceVersion) + 1);
        const before = live.yaml;
        setLive({ ...live, yaml: edited, resourceVersion: nextVersion });
        setOpenedVersion(nextVersion);
        toast.show({ kind: "success", title: "Applied", target: `${params.name} · ${tab.cluster}`, env: cluster?.env, detail: `server-side apply · resourceVersion ${nextVersion}` });
        if (live.gitops?.selfHeal) {
          // Self-heal puts Git's version back; the editor reports the change.
          setTimeout(() => {
            setLive((l) => ({ ...l, yaml: before, resourceVersion: String(Number(l.resourceVersion) + 1) }));
            setLiveChanges((n) => n + 1);
            toast.show({ kind: "error", title: `${live.gitops!.tool} reverted ${params.name}`, detail: "Self-heal synced the object back to Git. Change the source to keep the edit." });
          }, 5000);
        }
      },
    });

  const fold = () => void (editorRef.current && "getModifiedEditor" in editorRef.current ? editorRef.current.getModifiedEditor() : editorRef.current)?.getAction("editor.foldAll")?.run();
  const find = () => {
    const ed = editorRef.current && "getModifiedEditor" in editorRef.current ? editorRef.current.getModifiedEditor() : editorRef.current;
    ed?.focus();
    void ed?.getAction("actions.find")?.run();
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-app">
      {loadError && (
        <Banner tone="critical" className="shrink-0 rounded-none border-b border-line">
          Could not read {kindOnly}/{params.name}: <span className="selectable font-mono">{loadError}</span>
        </Banner>
      )}
      {backend && !loadError && live.resourceVersion === "" && (
        <Banner tone="info" className="shrink-0 rounded-none border-b border-line">
          Reading {kindOnly}/{params.name} from {tab.cluster}…
        </Banner>
      )}
      {live.gitops && (
        <Banner
          tone="warning"
          className="min-h-[42px] shrink-0 rounded-none border-b border-line"
          action={
            <span className="flex gap-1">
              <Button size="sm" onClick={() => ws.openView({ kind: "gitops", title: "GitOps" })}>
                <GitBranch aria-hidden />
                Open in GitOps
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(live.gitops!.source)}>
                <Copy aria-hidden />
                Copy source path
              </Button>
            </span>
          }
        >
          <b className="font-semibold">Managed by {live.gitops.tool}</b> <span className="font-mono">{live.gitops.app}</span>{" "}
          <span className="text-fg-secondary">
            · auto-sync{live.gitops.selfHeal ? " with self-heal" : ""}. Direct changes are reverted at the next reconciliation. Source:
          </span>{" "}
          <span className="font-mono">{live.gitops.source}</span>
        </Banner>
      )}
      {conflict && (
        <Banner
          tone="critical"
          className="shrink-0 rounded-none border-b border-line"
          action={
            <Button size="sm" onClick={() => setOpenedVersion(live.resourceVersion)}>
              Keep my edit on the new version
            </Button>
          }
        >
          <b className="font-semibold">The live object changed</b> while you were editing (resourceVersion {openedVersion} → {live.resourceVersion}). The
          diff now compares against the new version.
        </Banner>
      )}

      <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-line bg-surface-panel pl-3.5 pr-3 dark:bg-transparent">
        <Code className="size-4 text-fg-muted" aria-hidden />
        <span className="font-mono font-semibold">{params.name}</span>
        <span className="text-meta text-fg-muted">
          {params.kind}
          {params.namespace ? ` · ${params.namespace}` : ""} · {tab.cluster}
        </span>
        {cluster && <EnvironmentBadge env={cluster.env} />}
        <span className="mx-1 h-7 w-px bg-line" aria-hidden />
        <Segmented aria-label="Mode" value={mode} onValueChange={setMode} options={[{ value: "view", label: "View" }, { value: "edit", label: "Edit" }]} />
        {mode === "edit" && changes.length > 0 && (
          <span className="flex items-center gap-1.5 text-ui text-fg-secondary">
            <span className="size-[7px] rounded-full bg-fg" aria-hidden />
            {changes.length} unsaved {changes.length === 1 ? "change" : "changes"}
          </span>
        )}
        <div className="flex-1" />
        {mode === "edit" && (
          <Segmented
            aria-label="Diff"
            value={diff}
            onValueChange={setDiff}
            options={[
              { value: "none", label: "No diff" },
              { value: "inline", label: "Inline" },
              { value: "side", label: "Side by side" },
            ]}
          />
        )}
        <IconButton aria-label="Find" onClick={find}>
          <Search />
        </IconButton>
        <IconButton aria-label="Fold all" onClick={fold}>
          <FoldVertical />
        </IconButton>
        <IconButton aria-label="Copy YAML" onClick={() => void navigator.clipboard?.writeText(mode === "view" ? live.yaml : edited)}>
          <Copy />
        </IconButton>
        <IconButton
          aria-label="Download YAML"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([mode === "view" ? live.yaml : edited], { type: "text/yaml" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `${params.name}.yaml`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download />
        </IconButton>
      </div>

      <div className="flex h-[30px] shrink-0 items-center border-b border-line bg-surface-panel text-meta text-fg-secondary">
        {mode === "edit" && diff === "side" && (
          <span className="flex h-full flex-1 items-center gap-2 border-r border-line px-3">
            <Lock className="size-3.5" aria-hidden />
            Live · resourceVersion <span className="font-mono">{live.resourceVersion}</span>
            <span className="flex-1" />
            <span className="text-fg-muted">read-only · changed {liveChanges} times since opened</span>
          </span>
        )}
        <span className="flex h-full flex-1 items-center gap-2 px-3">
          {mode === "edit" ? (
            <>
              <span className="size-[7px] rounded-full bg-fg" aria-hidden />
              Your edit
            </>
          ) : (
            <>
              <Lock className="size-3.5" aria-hidden />
              Live · resourceVersion <span className="font-mono">{live.resourceVersion}</span> · press E to edit
            </>
          )}
          <span className="flex-1" />
          <span className="text-fg-muted">
            Ln {cursor.line}, Col {cursor.col} · YAML · spaces: 2
          </span>
        </span>
      </div>

      <div className={cn("min-h-0 flex-1 bg-term-bg", mode === "edit" && "shadow-[inset_0_0_0_1px_var(--line-selected)]")}>
        <div ref={hostRef} className="h-full w-full" />
      </div>

      {mode === "edit" && (
        <Tabs value={panel} onValueChange={setPanel} className="flex h-[138px] shrink-0 flex-col border-t border-line bg-surface-panel">
          <div className="flex items-center gap-3.5 border-b border-line px-3.5">
            <TabsList className="border-0" aria-label="Validation">
              <TabsTrigger value="dryrun" className="h-[30px]">
                {dryRun && <StatusGlyph health={dryRun.checks.some((c) => c.health === "failed") ? "failed" : "completed"} className={dryRun.checks.some((c) => c.health === "failed") ? undefined : "text-status-healthy"} />}
                Dry run
              </TabsTrigger>
              <TabsTrigger value="problems" className="h-[30px]">
                Problems <TabCount>{problems.length}</TabCount>
              </TabsTrigger>
              <TabsTrigger value="ownership" className="h-[30px]">
                {ownership.length > 0 && <StatusGlyph health="warning" />}
                Field ownership <TabCount>{ownership.length}</TabCount>
              </TabsTrigger>
            </TabsList>
            <div className="flex-1" />
            <span className="text-meta text-fg-muted">{dryRun ? `Server-side dry run · ${dryRun.at} · ${dryRun.ms}ms` : "Not run yet"}</span>
          </div>
          <TabsContent value="dryrun" className="min-h-0 flex-1 overflow-y-auto px-3.5 py-1.5">
            {!dryRun ? (
              <p className="m-0 py-1.5 text-cell text-fg-muted">Dry run sends the edit to the API server with dryRun=All: admission and validation run, nothing is stored.</p>
            ) : (
              [
                ...dryRun.checks,
                ...ownership.map<Check>((o) => ({
                  health: "warning",
                  text: (
                    <>
                      <span className="font-mono">{o.path}</span> is owned by field manager <span className="font-mono">{o.manager}</span>. Applying takes
                      ownership{live.gitops ? `; ${live.gitops.tool} will set it back.` : "."}
                    </>
                  ),
                  action: (
                    <Button size="sm" variant="ghost" onClick={() => setPanel("ownership")}>
                      Show fields
                    </Button>
                  ),
                })),
              ].map((c, i) => <CheckRow key={i} check={c} />)
            )}
          </TabsContent>
          <TabsContent value="problems" className="min-h-0 flex-1 overflow-y-auto px-3.5 py-1.5">
            {problems.length === 0 ? (
              <p className="m-0 py-1.5 text-cell text-fg-muted">No syntax problems.</p>
            ) : (
              problems.map((p, i) => <CheckRow key={i} check={{ health: "failed", text: <>Line {p.line}, column {p.col}: {p.message}</> }} />)
            )}
          </TabsContent>
          <TabsContent value="ownership" className="min-h-0 flex-1 overflow-y-auto px-3.5 py-1.5">
            {changes.length === 0 ? (
              <p className="m-0 py-1.5 text-cell text-fg-muted">No changed fields.</p>
            ) : (
              changes.map((p) => {
                const o = ownership.find((x) => x.path === p);
                return (
                  <CheckRow
                    key={p}
                    check={{
                      health: o ? "warning" : "completed",
                      text: (
                        <>
                          <span className="font-mono">{p}</span> · {o ? <>owned by <span className="font-mono">{o.manager}</span></> : "no other manager"}
                        </>
                      ),
                    }}
                  />
                );
              })
            )}
          </TabsContent>
        </Tabs>
      )}

      {mode === "edit" && (
        <div className="flex h-[50px] shrink-0 items-center gap-2 border-t border-line px-3.5">
          <span className="hidden text-meta text-fg-muted min-[1360px]:inline">
            Applies with server-side apply as field manager <span className="font-mono">clustrail</span>
          </span>
          <div className="flex-1" />
          <Button disabled={!changes.length} onClick={() => setEdited(live.yaml)}>
            Discard changes
          </Button>
          <Button disabled={!changes.length || problems.length > 0} onClick={runDryRun}>
            <Play aria-hidden />
            Dry run again
          </Button>
          <Button
            variant={cluster?.protected ? "locked" : "primary"}
            disabled={blocked || cluster?.readOnly}
            onClick={apply}
            className={cn(cluster?.protected && "border-solid border-env-prod text-env-prod-ink")}
          >
            {cluster?.protected && <Lock aria-hidden />}
            {live.gitops ? "Apply anyway…" : "Apply…"}
          </Button>
        </div>
      )}
    </main>
  );
}

function CheckRow({ check }: { check: Check }) {
  return (
    <div className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-2 py-[5px] text-cell">
      <StatusGlyph health={check.health} className={cn("mt-[3px]", check.health === "completed" && "text-status-healthy")} />
      <span>{check.text}</span>
      {check.action ?? <span />}
    </div>
  );
}
