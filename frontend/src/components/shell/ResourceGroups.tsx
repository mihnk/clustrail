import { useState, type ReactNode } from "react";
import {
  ArrowLeftRight,
  Box,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Database,
  FileText,
  Gauge,
  Globe,
  HardDrive,
  KeyRound,
  Layers,
  Network,
  Play,
  Puzzle,
  Route,
  Shield,
  Waypoints,
  type LucideIcon,
  Boxes,
  Scale,
  ShieldAlert,
  Timer,
  Cpu,
  Webhook,
  Split,
  DoorOpen,
  Archive,
  Users,
  UserCog,
  Link2,
  FileCode2,
} from "lucide-react";
import { useWorkspace, type WorkspaceTabKind } from "@/app/workspace";
import { backend, type KindInfo } from "@/backend/client";
import { customGroups, listLabel, NAV_FOLDED_BY_DEFAULT, NAV_GROUPS, served, type NavEntry } from "@/features/resources/kinds";
import { useQueries } from "@/lib/useQuery";
import { cn } from "@/lib/cn";
import { t } from "@/i18n";

const ICONS: Record<string, LucideIcon> = {
  pods: Box,
  deployments: Layers,
  "apps/StatefulSet": Database,
  "apps/DaemonSet": Copy,
  "apps/ReplicaSet": Boxes,
  "batch/Job": Play,
  "batch/CronJob": Clock,
  ConfigMap: FileText,
  Secret: KeyRound,
  "autoscaling/HorizontalPodAutoscaler": Scale,
  "policy/PodDisruptionBudget": ShieldAlert,
  quotas: Gauge,
  "scheduling.k8s.io/PriorityClass": Timer,
  "node.k8s.io/RuntimeClass": Cpu,
  "coordination.k8s.io/Lease": Link2,
  "admissionregistration.k8s.io/MutatingWebhookConfiguration": Webhook,
  "admissionregistration.k8s.io/ValidatingWebhookConfiguration": Webhook,
  Service: Network,
  "discovery.k8s.io/EndpointSlice": Split,
  "networking.k8s.io/Ingress": Globe,
  "networking.k8s.io/IngressClass": DoorOpen,
  network: Waypoints,
  chain: Route,
  portforwards: ArrowLeftRight,
  storage: HardDrive,
  PersistentVolumeClaim: Archive,
  PersistentVolume: HardDrive,
  "storage.k8s.io/StorageClass": Layers,
  ServiceAccount: UserCog,
  "rbac.authorization.k8s.io/Role": Shield,
  "rbac.authorization.k8s.io/RoleBinding": Users,
  "rbac.authorization.k8s.io/ClusterRole": Shield,
  "rbac.authorization.k8s.io/ClusterRoleBinding": Users,
  "apiextensions.k8s.io/CustomResourceDefinition": FileCode2,
};

const FOLD_KEY = "clustrail.nav.folded";

function readFolded(): Set<string> {
  try {
    const raw = localStorage.getItem(FOLD_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* storage unavailable: defaults */
  }
  return new Set(NAV_FOLDED_BY_DEFAULT);
}

function saveFolded(s: Set<string>) {
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify([...s]));
  } catch {
    /* not kept */
  }
}

/** The kinds each connected, selected cluster serves, from discovery (refreshed by the backend every 5 minutes). */
function useServedKinds(): { servedKeys: Set<string> | null; kinds: KindInfo[] } {
  const { selectedClusters } = useWorkspace();
  const connected = selectedClusters.filter((c) => c.connection === "connected").map((c) => c.id);
  const entries: [string, string][] = backend ? connected.map((c) => [c, `resourceKinds|${c}`]) : [];
  const { states } = useQueries(entries, (c) => backend!.resourceKinds(c), { keepPrevious: true, every: 5 * 60_000 });
  const lists = Object.values(states)
    .map((s) => s.data)
    .filter((d): d is KindInfo[] => !!d);
  if (!lists.length) return { servedKeys: null, kinds: [] };
  const kinds = lists.flat();
  return { servedKeys: new Set(kinds.map((k) => (k.group ? `${k.group}/${k.kind}` : k.kind))), kinds };
}

/**
 * The sidebar's resource groups, Lens's order: Workloads, Config, Network,
 * Storage, Access control, then custom resources by API group. Folds are
 * remembered on this machine. Kinds no selected cluster serves are left out.
 */
