package kube

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
	"k8s.io/utils/exec"
)

const (
	EventLogs = "clustrail:logs"
	EventExec = "clustrail:exec"

	logFlushInterval = 100 * time.Millisecond
	// One batch is capped so a burst cannot stall the UI thread.
	maxBatch = 2000
)

// Lines waiting for the window are bounded too (issue C11): a burst faster
// than maxBatch every logFlushInterval would otherwise grow the queue without
// limit. Past either bound the oldest waiting lines are dropped, and the next
// batch says how many and from when to when, so nothing goes silently.
var (
	maxPendingLines = 20_000
	maxPendingBytes = 8 << 20
)

type LogsRequest struct {
	Cluster   string   `json:"cluster"`
	Namespace string   `json:"namespace"`
	Pods      []string `json:"pods"`
	// Sources replace Namespace and Pods when set: workloads, label selectors
	// and pods, each in its own namespace (logsources.go).
	Sources      []LogSourceSpec `json:"sources,omitempty"`
	Containers   []string        `json:"containers"`
	Previous     bool            `json:"previous"`
	SinceSeconds int64           `json:"sinceSeconds"`
	TailLines    int64           `json:"tailLines"`
	// MaxPods caps the pods followed at once (default 30); the newest win.
	MaxPods int `json:"maxPods,omitempty"`
	// FollowNew adds pods that start matching a selector after the stream began.
	FollowNew bool `json:"followNew,omitempty"`
}

type LogLine struct {
	Namespace string `json:"namespace,omitempty"`
	Pod       string `json:"pod"`
	Container string `json:"container"`
	TS        string `json:"ts"`
	Level     string `json:"level"`
	Msg       string `json:"msg"`
	// Event marks an inline marker (stream end, reconnect) with its health,
	// or "joined"/"left" when a pod starts or stops being followed.
	Event string `json:"event,omitempty"`
}

type LogSourceState struct {
	Namespace string `json:"namespace,omitempty"`
	Pod       string `json:"pod"`
	Container string `json:"container"`
	State     string `json:"state"` // live · reconnecting · ended
	Note      string `json:"note,omitempty"`
}

type LogBatch struct {
	ID     string           `json:"id"`
	Lines  []LogLine        `json:"lines"`
	States []LogSourceState `json:"states,omitempty"`
	// Pods is every pod the stream has followed, sent when it changes.
	Pods []LogPod `json:"pods,omitempty"`
	// Matched and Skipped count the pods the sources match and those left out by MaxPods.
	Matched int `json:"matched,omitempty"`
	Skipped int `json:"skipped,omitempty"`
}

var levelRe = regexp.MustCompile(`\b(ERROR|ERR|FATAL|PANIC|WARN|WARNING|INFO|DEBUG)\b`)

func levelOf(msg string) string {
	m := levelRe.FindString(msg)
	switch m {
	case "ERROR", "ERR", "FATAL", "PANIC":
		return "ERROR"
	case "WARN", "WARNING":
		return "WARN"
	case "INFO":
		return "INFO"
	}
	return ""
}

// splitTimestamp separates the RFC3339Nano prefix added by Timestamps=true.
func splitTimestamp(line string) (time.Time, string) {
	ts, rest, ok := strings.Cut(line, " ")
	if !ok {
		return time.Time{}, line
	}
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return time.Time{}, line
	}
	return t, rest
}

type logStream struct {
	id      string
	cluster string
	cancel  context.CancelFunc
	mu      sync.Mutex
	lines   []LogLine
	bytes   int // of the waiting lines' messages
	// Lines dropped since the last batch because the window fell behind.
	dropped                int
	droppedFrom, droppedTo string
	states                 map[string]LogSourceState
	dirty                  bool
	// Membership (logsources.go): ns/pod → the pod's entry and its followers.
	pods      map[string]*followedPod
	podsDirty bool
	kicks     kicker // the flush loop waits on it while nothing is new
	matched   int
	skipped   int
}

type streams struct {
	mu   sync.Mutex
	logs map[string]*logStream
	exec map[string]*execSession
	seq  int
}

func (s *streams) next(prefix string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	return fmt.Sprintf("%s-%d-%d", prefix, time.Now().UnixMilli(), s.seq)
}

