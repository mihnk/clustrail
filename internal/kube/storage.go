package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/rest"
)

// Storage joins PersistentVolumeClaims, PersistentVolumes, StorageClasses and
// the pods that mount them, with the reason a claim is Pending and, where the
// kubelet's stats are readable, how full each volume is.

type StoragePod struct {
	Name  string `json:"name"`
	Phase string `json:"phase"`
	Node  string `json:"node,omitempty"`
	Owner string `json:"owner,omitempty"`
}

type StorageClaim struct {
	ID          string       `json:"id"`
	Namespace   string       `json:"namespace"`
	Name        string       `json:"name"`
	Phase       string       `json:"phase"`
	Health      Health       `json:"health"`
	Volume      string       `json:"volume,omitempty"`
	Class       string       `json:"class,omitempty"`
	Requested   string       `json:"requested"`
	Capacity    string       `json:"capacity,omitempty"`
	AccessModes []string     `json:"accessModes"`
	VolumeMode  string       `json:"volumeMode,omitempty"`
	Created     string       `json:"created"`
	Pods        []StoragePod `json:"pods"`
	// Reason is the newest event of a claim that is not Bound.
	Reason string `json:"reason,omitempty"`
	// UsedBytes and CapacityBytes come from the kubelet (stats/summary).
	UsedBytes     *int64 `json:"usedBytes,omitempty"`
	CapacityBytes *int64 `json:"capacityBytes,omitempty"`
}

type StorageVolume struct {
	Name          string   `json:"name"`
	Phase         string   `json:"phase"`
	Health        Health   `json:"health"`
	Capacity      string   `json:"capacity"`
	Class         string   `json:"class,omitempty"`
	Claim         string   `json:"claim,omitempty"`
	ReclaimPolicy string   `json:"reclaimPolicy"`
	AccessModes   []string `json:"accessModes"`
	Source        string   `json:"source"`
	Created       string   `json:"created"`
	Reason        string   `json:"reason,omitempty"`
}

type StorageClassInfo struct {
	Name          string `json:"name"`
	Provisioner   string `json:"provisioner"`
	ReclaimPolicy string `json:"reclaimPolicy"`
	BindingMode   string `json:"bindingMode"`
	Expansion     bool   `json:"expansion"`
	Default       bool   `json:"default"`
	Claims        int    `json:"claims"`
}

type StorageReport struct {
	Cluster string             `json:"cluster"`
	Scope   string             `json:"scope"`
	Claims  []StorageClaim     `json:"claims"`
	Volumes []StorageVolume    `json:"volumes"`
	Classes []StorageClassInfo `json:"classes"`
	// Usage says where usage came from, or why it is missing.
	Usage string   `json:"usage"`
	Notes []string `json:"notes"`
}

func quantity(rl corev1.ResourceList) string {
	if q, ok := rl[corev1.ResourceStorage]; ok {
		return q.String()
	}
	return ""
}

func modes(ms []corev1.PersistentVolumeAccessMode) []string {
	out := make([]string, len(ms))
	for i, m := range ms {
		out[i] = string(m)
	}
	return out
}

func volumeSource(pv *corev1.PersistentVolume) string {
	s := pv.Spec.PersistentVolumeSource
	switch {
	case s.CSI != nil:
		return "csi · " + s.CSI.Driver
	case s.NFS != nil:
		return "nfs · " + s.NFS.Server + ":" + s.NFS.Path
	case s.HostPath != nil:
		return "hostPath · " + s.HostPath.Path
	case s.Local != nil:
		return "local · " + s.Local.Path
	case s.AWSElasticBlockStore != nil:
		return "awsElasticBlockStore"
	case s.GCEPersistentDisk != nil:
		return "gcePersistentDisk"
	case s.AzureDisk != nil:
		return "azureDisk"
	}
	return "other"
}