export function ResourceGroups({ trailing, mockCounts, real }: { trailing: Partial<Record<string, ReactNode>>; mockCounts: Partial<Record<string, ReactNode>>; real: boolean }) {
  const { activeTab, openView, openTab } = useWorkspace();
  const [folded, setFolded] = useState(readFolded);
  const { servedKeys, kinds } = useServedKinds();
  const kind = activeTab?.kind;
  const listKind = kind === "list" ? activeTab?.params?.kind : undefined;

  const toggle = (id: string) =>
    setFolded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveFolded(next);
      return next;
    });

  const item = (e: NavEntry, indent = false) => {
    if ("view" in e) {
      const Icon = ICONS[e.view] ?? Box;
      const open = () => (e.view === "pods" ? openTab("pods") : openView({ kind: e.view as WorkspaceTabKind, title: e.label }));
      return <Entry key={e.view} icon={<Icon />} label={e.label} active={kind === e.view} onClick={open} trailing={trailing[e.view]} indent={indent} />;
    }
    if (!served(e.list, servedKeys)) return null;
    // The browser preview has no backend for kinds it never listed.
    if (!real && !(e.list in mockCounts)) return null;
    const Icon = ICONS[e.list] ?? Box;
    const label = listLabel(e.list);
    return (
      <Entry
        key={e.list}
        icon={<Icon />}
        label={label}
        active={listKind === e.list}
        onClick={() => openView({ kind: "list", title: label, params: { kind: e.list } })}
        trailing={real ? undefined : mockCounts[e.list]}
        indent={indent}
      />
    );
  };

  const custom = customGroups(kinds);
  return (
    <>
      {NAV_GROUPS.map((g) => {
        const items = g.entries.map((e) => item(e)).filter(Boolean);
        if (!items.length) return null;
        return (
          <Group key={g.id} id={g.id} title={g.title} folded={folded.has(g.id)} onToggle={() => toggle(g.id)}>
            {items}
          </Group>
        );
      })}
      {real && custom.length > 0 && (
        <Group id="custom" title={t("Custom resources")} hint={t("{n} kinds", { n: custom.reduce((n, g) => n + g.kinds.length, 0) })} folded={folded.has("custom")} onToggle={() => toggle("custom")}>
          {item({ list: "apiextensions.k8s.io/CustomResourceDefinition" })}
          {custom.map((g) => {
            const id = `custom:${g.group}`;
            const open = !folded.has(id) && folded.has(`${id}:seen`);
            return (
              <div key={g.group} className="flex flex-col gap-px">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => {
                    // Sub-groups start folded: "seen" marks that the user opened one before.
                    setFolded((cur) => {
                      const next = new Set(cur);
                      if (open) next.add(id);
                      else {
                        next.delete(id);
                        next.add(`${id}:seen`);
                      }
                      saveFolded(next);
                      return next;
                    });
                  }}
                  className="focus-ring flex h-6 w-full items-center gap-1.5 rounded-md border-0 bg-transparent pl-4 pr-2 text-left font-mono text-meta text-fg-secondary hover:bg-surface-hover [&>svg]:size-3"
                >
                  {open ? <ChevronDown /> : <ChevronRight />}
                  <span className="truncate">{g.group}</span>
                  <span className="ml-auto text-fg-muted">{g.kinds.length}</span>
                </button>
                {open &&
                  g.kinds.map((k) => {
                    const key = `${k.group}/${k.kind}`;
                    return (
                      <Entry
                        key={key}
                        icon={<Puzzle />}
                        label={k.kind}
                        mono
                        active={listKind === key}
                        onClick={() => openView({ kind: "list", title: k.kind, params: { kind: key } })}
                        indent
                      />
                    );
                  })}
              </div>
            );
          })}
        </Group>
      )}
    </>
  );
}

function Group({ id, title, hint, folded, onToggle, children }: { id: string; title: string; hint?: string; folded: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-px">
      <button
        type="button"
        aria-expanded={!folded}
        aria-controls={`nav-${id}`}
        onClick={onToggle}
        className="focus-ring flex h-6 w-full items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-left hover:bg-surface-hover [&>svg]:size-3 [&>svg]:text-fg-muted"
      >
        {folded ? <ChevronRight /> : <ChevronDown />}
        <span className="section-label">{title}</span>
        {hint && <span className="ml-auto text-meta text-fg-muted">{hint}</span>}
      </button>
      {!folded && (
        <div id={`nav-${id}`} className="flex flex-col gap-px">
          {children}
        </div>
      )}
    </section>
  );
}

function Entry({ icon, label, trailing, active, onClick, indent, mono }: { icon: ReactNode; label: string; trailing?: ReactNode; active?: boolean; onClick: () => void; indent?: boolean; mono?: boolean }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "focus-ring flex h-7 w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-body leading-none text-fg-secondary hover:bg-surface-hover [&>svg]:size-4 [&>svg]:shrink-0",
        indent && "pl-6",
        active && "bg-surface-panel font-medium text-fg shadow-[0_0_0_1px_var(--line)] dark:bg-surface-hover dark:shadow-none",
      )}
    >
      {icon}
      <span className={cn("truncate", mono && "font-mono text-ui")}>{label}</span>
      {trailing}
    </button>
  );
}