// StartLogs follows the logs of pods (all containers unless listed): fixed
// pods, or every pod a workload or label selector matches, joining and
// leaving as pods come and go. Each container is its own stream; when one ends
// (container restart), it reconnects to the new instance and an inline marker
// says so.
func (m *Manager) StartLogs(req LogsRequest) (string, error) {
	c, err := m.conn(req.Cluster)
	if err != nil {
		return "", err
	}
	if len(req.Sources) == 0 {
		req.Sources = []LogSourceSpec{{Namespace: req.Namespace, Pods: req.Pods}}
	}
	if req.MaxPods <= 0 {
		req.MaxPods = defaultMaxLogPods
	}
	id := m.streams.next("logs")
	ctx, cancel := context.WithCancel(c.ctx)
	ls := &logStream{id: id, cluster: req.Cluster, cancel: cancel, states: map[string]LogSourceState{}, pods: map[string]*followedPod{}, kicks: newKicker()}
	m.streams.mu.Lock()
	m.streams.logs[id] = ls
	m.streams.mu.Unlock()

	safeGo("log sources", nil, func() { m.followSources(ctx, c, ls, req) })
	safeLoop(ctx, "log flush", nil, func() {
		flushUntilQuiet(ctx, "log flush", logFlushInterval, ls.kicks, func() bool { return ls.flush(m.emit) })
	})
	return id, nil
}

func (ls *logStream) add(l LogLine) {
	ls.mu.Lock()
	ls.lines = append(ls.lines, l)
	ls.bytes += len(l.Msg)
	for len(ls.lines) > maxPendingLines || (ls.bytes > maxPendingBytes && len(ls.lines) > 1) {
		old := ls.lines[0]
		ls.lines = ls.lines[1:]
		ls.bytes -= len(old.Msg)
		if ls.dropped == 0 {
			ls.droppedFrom = old.TS
		}
		ls.dropped++
		ls.droppedTo = old.TS
	}
	ls.dirty = true
	ls.kicks.kick()
	ls.mu.Unlock()
}

func (ls *logStream) state(st LogSourceState) {
	ls.mu.Lock()
	ls.states[st.Pod+"/"+st.Container] = st
	ls.dirty = true
	ls.kicks.kick()
	ls.mu.Unlock()
}

func (ls *logStream) flush(emit Emitter) bool {
	ls.mu.Lock()
	if !ls.dirty && !ls.podsDirty {
		ls.mu.Unlock()
		return false
	}
	lines := ls.lines
	if len(lines) > maxBatch {
		ls.lines = lines[maxBatch:]
		lines = lines[:maxBatch]
	} else {
		ls.lines = nil
		ls.dirty = false
	}
	for _, l := range lines {
		ls.bytes -= len(l.Msg)
	}
	if ls.dropped > 0 {
		marker := LogLine{Event: "dropped", TS: ls.droppedTo,
			Msg: fmt.Sprintf("%d lines dropped (%s – %s): they came faster than the view could take them", ls.dropped, clockTS(ls.droppedFrom), clockTS(ls.droppedTo))}
		lines = append([]LogLine{marker}, lines...)
		ls.dropped, ls.droppedFrom, ls.droppedTo = 0, "", ""
	}
	states := make([]LogSourceState, 0, len(ls.states))
	for _, s := range ls.states {
		states = append(states, s)
	}
	batch := LogBatch{ID: ls.id, Lines: lines, States: states, Matched: ls.matched, Skipped: ls.skipped}
	if ls.podsDirty {
		batch.Pods = ls.podList()
		ls.podsDirty = false
	}
	ls.mu.Unlock()
	emit.Emit(EventLogs, batch)
	return true
}

