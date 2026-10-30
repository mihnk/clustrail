import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { Bug, Server, TriangleAlert, X } from "lucide-react";
import { useWorkspace } from "@/app/workspace";
import { backend, errorText } from "@/backend/client";
import { Button, IconButton } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { EnvironmentBadge } from "@/components/status/EnvironmentBadge";
import { useToast } from "@/components/ui/toast";
import { sessionRevealId } from "@/features/terminal/session";
import { cn } from "@/lib/cn";
import { t as tt, tn } from "@/i18n";

// Debug a pod with an ephemeral container, or a node through a privileged pod
// (internal/kube/debug.go). One host for both; views ask with openDebug().

type DebugTarget =
  | { kind: "pod"; cluster: string; namespace: string; pod: string }
  | { kind: "node"; cluster: string; node: string };

let pending: DebugTarget | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
export function openDebug(t: DebugTarget) {
  pending = t;
  listeners.forEach((l) => l());
}
function closeDebug() {
  pending = null;
  listeners.forEach((l) => l());
}

export function DebugHost() {
  const target = useSyncExternalStore(subscribe, () => pending);
  if (!target) return null;
  return target.kind === "pod" ? (
    <PodDebugDialog key={`${target.cluster}/${target.namespace}/${target.pod}`} target={target} />
  ) : (
    <NodeShellDialog key={`${target.cluster}/${target.node}`} target={target} />
  );
}

const IMAGES = [
  { image: "busybox:1.37", text: tt("Small: sh, ps, wget, nslookup") },
  { image: "nicolaka/netshoot:v0.13", text: tt("Network: dig, curl, tcpdump, ss") },
];
const PROFILES = ["general", "baseline", "restricted", "netadmin", "sysadmin"] as const;

