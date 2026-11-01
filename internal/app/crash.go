package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/mihnk/clustrail/internal/kube"
)

// Local crash and freeze reports (issue D7). A Go panic that Clustrail
// recovered from, a fatal crash (the runtime writes it to fatalPath, read
// at the next start), or a window that stopped answering for more than a
// second writes a report on this machine: where it stopped, versions, a
// few settings and the last lines of Clustrail's own log with cluster
// names and addresses replaced. No cluster data; nothing is sent.

// CrashReport is one saved report.
type CrashReport struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"` // panic (recovered), crash (the app stopped), freeze (the window)
	At     int64  `json:"at"`   // unix ms
	Title  string `json:"title"`
	Detail string `json:"detail"`
	// Text is the whole report, as Copy gives it.
	Text string `json:"text"`
	// Offered: shown once at a start (crashes) or as it happened (panics, freezes).
	Offered bool `json:"offered"`
}

const (
	keepReports  = 20
	logTailLines = 200
)

var (
	crashMu    sync.Mutex
	started    = time.Now()
	lastFreeze time.Time
)

func crashDir() string  { return filepath.Join(LogDir(), "crash") }
func fatalPath() string { return filepath.Join(crashDir(), "fatal.txt") }

// SetupCrashReports turns what a fatal crash left last time into a report,
// then has the runtime write the next one (debug.SetCrashOutput). It never
// stops the app from starting.
func SetupCrashReports() {
	if err := os.MkdirAll(crashDir(), 0o700); err != nil {
		slog.Warn("crash reports unavailable", "error", err)
		return
	}
	if raw, err := os.ReadFile(fatalPath()); err == nil && len(bytes.TrimSpace(raw)) > 0 {
		if len(raw) > 64<<10 {
			raw = raw[:64<<10]
		}
		title, detail := fatalSummary(string(raw))
		if _, err := saveReport("crash", title, detail, string(raw), nil); err != nil {
			slog.Warn("could not save the last crash", "error", err)
		}
	}
	f, err := os.OpenFile(fatalPath(), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		slog.Warn("crash output unavailable", "error", err)
		return
	}
	if err := debug.SetCrashOutput(f, debug.CrashOptions{}); err != nil {
		slog.Warn("crash output unavailable", "error", err)
	}
	_ = f.Close() // the runtime keeps its own descriptor
}

// fatalSummary is the first panic or fatal line of the runtime's crash output.
func fatalSummary(out string) (title, detail string) {
	title = "Clustrail stopped unexpectedly"
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "panic: ") || strings.HasPrefix(line, "fatal error: ") {
			return title, line
		}
	}
	return title, "the runtime reported a fatal error"
}

// recordPanic is kube's hook for a recovered panic.
func (w *Workspace) recordPanic(component, value, stack string) {
	if _, err := saveReport("panic", "Internal error in "+component, value, "component: "+component+"\npanic: "+value+"\n\n"+stack, w.redactor()); err != nil {
		slog.Warn("could not save a panic report", "error", err)
	}
}

// ReportFreeze records that the window stopped answering for ms
// milliseconds while it showed where. At most one report a minute.
func (w *Workspace) ReportFreeze(ms int, where string) (CrashReport, error) {
	crashMu.Lock()
	if time.Since(lastFreeze) < time.Minute {
		crashMu.Unlock()
		return CrashReport{}, nil
	}
	lastFreeze = time.Now()
	crashMu.Unlock()
	if len(where) > 300 {
		where = where[:300]
	}
	title := fmt.Sprintf("Window froze for %.1f s", float64(ms)/1000)
	r, err := saveReport("freeze", title, where, "The window stopped answering for "+fmt.Sprint(ms)+" ms.\nshowing: "+where, w.redactor())
	if err == nil {
		r.Offered = true
		_ = writeReport(r)
	}
	return r, err
}

// CrashReports lists saved reports, newest first.
func (w *Workspace) CrashReports() []CrashReport { return listReports() }

// PendingCrash is the newest crash or panic not offered yet; the UI offers it once at start.
func (w *Workspace) PendingCrash() *CrashReport {
	for _, r := range listReports() {
		if !r.Offered && r.Kind != "freeze" {
			return &r
		}
	}
	return nil
}

// AckCrash marks a report as offered.
func (w *Workspace) AckCrash(id string) error {
	r, err := readReport(id)
	if err != nil {
		return err
	}
	r.Offered = true
	return writeReport(r)
}

