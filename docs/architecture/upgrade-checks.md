# API removals and quotas

Two checks that only report facts the cluster records. Neither guesses.

## API removals

What stops working when the control plane moves to a later Kubernetes minor.

**Removal versions** come from the lifecycle tags Kubernetes keeps in
`k8s.io/api` (`APILifecycleRemoved`, `APILifecycleReplacement`), read from the
client-go scheme at start. They follow the client-go version Clustrail is built
with. Versions already deleted from `k8s.io/api` carry no tags any more; five are
listed by hand from the deprecated API migration guide (`autoscaling/v2beta1`
and `v2beta2`, both `PodSecurityPolicy` versions, `apiregistration.k8s.io/v1beta1`).

**What uses them.** Only sources that record the version that was used:

| Source | What it proves | Limits |
|---|---|---|
| Helm release manifest | The current revision (newest deployed, else newest) declares that apiVersion, hooks included. Helm builds the release's current objects from it, so `helm upgrade` fails once the version is gone. | Older revisions are not read. |
| `kubectl.kubernetes.io/last-applied-configuration` | The file last applied with `kubectl apply` used that apiVersion; applying it again fails once the version is gone. | Only objects created or updated with client-side apply. Kinds that controllers create (Events, Leases, EndpointSlices, …) are not listed. |
| `apiserver_requested_deprecated_apis` | A client requested that group/version/resource since the API server started. | Needs `get` on the `/metrics` URL. Counts only the API server that answered. Does not name the client: the audit log does. |

A live object is not a source: the API server converts every object to the
version it is asked for.

Objects are read with metadata-only lists (500 a page), cluster-wide, else in
the context's namespace with a note. Tested with fakes and against a real API
server (`TestAPIRemovalsAgainstAPIServer`, envtest).

## Quotas and limits

`status.used` against `status.hard` of each ResourceQuota, as the quota
controller counts them; full means used ≥ hard, so anything that adds to it is
refused. LimitRanges are shown as stored (the API server fills `defaultRequest`
from `default`, and `default` from `max`, when they are left out).

Two rules are derived, both from the admission plugins:

- A container without a request or limit gets the LimitRange's Container
  defaults.
- A quota without scopes that limits `requests.cpu`/`cpu`, `requests.memory`/`memory`,
  `limits.cpu` or `limits.memory` refuses pods whose containers do not set it
  (a limit also counts as the request), unless a LimitRange default fills it in.

Scoped quotas (`BestEffort`, `NotBestEffort`, priority classes, …) make no rule:
whether they match a pod depends on the pod.
