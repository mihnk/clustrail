package kube

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
)

// EventList carries updates of generic lists started with StartListWatch.
const EventList = "clustrail:list"

const (
	// maxListRows bounds one generic list per cluster; more is reported as truncated.
	maxListRows = 20000
	listPage    = 500
	// pollEvery is the update interval in poll mode (Settings › Update method).
	pollEvery = 30 * time.Second
)

// pollMode switches watches to periodic lists (Settings › Update method).
// It applies to generic lists immediately and to clusters on their next connect.
var pollMode atomic.Bool

func SetPollMode(on bool) { pollMode.Store(on) }

// ListUpdate is one batch of a generic list: a reset carries every row and
// the columns; later updates only what changed.
type ListUpdate struct {
	ID         string        `json:"id"`
	Cluster    string        `json:"cluster"`
	Reset      bool          `json:"reset,omitempty"`
	Columns    []TableColumn `json:"columns,omitempty"`
	Namespaced bool          `json:"namespaced"`
	Shown      string        `json:"shown,omitempty"`
	Truncated  bool          `json:"truncated,omitempty"`
	Upserts    []GenericRow  `json:"upserts"`
	Deletes    []string      `json:"deletes"`
	Error      string        `json:"error,omitempty"`
	// Mode is "watch" or "poll".
	Mode string `json:"mode"`
}

type listWatches struct {
	mu   sync.Mutex
	byID map[string]context.CancelFunc
	seq  int
}

// StartListWatch lists a kind and keeps it current: with a watch, or by
// listing every 30 s in poll mode. Updates arrive as EventList.
func (m *Manager) StartListWatch(cluster, kind, namespace string) (string, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return "", err
	}
	gvr, namespaced, err := c.resolve(kind)
	if err != nil {
		return "", err
	}
	if !namespaced {
		namespace = ""
	}
	m.lists.mu.Lock()
	if m.lists.byID == nil {
		m.lists.byID = map[string]context.CancelFunc{}
	}
	m.lists.seq++
	id := fmt.Sprintf("list-%d", m.lists.seq)
	ctx, cancel := context.WithCancel(c.ctx)
	m.lists.byID[id] = cancel
	m.lists.mu.Unlock()
	lw := &listWatch{id: id, cluster: cluster, c: c, gvr: gvr, namespaced: namespaced, ns: namespace, emit: m.emit}
	go lw.run(ctx)
	return id, nil
}