func (m *Manager) followContainer(ctx context.Context, c *clusterConn, ls *logStream, req LogsRequest, ns, pod, container string) {
	opts := &corev1.PodLogOptions{Container: container, Timestamps: true, Follow: !req.Previous, Previous: req.Previous}
	if req.SinceSeconds > 0 {
		opts.SinceSeconds = &req.SinceSeconds
	}
	if req.TailLines > 0 {
		opts.TailLines = &req.TailLines
	}
	var last time.Time
	restarts := -1
	for attempt := 0; ctx.Err() == nil; attempt++ {
		ls.state(LogSourceState{Namespace: ns, Pod: pod, Container: container, State: "live"})
		rc, err := c.client.CoreV1().Pods(ns).GetLogs(pod, opts).Stream(ctx)
		if err == nil {
			_ = readLogLines(rc, maxLogLine, func(line string) {
				t, msg := splitTimestamp(line)
				if !t.IsZero() {
					last = t
				}
				ls.add(LogLine{Namespace: ns, Pod: pod, Container: container, TS: t.Local().Format("15:04:05.000"), Level: levelOf(msg), Msg: msg})
			})
			rc.Close()
		}
		if ctx.Err() != nil || req.Previous {
			if req.Previous && err != nil {
				ls.add(LogLine{Namespace: ns, Pod: pod, Container: container, Msg: "No previous instance: " + err.Error(), Event: "unknown"})
			}
			ls.state(LogSourceState{Namespace: ns, Pod: pod, Container: container, State: "ended"})
			return
		}
		// The stream ended: the container restarted, the pod went away, or the connection dropped.
		p, perr := c.client.CoreV1().Pods(ns).Get(ctx, pod, metav1.GetOptions{})
		if perr != nil {
			ls.state(LogSourceState{Namespace: ns, Pod: pod, Container: container, State: "ended", Note: "pod deleted"})
			ls.left(ns, pod, "pod deleted")
			return
		}
		for _, cs := range p.Status.ContainerStatuses {
			if cs.Name != container {
				continue
			}
			if lt := cs.LastTerminationState.Terminated; lt != nil && int(cs.RestartCount) != restarts && restarts >= 0 {
				ls.add(LogLine{Namespace: ns, Pod: pod, Container: container, TS: lt.FinishedAt.Local().Format("15:04:05.000"),
					Msg: fmt.Sprintf("Container %s terminated · %s · exit %d · %s", container, orDefault(lt.Reason, "Error"), lt.ExitCode, lt.FinishedAt.Local().Format("15:04:05")), Event: "failed"})
			}
			if restarts >= 0 && int(cs.RestartCount) != restarts {
				ls.add(LogLine{Namespace: ns, Pod: pod, Container: container, TS: time.Now().Format("15:04:05.000"),
					Msg: fmt.Sprintf("Stream reconnected · new container instance (restart %d) · %s", cs.RestartCount, time.Now().Format("15:04:05")), Event: "progressing"})
			}
			restarts = int(cs.RestartCount)
			if w := cs.State.Waiting; w != nil {
				ls.state(LogSourceState{Namespace: ns, Pod: pod, Container: container, State: "reconnecting", Note: w.Reason})
			}
		}
		if !last.IsZero() {
			since := metav1.NewTime(last.Add(time.Millisecond))
			opts.SinceTime, opts.SinceSeconds, opts.TailLines = &since, nil, nil
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Duration(min(2+attempt, 10)) * time.Second):
		}
	}
}

// maxLogLine is the longest log line kept; the rest of a longer line is
// dropped and the line says how much.
var maxLogLine = 64 << 10

// readLogLines calls fn for each line of r. A line longer than limit is cut
// with a note of how many bytes were dropped, and reading goes on: a scanner
// would stop at the first line over its limit, and the stream, reconnecting
// from the same timestamp, would stop at that line forever.
func readLogLines(r io.Reader, limit int, fn func(string)) error {
	br := bufio.NewReaderSize(r, 64<<10)
	var line []byte
	dropped, pending := 0, false
	emit := func() {
		text := strings.TrimSuffix(string(line), "\r")
		if dropped > 0 {
			text += fmt.Sprintf(" … [line cut: %d more bytes]", dropped)
		}
		fn(text)
		line, dropped, pending = line[:0], 0, false
	}
	for {
		chunk, err := br.ReadSlice('\n')
		complete := len(chunk) > 0 && chunk[len(chunk)-1] == '\n'
		if complete {
			chunk = chunk[:len(chunk)-1]
		}
		if len(chunk) > 0 {
			pending = true
			take := max(0, min(limit-len(line), len(chunk)))
			line = append(line, chunk[:take]...)
			dropped += len(chunk) - take
		}
		if complete {
			pending = true
			emit()
		}
		switch {
		case err == nil, errors.Is(err, bufio.ErrBufferFull):
		case err == io.EOF:
			if pending {
				emit() // the last line, without a newline
			}
			return nil
		default:
			return err
		}
	}
}

