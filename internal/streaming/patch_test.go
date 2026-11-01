package streaming

import (
	"context"
	"encoding/json"
	"math/rand/v2"
	"reflect"
	"testing"
	"time"
)

// prow is a patchable test row: two fields that change independently.
type prow struct {
	ID string `json:"id"`
	A  int    `json:"a"`
	B  string `json:"b"`
}

func (r prow) RowID() string { return r.ID }

func (r prow) ChangedFields(old prow) []string {
	var out []string
	if r.A != old.A {
		out = append(out, "a")
	}
	if r.B != old.B {
		out = append(out, "b")
	}
	return out
}

func (r prow) Patch(fields []string) map[string]any {
	out := map[string]any{"id": r.ID}
	for _, f := range fields {
		switch f {
		case "a":
			out[f] = r.A
		case "b":
			out[f] = r.B
		}
	}
	return out
}

type pmanual struct{ sink chan Sink[prow] }

func (m *pmanual) open(Key) (Source[prow], error) {
	return func(ctx context.Context, s Sink[prow]) {
		m.sink <- s
		<-ctx.Done()
	}, nil
}

// patchClient applies frames as the UI does, patches merged into the rows it has.
type patchClient struct {
	rows    map[string]map[string]any
	staging map[string]map[string]any
	seq     uint64
	gaps    int
	missing int
}

func (c *patchClient) apply(raw []byte) {
	var f struct {
		T       string           `json:"t"`
		Seq     uint64           `json:"seq"`
		Part    int              `json:"part"`
		Final   bool             `json:"final"`
		Rows    []map[string]any `json:"rows"`
		Upserts []map[string]any `json:"up"`
		Patches []map[string]any `json:"ch"`
		Deletes []string         `json:"del"`
	}
	_ = json.Unmarshal(raw, &f)
	if f.T == "snap" && f.Part == 0 {
		c.staging = map[string]map[string]any{}
	} else if f.Seq != c.seq+1 {
		c.gaps++
	}
	c.seq = f.Seq
	switch f.T {
	case "snap":
		for _, r := range f.Rows {
			c.staging[r["id"].(string)] = r
		}
		if f.Final {
			c.rows = c.staging
		}
	case "delta":
		for _, r := range f.Upserts {
			c.rows[r["id"].(string)] = r
		}
		for _, p := range f.Patches {
			cur, ok := c.rows[p["id"].(string)]
			if !ok {
				c.missing++
				continue
			}
			merged := map[string]any{}
			for k, v := range cur {
				merged[k] = v
			}
			for k, v := range p {
				merged[k] = v
			}
			c.rows[p["id"].(string)] = merged
		}
		for _, id := range f.Deletes {
			delete(c.rows, id)
		}
	}
}

// Random creates, updates of one field, deletes and re-creates, with the
// transport full at times: the client merges patches and ends with exactly
// the source's rows, never receiving a patch for a row it lacks.
func TestPatchesConvergeWithTheSource(t *testing.T) {
	for seed := uint64(1); seed <= 6; seed++ {
		r := rand.New(rand.NewPCG(seed, seed))
		m := &pmanual{sink: make(chan Sink[prow], 1)}
		ctx, cancel := context.WithCancel(context.Background())
		h := NewHub[prow](ctx, m.open)
		conn := &fakeConn{ctx: ctx, in: make(chan []byte, 8)}
		go Serve(h, conn)
		conn.send(t, ClientMessage{Op: "sub", Sub: "p", Key: Key{Cluster: "a", Kind: "Pod"}})
		s := <-m.sink
		truth := map[string]prow{}
		seedRows := make([]prow, 50)
		for i := range seedRows {
			seedRows[i] = prow{ID: "r" + itoa(i), A: i, B: "x"}
			truth[seedRows[i].ID] = seedRows[i]
		}
		s.Replace(seedRows)
		cl := &patchClient{}
		drain := func() {
			conn.mu.Lock()
			raw := conn.frames
			conn.frames = nil
			conn.mu.Unlock()
			for _, b := range raw {
				cl.apply(b)
			}
		}
		// The consumer registers after its source starts: wait for its first snapshot.
		for wait := time.Now().Add(5 * time.Second); cl.rows == nil; time.Sleep(5 * time.Millisecond) {
			if time.Now().After(wait) {
				t.Fatal("no snapshot")
			}
			drain()
		}
		for step := range 3000 {
			id := "r" + itoa(r.IntN(80))
			cur, exists := truth[id]
			switch op := r.IntN(10); {
			case op < 5 && exists:
				cur.A++
				truth[id] = cur
				s.Upsert(cur)
			case op < 7 && exists:
				cur.B += "y"
				truth[id] = cur
				s.Upsert(cur)
			case op < 8 && exists:
				delete(truth, id)
				s.Delete(id)
			default:
				nr := prow{ID: id, A: r.IntN(100), B: "new"}
				truth[id] = nr
				s.Upsert(nr)
			}
			if step%200 == 0 {
				conn.full.Store(r.IntN(2) == 0)
			}
			if step%50 == 0 {
				time.Sleep(2 * time.Millisecond)
				drain()
			}
		}
		conn.full.Store(false)
		want := map[string]map[string]any{}
		for id, row := range truth {
			raw, _ := json.Marshal(row)
			var m map[string]any
			_ = json.Unmarshal(raw, &m)
			want[id] = m
		}
		deadline := time.Now().Add(5 * time.Second)
		for !reflect.DeepEqual(cl.rows, want) {
			if time.Now().After(deadline) {
				t.Fatalf("seed %d: rows differ: client %d rows, source %d", seed, len(cl.rows), len(want))
			}
			time.Sleep(10 * time.Millisecond)
			drain()
		}
		if cl.gaps != 0 || cl.missing != 0 {
			t.Fatalf("seed %d: gaps %d, patches for missing rows %d", seed, cl.gaps, cl.missing)
		}
		if h.Stats.Patches.Load() == 0 {
			t.Fatalf("seed %d: no patch was sent (snapshots %d, overflows %d, frames %d, send full %d)", seed, h.Stats.Snapshots.Load(), h.Stats.Overflows.Load(), h.Stats.Frames.Load(), h.Stats.SendFull.Load())
		}
		cancel()
	}
}