// Storage reads the cluster's storage. Claims fall back to the context's
// namespace when RBAC denies listing them cluster-wide.
func (m *Manager) Storage(cluster string) (StorageReport, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return StorageReport{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	out := StorageReport{Cluster: cluster, Claims: []StorageClaim{}, Volumes: []StorageVolume{}, Classes: []StorageClassInfo{}, Notes: []string{}}
	core := c.client.CoreV1()

	pvcs, err := core.PersistentVolumeClaims("").List(ctx, metav1.ListOptions{})
	if apierrors.IsForbidden(err) && c.fallbackNS != "" {
		out.Scope = c.fallbackNS
		pvcs, err = core.PersistentVolumeClaims(c.fallbackNS).List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		return out, err
	}

	// Pods that mount each claim.
	var pods []*corev1.Pod
	if c.pods != nil && c.started.Load() && (c.podsNS == "" || c.podsNS == out.Scope) {
		pods, _ = c.pods.List(labels.Everything())
	} else if list, err := core.Pods(out.Scope).List(ctx, metav1.ListOptions{}); err == nil {
		for i := range list.Items {
			pods = append(pods, &list.Items[i])
		}
	}
	mounts := map[string][]StoragePod{}
	nodes := map[string]bool{}
	for _, p := range pods {
		for _, v := range p.Spec.Volumes {
			if v.PersistentVolumeClaim == nil {
				continue
			}
			sp := StoragePod{Name: p.Name, Phase: string(p.Status.Phase), Node: p.Spec.NodeName}
			if o := metav1.GetControllerOf(p); o != nil {
				sp.Owner = o.Kind + "/" + o.Name
			}
			key := p.Namespace + "/" + v.PersistentVolumeClaim.ClaimName
			mounts[key] = append(mounts[key], sp)
			if p.Spec.NodeName != "" && p.Status.Phase == corev1.PodRunning {
				nodes[p.Spec.NodeName] = true
			}
		}
	}

	usage, usageNote := m.volumeUsage(ctx, c, nodes)
	out.Usage = usageNote
	classCount := map[string]int{}
	for i := range pvcs.Items {
		pvc := &pvcs.Items[i]
		key := pvc.Namespace + "/" + pvc.Name
		cl := StorageClaim{
			ID: cluster + "/" + key, Namespace: pvc.Namespace, Name: pvc.Name, Phase: string(pvc.Status.Phase),
			Volume: pvc.Spec.VolumeName, Requested: quantity(pvc.Spec.Resources.Requests), Capacity: quantity(pvc.Status.Capacity),
			AccessModes: modes(pvc.Spec.AccessModes), Created: pvc.CreationTimestamp.UTC().Format(time.RFC3339),
			Pods: mounts[key],
		}
		if cl.Pods == nil {
			cl.Pods = []StoragePod{}
		}
		if pvc.Spec.StorageClassName != nil {
			cl.Class = *pvc.Spec.StorageClassName
			classCount[cl.Class]++
		}
		if pvc.Spec.VolumeMode != nil {
			cl.VolumeMode = string(*pvc.Spec.VolumeMode)
		}
		switch pvc.Status.Phase {
		case corev1.ClaimBound:
			cl.Health = Healthy
		case corev1.ClaimLost:
			cl.Health = Failed
		default:
			cl.Health = Warning
		}
		if pvc.DeletionTimestamp != nil {
			cl.Health, cl.Phase = Terminating, "Terminating"
		}
		if u, ok := usage[key]; ok {
			cl.UsedBytes, cl.CapacityBytes = &u[0], &u[1]
		}
		out.Claims = append(out.Claims, cl)
	}
	m.claimReasons(ctx, c, out.Claims)

	if pvs, err := core.PersistentVolumes().List(ctx, metav1.ListOptions{}); err != nil {
		out.Notes = append(out.Notes, "PersistentVolumes: "+errorReason(err))
	} else {
		for i := range pvs.Items {
			pv := &pvs.Items[i]
			v := StorageVolume{
				Name: pv.Name, Phase: string(pv.Status.Phase), Capacity: quantity(pv.Spec.Capacity), Class: pv.Spec.StorageClassName,
				ReclaimPolicy: string(pv.Spec.PersistentVolumeReclaimPolicy), AccessModes: modes(pv.Spec.AccessModes),
				Source: volumeSource(pv), Created: pv.CreationTimestamp.UTC().Format(time.RFC3339), Reason: pv.Status.Message,
			}
			if r := pv.Spec.ClaimRef; r != nil {
				v.Claim = r.Namespace + "/" + r.Name
			}
			switch pv.Status.Phase {
			case corev1.VolumeBound:
				v.Health = Healthy
			case corev1.VolumeAvailable:
				v.Health = Idle
			case corev1.VolumeReleased:
				v.Health = Warning
			case corev1.VolumeFailed:
				v.Health = Failed
			default:
				v.Health = Unknown
			}
			out.Volumes = append(out.Volumes, v)
		}
	}

	if scs, err := c.client.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{}); err != nil {
		out.Notes = append(out.Notes, "StorageClasses: "+errorReason(err))
	} else {
		for i := range scs.Items {
			out.Classes = append(out.Classes, classInfo(&scs.Items[i], classCount))
		}
	}
	sort.Slice(out.Claims, func(i, j int) bool {
		hi, hj := out.Claims[i].Health != Healthy, out.Claims[j].Health != Healthy
		if hi != hj {
			return hi
		}
		return out.Claims[i].Namespace+"/"+out.Claims[i].Name < out.Claims[j].Namespace+"/"+out.Claims[j].Name
	})
	sort.Slice(out.Volumes, func(i, j int) bool { return out.Volumes[i].Name < out.Volumes[j].Name })
	sort.Slice(out.Classes, func(i, j int) bool { return out.Classes[i].Name < out.Classes[j].Name })
	return out, nil
}

