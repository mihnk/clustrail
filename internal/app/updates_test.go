package app

import "testing"

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{{"0.10.0", "0.9.3", true}, {"0.9.0", "0.9.0", false}, {"1.0.0", "1.0.0-dev", false}, {"0.9.1", "0.9.0-dev", true}, {"0.8.9", "0.9.0", false}} {
		if got := newer(c.a, c.b); got != c.want {
			t.Errorf("newer(%q, %q) = %v", c.a, c.b, got)
		}
	}
}
