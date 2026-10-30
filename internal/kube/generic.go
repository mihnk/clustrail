package kube

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"
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
	UID       string            `json:"uid,omitempty"`
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
	out, err := c.listableKinds()
	if err != nil {
		return nil, err
	}
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
	cols, keep := tableColumns(t.ColumnDefinitions)
	return GenericList{Columns: cols, Rows: tableRows(t.Rows, keep), Truncated: t.Continue != ""}
}

// tableColumns picks the columns shown and their indexes in each row's cells.
func tableColumns(defs []metav1.TableColumnDefinition) ([]TableColumn, []int) {
	cols, keep := []TableColumn{}, []int{}
	for i, col := range defs {
		if col.Name == "Name" || col.Name == "Age" {
			continue
		}
		keep = append(keep, i)
		cols = append(cols, TableColumn{Name: col.Name, Type: col.Type, Description: firstSentence(col.Description), Priority: int(col.Priority)})
	}
	return cols, keep
}

// tableRows converts table rows (with includeObject=Metadata) to rows; IDs are set by the caller.
func tableRows(rows []metav1.TableRow, keep []int) []GenericRow {
	out := make([]GenericRow, 0, len(rows))
	for _, r := range rows {
		var meta metav1.PartialObjectMetadata
		if len(r.Object.Raw) > 0 {
			_ = json.Unmarshal(r.Object.Raw, &meta)
		}
		row := GenericRow{UID: string(meta.UID), Namespace: meta.Namespace, Name: meta.Name, Labels: meta.Labels, Cells: make([]string, 0, len(keep))}
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
		out = append(out, row)
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
				items = append(items, GenericRow{UID: string(o.GetUID()), Namespace: o.GetNamespace(), Name: o.GetName(), Labels: o.GetLabels(), Created: rfc3339(o.GetCreationTimestamp()), Cells: []string{}})
			}
		}
	} else {
		l, e := ri.List(ctx, opts)
		err = e
		if e == nil {
			out.Truncated = l.GetContinue() != ""
			for _, o := range l.Items {
				items = append(items, GenericRow{UID: string(o.GetUID()), Name: o.GetName(), Labels: o.GetLabels(), Created: rfc3339(o.GetCreationTimestamp()), Cells: []string{}})
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
// uid, when set, is the object the user confirmed: an object recreated under
// the same name since then is not deleted.
func (m *Manager) DeleteResource(cluster, kind, ns, name, uid string) error {
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
	opts := deleteOptions(uid, metav1.DeletePropagationBackground)
	if namespaced {
		err = c.dynamic.Resource(gvr).Namespace(ns).Delete(ctx, name, opts)
	} else {
		err = c.dynamic.Resource(gvr).Delete(ctx, name, opts)
	}
	return replacedError(err, uid, kindLabel(kind), name)
}

// CreateResult is the outcome for one document of a manifest.
type CreateResult struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
	// Status: created, valid (dry run passed), exists, failed or skipped.
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

// CreateObjects creates every document of a manifest, in order, like
// kubectl create -f. Objects that exist are reported, never changed. With
// dryRun every document is checked by the API server; otherwise creation
// stops at the first failure and the rest are reported as skipped (nothing
// already created is rolled back).
func (m *Manager) CreateObjects(cluster, text string, dryRun bool) ([]CreateResult, error) {
	var c *clusterConn
	var err error
	if dryRun {
		c, err = m.conn(cluster)
	} else {
		c, err = m.writable(cluster)
	}
	if err != nil {
		return nil, err
	}
	var docs []*unstructured.Unstructured
	dec := utilyaml.NewYAMLOrJSONDecoder(strings.NewReader(text), 4096)
	for {
		var obj map[string]any
		if err := dec.Decode(&obj); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, fmt.Errorf("document %d: %w", len(docs)+1, err)
		}
		if len(obj) == 0 {
			continue // empty document between separators
		}
		u := &unstructured.Unstructured{Object: obj}
		if u.GetKind() == "" || u.GetAPIVersion() == "" {
			return nil, fmt.Errorf("document %d: apiVersion and kind are required", len(docs)+1)
		}
		if u.GetName() == "" && u.GetGenerateName() == "" {
			return nil, fmt.Errorf("document %d (%s): metadata.name is required", len(docs)+1, u.GetKind())
		}
		docs = append(docs, u)
	}
	if len(docs) == 0 {
		return nil, errors.New("the manifest has no objects")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	out := make([]CreateResult, 0, len(docs))
	failed := false
	for _, u := range docs {
		res := CreateResult{Kind: u.GetKind(), Name: u.GetName(), Namespace: u.GetNamespace()}
		if failed {
			res.Status = "skipped"
			out = append(out, res)
			continue
		}
		gvr, namespaced, err := c.resolve(u.GroupVersionKind().Group + "/" + u.GetKind())
		if err != nil {
			gvr, namespaced, err = c.resolve(u.GetKind())
		}
		if err == nil {
			for _, f := range []string{"resourceVersion", "uid", "creationTimestamp", "managedFields"} {
				unstructured.RemoveNestedField(u.Object, "metadata", f)
			}
			unstructured.RemoveNestedField(u.Object, "status")
			opts := metav1.CreateOptions{FieldManager: "clustrail"}
			if dryRun {
				opts.DryRun = []string{metav1.DryRunAll}
			}
			ri := c.dynamic.Resource(gvr)
			if namespaced {
				if u.GetNamespace() == "" {
					ns := c.fallbackNS
					if ns == "" {
						ns = "default"
					}
					u.SetNamespace(ns)
				}
				res.Namespace = u.GetNamespace()
				_, err = ri.Namespace(u.GetNamespace()).Create(ctx, u, opts)
			} else {
				res.Namespace = ""
				_, err = ri.Create(ctx, u, opts)
			}
		}
		switch {
		case err == nil && dryRun:
			res.Status = "valid"
		case err == nil:
			res.Status = "created"
		case apierrors.IsAlreadyExists(err):
			res.Status, res.Error = "exists", "already exists; change it with Edit YAML"
			failed = !dryRun
		default:
			res.Status, res.Error = "failed", err.Error()
			failed = !dryRun
		}
		out = append(out, res)
	}
	return out, nil
}