func (m *Manager) StopLogs(id string) {
	m.streams.mu.Lock()
	ls := m.streams.logs[id]
	delete(m.streams.logs, id)
	m.streams.mu.Unlock()
	if ls != nil {
		ls.cancel()
	}
}

type ExecRequest struct {
	Cluster   string   `json:"cluster"`
	Namespace string   `json:"namespace"`
	Pod       string   `json:"pod"`
	Container string   `json:"container"`
	Command   []string `json:"command"`
	Cols      uint16   `json:"cols"`
	Rows      uint16   `json:"rows"`
}

type ExecOutput struct {
	ID   string `json:"id"`
	Data string `json:"data,omitempty"` // base64: terminal output can split UTF-8 sequences
	Exit *int   `json:"exit,omitempty"`
	Err  string `json:"error,omitempty"`
}

type execSession struct {
	cluster string
	stdin   *io.PipeWriter
	sizes   chan remotecommand.TerminalSize
	cancel  context.CancelFunc
	// cleanup is a file removed when the session closes (a local shell's kubeconfig).
	cleanup string
}

type sizeQueue chan remotecommand.TerminalSize

func (q sizeQueue) Next() *remotecommand.TerminalSize {
	s, ok := <-q
	if !ok {
		return nil
	}
	return &s
}

type emitWriter struct {
	id   string
	emit Emitter
}

func (w emitWriter) Write(p []byte) (int, error) {
	w.emit.Emit(EventExec, ExecOutput{ID: w.id, Data: base64.StdEncoding.EncodeToString(p)})
	return len(p), nil
}

// StartExec opens an interactive TTY in a container (WebSocket, falling back to SPDY).
// Shells count as changes: read-only contexts refuse them.
func (m *Manager) StartExec(req ExecRequest) (string, error) {
	c, err := m.writable(req.Cluster)
	if err != nil {
		return "", err
	}
	if len(req.Command) == 0 {
		req.Command = []string{"/bin/sh", "-c", "command -v bash >/dev/null && exec bash || exec sh"}
	}
	execReq := c.client.CoreV1().RESTClient().Post().Resource("pods").Namespace(req.Namespace).Name(req.Pod).SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{Container: req.Container, Command: req.Command, Stdin: true, Stdout: true, TTY: true}, scheme.ParameterCodec)
	return m.startRemote(c, req, execReq.URL(), true, true)
}

// AttachInfo is what an attach can do, from the container's spec.
type AttachInfo struct {
	ID string `json:"id"`
	// Stdin: the container was started with stdin open, so input reaches it.
	Stdin bool `json:"stdin"`
	// TTY: the container has a terminal; without one, output is plain lines.
	TTY bool `json:"tty"`
}

