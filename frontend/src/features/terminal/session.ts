// Kept apart from ShellWorkspace (lazy-loaded with xterm) so any view can ask for a session.

/** What a reveal of kind "session" carries: "cluster/ns/pod/container", or this as JSON. */
export interface SessionRequest {
  cluster: string;
  namespace: string;
  pod: string;
  container: string;
  /** Runs instead of the default shell. */
  command?: string[];
  /** A node shell pod Clustrail started; closing the session deletes it. */
  nodeShell?: { node: string };
  /** An ephemeral debug container. */
  debug?: boolean;
  /** attach: the container's main process (kubectl attach); local: this machine's shell with the cluster's context. */
  mode?: "attach" | "local";
}

export function sessionRevealId(r: SessionRequest): string {
  return JSON.stringify(r);
}
