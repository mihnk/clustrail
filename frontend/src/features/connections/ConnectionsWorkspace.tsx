import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Copy, Eye, FileText, KeyRound, Lock, Play, Plus, RefreshCw, Shield, Unplug, X } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { connectionTest, discoveredContexts, kubeconfigSources, type TestStep } from "@/data/connections";
import type { Cluster, ConnectionState, Environment } from "@/data/types";
import { Banner } from "@/components/ui/banner";
import { useToast } from "@/components/ui/toast";
import { Button, IconButton } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/components/safety/ConfirmationDialog";
import { EnvironmentBadge, EnvMarker } from "@/components/status/EnvironmentBadge";
import { StatusGlyph, healthTone } from "@/components/status/StatusGlyph";
import type { Health } from "@/data/types";
import { cn } from "@/lib/cn";

type Protection = "standard" | "protected" | "readonly";

const GROUP: Record<Environment, string> = { prod: "Production", stg: "Staging", dev: "Development" };
const protectionOf = (c: Cluster): Protection => (c.readOnly ? "readonly" : c.protected ? "protected" : "standard");

const STATUS: Record<ConnectionState, { health: Health; label: string }> = {
  connected: { health: "healthy", label: "Connected" },
  connecting: { health: "progressing", label: "Connecting…" },
  reconnecting: { health: "warning", label: "Reconnecting" },
  disconnected: { health: "unknown", label: "Not connected" },
  "auth-expired": { health: "warning", label: "Credentials expired" },
  unreachable: { health: "failed", label: "Unreachable" },
};

function statusDetail(c: Cluster): string {
  switch (c.connection) {
    case "connected":
      return [c.version, c.identity && `RBAC: ${c.identity}`].filter(Boolean).join(" · ");
    case "auth-expired":
      return `auth step failed${c.lastConnected ? ` · last connected ${c.lastConnected}` : ""}`;
    case "unreachable":
      return c.error?.split(": ").pop() ?? "dial failed";
    case "disconnected":
      return c.auth === "client cert" ? "cert expires in 41d" : `last connected ${c.lastConnected ?? "never"}`;
    default:
      return "";
  }
}