// StartAttach attaches to a container's main process, like kubectl attach:
// input only when the container keeps stdin open, a TTY only when it has one.
// Closing the session detaches; the process keeps running. Attaching counts
// as a change (it can send input): read-only contexts refuse it.
func (m *Manager) StartAttach(req ExecRequest) (AttachInfo, error) {
	c, err := m.writable(req.Cluster)
	if err != nil {
		return AttachInfo{}, err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	pod, err := c.client.CoreV1().Pods(req.Namespace).Get(ctx, req.Pod, metav1.GetOptions{})
	if err != nil {
		return AttachInfo{}, err
	}
	var ct *corev1.Container
	for i := range pod.Spec.Containers {
		if req.Container == "" || pod.Spec.Containers[i].Name == req.Container {
			ct = &pod.Spec.Containers[i]
			break
		}
	}
	if ct == nil {
		for i := range pod.Spec.EphemeralContainers {
			if pod.Spec.EphemeralContainers[i].Name == req.Container {
				c := corev1.Container(pod.Spec.EphemeralContainers[i].EphemeralContainerCommon)
				ct = &c
			}
		}
	}
	if ct == nil {
		return AttachInfo{}, fmt.Errorf("container %q not found in pod %s", req.Container, req.Pod)
	}
	req.Container = ct.Name
	info := AttachInfo{Stdin: ct.Stdin, TTY: ct.TTY && ct.Stdin}
	attachReq := c.client.CoreV1().RESTClient().Post().Resource("pods").Namespace(req.Namespace).Name(req.Pod).SubResource("attach").
		VersionedParams(&corev1.PodAttachOptions{Container: ct.Name, Stdin: info.Stdin, Stdout: true, Stderr: !info.TTY, TTY: info.TTY}, scheme.ParameterCodec)
	info.ID, err = m.startRemote(c, req, attachReq.URL(), info.Stdin, info.TTY)
	return info, err
}

// startRemote streams an exec or attach request into a session that
// ExecInput, ExecResize and CloseExec drive.
func (m *Manager) startRemote(c *clusterConn, req ExecRequest, u *url.URL, stdin, tty bool) (string, error) {
	ws, err := remotecommand.NewWebSocketExecutor(c.rest, "GET", u.String())
	if err != nil {
		return "", err
	}
	spdy, err := remotecommand.NewSPDYExecutor(c.rest, "POST", u)
	if err != nil {
		return "", err
	}
	executor, err := remotecommand.NewFallbackExecutor(ws, spdy, func(err error) bool { return true })
	if err != nil {
		return "", err
	}
	id := m.streams.next("exec")
	pr, pw := io.Pipe()
	ctx, cancel := context.WithCancel(c.ctx)
	sess := &execSession{cluster: req.Cluster, stdin: pw, sizes: make(chan remotecommand.TerminalSize, 4), cancel: cancel}
	if req.Cols > 0 && tty {
		sess.sizes <- remotecommand.TerminalSize{Width: req.Cols, Height: req.Rows}
	}
	m.streams.mu.Lock()
	m.streams.exec[id] = sess
	m.streams.mu.Unlock()
	safeGo("shell session", func(err error) {
		code := -1
		m.emit.Emit(EventExec, ExecOutput{ID: id, Exit: &code, Err: err.Error()})
		m.CloseExec(id)
	}, func() {
		out := emitWriter{id: id, emit: m.emit}
		opts := remotecommand.StreamOptions{Stdout: out, Tty: tty}
		if stdin {
			opts.Stdin = pr
		}
		if tty {
			opts.TerminalSizeQueue = sizeQueue(sess.sizes)
		} else {
			opts.Stderr = out
		}
		err := executor.StreamWithContext(ctx, opts)
		code := 0
		var exitErr exec.ExitError
		res := ExecOutput{ID: id}
		switch {
		case err == nil:
		case errors.As(err, &exitErr):
			code = exitErr.ExitStatus()
		case ctx.Err() != nil:
			code = 130
		default:
			code, res.Err = -1, err.Error()
		}
		res.Exit = &code
		m.emit.Emit(EventExec, res)
		m.CloseExec(id)
	})
	return id, nil
}

func (m *Manager) execSession(id string) *execSession {
	m.streams.mu.Lock()
	defer m.streams.mu.Unlock()
	return m.streams.exec[id]
}

func (m *Manager) ExecInput(id, data string) error {
	if err := checkSize("the input", len(data), maxExecInputBytes); err != nil {
		return err
	}
	s := m.execSession(id)
	if s == nil {
		return fmt.Errorf("session %s ended", id)
	}
	_, err := s.stdin.Write([]byte(data))
	return err
}

func (m *Manager) ExecResize(id string, cols, rows uint16) {
	if s := m.execSession(id); s != nil {
		select {
		case s.sizes <- remotecommand.TerminalSize{Width: cols, Height: rows}:
		default: // a resize is pending; the next one supersedes it
		}
	}
}

func (m *Manager) CloseExec(id string) {
	m.streams.mu.Lock()
	s := m.streams.exec[id]
	delete(m.streams.exec, id)
	m.streams.mu.Unlock()
	if s != nil {
		s.cancel()
		_ = s.stdin.Close()
		if s.cleanup != "" {
			_ = os.Remove(s.cleanup)
		}
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// clockTS shows a log timestamp as a time of day (the raw text if it is not RFC 3339).
func clockTS(ts string) string {
	if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
		return t.Local().Format("15:04:05")
	}
	if ts == "" {
		return "?"
	}
	return ts
}