func classInfo(sc *storagev1.StorageClass, counts map[string]int) StorageClassInfo {
	info := StorageClassInfo{Name: sc.Name, Provisioner: sc.Provisioner, ReclaimPolicy: "Delete", BindingMode: "Immediate", Claims: counts[sc.Name]}
	if sc.ReclaimPolicy != nil {
		info.ReclaimPolicy = string(*sc.ReclaimPolicy)
	}
	if sc.VolumeBindingMode != nil {
		info.BindingMode = string(*sc.VolumeBindingMode)
	}
	if sc.AllowVolumeExpansion != nil {
		info.Expansion = *sc.AllowVolumeExpansion
	}
	info.Default = sc.Annotations["storageclass.kubernetes.io/is-default-class"] == "true"
	return info
}

// claimReasons fills in the newest event of each claim that is not Bound.
func (m *Manager) claimReasons(ctx context.Context, c *clusterConn, claims []StorageClaim) {
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i := range claims {
		if claims[i].Health == Healthy {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(cl *StorageClaim) {
			defer func() { <-sem; wg.Done() }()
			evs, err := c.client.CoreV1().Events(cl.Namespace).List(ctx, metav1.ListOptions{FieldSelector: "involvedObject.kind=PersistentVolumeClaim,involvedObject.name=" + cl.Name})
			if err != nil || len(evs.Items) == 0 {
				return
			}
			sort.Slice(evs.Items, func(a, b int) bool { return lastSeen(evs.Items[a]).After(lastSeen(evs.Items[b])) })
			e := evs.Items[0]
			cl.Reason = e.Reason
			if n := max(e.Count, 1); n > 1 {
				cl.Reason += fmt.Sprintf(" ×%d", n)
			}
			if msg := strings.TrimSpace(e.Message); msg != "" {
				cl.Reason += " · " + msg
			}
		}(&claims[i])
	}
	wg.Wait()
}

// volumeUsage reads used and capacity bytes per claim from the kubelet's
// stats/summary on the nodes that run pods with claims (nodes/proxy).
func (m *Manager) volumeUsage(ctx context.Context, c *clusterConn, nodes map[string]bool) (map[string][2]int64, string) {
	out := map[string][2]int64{}
	if len(nodes) == 0 {
		return out, "kubelet"
	}
	rc, ok := c.client.CoreV1().RESTClient().(*rest.RESTClient)
	if !ok || rc == nil {
		return out, "kubelet stats unavailable"
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	var forbidden, failed int
	sem := make(chan struct{}, 8)
	for node := range nodes {
		wg.Add(1)
		sem <- struct{}{}
		go func(node string) {
			defer func() { <-sem; wg.Done() }()
			nctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			raw, err := rc.Get().Resource("nodes").Name(node).SubResource("proxy").Suffix("stats/summary").DoRaw(nctx)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				if apierrors.IsForbidden(err) {
					forbidden++
				} else {
					failed++
				}
				return
			}
			for k, v := range parseVolumeStats(raw) {
				out[k] = v
			}
		}(node)
	}
	wg.Wait()
	switch {
	case forbidden > 0:
		return out, "not allowed to read kubelet stats (nodes/proxy)"
	case failed == len(nodes):
		return out, "kubelet stats unreachable"
	case failed > 0:
		return out, fmt.Sprintf("kubelet stats unreachable on %d of %d nodes", failed, len(nodes))
	}
	return out, "kubelet"
}

func parseVolumeStats(raw []byte) map[string][2]int64 {
	var summary struct {
		Pods []struct {
			Volume []struct {
				UsedBytes     *int64 `json:"usedBytes"`
				CapacityBytes *int64 `json:"capacityBytes"`
				PVCRef        *struct {
					Name      string `json:"name"`
					Namespace string `json:"namespace"`
				} `json:"pvcRef"`
			} `json:"volume"`
		} `json:"pods"`
	}
	out := map[string][2]int64{}
	if json.Unmarshal(raw, &summary) != nil {
		return out
	}
	for _, p := range summary.Pods {
		for _, v := range p.Volume {
			if v.PVCRef == nil || v.UsedBytes == nil || v.CapacityBytes == nil {
				continue
			}
			out[v.PVCRef.Namespace+"/"+v.PVCRef.Name] = [2]int64{*v.UsedBytes, *v.CapacityBytes}
		}
	}
	return out
}