func (m *Manager) StopListWatch(id string) {
	m.lists.mu.Lock()
	cancel := m.lists.byID[id]
	delete(m.lists.byID, id)
	m.lists.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

type listWatch struct {
	id, cluster string
	c           *clusterConn
	gvr         schema.GroupVersionResource
	namespaced  bool
	ns          string
	emit        Emitter

	shown string
	keep  []int // table cell indexes of the shown columns
	rows  map[string]GenericRow
}

func (w *listWatch) rowID(r *GenericRow) {
	r.Cluster = w.cluster
	if r.Namespace != "" {
		r.ID = w.cluster + "/" + r.Namespace + "/" + r.Name
	} else {
		r.ID = w.cluster + "/" + r.Name
	}
}

func (w *listWatch) mode() string {
	if pollMode.Load() {
		return "poll"
	}
	return "watch"
}

func (w *listWatch) run(ctx context.Context) {
	for attempt := 0; ctx.Err() == nil; attempt++ {
		list, rv, err := w.list(ctx)
		if err != nil {
			w.emit.Emit(EventList, ListUpdate{ID: w.id, Cluster: w.cluster, Error: errText(err), Upserts: []GenericRow{}, Deletes: []string{}, Mode: w.mode()})
			if !sleepCtx(ctx, backoff(attempt+2)) {
				return
			}
			continue
		}
		attempt = 0
		if w.rows == nil {
			// First list: a reset with every row and the columns.
			w.rows = map[string]GenericRow{}
			for _, r := range list.Rows {
				w.rows[r.ID] = r
			}
			w.emit.Emit(EventList, ListUpdate{ID: w.id, Cluster: w.cluster, Reset: true, Columns: list.Columns, Namespaced: w.namespaced, Shown: w.shown,
				Truncated: list.Truncated, Upserts: list.Rows, Deletes: []string{}, Mode: w.mode()})
		} else {
			// A re-list (poll, or after a watch ended): send the difference.
			w.diff(list)
		}
		if pollMode.Load() || list.Truncated || rv == "" {
			// Truncated lists cannot be watched consistently; poll them instead.
			if !sleepCtx(ctx, pollEvery) {
				return
			}
			continue
		}
		if err := w.watch(ctx, rv); err != nil && ctx.Err() == nil && !apierrors.IsResourceExpired(err) && !apierrors.IsGone(err) {
			w.emit.Emit(EventList, ListUpdate{ID: w.id, Cluster: w.cluster, Error: "watch ended: " + errText(err), Upserts: []GenericRow{}, Deletes: []string{}, Mode: w.mode()})
			if !sleepCtx(ctx, 2*time.Second) {
				return
			}
		}
	}
}

func (w *listWatch) diff(list GenericList) {
	u := ListUpdate{ID: w.id, Cluster: w.cluster, Namespaced: w.namespaced, Shown: w.shown, Truncated: list.Truncated, Upserts: []GenericRow{}, Deletes: []string{}, Mode: w.mode()}
	seen := map[string]bool{}
	for _, r := range list.Rows {
		seen[r.ID] = true
		if old, ok := w.rows[r.ID]; !ok || !sameRow(old, r) {
			u.Upserts = append(u.Upserts, r)
			w.rows[r.ID] = r
		}
	}
	for id := range w.rows {
		if !seen[id] {
			u.Deletes = append(u.Deletes, id)
			delete(w.rows, id)
		}
	}
	sort.Strings(u.Deletes)
	if len(u.Upserts) > 0 || len(u.Deletes) > 0 {
		w.emit.Emit(EventList, u)
	}
}

func sameRow(a, b GenericRow) bool {
	if a.Created != b.Created || len(a.Cells) != len(b.Cells) || len(a.Labels) != len(b.Labels) {
		return false
	}
	for i := range a.Cells {
		if a.Cells[i] != b.Cells[i] {
			return false
		}
	}
	for k, v := range a.Labels {
		if b.Labels[k] != v {
			return false
		}
	}
	return true
}

// list reads every page (up to maxListRows) and returns the list's resourceVersion.
func (w *listWatch) list(ctx context.Context) (GenericList, string, error) {
	ns := w.ns
	if w.shown != "" {
		ns = w.shown
	}
	list, rv, err := w.listIn(ctx, ns)
	if apierrors.IsForbidden(err) && w.namespaced && ns == "" && w.c.fallbackNS != "" {
		if list, rv, err = w.listIn(ctx, w.c.fallbackNS); err == nil {
			w.shown = w.c.fallbackNS
		}
	}
	for i := range list.Rows {
		w.rowID(&list.Rows[i])
	}
	return list, rv, err
}

func (w *listWatch) listIn(ctx context.Context, ns string) (GenericList, string, error) {
	lctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	rc := w.c.client.Discovery().RESTClient()
	if rc == nil {
		return w.listDynamic(lctx, ns)
	}
	out := GenericList{Rows: []GenericRow{}}
	cont, rv := "", ""
	for {
		req := rc.Get().AbsPath(w.path(ns)).Param("limit", fmt.Sprint(listPage)).Param("includeObject", "Metadata").
			SetHeader("Accept", "application/json;as=Table;v=v1;g=meta.k8s.io,application/json")
		if cont != "" {
			req = req.Param("continue", cont)
		}
		raw, err := req.Do(lctx).Raw()
		if err != nil {
			return out, "", err
		}
		var t metav1.Table
		if err := json.Unmarshal(raw, &t); err != nil {
			return out, "", err
		}
		if t.Kind != "Table" {
			// An aggregated API without table support.
			return w.listDynamic(lctx, ns)
		}
		if out.Columns == nil || len(t.ColumnDefinitions) > 0 {
			out.Columns, w.keep = tableColumns(t.ColumnDefinitions)
		}
		out.Rows = append(out.Rows, tableRows(t.Rows, w.keep)...)
		rv, cont = t.ResourceVersion, t.Continue
		if cont == "" {
			return out, rv, nil
		}
		if len(out.Rows) >= maxListRows {
			out.Truncated = true
			return out, "", nil
		}
	}
}

func (w *listWatch) path(ns string) string {
	p := "/api/" + w.gvr.Version
	if w.gvr.Group != "" {
		p = "/apis/" + w.gvr.Group + "/" + w.gvr.Version
	}
	if w.namespaced && ns != "" {
		p += "/namespaces/" + ns
	}
	return p + "/" + w.gvr.Resource
}

// listDynamic is the plain-list fallback (no table view): names and ages only.
func (w *listWatch) listDynamic(ctx context.Context, ns string) (GenericList, string, error) {
	l, err := w.c.listPlain(ctx, w.gvr, w.namespaced, ns)
	if err != nil {
		return l, "", err
	}
	ri := w.c.dynamic.Resource(w.gvr)
	var rv string
	if w.namespaced {
		if ul, err := ri.Namespace(ns).List(ctx, metav1.ListOptions{Limit: 1}); err == nil {
			rv = ul.GetResourceVersion()
		}
	} else if ul, err := ri.List(ctx, metav1.ListOptions{Limit: 1}); err == nil {
		rv = ul.GetResourceVersion()
	}
	return l, rv, nil
}

// watch streams changes from rv and sends them in batches every 500 ms. It
// returns when the watch ends; the caller re-lists.
func (w *listWatch) watch(ctx context.Context, rv string) error {
	events := make(chan GenericRowEvent, 256)
	wctx, cancel := context.WithCancel(ctx)
	defer cancel()
	errc := make(chan error, 1)
	go func() { errc <- w.stream(wctx, rv, events); close(events) }()
	t := time.NewTicker(500 * time.Millisecond)
	defer t.Stop()
	pending := ListUpdate{ID: w.id, Cluster: w.cluster, Namespaced: w.namespaced, Shown: w.shown, Upserts: []GenericRow{}, Deletes: []string{}}
	flush := func() {
		if len(pending.Upserts) == 0 && len(pending.Deletes) == 0 {
			return
		}
		pending.Mode = w.mode()
		w.emit.Emit(EventList, pending)
		pending = ListUpdate{ID: w.id, Cluster: w.cluster, Namespaced: w.namespaced, Shown: w.shown, Upserts: []GenericRow{}, Deletes: []string{}}
	}
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				flush()
				return <-errc
			}
			w.rowID(&ev.Row)
			if ev.Deleted {
				delete(w.rows, ev.Row.ID)
				pending.Deletes = append(pending.Deletes, ev.Row.ID)
			} else {
				w.rows[ev.Row.ID] = ev.Row
				pending.Upserts = append(pending.Upserts, ev.Row)
			}
		case <-t.C:
			flush()
			if pollMode.Load() {
				// Switched to poll mode while watching.
				return nil
			}
		}
	}
}