/** kubeconfig contexts: grouping, Clustrail protection, and connection diagnostics. */
export function ConnectionsWorkspace({ active }: { active: boolean }) {
  const ws = useWorkspace();
  const { clusters, connectCluster, updateCluster, disconnectCluster, hideCluster, addCluster } = ws;
  const { confirm } = useConfirm();
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>("staging-perf");
  const [discovered, setDiscovered] = useState(discoveredContexts);
  const [newGroup, setNewGroup] = useState<Environment | null>(null);
  const [newProtection, setNewProtection] = useState<Protection>("standard");
  const [tests, setTests] = useState<Record<string, { steps: TestStep[]; at: string; shown: number }>>({});
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const runTest = (c: Cluster) => {
    const steps = connectionTest(c);
    const at = new Date().toLocaleTimeString([], { hour12: false });
    setTests((t) => ({ ...t, [c.id]: { steps, at, shown: 0 } }));
    steps.forEach((_, i) =>
      timers.current.push(window.setTimeout(() => setTests((t) => (t[c.id] ? { ...t, [c.id]: { ...t[c.id]!, shown: i + 1 } } : t)), 180 * (i + 1))),
    );
  };

  useEffect(() => {
    if (!active) return;
    const c = clusters.find((x) => x.id === selectedId);
    if (c && !tests[c.id]) runTest(c);
  }, [active, selectedId]);

  const setProtection = (c: Cluster, p: Protection) => {
    const apply = () => updateCluster(c.id, { protected: p === "protected", readOnly: p === "readonly" });
    if (protectionOf(c) === "protected" && p === "standard") {
      // Lowering protection is itself guarded: typing the name makes it deliberate.
      confirm({
        action: "Remove protection from",
        targetName: c.name,
        icon: <Shield />,
        env: c.env,
        cluster: c.name,
        protected: true,
        destructive: false,
        whatHappens: "Changes and shells on this cluster will ask for a single confirmation instead of a typed one. RBAC is unchanged.",
        confirmLabel: "Remove protection",
        phrase: c.name,
        onConfirm: apply,
      });
    } else apply();
  };

  const connected = clusters.filter((c) => c.connection === "connected").length;
  const selected = clusters.find((c) => c.id === selectedId) ?? null;
  const grid = "grid grid-cols-[minmax(0,1fr)_104px_136px_120px_150px] items-center gap-x-3 px-4 max-[1360px]:grid-cols-[minmax(0,1fr)_136px_120px_140px]";

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* Kubeconfig sources */}
      <aside aria-label="Kubeconfig sources" className="flex w-[250px] shrink-0 flex-col gap-2 border-r border-line bg-surface-panel px-2.5 py-3 max-[1360px]:hidden">
        <div className="flex items-center">
          <span className="section-label flex-1">Kubeconfig sources</span>
          <IconButton aria-label="Detect again" title="Re-read kubeconfig files" onClick={() => toast.show({ kind: "success", title: "Kubeconfig files re-read", detail: `${discovered.length} new context${discovered.length === 1 ? "" : "s"}` })}>
            <RefreshCw />
          </IconButton>
        </div>
        {kubeconfigSources.map((s) => (
          <div key={s.path} className="flex flex-col gap-[3px] rounded-lg border border-line px-2.5 py-2 text-ui">
            <span className="flex min-w-0 items-center gap-1.5">
              <FileText className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
              <span className="truncate font-mono">{s.path}</span>
            </span>
            <span className={cn("truncate text-meta text-fg-muted", s.resolved && "font-mono")}>
              {s.resolved ? `${s.resolved} · ` : ""}
              {s.contexts} context{s.contexts === 1 ? "" : "s"}
              {!s.resolved && s.watched && " · watched"}
              {s.changed && ` · changed ${s.changed}`}
            </span>
          </div>
        ))}
        <Button disabled title="Opens a file picker in the desktop app">
          <Plus aria-hidden />
          Add kubeconfig file…
        </Button>
        <div className="flex-1" />
        <Banner tone="info" className="items-start text-ui">
          Clustrail reads these files in place and runs their auth plugins on your machine. No account, no cloud, nothing copied or uploaded.
        </Banner>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line pl-4 pr-3">
          <KeyRound className="size-4" aria-hidden />
          <span className="text-title font-semibold">Contexts</span>
          <span className="text-meta text-fg-muted">
            {clusters.length + discovered.length} found · {connected} connected
          </span>
          <div className="flex-1" />
          <Button onClick={() => clusters.forEach(runTest)}>
            <Play aria-hidden />
            Test all
          </Button>
        </div>
        <div className={cn(grid, "h-9 shrink-0 border-b border-line text-ui text-fg-muted")}>
          <span>Context · server</span>
          <span className="max-[1360px]:hidden">Auth</span>
          <span>Group</span>
          <span>Protection</span>
          <span>Status</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Contexts">
          {discovered.map((c) => (
            <div key={c.id} className={cn(grid, "h-[46px] border-b border-line-row")}>
              <TwoLine
                first={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="rounded-[4px] bg-status-progressing-soft px-1.5 font-mono text-label font-semibold text-status-progressing">New</span>
                    <span className="truncate font-medium">{c.context}</span>
                  </span>
                }
                second={`found in ${c.source} 2m ago · not connected`}
              />
              <span className="truncate font-mono text-meta text-fg-muted max-[1360px]:hidden">{c.auth}</span>
              <GroupSelect value={newGroup} onChange={setNewGroup} />
              <ProtectionSelect value={newProtection} onChange={setNewProtection} />
              <Button
                size="sm"
                className="justify-self-start"
                disabled={!newGroup}
                title={newGroup ? undefined : "Pick a group first: it decides the environment color and default protection"}
                onClick={() => {
                  addCluster({ ...c, env: newGroup!, protected: newProtection === "protected", readOnly: newProtection === "readonly" });
                  setDiscovered(discovered.filter((d) => d.id !== c.id));
                  setSelectedId(c.id);
                }}
              >
                Add &amp; connect
              </Button>
            </div>
          ))}
          {clusters.map((c) => {
            const st = STATUS[c.connection];
            return (
              <div
                key={c.id}
                role="option"
                aria-selected={c.id === selectedId}
                tabIndex={0}
                onClick={() => setSelectedId(c.id)}
                onKeyDown={(e) => e.key === "Enter" && setSelectedId(c.id)}
                className={cn(
                  grid,
                  "focus-ring h-[46px] cursor-default border-b border-line-row hover:bg-surface-hover",
                  c.id === selectedId && "bg-surface-selected shadow-[inset_2px_0_0_var(--accent)] hover:bg-surface-selected",
                )}
              >
                <TwoLine
                  first={
                    <span className="flex min-w-0 items-center gap-2">
                      <EnvMarker env={c.env} />
                      <span className="truncate font-medium">{c.name}</span>
                    </span>
                  }
                  second={<span className="font-mono">{c.server}</span>}
                />
                <span className="truncate font-mono text-meta text-fg-muted max-[1360px]:hidden">{c.auth}</span>
                <span onClick={(e) => e.stopPropagation()}>
                  <GroupSelect value={c.env} onChange={(env) => updateCluster(c.id, { env })} />
                </span>
                <span onClick={(e) => e.stopPropagation()}>
                  <ProtectionSelect value={protectionOf(c)} onChange={(p) => setProtection(c, p)} />
                </span>
                <TwoLine
                  first={
                    <span className={cn("flex min-w-0 items-center gap-[7px] text-ui font-medium", healthTone[st.health])}>
                      <StatusGlyph health={st.health} />
                      <span className="truncate">
                        {st.label}
                        {c.connection === "connected" && c.latencyMs !== null && ` · ${c.latencyMs}ms`}
                      </span>
                    </span>
                  }
                  second={statusDetail(c)}
                />
              </div>
            );
          })}
        </div>
        <div className="flex h-7 shrink-0 items-center border-t border-line px-4 text-meta text-fg-muted">
          Removing a context here hides it in Clustrail; your kubeconfig file is never modified
        </div>
      </main>

      {selected && (
        <aside aria-label="Context details" className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-panel max-[1360px]:w-[320px]">
          <div className="flex flex-col gap-1.5 px-3.5 pb-2.5 pt-2.5">
            <div className="flex items-center gap-1.5 text-ui text-fg-muted">
              <KeyRound className="size-3.5" aria-hidden />
              <span>Context</span>
              <EnvironmentBadge env={selected.env} className="ml-1" />
              <div className="flex-1" />
              <IconButton aria-label="Close" onClick={() => setSelectedId(null)} className="[&_svg]:size-3.5">
                <X />
              </IconButton>
            </div>
            <h1 className="selectable m-0 truncate font-mono text-mono-title font-semibold">{selected.name}</h1>
            <span className="truncate font-mono text-meta text-fg-muted">
              {selected.context} · {selected.source}
            </span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t border-line px-3.5 py-3">
            <ConnectionTest test={tests[selected.id]} onRun={() => runTest(selected)} />
            {selected.connection === "auth-expired" && selected.authHint && (
              <AuthHelp cluster={selected} onRetry={() => connectCluster(selected.id)} />
            )}
            {selected.connection === "unreachable" && (
              <div className="flex flex-col gap-1.5 text-cell">
                <b className="font-semibold">API server unreachable</b>
                <code className="selectable block rounded-md bg-term-bg px-2 py-1.5 font-mono text-ui text-term-fg">{selected.error}</code>
                <span className="text-fg-secondary">Start the cluster (for kind: docker start kind-local-control-plane), then retry.</span>
                <Button size="sm" variant="primary" className="self-start" onClick={() => connectCluster(selected.id)}>
                  <RefreshCw aria-hidden />
                  Retry connection
                </Button>
              </div>
            )}
            <section className="flex flex-col gap-1.5" aria-label="Protection">
              <span className="section-label">Protection</span>
              <div role="radiogroup" aria-label="Protection" className="flex flex-col gap-1.5">
                <ProtectionOption
                  value="standard"
                  current={protectionOf(selected)}
                  onSelect={(p) => setProtection(selected, p)}
                  title="Standard"
                  detail="Destructive actions ask for confirmation."
                />
                <ProtectionOption
                  value="protected"
                  current={protectionOf(selected)}
                  onSelect={(p) => setProtection(selected, p)}
                  title={
                    <>
                      <Lock className="size-3.5" aria-hidden />
                      Protected
                    </>
                  }
                  detail="Every change and every shell needs a typed confirmation."
                />
                <ProtectionOption
                  value="readonly"
                  current={protectionOf(selected)}
                  onSelect={(p) => setProtection(selected, p)}
                  title={
                    <>
                      <Eye className="size-3.5" aria-hidden />
                      Read-only
                    </>
                  }
                  detail="Changes and shell are blocked in Clustrail. Not a substitute for RBAC."
                />
              </div>
            </section>
            <div className="flex items-center gap-1.5">
              {selected.connection === "connected" || selected.connection === "reconnecting" ? (
                <Button onClick={() => disconnectCluster(selected.id)}>
                  <Unplug aria-hidden />
                  Disconnect
                </Button>
              ) : (
                <Button onClick={() => connectCluster(selected.id)} disabled={selected.connection === "connecting"}>
                  <Play aria-hidden />
                  Connect
                </Button>
              )}
              <div className="flex-1" />
              <Button
                variant="ghost"
                onClick={() => {
                  hideCluster(selected.id);
                  setSelectedId(null);
                }}
              >
                Hide context
              </Button>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}

function TwoLine({ first, second }: { first: ReactNode; second: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-[3px] text-cell">
      {first}
      <span className="truncate text-meta text-fg-muted">{second}</span>
    </div>
  );
}

const selectClass =
  "focus-ring flex h-6 w-full items-center justify-between gap-1.5 rounded-[5px] border border-line-strong bg-transparent pl-2 pr-1.5 text-ui text-fg";

function GroupSelect({ value, onChange }: { value: Environment | null; onChange: (env: Environment) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={selectClass} aria-label="Group">
          {value ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <EnvironmentBadge env={value} />
              <span className="truncate">{GROUP[value]}</span>
            </span>
          ) : (
            <span className="text-fg-muted">Unassigned</span>
          )}
          <ChevronDown className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={(v) => onChange(v as Environment)}>
          {(["prod", "stg", "dev"] as const).map((e) => (
            <DropdownMenuRadioItem key={e} value={e}>
              <EnvironmentBadge env={e} />
              {GROUP[e]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const PROTECTION_LABEL: Record<Protection, ReactNode> = {
  standard: (
    <span className="flex items-center gap-1.5 text-fg-secondary">
      <Shield className="size-3" aria-hidden />
      Standard
    </span>
  ),
  protected: (
    <span className="flex items-center gap-1.5 text-env-prod-ink">
      <Lock className="size-3" aria-hidden />
      Protected
    </span>
  ),
  readonly: (
    <span className="flex items-center gap-1.5 text-fg">
      <Eye className="size-3" aria-hidden />
      Read-only
    </span>
  ),
};

function ProtectionSelect({ value, onChange }: { value: Protection; onChange: (p: Protection) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={selectClass} aria-label="Protection">
          {PROTECTION_LABEL[value]}
          <ChevronDown className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as Protection)}>
          {(["standard", "protected", "readonly"] as const).map((p) => (
            <DropdownMenuRadioItem key={p} value={p}>
              {PROTECTION_LABEL[p]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProtectionOption({
  value,
  current,
  onSelect,
  title,
  detail,
}: {
  value: Protection;
  current: Protection;
  onSelect: (p: Protection) => void;
  title: ReactNode;
  detail: string;
}) {
  const on = value === current;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={() => onSelect(value)}
      className={cn(
        "focus-ring grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5 rounded-lg border border-line bg-transparent px-2.5 py-2 text-left text-cell text-fg",
        on && "border-line-selected bg-accent-soft",
      )}
    >
      <span className={cn("mt-0.5 flex size-3.5 items-center justify-center rounded-full border border-line-strong", on && "border-accent")}>
        {on && <span className="size-1.5 rounded-full bg-accent" />}
      </span>
      <span className="flex flex-col gap-0.5">
        <b className="flex items-center gap-1.5 font-semibold">{title}</b>
        <span className="text-meta text-fg-muted">{detail}</span>
      </span>
    </button>
  );
}

function ConnectionTest({ test, onRun }: { test?: { steps: TestStep[]; at: string; shown: number }; onRun: () => void }) {
  return (
    <section className="flex flex-col" aria-label="Connection test">
      <div className="flex items-center gap-2 pb-1">
        <span className="section-label flex-1">Connection test</span>
        {test && <span className="font-mono text-meta text-fg-muted">{test.at}</span>}
        <Button size="sm" variant="ghost" onClick={onRun}>
          <Play aria-hidden />
          Test
        </Button>
      </div>
      {test?.steps.map((s, i) => {
        const pending = i >= test.shown;
        return (
          <div
            key={s.name}
            className={cn(
              "grid h-[26px] grid-cols-[16px_110px_minmax(0,1fr)_auto] items-center gap-x-2 text-cell",
              (s.result === "skipped" || pending) && "text-fg-muted",
            )}
          >
            {pending ? (
              <StatusGlyph health="idle" />
            ) : s.result === "ok" ? (
              <StatusGlyph health="completed" className="text-status-healthy" />
            ) : s.result === "failed" ? (
              <StatusGlyph health="failed" />
            ) : (
              <StatusGlyph health="terminating" />
            )}
            <span className={cn(s.result === "failed" && !pending && "font-semibold")}>{s.name}</span>
            <span className={cn("truncate text-meta", s.result === "failed" && !pending ? "text-status-critical" : "text-fg-muted", s.name === "DNS" && "font-mono")}>
              {pending ? "" : s.detail}
            </span>
            <span className="font-mono text-meta text-fg-muted">{!pending && s.ms !== undefined ? (s.ms >= 1000 ? `${(s.ms / 1000).toFixed(1)}s` : `${s.ms}ms`) : ""}</span>
          </div>
        );
      })}
    </section>
  );
}

function AuthHelp({ cluster: c, onRetry }: { cluster: Cluster; onRetry: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5 text-cell">
      <b className="font-semibold">Credentials expired</b>
      <code className="selectable block rounded-md bg-term-bg px-2 py-1.5 font-mono text-ui text-term-fg">
        {c.authHint!.plugin}: Reauthentication failed. cannot prompt during non-interactive execution.
      </code>
      <span className="text-fg-secondary">Run this in your own terminal, then retry:</span>
      <div className="flex items-center gap-1.5">
        <code className="selectable flex-1 rounded-md border border-line-strong bg-surface-app px-2 py-1 font-mono text-ui">{c.authHint!.command}</code>
        <IconButton
          aria-label={copied ? "Copied" : "Copy command"}
          onClick={() =>
            void navigator.clipboard?.writeText(c.authHint!.command).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
          }
        >
          {copied ? <Check className="text-status-healthy" /> : <Copy />}
        </IconButton>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={onRetry}>
          <RefreshCw aria-hidden />
          Retry connection
        </Button>
        <span className="text-meta text-fg-muted">Clustrail never handles your password</span>
      </div>
    </div>
  );
}
