package kube

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
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

type LogsRequest struct {
	Cluster      string   `json:"cluster"`
	Namespace    string   `json:"namespace"`
	Pods         []string `json:"pods"`
	Containers   []string `json:"containers"`
	Previous     bool     `json:"previous"`
	SinceSeconds int64    `json:"sinceSeconds"`
	TailLines    int64    `json:"tailLines"`
}

type LogLine struct {
	Pod       string `json:"pod"`
	Container string `json:"container"`
	TS        string `json:"ts"`
	Level     string `json:"level"`
	Msg       string `json:"msg"`
	// Event marks an inline marker (stream end, reconnect) with its health.
	Event string `json:"event,omitempty"`
}

type LogSourceState struct {
	Pod       string `json:"pod"`
	Container string `json:"container"`
	State     string `json:"state"` // live · reconnecting · ended
	Note      string `json:"note,omitempty"`
}

type LogBatch struct {
	ID     string           `json:"id"`
	Lines  []LogLine        `json:"lines"`
	States []LogSourceState `json:"states,omitempty"`
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
	id     string
	cancel context.CancelFunc
	mu     sync.Mutex
	lines  []LogLine
	states map[string]LogSourceState
	dirty  bool
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

// StartLogs follows the logs of several pods (all containers unless listed).
// Each container is its own stream; when one ends (container restart), it
// reconnects to the new instance and an inline marker says so.
func (m *Manager) StartLogs(req LogsRequest) (string, error) {
	c, err := m.conn(req.Cluster)
	if err != nil {
		return "", err
	}
	id := m.streams.next("logs")
	ctx, cancel := context.WithCancel(c.ctx)
	ls := &logStream{id: id, cancel: cancel, states: map[string]LogSourceState{}}
	m.streams.mu.Lock()
	m.streams.logs[id] = ls
	m.streams.mu.Unlock()

	for _, podName := range req.Pods {
		pod, err := c.client.CoreV1().Pods(req.Namespace).Get(ctx, podName, metav1.GetOptions{})
		if err != nil {
			ls.add(LogLine{Pod: podName, Msg: "cannot read pod: " + err.Error(), Event: "failed"})
			continue
		}
		for _, ct := range pod.Spec.Containers {
			if len(req.Containers) > 0 && !contains(req.Containers, ct.Name) {
				continue
			}
			go m.followContainer(ctx, c, ls, req, podName, ct.Name)
		}
	}
	go func() {
		t := time.NewTicker(logFlushInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				ls.flush(m.emit)
			}
		}
	}()
	return id, nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func (ls *logStream) add(l LogLine) {
	ls.mu.Lock()
	ls.lines = append(ls.lines, l)
	ls.dirty = true
	ls.mu.Unlock()
}

func (ls *logStream) state(st LogSourceState) {
	ls.mu.Lock()
	ls.states[st.Pod+"/"+st.Container] = st
	ls.dirty = true
	ls.mu.Unlock()
}

func (ls *logStream) flush(emit Emitter) {
	ls.mu.Lock()
	if !ls.dirty {
		ls.mu.Unlock()
		return
	}
	lines := ls.lines
	if len(lines) > maxBatch {
		ls.lines = lines[maxBatch:]
		lines = lines[:maxBatch]
	} else {
		ls.lines = nil
		ls.dirty = false
	}
	states := make([]LogSourceState, 0, len(ls.states))
	for _, s := range ls.states {
		states = append(states, s)
	}
	ls.mu.Unlock()
	emit.Emit(EventLogs, LogBatch{ID: ls.id, Lines: lines, States: states})
}

func (m *Manager) followContainer(ctx context.Context, c *clusterConn, ls *logStream, req LogsRequest, pod, container string) {
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
		ls.state(LogSourceState{Pod: pod, Container: container, State: "live"})
		rc, err := c.client.CoreV1().Pods(req.Namespace).GetLogs(pod, opts).Stream(ctx)
		if err == nil {
			sc := bufio.NewScanner(rc)
			sc.Buffer(make([]byte, 64*1024), 1024*1024)
			for sc.Scan() {
				t, msg := splitTimestamp(sc.Text())
				if !t.IsZero() {
					last = t
				}
				ls.add(LogLine{Pod: pod, Container: container, TS: t.Local().Format("15:04:05.000"), Level: levelOf(msg), Msg: msg})
			}
			rc.Close()
		}
		if ctx.Err() != nil || req.Previous {
			if req.Previous && err != nil {
				ls.add(LogLine{Pod: pod, Container: container, Msg: "No previous instance: " + err.Error(), Event: "unknown"})
			}
			ls.state(LogSourceState{Pod: pod, Container: container, State: "ended"})
			return
		}
		// The stream ended: the container restarted, the pod went away, or the connection dropped.
		p, perr := c.client.CoreV1().Pods(req.Namespace).Get(ctx, pod, metav1.GetOptions{})
		if perr != nil {
			ls.add(LogLine{Pod: pod, Container: container, TS: time.Now().Format("15:04:05.000"), Msg: "Stream ended · pod is gone", Event: "unknown"})
			ls.state(LogSourceState{Pod: pod, Container: container, State: "ended", Note: "pod deleted"})
			return
		}
		for _, cs := range p.Status.ContainerStatuses {
			if cs.Name != container {
				continue
			}
			if lt := cs.LastTerminationState.Terminated; lt != nil && int(cs.RestartCount) != restarts && restarts >= 0 {
				ls.add(LogLine{Pod: pod, Container: container, TS: lt.FinishedAt.Local().Format("15:04:05.000"),
					Msg: fmt.Sprintf("Container %s terminated · %s · exit %d · %s", container, orDefault(lt.Reason, "Error"), lt.ExitCode, lt.FinishedAt.Local().Format("15:04:05")), Event: "failed"})
			}
			if restarts >= 0 && int(cs.RestartCount) != restarts {
				ls.add(LogLine{Pod: pod, Container: container, TS: time.Now().Format("15:04:05.000"),
					Msg: fmt.Sprintf("Stream reconnected · new container instance (restart %d) · %s", cs.RestartCount, time.Now().Format("15:04:05")), Event: "progressing"})
			}
			restarts = int(cs.RestartCount)
			if w := cs.State.Waiting; w != nil {
				ls.state(LogSourceState{Pod: pod, Container: container, State: "reconnecting", Note: w.Reason})
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
	stdin  *io.PipeWriter
	sizes  chan remotecommand.TerminalSize
	cancel context.CancelFunc
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
	ws, err := remotecommand.NewWebSocketExecutor(c.rest, "GET", execReq.URL().String())
	if err != nil {
		return "", err
	}
	spdy, err := remotecommand.NewSPDYExecutor(c.rest, "POST", execReq.URL())
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
	sess := &execSession{stdin: pw, sizes: make(chan remotecommand.TerminalSize, 4), cancel: cancel}
	if req.Cols > 0 {
		sess.sizes <- remotecommand.TerminalSize{Width: req.Cols, Height: req.Rows}
	}
	m.streams.mu.Lock()
	m.streams.exec[id] = sess
	m.streams.mu.Unlock()
	go func() {
		out := emitWriter{id: id, emit: m.emit}
		err := executor.StreamWithContext(ctx, remotecommand.StreamOptions{Stdin: pr, Stdout: out, Tty: true, TerminalSizeQueue: sizeQueue(sess.sizes)})
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
	}()
	return id, nil
}

func (m *Manager) execSession(id string) *execSession {
	m.streams.mu.Lock()
	defer m.streams.mu.Unlock()
	return m.streams.exec[id]
}

func (m *Manager) ExecInput(id, data string) error {
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
	}
}
