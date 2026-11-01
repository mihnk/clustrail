package app

import (
	"context"
	"log/slog"
	"sync/atomic"

	"github.com/mihnk/clustrail/internal/kube"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

// EventReveal asks the UI to open an object (a notification was clicked).
const EventReveal = "clustrail:reveal"

// Desktop notifications, where the system offers them. On macOS they need
// the packaged, signed app; an unpackaged build (development, benchmarks)
// runs without them and shows the news in the window only.
type Desktop struct {
	svc       *notifications.NotificationService
	available atomic.Bool
}

// NewDesktop makes the service; register it with the app.
func NewDesktop() *Desktop { return &Desktop{svc: notifications.New()} }

func (d *Desktop) ServiceName() string { return "clustrail-desktop-notifications" }

// ServiceStartup never fails the app: without notifications Clustrail still runs.
func (d *Desktop) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	if err := d.svc.ServiceStartup(ctx, options); err != nil {
		slog.Info("desktop notifications unavailable", "error", err)
		return nil
	}
	d.available.Store(true)
	// A click opens the object it is about, in front.
	d.svc.OnNotificationResponse(func(r notifications.NotificationResult) {
		if r.Error != nil {
			return
		}
		app := application.Get()
		for _, w := range app.Window.GetAll() {
			w.Show()
			w.Focus()
		}
		app.Event.Emit(EventReveal, r.Response.UserInfo)
	})
	return nil
}

func (d *Desktop) ServiceShutdown() error {
	if d.available.Load() {
		return d.svc.ServiceShutdown()
	}
	return nil
}

// send shows an alert as a desktop notification, asking for permission the first time.
func (d *Desktop) send(a kube.Alert) {
	if d == nil || !d.available.Load() {
		return
	}
	ok, err := d.svc.CheckNotificationAuthorization()
	if err == nil && !ok {
		ok, err = d.svc.RequestNotificationAuthorization()
	}
	if err != nil || !ok {
		return
	}
	sub := a.Cluster
	if a.Namespace != "" {
		sub += " · " + a.Namespace
	}
	if err := d.svc.SendNotification(notifications.NotificationOptions{
		ID: a.ID, Title: a.Title, Subtitle: sub, Body: a.Detail, ThreadID: a.Cluster,
		Data: map[string]any{"kind": a.ObjectKind, "cluster": a.Cluster, "namespace": a.Namespace, "name": a.Object},
	}); err != nil {
		slog.Warn("desktop notification failed", "error", err)
	}
}

// anyWindowFocused reports whether a Clustrail window is in front.
func anyWindowFocused() bool {
	app := application.Get()
	if app == nil {
		return false
	}
	for _, w := range app.Window.GetAll() {
		if w.IsFocused() {
			return true
		}
	}
	return false
}

// alertSink sends every alert to the window (a toast there when it is in
// front, and the recent list), and as a desktop notification when no
// Clustrail window is in front.
func (w *Workspace) alertSink(a kube.Alert) {
	if app := application.Get(); app != nil {
		app.Event.Emit(kube.EventAlert, a)
	}
	if !anyWindowFocused() || a.Kind == "test" {
		w.Desktop.send(a)
	}
}

// Notifications API for the UI.

func (w *Workspace) NotificationSettings() kube.NotifySettings { return w.m.NotificationSettings() }

func (w *Workspace) SetNotificationSettings(s kube.NotifySettings) error {
	return w.m.SetNotificationSettings(s)
}

func (w *Workspace) Alerts() []kube.Alert { return w.m.Alerts() }

// TestNotification sends a sample through the same path; it reports whether
// desktop notifications are available.
func (w *Workspace) TestNotification() bool {
	w.m.TestNotification()
	return w.Desktop != nil && w.Desktop.available.Load()
}