function Frame({
  icon,
  title,
  cluster,
  subtitle,
  children,
  footer,
}: {
  icon: ReactNode;
  title: string;
  cluster: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  const ws = useWorkspace();
  const c = ws.clusterById(cluster);
  const strong = c?.protected || c?.env === "prod";
  return (
    <Dialog.Root open onOpenChange={(o) => !o && closeDebug()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[90px] z-50 flex max-h-[calc(100vh-120px)] w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line-strong bg-surface-elevated text-fg shadow-dialog"
        >
          {strong && <div className="h-1 shrink-0 bg-env-prod" aria-hidden />}
          <div className="flex flex-col gap-3.5 overflow-y-auto p-5">
            <div className="flex items-center gap-2">
              <span className="text-fg-secondary [&_svg]:size-4">{icon}</span>
              <Dialog.Title className="m-0 text-title font-semibold">{title}</Dialog.Title>
              <div className="flex-1" />
              {c && <EnvironmentBadge env={c.env} />}
              {c?.protected && <span className="text-meta font-semibold text-env-prod-ink">{tt("Protected")}</span>}
              <Dialog.Close asChild>
                <IconButton aria-label={tt("Close")}>
                  <X />
                </IconButton>
              </Dialog.Close>
            </div>
            <span className="-mt-2 truncate font-mono text-meta text-fg-secondary">{subtitle}</span>
            {children}
          </div>
          <div className="flex items-center gap-2 border-t border-line-strong bg-surface-panel px-5 py-3">{footer}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Typed confirmation for production and protected contexts, like every other change. */
function useTyped(cluster: string) {
  const ws = useWorkspace();
  const c = ws.clusterById(cluster);
  const needed = !!(c?.protected || c?.env === "prod");
  const [typed, setTyped] = useState("");
  const field = needed ? (
    <TextField
      label={tn("Type {v0} to confirm", { v0: <b className="font-mono font-semibold text-env-prod-ink">{cluster}</b> })}
      mono
      value={typed}
      onChange={(e) => setTyped(e.target.value)}
    />
  ) : null;
  return { ok: !needed || typed.trim() === cluster, field, context: c?.context ?? cluster };
}

function PodDebugDialog({ target }: { target: Extract<DebugTarget, { kind: "pod" }> }) {
  const ws = useWorkspace();
  const toast = useToast();
  const [containers, setContainers] = useState<string[]>([]);
  const [image, setImage] = useState(IMAGES[1]!.image);
  const [custom, setCustom] = useState("");
  const [targetContainer, setTargetContainer] = useState("");
  const [profile, setProfile] = useState<(typeof PROFILES)[number]>("general");
  const [command, setCommand] = useState("sh");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typed = useTyped(target.cluster);

  useEffect(() => {
    if (!backend) return;
    let cancelled = false;
    void backend
      .podDetail(target.cluster, target.namespace, target.pod)
      .then((d) => {
        if (cancelled) return;
        const names = d.containers.map((c) => c.name);
        setContainers(names);
        setTargetContainer((cur) => cur || names[0] || "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [target.cluster, target.namespace, target.pod]);

  const chosen = image === "custom" ? custom.trim() : image;
  const argv = command.trim().split(/\s+/).filter(Boolean);
  const kubectl = `kubectl --context ${typed.context} debug -n ${target.namespace} ${target.pod} -it --image=${chosen || "IMAGE"}${targetContainer ? ` --target=${targetContainer}` : ""} --profile=${profile} -- ${argv.join(" ") || "sh"}`;

  const start = () => {
    if (!backend || !chosen || !typed.ok) return;
    setBusy(true);
    setError(null);
    backend
      .addDebugContainer({ cluster: target.cluster, namespace: target.namespace, pod: target.pod, image: chosen, target: targetContainer, profile, command: argv })
      .then((dc) => {
        closeDebug();
        ws.openView({ id: "shell", kind: "shell", title: "Shell", cluster: target.cluster });
        ws.revealResource("session", sessionRevealId({ cluster: target.cluster, namespace: dc.namespace, pod: dc.pod, container: dc.container, command: argv.length ? argv : ["sh"], debug: true }));
        toast.show({ kind: "success", title: tt("Debug container running"), target: `${dc.container} · ${target.pod}` });
      })
      .catch((e) => {
        setError(errorText(e));
        setBusy(false);
      });
  };

  return (
    <Frame
      icon={<Bug />}
      title={tt("Debug container")}
      cluster={target.cluster}
      subtitle={`${target.namespace}/${target.pod} · ${target.cluster}`}
      footer={
        <>
          <span className="text-meta text-fg-muted">{tt("Opens a Shell tab attached to the container")}</span>
          <div className="flex-1" />
          <Dialog.Close asChild>
            <Button>{tt("Cancel")}</Button>
          </Dialog.Close>
          <Button variant="danger" disabled={!chosen || !typed.ok || busy} onClick={start}>
            {busy ? tt("Starting… (pulling the image)") : tt("Add debug container")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-ui text-fg-secondary">{tt("Image")}</span>
        <div className="grid grid-cols-3 gap-2">
          {[...IMAGES, { image: "custom", text: tt("Any image you can pull") }].map((im) => (
            <button
              key={im.image}
              type="button"
              aria-pressed={image === im.image}
              onClick={() => setImage(im.image)}
              className={cn(
                "focus-ring flex flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-left",
                image === im.image ? "border-line-selected bg-surface-selected" : "border-line-strong bg-surface-panel",
              )}
            >
              <span className="truncate font-mono text-meta font-semibold">{im.image === "custom" ? tt("Custom…") : im.image}</span>
              <span className="text-meta text-fg-secondary">{im.text}</span>
            </button>
          ))}
        </div>
        {image === "custom" && <TextField aria-label={tt("Custom image")} mono autoFocus placeholder="registry.example.com/tools:1.0" value={custom} onChange={(e) => setCustom(e.target.value)} />}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-[5px] text-ui text-fg-secondary">
          {tt("Target container")}
          <select value={targetContainer} onChange={(e) => setTargetContainer(e.target.value)} className="focus-ring h-7 rounded-md border border-line-strong bg-surface-app px-2 font-mono text-cell text-fg">
            {containers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            <option value="">{tt("None (own processes only)")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-[5px] text-ui text-fg-secondary">
          {tt("Profile")}
          <select value={profile} onChange={(e) => setProfile(e.target.value as (typeof PROFILES)[number])} className="focus-ring h-7 rounded-md border border-line-strong bg-surface-app px-2 font-mono text-cell text-fg">
            {PROFILES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>
      <TextField label={tt("Command")} mono value={command} onChange={(e) => setCommand(e.target.value)} />
      <div className="flex items-start gap-2 rounded-lg bg-status-warning-soft px-3 py-2 text-meta leading-[1.45] text-fg-secondary">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-status-warning" aria-hidden />
        <span>{tt("An ephemeral container cannot be removed. It stays in the pod spec until the pod is deleted, and it does not restart. The pod keeps running; nothing else changes.")}</span>
      </div>
      <code className="selectable block break-all rounded-md bg-surface-panel px-2.5 py-1.5 font-mono text-meta text-fg-secondary">{kubectl}</code>
      {typed.field}
      {error && <span className="selectable rounded-md bg-status-critical-soft px-2.5 py-2 font-mono text-meta text-status-critical">{error}</span>}
    </Frame>
  );
}

function NodeShellDialog({ target }: { target: Extract<DebugTarget, { kind: "node" }> }) {
  const ws = useWorkspace();
  const toast = useToast();
  const [image, setImage] = useState("busybox:1.37");
  const [namespace, setNamespace] = useState("kube-system");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typed = useTyped(target.cluster);

  const start = () => {
    if (!backend || !image.trim() || !typed.ok) return;
    setBusy(true);
    setError(null);
    backend
      .startNodeShell({ cluster: target.cluster, node: target.node, namespace: namespace.trim(), image: image.trim() })
      .then((sh) => {
        closeDebug();
        ws.openView({ id: "shell", kind: "shell", title: "Shell", cluster: target.cluster });
        ws.revealResource("session", sessionRevealId({ cluster: target.cluster, namespace: sh.namespace, pod: sh.pod, container: sh.container, command: sh.command, nodeShell: { node: target.node } }));
      })
      .catch((e) => {
        setError(errorText(e));
        setBusy(false);
        toast.show({ kind: "error", title: tt("Node shell did not start"), target: `${target.node} · ${target.cluster}`, detail: errorText(e), copyText: errorText(e) });
      });
  };

  return (
    <Frame
      icon={<Server />}
      title={tt("Node shell")}
      cluster={target.cluster}
      subtitle={`${target.node} · ${target.cluster}`}
      footer={
        <>
          <span className="text-meta text-fg-muted">{tt("Recorded in clustrail.log")}</span>
          <div className="flex-1" />
          <Dialog.Close asChild>
            <Button>{tt("Cancel")}</Button>
          </Dialog.Close>
          <Button variant="danger" disabled={!image.trim() || !namespace.trim() || !typed.ok || busy} onClick={start}>
            {busy ? tt("Starting…") : tt("Start node shell")}
          </Button>
        </>
      }
    >
      <p className="m-0 text-ui leading-[1.5] text-fg-secondary">
        {tt("Clustrail starts a privileged pod on this node with the host’s process, network and IPC namespaces, then opens a shell in the node’s root filesystem.")}{" "}
        <code className="font-mono text-fg">chroot /host</code>
      </p>
      <div className="grid grid-cols-2 gap-3">
        <TextField label={tt("Image")} mono value={image} onChange={(e) => setImage(e.target.value)} />
        <TextField label={tt("Namespace")} mono value={namespace} onChange={(e) => setNamespace(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1 rounded-lg border border-line-strong px-3 py-2 text-meta">
        <span className="font-semibold">{tt("The pod")}</span>
        <span className="text-fg-secondary">{tt("privileged · hostPID · hostNetwork · hostIPC · tolerates every taint · pinned to the node · deleted when the shell closes or Clustrail quits")}</span>
      </div>
      <div className="flex items-start gap-2 rounded-lg bg-status-critical-soft px-3 py-2 text-meta leading-[1.45] text-fg-secondary">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-status-critical" aria-hidden />
        <span>{tt("This is root on the node. Pod Security admission (baseline or restricted) on the namespace refuses it; the error says which policy.")}</span>
      </div>
      <code className="selectable block break-all rounded-md bg-surface-panel px-2.5 py-1.5 font-mono text-meta text-fg-secondary">
        kubectl --context {typed.context} debug node/{target.node} -it --profile=sysadmin --image={image || "IMAGE"} -- chroot /host
      </code>
      {typed.field}
      {error && <span className="selectable rounded-md bg-status-critical-soft px-2.5 py-2 font-mono text-meta text-status-critical">{error}</span>}
    </Frame>
  );
}
