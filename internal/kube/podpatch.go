package kube

import "maps"

// PodRow on the pod stream (internal/streaming): an update of a pod the
// window already has goes out as its changed fields (issue C6).
// TestPodRowPatchCoversEveryField fails when a field is added to PodRow
// without being compared here.

func eqIntPtr(a, b *int) bool { return (a == nil) == (b == nil) && (a == nil || *a == *b) }

func eqInt64Ptr(a, b *int64) bool { return (a == nil) == (b == nil) && (a == nil || *a == *b) }

// ChangedFields lists the JSON fields of p that differ from old.
func (p PodRow) ChangedFields(old PodRow) []string {
	var out []string
	add := func(changed bool, name string) {
		if changed {
			out = append(out, name)
		}
	}
	add(p.UID != old.UID, "uid")
	add(p.Name != old.Name, "name")
	add(p.Namespace != old.Namespace, "namespace")
	add(p.Cluster != old.Cluster, "cluster")
	add(p.Env != old.Env, "env")
	add(p.Node != old.Node, "node")
	add(p.Health != old.Health, "health")
	add(p.Status != old.Status, "status")
	add(p.Reason != old.Reason, "reason")
	add(p.ReadyContainers != old.ReadyContainers, "readyContainers")
	add(p.TotalContainers != old.TotalContainers, "totalContainers")
	add(p.Restarts != old.Restarts, "restarts")
	add(!eqIntPtr(p.CPUMilli, old.CPUMilli), "cpuMilli")
	add(!eqIntPtr(p.MemoryMiB, old.MemoryMiB), "memoryMiB")
	add(p.AgeSeconds != old.AgeSeconds, "ageSeconds")
	add((p.Owner == nil) != (old.Owner == nil) || (p.Owner != nil && *p.Owner != *old.Owner), "owner")
	add(!maps.Equal(p.Labels, old.Labels), "labels")
	add(!eqInt64Ptr(p.StaleSeconds, old.StaleSeconds), "staleSeconds")
	return out
}

// Patch is the pod's id and the given fields' current values, by JSON name.
func (p PodRow) Patch(fields []string) map[string]any {
	out := make(map[string]any, len(fields)+1)
	out["id"] = p.ID
	for _, f := range fields {
		switch f {
		case "uid":
			out[f] = p.UID
		case "name":
			out[f] = p.Name
		case "namespace":
			out[f] = p.Namespace
		case "cluster":
			out[f] = p.Cluster
		case "env":
			out[f] = p.Env
		case "node":
			out[f] = p.Node
		case "health":
			out[f] = p.Health
		case "status":
			out[f] = p.Status
		case "reason":
			out[f] = p.Reason
		case "readyContainers":
			out[f] = p.ReadyContainers
		case "totalContainers":
			out[f] = p.TotalContainers
		case "restarts":
			out[f] = p.Restarts
		case "cpuMilli":
			out[f] = p.CPUMilli
		case "memoryMiB":
			out[f] = p.MemoryMiB
		case "ageSeconds":
			out[f] = p.AgeSeconds
		case "owner":
			out[f] = p.Owner
		case "labels":
			out[f] = p.Labels
		case "staleSeconds":
			out[f] = p.StaleSeconds
		}
	}
	return out
}