// GenericRowEvent is one change from a watch.
type GenericRowEvent struct {
	Row     GenericRow
	Deleted bool
}

func (w *listWatch) stream(ctx context.Context, rv string, out chan<- GenericRowEvent) error {
	ns := w.ns
	if w.shown != "" {
		ns = w.shown
	}
	rc := w.c.client.Discovery().RESTClient()
	if rc == nil {
		return w.streamDynamic(ctx, ns, rv, out)
	}
	body, err := rc.Get().AbsPath(w.path(ns)).Param("watch", "true").Param("resourceVersion", rv).Param("includeObject", "Metadata").
		Param("allowWatchBookmarks", "true").Timeout(0).
		SetHeader("Accept", "application/json;as=Table;v=v1;g=meta.k8s.io,application/json").Stream(ctx)
	if err != nil {
		return err
	}
	defer body.Close()
	dec := json.NewDecoder(body)
	for {
		var ev metav1.WatchEvent
		if err := dec.Decode(&ev); err != nil {
			if errors.Is(err, io.EOF) || ctx.Err() != nil {
				return nil
			}
			return err
		}
		switch watch.EventType(ev.Type) {
		case watch.Bookmark:
			continue
		case watch.Error:
			var st metav1.Status
			_ = json.Unmarshal(ev.Object.Raw, &st)
			return &apierrors.StatusError{ErrStatus: st}
		}
		var t metav1.Table
		if err := json.Unmarshal(ev.Object.Raw, &t); err != nil {
			continue
		}
		if len(t.ColumnDefinitions) > 0 {
			_, w.keep = tableColumns(t.ColumnDefinitions)
		}
		for _, r := range tableRows(t.Rows, w.keep) {
			select {
			case out <- GenericRowEvent{Row: r, Deleted: watch.EventType(ev.Type) == watch.Deleted}:
			case <-ctx.Done():
				return nil
			}
		}
	}
}

func (w *listWatch) streamDynamic(ctx context.Context, ns, rv string, out chan<- GenericRowEvent) error {
	ri := w.c.dynamic.Resource(w.gvr)
	opts := metav1.ListOptions{ResourceVersion: rv}
	var wi watch.Interface
	var err error
	if w.namespaced {
		wi, err = ri.Namespace(ns).Watch(ctx, opts)
	} else {
		wi, err = ri.Watch(ctx, opts)
	}
	if err != nil {
		return err
	}
	defer wi.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-wi.ResultChan():
			if !ok {
				return nil
			}
			o, ok := ev.Object.(*unstructured.Unstructured)
			if !ok {
				continue
			}
			r := GenericRow{Namespace: o.GetNamespace(), Name: o.GetName(), Labels: o.GetLabels(), Created: rfc3339(o.GetCreationTimestamp()), Cells: []string{}}
			select {
			case out <- GenericRowEvent{Row: r, Deleted: ev.Type == watch.Deleted}:
			case <-ctx.Done():
				return nil
			}
		}
	}
}
