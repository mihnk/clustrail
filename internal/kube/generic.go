package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// KindInfo is a resource kind the cluster serves and this identity's verbs
// aside, Clustrail can list (the ⌘J list).
type KindInfo struct {
	Kind       string   `json:"kind"`
	Group      string   `json:"group"`
	Version    string   `json:"version"`
	Resource   string   `json:"resource"`
	Namespaced bool     `json:"namespaced"`
	ShortNames []string `json:"shortNames,omitempty"`
	Delete     bool     `json:"delete"`
}

// TableColumn is one column of the API server's table view (kubectl get).
type TableColumn struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Description string `json:"description,omitempty"`
	// Priority > 0 columns are what kubectl shows with -o wide.
	Priority int `json:"priority"`
}

// GenericRow is one object of a generic list.
type GenericRow struct {
	ID        string            `json:"id"`
	Cluster   string            `json:"cluster"`
	Namespace string            `json:"namespace,omitempty"`
	Name      string            `json:"name"`
	Created   string            `json:"created,omitempty"` // RFC 3339
	Labels    map[string]string `json:"labels,omitempty"`
	// Cells line up with GenericList.Columns.
	Cells []string `json:"cells"`
}

// GenericList is a kind listed in one cluster with the server's own columns.
type GenericList struct {
	Cluster    string        `json:"cluster"`
	Kind       string        `json:"kind"`
	Namespaced bool          `json:"namespaced"`
	Columns    []TableColumn `json:"columns"`
	Rows       []GenericRow  `json:"rows"`
	// Truncated: more objects exist than were fetched (listLimit).
	Truncated bool `json:"truncated,omitempty"`
	// Shown is the one namespace listed because RBAC denies the others.
	Shown string `json:"shown,omitempty"`
}

const listLimit = 2000

func hasVerb(verbs []string, v string) bool {
	for _, x := range verbs {
		if x == v {
			return true
		}
	}
	return false
}

// ResourceKinds lists every kind the cluster serves that can be listed,
// sorted by kind name with the core and apps groups first on ties.
func (m *Manager) ResourceKinds(cluster string) ([]KindInfo, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return nil, err
	}
	if _, _, err := c.resolve("Pod"); err != nil && c.kinds.err != nil {
		return nil, c.kinds.err
	}
	out := append([]KindInfo(nil), c.kinds.listable...)
	rank := func(g string) int {
		switch g {
		case "":
			return 0
		case "apps", "batch", "networking.k8s.io":
			return 1
		}
		return 2
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return rank(out[i].Group) < rank(out[j].Group)
	})
	return out, nil
}

// ListResources lists a kind ("Service", "batch/CronJob", …) with the API
// server's table columns, like kubectl get. namespace "" means all
// namespaces; when that is forbidden, the context's namespace is listed.
func (m *Manager) ListResources(cluster, kind, namespace string) (GenericList, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return GenericList{}, err
	}
	gvr, namespaced, err := c.resolve(kind)
	if err != nil {
		return GenericList{}, err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	if !namespaced {
		namespace = ""
	}
	list, err := c.listTable(ctx, gvr, namespaced, namespace)
	if apierrors.IsForbidden(err) && namespaced && namespace == "" && c.fallbackNS != "" {
		if list, err = c.listTable(ctx, gvr, namespaced, c.fallbackNS); err == nil {
			list.Shown = c.fallbackNS
		}
	}
	if err != nil {
		return GenericList{}, err
	}
	list.Cluster, list.Kind, list.Namespaced = cluster, kind, namespaced
	for i := range list.Rows {
		r := &list.Rows[i]
		r.Cluster = cluster
		if r.Namespace != "" {
			r.ID = cluster + "/" + r.Namespace + "/" + r.Name
		} else {
			r.ID = cluster + "/" + r.Name
		}
	}
	return list, nil
}

// listTable asks for the server-side table (Accept: as=Table). Clients
// without a raw REST client (the fakes in tests) fall back to a plain list.
func (c *clusterConn) listTable(ctx context.Context, gvr schema.GroupVersionResource, namespaced bool, ns string) (GenericList, error) {
	rc := c.client.Discovery().RESTClient()
	if rc == nil {
		return c.listPlain(ctx, gvr, namespaced, ns)
	}
	path := "/api/" + gvr.Version
	if gvr.Group != "" {
		path = "/apis/" + gvr.Group + "/" + gvr.Version
	}
	if namespaced && ns != "" {
		path += "/namespaces/" + ns
	}
	path += "/" + gvr.Resource
	raw, err := rc.Get().AbsPath(path).
		Param("limit", fmt.Sprint(listLimit)).
		Param("includeObject", "Metadata").
		SetHeader("Accept", "application/json;as=Table;v=v1;g=meta.k8s.io,application/json").
		Do(ctx).Raw()
	if err != nil {
		return GenericList{}, err
	}
	var table metav1.Table
	if err := json.Unmarshal(raw, &table); err != nil {
		return GenericList{}, err
	}
	if table.Kind != "Table" {
		// An aggregated API without table support: plain list instead.
		return c.listPlain(ctx, gvr, namespaced, ns)
	}
	return fromTable(&table), nil
}

