package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mihnk/clustrail/internal/kube"
)

func crashHome(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", dir)
	t.Setenv("HOME", dir)
	if err := os.MkdirAll(LogDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(LogPath(), []byte("14:01:58 INFO connected cluster=prod-eu-west-1 server=https://4F3A.gr7.eu-west-1.eks.amazonaws.com\n14:02:00 INFO identity=jane@example.com ip=10.42.3.17:6443\n"), 0o600)
}

// A recovered panic writes a report that the next start offers once.
func TestAForcedPanicIsOfferedAtTheNextStart(t *testing.T) {
	crashHome(t)
	w := &Workspace{}
	w.installPanicReports()
	t.Cleanup(func() { kube.SetPanicReporter(func(string, string, string) {}) })
	kube.ForcePanicForTest("cluster flush")

	p := w.PendingCrash()
	if p == nil || p.Kind != "panic" || !strings.Contains(p.Title, "cluster flush") || !strings.Contains(p.Text, "boom for a test") {
		t.Fatalf("pending = %+v", p)
	}
	if !strings.Contains(p.Text, "goroutine") {
		t.Fatal("the report holds the stack")
	}
	if err := w.AckCrash(p.ID); err != nil {
		t.Fatal(err)
	}
	if w.PendingCrash() != nil {
		t.Fatal("a report is offered once")
	}
	if n := len(w.CrashReports()); n != 1 {
		t.Fatalf("reports kept = %d", n)
	}
}

// What a fatal crash left in the runtime's crash output becomes a report at the next start.
func TestAFatalCrashBecomesAReportAtStart(t *testing.T) {
	crashHome(t)
	if err := os.MkdirAll(crashDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(fatalPath(), []byte("panic: runtime error: index out of range [3] with length 3\n\ngoroutine 418 [running]:\nmain.main()\n"), 0o600)
	SetupCrashReports()
	p := (&Workspace{}).PendingCrash()
	if p == nil || p.Kind != "crash" || p.Detail != "panic: runtime error: index out of range [3] with length 3" {
		t.Fatalf("pending = %+v", p)
	}
	if raw, _ := os.ReadFile(fatalPath()); len(raw) != 0 {
		t.Fatal("the crash output is emptied for the next run")
	}
}

// No cluster names, servers, addresses or e-mails reach a report.
func TestReportsReplaceClusterNamesAndAddresses(t *testing.T) {
	crashHome(t)
	r, err := saveReport("panic", "Internal error in prod-eu-west-1", "x", "connecting prod-eu-west-1 at https://api.prod:6443", redactWith([]string{"prod-eu-west-1"}))
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"prod-eu-west-1", "eks.amazonaws.com", "jane@example.com", "10.42.3.17", "https://"} {
		if strings.Contains(r.Text, leak) || strings.Contains(r.Title, leak) {
			t.Errorf("report holds %q:\n%s", leak, r.Text)
		}
	}
	if !strings.Contains(r.Text, "<cluster-1>") || !strings.Contains(r.Text, "<server>") {
		t.Fatalf("placeholders missing:\n%s", r.Text)
	}
}

func TestFreezesAreReportedAtMostOnceAMinute(t *testing.T) {
	crashHome(t)
	lastFreeze = lastFreeze.AddDate(-1, 0, 0)
	w := &Workspace{}
	r, err := w.ReportFreeze(2400, "Pods table · 48,000 rows")
	if err != nil || r.Kind != "freeze" || r.Title != "Window froze for 2.4 s" || !r.Offered {
		t.Fatalf("report = %+v, %v", r, err)
	}
	if again, _ := w.ReportFreeze(3000, "again"); again.ID != "" {
		t.Fatal("a second freeze within a minute is not reported")
	}
	if w.PendingCrash() != nil {
		t.Fatal("a freeze is shown as it happens, not offered at start")
	}
}

func TestReportIDsCannotLeaveTheReportsFolder(t *testing.T) {
	crashHome(t)
	w := &Workspace{}
	for _, id := range []string{"../../etc/passwd", "x", filepath.Join("..", "a")} {
		if err := w.DeleteCrashReport(id); err == nil {
			t.Errorf("%q accepted", id)
		}
	}
}

func TestOnlyTheNewestReportsAreKept(t *testing.T) {
	crashHome(t)
	for i := range keepReports + 5 {
		_, _ = saveReport("panic", "p", strings.Repeat("x", i), "body", nil)
	}
	if n := len(listReports()); n != keepReports {
		t.Fatalf("kept %d reports", n)
	}
}