func (w *Workspace) DeleteCrashReport(id string) error {
	p, err := reportPath(id)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// RevealCrashReport shows the report's file in the system file manager.
func (w *Workspace) RevealCrashReport(id string) error {
	p, err := reportPath(id)
	if err != nil {
		return err
	}
	return revealInFileManager(p)
}

var reportID = regexp.MustCompile(`^[0-9]{8}-[0-9]{6}-[a-z]+-[0-9a-f]{4}$`)

func reportPath(id string) (string, error) {
	if !reportID.MatchString(id) {
		return "", fmt.Errorf("not a report id: %q", id)
	}
	return filepath.Join(crashDir(), id+".json"), nil
}

func saveReport(kind, title, detail, body string, redact func(string) string) (CrashReport, error) {
	if redact == nil {
		redact = func(s string) string { return s }
	}
	now := time.Now()
	var b strings.Builder
	fmt.Fprintf(&b, "Clustrail %s (%s/%s), %s\n", Version, runtime.GOOS, runtime.GOARCH, runtime.Version())
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, d := range bi.Deps {
			if d.Path == "k8s.io/client-go" || d.Path == "github.com/wailsapp/wails/v3" {
				fmt.Fprintf(&b, "%s %s\n", d.Path, d.Version)
			}
		}
	}
	fmt.Fprintf(&b, "kind: %s · at %s · uptime %s\n\n", kind, now.UTC().Format(time.RFC3339), time.Since(started).Round(time.Second))
	b.WriteString(redact(body))
	b.WriteString("\n\nlog (last lines, cluster names and addresses replaced):\n")
	b.WriteString(redact(logTail(logTailLines)))
	r := CrashReport{
		ID:   fmt.Sprintf("%s-%s-%04x", now.Format("20060102-150405"), kind, now.Nanosecond()&0xffff),
		Kind: kind, At: now.UnixMilli(), Title: redact(title), Detail: redact(detail), Text: b.String(),
	}
	if err := writeReport(r); err != nil {
		return r, err
	}
	pruneReports()
	return r, nil
}

func writeReport(r CrashReport) error {
	p, err := reportPath(r.ID)
	if err != nil {
		return err
	}
	raw, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	crashMu.Lock()
	defer crashMu.Unlock()
	if err := os.MkdirAll(crashDir(), 0o700); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func readReport(id string) (CrashReport, error) {
	var r CrashReport
	p, err := reportPath(id)
	if err != nil {
		return r, err
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		return r, err
	}
	err = json.Unmarshal(raw, &r)
	return r, err
}

func listReports() []CrashReport {
	entries, _ := os.ReadDir(crashDir())
	out := []CrashReport{}
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".json")
		if !ok {
			continue
		}
		if r, err := readReport(id); err == nil {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At > out[j].At })
	return out
}

func pruneReports() {
	all := listReports()
	for _, r := range all[min(keepReports, len(all)):] {
		if p, err := reportPath(r.ID); err == nil {
			_ = os.Remove(p)
		}
	}
}

// logTail is the last n lines of Clustrail's own log.
func logTail(n int) string {
	raw, err := os.ReadFile(LogPath())
	if err != nil {
		return "(no log)"
	}
	if len(raw) > 256<<10 {
		raw = raw[len(raw)-256<<10:]
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

var (
	urlRe   = regexp.MustCompile(`https?://[^\s"']+`)
	ipRe    = regexp.MustCompile(`\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b`)
	emailRe = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
)

// redactor replaces what could name the user's clusters: context names,
// cluster names and servers known to the manager, any URL, IP address or
// e-mail address, and the home directory.
func (w *Workspace) redactor() func(string) string {
	var names []string
	if w.m != nil {
		for _, c := range w.m.List().Clusters {
			names = append(names, c.ID, c.Name, c.Context)
		}
	}
	return redactWith(names)
}

func redactWith(names []string) func(string) string {
	sort.Slice(names, func(i, j int) bool { return len(names[i]) > len(names[j]) })
	home, _ := os.UserHomeDir()
	index := map[string]int{}
	return func(s string) string {
		s = urlRe.ReplaceAllString(s, "<server>")
		s = emailRe.ReplaceAllString(s, "<email>")
		s = ipRe.ReplaceAllString(s, "<ip>")
		for _, n := range names {
			if len(n) < 3 || !strings.Contains(s, n) {
				continue
			}
			i, ok := index[n]
			if !ok {
				i = len(index) + 1
				index[n] = i
			}
			s = strings.ReplaceAll(s, n, fmt.Sprintf("<cluster-%d>", i))
		}
		if home != "" {
			s = strings.ReplaceAll(s, home, "~")
		}
		return s
	}
}

// installPanicReports has kube report each recovered panic here.
func (w *Workspace) installPanicReports() {
	kube.SetPanicReporter(w.recordPanic)
}
