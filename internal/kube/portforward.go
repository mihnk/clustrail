package kube

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/httpstream"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/transport/spdy"
)

// EventPortForwards carries the full list of port forwards whenever one changes.
const EventPortForwards = "clustrail:portforwards"

// PortForwardRequest forwards a local port to a Pod, or to a ready Pod
// behind a Service or Deployment, like kubectl port-forward.
type PortForwardRequest struct {
	Cluster   string `json:"cluster"`
	Namespace string `json:"namespace"`
	Kind      string `json:"kind"` // Pod, Service or Deployment
	Name      string `json:"name"`
	// Port on the target: a Service port for Services, else a container port.
	Port int `json:"port"`
	// LocalPort 0 picks a free port.
	LocalPort int `json:"localPort"`
}

// PortForward is one forward as the UI lists it.
type PortForward struct {
	ID        string `json:"id"`
	Cluster   string `json:"cluster"`
	Namespace string `json:"namespace"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Port      int    `json:"port"`
	LocalPort int    `json:"localPort"`
	// Pod and PodPort are what the forward currently reaches.
	Pod     string `json:"pod,omitempty"`
	PodPort int    `json:"podPort,omitempty"`
	State   string `json:"state"` // starting, active, reconnecting, failed
	Error   string `json:"error,omitempty"`
	Started string `json:"started"`
}

type portForward struct {
	info   PortForward
	cancel context.CancelFunc
}

type forwards struct {
	mu   sync.Mutex
	byID map[string]*portForward
	seq  int
}

// StartPortForward starts a forward and keeps it alive: when the pod goes
// away it re-resolves the target and reconnects on the same local port.
func (m *Manager) StartPortForward(req PortForwardRequest) (PortForward, error) {
	c, err := m.conn(req.Cluster)
	if err != nil {
		return PortForward{}, err
	}
	if req.Port <= 0 {
		return PortForward{}, errors.New("a target port is required")
	}
	ctx, cancel := context.WithCancel(c.ctx)
	pod, podPort, err := resolveForwardTarget(ctx, c, req)
	if err != nil {
		cancel()
		return PortForward{}, err
	}
	m.forwards.mu.Lock()
	if m.forwards.byID == nil {
		m.forwards.byID = map[string]*portForward{}
	}
	m.forwards.seq++
	pf := &portForward{cancel: cancel, info: PortForward{
		ID: fmt.Sprintf("pf-%d", m.forwards.seq), Cluster: req.Cluster, Namespace: req.Namespace, Kind: req.Kind, Name: req.Name,
		Port: req.Port, LocalPort: req.LocalPort, Pod: pod, PodPort: podPort, State: "starting", Started: time.Now().UTC().Format(time.RFC3339),
	}}
	m.forwards.byID[pf.info.ID] = pf
	m.forwards.mu.Unlock()

	ready := make(chan int, 1)
	go m.runForward(ctx, c, req, pf, ready)
	select {
	case port := <-ready:
		if port < 0 {
			m.forwards.mu.Lock()
			info := pf.info
			delete(m.forwards.byID, pf.info.ID)
			m.forwards.mu.Unlock()
			cancel()
			m.emitForwards()
			return PortForward{}, errors.New(info.Error)
		}
	case <-time.After(30 * time.Second):
		cancel()
		m.StopPortForward(pf.info.ID)
		return PortForward{}, errors.New("port forward did not become ready within 30s")
	}
	return m.forward(pf.info.ID), nil
}

func (m *Manager) runForward(ctx context.Context, c *clusterConn, req PortForwardRequest, pf *portForward, ready chan<- int) {
	var cameUp atomic.Bool // set from the forwarder's goroutine
	for attempt := 0; ctx.Err() == nil; attempt++ {
		if attempt > 0 {
			pod, podPort, err := resolveForwardTarget(ctx, c, req)
			if err != nil {
				m.setForward(pf, func(i *PortForward) { i.State, i.Error = "reconnecting", err.Error() })
				if !sleepCtx(ctx, backoff(attempt)) {
					return
				}
				continue
			}
			m.setForward(pf, func(i *PortForward) { i.Pod, i.PodPort = pod, podPort })
		}
		m.forwards.mu.Lock()
		info := pf.info
		m.forwards.mu.Unlock()
		localPort, err := forwardOnce(ctx, c, info, func(port int) {
			m.setForward(pf, func(i *PortForward) { i.LocalPort, i.State, i.Error = port, "active", "" })
			if cameUp.CompareAndSwap(false, true) {
				ready <- port
			}
		})
		if ctx.Err() != nil {
			return
		}
		if !cameUp.Load() {
			// Never came up (port in use, RBAC): report and stop.
			m.setForward(pf, func(i *PortForward) { i.State, i.Error = "failed", errText(err) })
			ready <- -1
			return
		}
		if localPort > 0 {
			// It was up: keep the same local port and start the backoff over.
			req.LocalPort, attempt = localPort, 0
			m.forwards.mu.Lock()
			pf.info.LocalPort = localPort
			m.forwards.mu.Unlock()
		}
		m.setForward(pf, func(i *PortForward) { i.State, i.Error = "reconnecting", errText(err) })
		if !sleepCtx(ctx, backoff(attempt+1)) {
			return
		}
	}
}

func backoff(attempt int) time.Duration {
	d := time.Duration(attempt) * time.Second
	if d > 10*time.Second {
		d = 10 * time.Second
	}
	return d
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

// forwardOnce runs one port-forward session until it fails or ctx ends.
// onReady gets the bound local port.
func forwardOnce(ctx context.Context, c *clusterConn, info PortForward, onReady func(int)) (int, error) {
	url := c.client.CoreV1().RESTClient().Post().Resource("pods").Namespace(info.Namespace).Name(info.Pod).SubResource("portforward").URL()
	transport, upgrader, err := spdy.RoundTripperFor(c.rest)
	if err != nil {
		return 0, err
	}
	dialer := spdy.NewDialer(upgrader, &http.Client{Transport: transport}, "POST", url)
	// Newer API servers take port-forward over WebSockets; older ones only SPDY.
	if ws, err := portforward.NewSPDYOverWebsocketDialer(url, c.rest); err == nil {
		dialer = portforward.NewFallbackDialer(ws, dialer, func(err error) bool {
			return httpstream.IsUpgradeFailure(err) || httpstream.IsHTTPSProxyError(err)
		})
	}
	sessionCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	readyCh := make(chan struct{})
	fw, err := portforward.NewOnAddressesWithContext(sessionCtx, dialer, []string{"127.0.0.1"},
		[]string{fmt.Sprintf("%d:%d", info.LocalPort, info.PodPort)}, readyCh, io.Discard, io.Discard)
	if err != nil {
		return 0, err
	}
	var local atomic.Int32
	go func() {
		select {
		case <-readyCh:
			if ports, err := fw.GetPorts(); err == nil && len(ports) > 0 {
				local.Store(int32(ports[0].Local))
			}
			onReady(int(local.Load()))
		case <-sessionCtx.Done():
		}
	}()
	err = fw.ForwardPorts()
	if err == nil {
		err = errors.New("connection to the pod closed")
	}
	return int(local.Load()), err
}

// resolveForwardTarget finds a running pod and its port for a request:
// a Service's port maps through targetPort to a container port.
func resolveForwardTarget(ctx context.Context, c *clusterConn, req PortForwardRequest) (string, int, error) {
	core := c.client.CoreV1()
	switch req.Kind {
	case "", "Pod":
		p, err := core.Pods(req.Namespace).Get(ctx, req.Name, metav1.GetOptions{})
		if err != nil {
			return "", 0, err
		}
		if p.Status.Phase != corev1.PodRunning {
			return "", 0, fmt.Errorf("pod %s is %s, not Running", p.Name, p.Status.Phase)
		}
		return p.Name, req.Port, nil
	case "Service":
		svc, err := core.Services(req.Namespace).Get(ctx, req.Name, metav1.GetOptions{})
		if err != nil {
			return "", 0, err
		}
		if len(svc.Spec.Selector) == 0 {
			return "", 0, fmt.Errorf("service %s has no selector; forward to a pod instead", svc.Name)
		}
		var sp *corev1.ServicePort
		for i := range svc.Spec.Ports {
			if int(svc.Spec.Ports[i].Port) == req.Port {
				sp = &svc.Spec.Ports[i]
			}
		}
		if sp == nil {
			return "", 0, fmt.Errorf("service %s has no port %d", svc.Name, req.Port)
		}
		pod, err := readyPod(ctx, c, req.Namespace, svc.Spec.Selector)
		if err != nil {
			return "", 0, err
		}
		port, err := containerPort(pod, sp.TargetPort, req.Port)
		return pod.Name, port, err
	case "Deployment":
		d, err := c.client.AppsV1().Deployments(req.Namespace).Get(ctx, req.Name, metav1.GetOptions{})
		if err != nil {
			return "", 0, err
		}
		if d.Spec.Selector == nil {
			return "", 0, fmt.Errorf("deployment %s has no selector", d.Name)
		}
		pod, err := readyPod(ctx, c, req.Namespace, d.Spec.Selector.MatchLabels)
		if err != nil {
			return "", 0, err
		}
		return pod.Name, req.Port, nil
	}
	return "", 0, fmt.Errorf("cannot port-forward to a %s", req.Kind)
}

// readyPod picks a ready pod for the selector, newest first, like kubectl.
func readyPod(ctx context.Context, c *clusterConn, ns string, selector map[string]string) (*corev1.Pod, error) {
	list, err := c.client.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{LabelSelector: labels.SelectorFromSet(selector).String()})
	if err != nil {
		return nil, err
	}
	pods := list.Items
	sort.Slice(pods, func(i, j int) bool { return pods[j].CreationTimestamp.Before(&pods[i].CreationTimestamp) })
	for i := range pods {
		p := &pods[i]
		if p.DeletionTimestamp != nil || p.Status.Phase != corev1.PodRunning {
			continue
		}
		for _, cond := range p.Status.Conditions {
			if cond.Type == corev1.PodReady && cond.Status == corev1.ConditionTrue {
				return p, nil
			}
		}
	}
	return nil, fmt.Errorf("no ready pod matches %s", labels.SelectorFromSet(selector))
}

func containerPort(p *corev1.Pod, target intstr.IntOrString, servicePort int) (int, error) {
	switch {
	case target.Type == intstr.String && target.StrVal != "":
		for _, ct := range p.Spec.Containers {
			for _, cp := range ct.Ports {
				if cp.Name == target.StrVal {
					return int(cp.ContainerPort), nil
				}
			}
		}
		return 0, fmt.Errorf("pod %s has no container port named %q", p.Name, target.StrVal)
	case target.IntValue() > 0:
		return target.IntValue(), nil
	}
	return servicePort, nil
}

func (m *Manager) setForward(pf *portForward, f func(*PortForward)) {
	m.forwards.mu.Lock()
	f(&pf.info)
	m.forwards.mu.Unlock()
	m.emitForwards()
}

func (m *Manager) forward(id string) PortForward {
	m.forwards.mu.Lock()
	defer m.forwards.mu.Unlock()
	if pf := m.forwards.byID[id]; pf != nil {
		return pf.info
	}
	return PortForward{}
}

// PortForwards lists active forwards, oldest first.
func (m *Manager) PortForwards() []PortForward {
	m.forwards.mu.Lock()
	defer m.forwards.mu.Unlock()
	out := make([]PortForward, 0, len(m.forwards.byID))
	for _, pf := range m.forwards.byID {
		out = append(out, pf.info)
	}
	sort.Slice(out, func(i, j int) bool {
		a, _ := strconv.Atoi(strings.TrimPrefix(out[i].ID, "pf-"))
		b, _ := strconv.Atoi(strings.TrimPrefix(out[j].ID, "pf-"))
		return a < b
	})
	return out
}

func (m *Manager) emitForwards() {
	if m.emit != nil {
		m.emit.Emit(EventPortForwards, m.PortForwards())
	}
}

func (m *Manager) StopPortForward(id string) {
	m.forwards.mu.Lock()
	pf := m.forwards.byID[id]
	delete(m.forwards.byID, id)
	m.forwards.mu.Unlock()
	if pf != nil {
		pf.cancel()
		m.emitForwards()
	}
}

func (m *Manager) stopForwardsOf(cluster string) {
	for _, f := range m.PortForwards() {
		if f.Cluster == cluster {
			m.StopPortForward(f.ID)
		}
	}
}

func (m *Manager) stopAllForwards() {
	for _, f := range m.PortForwards() {
		m.StopPortForward(f.ID)
	}
}

// PortOption is a port the forward dialog offers for a target.
type PortOption struct {
	Port   int    `json:"port"`
	Name   string `json:"name,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// ForwardablePorts lists the declared ports of a Pod (containers), Service
// or Deployment (pod template), for the dialog to offer.
func (m *Manager) ForwardablePorts(cluster, kind, ns, name string) ([]PortOption, error) {
	c, err := m.conn(cluster)
	if err != nil {
		return nil, err
	}
	ctx, cancel := actionCtx()
	defer cancel()
	fromContainers := func(cs []corev1.Container) []PortOption {
		out := []PortOption{}
		for _, ct := range cs {
			for _, p := range ct.Ports {
				if p.Protocol != "" && p.Protocol != corev1.ProtocolTCP {
					continue
				}
				out = append(out, PortOption{Port: int(p.ContainerPort), Name: p.Name, Detail: "container " + ct.Name})
			}
		}
		return out
	}
	switch kind {
	case "Pod":
		p, err := c.client.CoreV1().Pods(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, err
		}
		return fromContainers(p.Spec.Containers), nil
	case "Deployment":
		d, err := c.client.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, err
		}
		return fromContainers(d.Spec.Template.Spec.Containers), nil
	case "Service":
		s, err := c.client.CoreV1().Services(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, err
		}
		out := []PortOption{}
		for _, p := range s.Spec.Ports {
			if p.Protocol != "" && p.Protocol != corev1.ProtocolTCP {
				continue
			}
			out = append(out, PortOption{Port: int(p.Port), Name: p.Name, Detail: "→ " + p.TargetPort.String()})
		}
		return out, nil
	}
	return nil, fmt.Errorf("cannot port-forward to a %s", kind)
}
