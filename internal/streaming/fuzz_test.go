package streaming

import (
	"context"
	"maps"
	"testing"
)

// The pod stream protocol under any order of events: changes, sends that
// fail and come back, resyncs. Whatever happens, once everything pending is
// delivered the client holds exactly the source's rows. Explore with
//
//	go test -run - -fuzz FuzzConsumerConverges -fuzztime 60s ./internal/streaming
func FuzzConsumerConverges(f *testing.F) {
	f.Add([]byte{0, 1, 2, 3, 0, 4, 3})
	f.Add([]byte{0x10, 0x21, 0x30, 0x44, 0x13, 0x05, 0x23, 0x33, 0x40})
	f.Add([]byte{5, 0, 0, 4, 1, 4, 3, 2, 2, 4, 5, 3})
	f.Fuzz(func(t *testing.T, ops []byte) {
		if len(ops) > 400 {
			ops = ops[:400]
		}
		m := &manual{sink: make(chan Sink[row], 1)}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		h := NewHub[row](ctx, m.open)
		c, err := h.Subscribe(Key{Cluster: "a", Kind: "Pod"})
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		s := <-m.sink

		client := map[string]int{}
		apply := func(b Batch[row]) {
			if b.Snapshot {
				client = map[string]int{}
				for _, r := range b.Rows {
					client[r.ID] = r.V
				}
			}
			for _, r := range b.Upserts {
				client[r.ID] = r.V
			}
			for _, id := range b.Deletes {
				delete(client, id)
			}
		}
		ids := []string{"a", "b", "c", "d", "e", "f", "g", "h"}
		for i, o := range ops {
			id := ids[int(o>>4)%len(ids)]
			switch o % 6 {
			case 0:
				s.Upsert(row{id, i})
			case 1:
				s.Delete(id)
			case 2: // a relist: the rows whose bit is set in the high nibble
				var rows []row
				for j, x := range ids[:4] {
					if o>>(4+j)&1 == 1 {
						rows = append(rows, row{x, i})
					}
				}
				s.Replace(rows)
			case 3:
				apply(c.Take())
			case 4: // a send that failed
				c.Return(c.Take())
			case 5:
				c.Resync()
			}
		}
		apply(c.Take())

		truth := map[string]int{}
		for _, r := range h.TopicRows(Key{Cluster: "a", Kind: "Pod"}) {
			truth[r.ID] = r.V
		}
		if !maps.Equal(client, truth) {
			t.Fatalf("client %v, source %v (ops %v)", client, truth, ops)
		}
	})
}
