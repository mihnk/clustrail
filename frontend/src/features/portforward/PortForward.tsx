import { useEffect, useState, useSyncExternalStore } from "react";
import { Dialog } from "radix-ui";
import { ArrowLeftRight, ExternalLink, Square, X } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { backend, errorText, EVENTS, onEvent, openExternal, type PortForwardInfo, type PortForwardRequest } from "@/backend/client";
import { Button, IconButton } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { t as tt } from "@/i18n";

type Target = Pick<PortForwardRequest, "cluster" | "namespace" | "kind" | "name">;

// One dialog for the whole app; any view asks for it with openPortForward().
let pending: Target | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
export function openPortForward(t: Target) {
  pending = t;
  listeners.forEach((l) => l());
}
function closePortForward() {
  pending = null;
  listeners.forEach((l) => l());
}

/** Active forwards, kept current by backend events. */
export function usePortForwards(): PortForwardInfo[] {
  const [list, setList] = useState<PortForwardInfo[]>([]);
  useEffect(() => {
    if (!backend) return;
    let cancelled = false;
    void backend.portForwards().then((l) => !cancelled && setList(l ?? []));
    const off = onEvent<PortForwardInfo[]>(EVENTS.portForwards, (l) => setList(l ?? []));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return list;
}

const urlOf = (f: Pick<PortForwardInfo, "localPort">) => `http://localhost:${f.localPort}`;

/** The port-forward dialog, mounted once. */
export function PortForwardHost() {
  const target = useSyncExternalStore(subscribe, () => pending);
  return target ? <PortForwardDialog key={`${target.cluster}/${target.namespace}/${target.kind}/${target.name}`} target={target} /> : null;
}

function PortForwardDialog({ target }: { target: Target }) {
  const ws = useWorkspace();
  const toast = useToast();
  const cluster = ws.clusterById(target.cluster);
  const [ports, setPorts] = useState<{ port: number; name?: string; detail?: string }[] | null>(null);
  const [port, setPort] = useState("");
  const [local, setLocal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!backend) return;
    void backend
      .forwardablePorts(target.cluster, target.kind, target.namespace, target.name)
      .then((p) => {
        setPorts(p ?? []);
        if (p?.[0]) setPort(String(p[0].port));
      })
      .catch(() => setPorts([]));
  }, []);

  const remote = Number(port);
  // Ports below 1024 need root on Linux; let the OS pick one instead.
  const suggestedLocal = remote >= 1024 ? remote : 0;
  const localNum = local === "" ? suggestedLocal : Number(local);
  const valid = Number.isInteger(remote) && remote > 0 && remote < 65536 && Number.isInteger(localNum) && localNum >= 0 && localNum < 65536;

  const start = () => {
    if (!backend || !valid) return;
    setBusy(true);
    setError(null);
    backend
      .startPortForward({ ...target, port: remote, localPort: localNum })
      .then((f) => {
        closePortForward();
        toast.show({
          kind: "success",
          title: tt("Forwarding localhost:{localPort}", { localPort: f.localPort }),
          target: `${target.name}:${remote} · ${target.cluster}`,
          env: cluster?.env,
          action: { label: tt("Open"), onClick: () => openExternal(urlOf(f)) },
        });
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && closePortForward()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[120px] z-50 flex w-[460px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-3.5 rounded-xl border border-line-strong bg-surface-elevated p-5 text-fg shadow-dialog"
        >
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="size-4 text-fg-secondary" aria-hidden />
            <Dialog.Title className="m-0 text-title font-semibold">{tt("Port forward")}</Dialog.Title>
            <div className="flex-1" />
            <Dialog.Close asChild>
              <IconButton aria-label={tt("Close")}>
                <X />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className="flex items-center gap-1.5 text-ui">
            {cluster && <EnvironmentBadge env={cluster.env} />}
            <span className="font-mono">
              {target.kind.toLowerCase()}/{target.name}
            </span>
            <span className="text-fg-muted">
              · {target.namespace} · {target.cluster}
            </span>
          </div>
          {ports && ports.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {ports.map((p) => (
                <button
                  key={`${p.port}/${p.name}`}
                  type="button"
                  onClick={() => setPort(String(p.port))}
                  className={cn(
                    "focus-ring rounded-md border px-2 py-1 text-left text-meta",
                    String(p.port) === port ? "border-accent bg-accent-soft text-fg" : "border-line-strong text-fg-secondary",
                  )}
                >
                  <span className="font-mono">{p.port}</span>
                  {p.name ? ` ${p.name}` : ""}
                  {p.detail && <span className="text-fg-muted"> · {p.detail}</span>}
                </button>
              ))}
            </div>
          )}
          {ports && ports.length === 0 && <span className="text-meta text-fg-muted">{tt("No ports are declared; type the port the process listens on.")}</span>}
          <div className="grid grid-cols-2 gap-3">
            <TextField label={target.kind === "Service" ? tt("Service port") : tt("Container port")} mono inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.trim())} autoFocus />
            <TextField
              label={tt("Local port")}
              mono
              inputMode="numeric"
              value={local}
              placeholder={suggestedLocal ? String(suggestedLocal) : tt("any free")}
              onChange={(e) => setLocal(e.target.value.trim())}
              onKeyDown={(e) => e.key === "Enter" && start()}
            />
          </div>
          <span className="text-meta text-fg-muted">{tt("Listens on 127.0.0.1 only.")}{" "}{target.kind !== "Pod" && tt("Reaches one ready pod; when it goes away, the forward reconnects to another.")}
          </span>
          {error && <span className="selectable rounded-md bg-status-critical-soft px-2.5 py-2 font-mono text-meta text-status-critical">{error}</span>}
          <code className="selectable block truncate rounded-md bg-surface-panel px-2.5 py-1.5 font-mono text-meta text-fg-secondary">{tt("kubectl --context")}{" "}{cluster?.context ?? target.cluster} -n {target.namespace} port-forward {target.kind.toLowerCase()}/{target.name} {localNum || ""}:{port || "PORT"}
          </code>
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>{tt("Cancel")}</Button>
            </Dialog.Close>
            <Button variant="primary" disabled={!valid || busy} onClick={start}>
              {busy ? tt("Starting…") : tt("Start forward")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Status bar item: active forwards with open and stop. */
export function PortForwardIndicator() {
  const forwards = usePortForwards();
  if (!forwards.length) return null;
  const troubled = forwards.filter((f) => f.state !== "active").length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn("focus-ring flex items-center gap-1 whitespace-nowrap rounded px-1", troubled ? "text-status-warning" : "text-fg-secondary")}>
          <ArrowLeftRight className="size-3" aria-hidden />
          {tt(forwards.length === 1 ? "1 forward" : "{n} forwards", { n: forwards.length })}
          {troubled > 0 && tt(" · {troubled} reconnecting", { troubled })}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[380px]">
        <DropdownMenuLabel>{tt("Port forwards")}</DropdownMenuLabel>
        {forwards.map((f) => (
          <div key={f.id} className="flex items-center gap-2 px-2 py-1.5 text-ui">
            <span className={cn("size-1.5 shrink-0 rounded-full", f.state === "active" ? "bg-status-healthy" : "bg-status-warning")} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-mono">{tt("localhost:{localPort} → {v1}/{name}:{port}", { localPort: f.localPort, v1: f.kind.toLowerCase(), name: f.name, port: f.port })}
              </span>
              <span className="truncate text-meta text-fg-muted" title={f.error}>
                {f.state === "active" ? `${f.pod}:${f.podPort} · ${f.cluster}` : `${f.state}${f.error ? ` · ${f.error}` : ""}`}
              </span>
            </div>
            <IconButton aria-label={tt("Open in browser")} onClick={() => openExternal(urlOf(f))} disabled={f.state !== "active"}>
              <ExternalLink />
            </IconButton>
            <IconButton aria-label={tt("Stop forward")} onClick={() => void backend?.stopPortForward(f.id)}>
              <Square />
            </IconButton>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