// fromTable keeps every column but Name (shown on its own) and Age (computed
// from the creation time so it stays current between refreshes).
func fromTable(t *metav1.Table) GenericList {
	var keep []int
	out := GenericList{Columns: []TableColumn{}, Rows: make([]GenericRow, 0, len(t.Rows)), Truncated: t.Continue != ""}
	for i, col := range t.ColumnDefinitions {
		if col.Name == "Name" || col.Name == "Age" {
			continue
		}
		keep = append(keep, i)
		out.Columns = append(out.Columns, TableColumn{Name: col.Name, Type: col.Type, Description: firstSentence(col.Description), Priority: int(col.Priority)})
	}
	for _, r := range t.Rows {
		var meta metav1.PartialObjectMetadata
		if len(r.Object.Raw) > 0 {
			_ = json.Unmarshal(r.Object.Raw, &meta)
		}
		row := GenericRow{Namespace: meta.Namespace, Name: meta.Name, Labels: meta.Labels, Cells: make([]string, 0, len(keep))}
		if !meta.CreationTimestamp.IsZero() {
			row.Created = meta.CreationTimestamp.UTC().Format(time.RFC3339)
		}
		if row.Name == "" && len(r.Cells) > 0 {
			row.Name = fmt.Sprint(r.Cells[0])
		}
		for _, i := range keep {
			if i < len(r.Cells) {
				row.Cells = append(row.Cells, cellText(r.Cells[i]))
			} else {
				row.Cells = append(row.Cells, "")
			}
		}
		out.Rows = append(out.Rows, row)
	}
	return out
}

func cellText(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		if x == float64(int64(x)) {
			return fmt.Sprint(int64(x))
		}
		return fmt.Sprint(x)
	default:
		b, _ := json.Marshal(x)
		return string(b)
	}
}

func firstSentence(s string) string {
	if i := strings.Index(s, ". "); i > 0 {
		return s[:i+1]
	}
	return s
}

func (c *clusterConn) listPlain(ctx context.Context, gvr schema.GroupVersionResource, namespaced bool, ns string) (GenericList, error) {
	ri := c.dynamic.Resource(gvr)
	opts := metav1.ListOptions{Limit: listLimit}
	var out GenericList
	var err error
	var items []GenericRow
	if namespaced {
		l, e := ri.Namespace(ns).List(ctx, opts)
		err = e
		if e == nil {
			out.Truncated = l.GetContinue() != ""
			for _, o := range l.Items {
				items = append(items, GenericRow{Namespace: o.GetNamespace(), Name: o.GetName(), Labels: o.GetLabels(), Created: rfc3339(o.GetCreationTimestamp()), Cells: []string{}})
			}
		}
	} else {
		l, e := ri.List(ctx, opts)
		err = e
		if e == nil {
			out.Truncated = l.GetContinue() != ""
			for _, o := range l.Items {
				items = append(items, GenericRow{Name: o.GetName(), Labels: o.GetLabels(), Created: rfc3339(o.GetCreationTimestamp()), Cells: []string{}})
			}
		}
	}
	if err != nil {
		return out, err
	}
	out.Columns, out.Rows = []TableColumn{}, items
	if out.Rows == nil {
		out.Rows = []GenericRow{}
	}
	return out, nil
}

func rfc3339(t metav1.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// DeleteResource deletes any object; dependents go with background propagation, like kubectl.
func (m *Manager) DeleteResource(cluster, kind, ns, name string) error {
	c, err := m.writable(cluster)
	if err != nil {
		return err
	}
	gvr, namespaced, err := c.resolve(kind)
	if err != nil {
		return err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	bg := metav1.DeletePropagationBackground
	opts := metav1.DeleteOptions{PropagationPolicy: &bg}
	if namespaced {
		return c.dynamic.Resource(gvr).Namespace(ns).Delete(ctx, name, opts)
	}
	return c.dynamic.Resource(gvr).Delete(ctx, name, opts)
}
