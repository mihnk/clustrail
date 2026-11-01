package kube

import (
	"context"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// Quotas and limits: each ResourceQuota's own status.used and status.hard (the
// API server counts them), and LimitRanges as written. Two lines are derived,
// both from admission rules: what a container without requests gets, and
// which pods an unscoped quota refuses because nothing fills a request in.

type QuotaItem struct {
	Resource string `json:"resource"`
	Used     string `json:"used"`
	Hard     string `json:"hard"`
	// Ratio is used / hard (0 when hard is 0 and nothing is used).
	Ratio float64 `json:"ratio"`
	// Full: used ≥ hard, so the next object (or any request) of this resource is refused.
	Full bool `json:"full"`
}

type QuotaInfo struct {
	Namespace string      `json:"namespace"`
	Name      string      `json:"name"`
	Scopes    []string    `json:"scopes"`
	Items     []QuotaItem `json:"items"`
}

type LimitItem struct {
	Type                 string `json:"type"` // Container, Pod, PersistentVolumeClaim
	Resource             string `json:"resource"`
	DefaultRequest       string `json:"defaultRequest,omitempty"`
	Default              string `json:"default,omitempty"`
	Min                  string `json:"min,omitempty"`
	Max                  string `json:"max,omitempty"`
	MaxLimitRequestRatio string `json:"maxLimitRequestRatio,omitempty"`
}

type LimitRangeInfo struct {
	Namespace string      `json:"namespace"`
	Name      string      `json:"name"`
	Items     []LimitItem `json:"items"`
}

// QuotaRule is a derived admission rule for a namespace.
type QuotaRule struct {
	Namespace string `json:"namespace"`
	// Kind: "needs" (containers must set Resource, as a request or a limit;
	// nothing fills it in) or "defaults" (a LimitRange fills it in).
	Kind     string `json:"kind"`
	Resource string `json:"resource"` // requests.cpu, limits.memory, …
	Quota    string `json:"quota,omitempty"`
	Value    string `json:"value,omitempty"` // the default, for "defaults"
}

type QuotaReport struct {
	Cluster string           `json:"cluster"`
	Quotas  []QuotaInfo      `json:"quotas"`
	Limits  []LimitRangeInfo `json:"limits"`
	Rules   []QuotaRule      `json:"rules"`
	Notes   []string         `json:"notes"`
}

func (m *Manager) Quotas(cluster string) (QuotaReport, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return QuotaReport{}, err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	return readQuotas(ctx, cluster, c.client, c.fallbackNS), nil
}

func readQuotas(ctx context.Context, cluster string, client kubernetes.Interface, fallbackNS string) QuotaReport {
	out := QuotaReport{Cluster: cluster, Quotas: []QuotaInfo{}, Limits: []LimitRangeInfo{}, Rules: []QuotaRule{}, Notes: []string{}}
	quotas, err := listIn(ctx, fallbackNS, &out.Notes, "ResourceQuotas", func(ns string) ([]corev1.ResourceQuota, error) {
		l, err := client.CoreV1().ResourceQuotas(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, err
		}
		return l.Items, nil
	})
	if err != nil {
		out.Notes = append(out.Notes, "ResourceQuotas: "+errorReason(err))
	}
	limits, err := listIn(ctx, fallbackNS, &out.Notes, "LimitRanges", func(ns string) ([]corev1.LimitRange, error) {
		l, err := client.CoreV1().LimitRanges(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, err
		}
		return l.Items, nil
	})
	if err != nil {
		out.Notes = append(out.Notes, "LimitRanges: "+errorReason(err))
	}
	for _, q := range quotas {
		out.Quotas = append(out.Quotas, quotaInfo(q))
	}
	sort.SliceStable(out.Quotas, func(i, j int) bool {
		a, b := out.Quotas[i], out.Quotas[j]
		if fa, fb := maxRatio(a), maxRatio(b); fa != fb {
			return fa > fb
		}
		return a.Namespace+"/"+a.Name < b.Namespace+"/"+b.Name
	})
	for _, l := range limits {
		out.Limits = append(out.Limits, limitInfo(l))
	}
	sort.Slice(out.Limits, func(i, j int) bool {
		return out.Limits[i].Namespace+"/"+out.Limits[i].Name < out.Limits[j].Namespace+"/"+out.Limits[j].Name
	})
	out.Rules = quotaRules(quotas, limits)
	return out
}

// listIn lists cluster-wide, else in fallbackNS (with a note) when cluster-wide is forbidden.
func listIn[T any](ctx context.Context, fallbackNS string, notes *[]string, label string, list func(ns string) ([]T, error)) ([]T, error) {
	items, err := list("")
	if apierrors.IsForbidden(err) && fallbackNS != "" {
		items, err = list(fallbackNS)
		if err == nil {
			*notes = append(*notes, label+": only namespace "+fallbackNS+" (not allowed to list them cluster-wide)")
		}
	}
	return items, err
}

func quotaInfo(q corev1.ResourceQuota) QuotaInfo {
	info := QuotaInfo{Namespace: q.Namespace, Name: q.Name, Scopes: []string{}, Items: []QuotaItem{}}
	for _, s := range q.Spec.Scopes {
		info.Scopes = append(info.Scopes, string(s))
	}
	if sel := q.Spec.ScopeSelector; sel != nil {
		for _, e := range sel.MatchExpressions {
			s := string(e.ScopeName) + " " + string(e.Operator)
			if len(e.Values) > 0 {
				s += " " + strings.Join(e.Values, ",")
			}
			info.Scopes = append(info.Scopes, s)
		}
	}
	hard := q.Status.Hard
	if len(hard) == 0 {
		hard = q.Spec.Hard // not counted yet by the quota controller
	}
	for name, h := range hard {
		u := q.Status.Used[name]
		info.Items = append(info.Items, quotaItem(string(name), u, h))
	}
	sort.Slice(info.Items, func(i, j int) bool {
		a, b := info.Items[i], info.Items[j]
		if a.Ratio != b.Ratio {
			return a.Ratio > b.Ratio
		}
		return a.Resource < b.Resource
	})
	return info
}

func quotaItem(name string, used, hard resource.Quantity) QuotaItem {
	it := QuotaItem{Resource: name, Used: used.String(), Hard: hard.String(), Full: used.Cmp(hard) >= 0}
	if h := hard.AsApproximateFloat64(); h > 0 {
		it.Ratio = used.AsApproximateFloat64() / h
	} else if !used.IsZero() {
		it.Ratio = 1
	} else {
		it.Ratio = 1 // hard 0: nothing of it may be created
	}
	return it
}

func maxRatio(q QuotaInfo) float64 {
	m := 0.0
	for _, it := range q.Items {
		r := it.Ratio
		if it.Full {
			r = max(r, 1)
		}
		m = max(m, r)
	}
	return m
}

func limitInfo(l corev1.LimitRange) LimitRangeInfo {
	info := LimitRangeInfo{Namespace: l.Namespace, Name: l.Name, Items: []LimitItem{}}
	for _, it := range l.Spec.Limits {
		names := map[corev1.ResourceName]bool{}
		for _, m := range []corev1.ResourceList{it.DefaultRequest, it.Default, it.Min, it.Max, it.MaxLimitRequestRatio} {
			for n := range m {
				names[n] = true
			}
		}
		var sorted []string
		for n := range names {
			sorted = append(sorted, string(n))
		}
		sort.Strings(sorted)
		for _, n := range sorted {
			r := corev1.ResourceName(n)
			info.Items = append(info.Items, LimitItem{
				Type: string(it.Type), Resource: n,
				DefaultRequest: qty(it.DefaultRequest, r), Default: qty(it.Default, r),
				Min: qty(it.Min, r), Max: qty(it.Max, r), MaxLimitRequestRatio: qty(it.MaxLimitRequestRatio, r),
			})
		}
	}
	return info
}

func qty(l corev1.ResourceList, n corev1.ResourceName) string {
	if q, ok := l[n]; ok {
		return q.String()
	}
	return ""
}

// quotaRules derives, per namespace, the requests and limits pods must carry.
// The ResourceQuota admission refuses a pod matched by a quota that limits
// requests.cpu (or cpu), requests.memory (or memory), limits.cpu or
// limits.memory when a container does not set that value. A LimitRange's
// Container default fills limits in, and its defaultRequest fills requests in
// (the API server sets defaultRequest from default when it is left out); a
// container's limit also becomes its request when the request is missing.
// Only quotas without scopes are used: they match every pod.
func quotaRules(quotas []corev1.ResourceQuota, limits []corev1.LimitRange) []QuotaRule {
	type key struct{ ns, res string }
	need := map[key]string{} // → quota name
	for _, q := range quotas {
		if len(q.Spec.Scopes) > 0 || q.Spec.ScopeSelector != nil {
			continue
		}
		for name := range q.Spec.Hard {
			res := string(name)
			switch res {
			case "cpu":
				res = "requests.cpu"
			case "memory":
				res = "requests.memory"
			}
			switch res {
			case "requests.cpu", "requests.memory", "limits.cpu", "limits.memory":
				if _, ok := need[key{q.Namespace, res}]; !ok {
					need[key{q.Namespace, res}] = q.Name
				}
			}
		}
	}
	defaults := map[key]string{}
	for _, l := range limits {
		for _, it := range l.Spec.Limits {
			if it.Type != corev1.LimitTypeContainer {
				continue
			}
			for _, r := range []corev1.ResourceName{corev1.ResourceCPU, corev1.ResourceMemory} {
				if v := qty(it.DefaultRequest, r); v != "" {
					defaults[key{l.Namespace, "requests." + string(r)}] = v
				}
				if v := qty(it.Default, r); v != "" {
					defaults[key{l.Namespace, "limits." + string(r)}] = v
					if _, ok := defaults[key{l.Namespace, "requests." + string(r)}]; !ok {
						defaults[key{l.Namespace, "requests." + string(r)}] = v
					}
				}
			}
		}
	}
	out := []QuotaRule{}
	for k, quota := range need {
		if v, ok := defaults[k]; ok {
			out = append(out, QuotaRule{Namespace: k.ns, Kind: "defaults", Resource: k.res, Quota: quota, Value: v})
		} else {
			out = append(out, QuotaRule{Namespace: k.ns, Kind: "needs", Resource: k.res, Quota: quota})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Namespace != out[j].Namespace {
			return out[i].Namespace < out[j].Namespace
		}
		return out[i].Resource < out[j].Resource
	})
	return out
}
