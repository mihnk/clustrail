package app

import (
	"github.com/mihnk/clustrail/internal/kube"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Quiet mode (kube/activity.go) learns the native window state here and the
// page's visibility from the UI (SetPageHidden).

// WatchWindow follows the main window: minimised or hidden puts the app in
// the background, shown again brings it back; on macOS hiding the
// application (⌘H) does the same.
func (w *Workspace) WatchWindow(win *application.WebviewWindow) {
	set := func(source string, hidden bool) {
		if w.m != nil {
			go w.m.SetHidden(source, hidden)
		}
	}
	for _, ev := range []events.WindowEventType{events.Common.WindowMinimise, events.Common.WindowHide} {
		win.OnWindowEvent(ev, func(*application.WindowEvent) { set(kube.HiddenMinimised, true) })
	}
	for _, ev := range []events.WindowEventType{events.Common.WindowUnMinimise, events.Common.WindowRestore, events.Common.WindowShow, events.Common.WindowFocus} {
		win.OnWindowEvent(ev, func(*application.WindowEvent) { set(kube.HiddenMinimised, false) })
	}
	app := application.Get()
	app.Event.OnApplicationEvent(events.Mac.ApplicationDidHide, func(*application.ApplicationEvent) { set(kube.HiddenApp, true) })
	app.Event.OnApplicationEvent(events.Mac.ApplicationDidUnhide, func(*application.ApplicationEvent) { set(kube.HiddenApp, false) })
}

// SetPageHidden is the page's visibility (document.visibilityState).
func (w *Workspace) SetPageHidden(hidden bool) { w.m.SetHidden(kube.HiddenPage, hidden) }

// SetPauseInBackground follows Settings › Pause watches in the background.
func (w *Workspace) SetPauseInBackground(on bool) { w.m.SetPauseInBackground(on) }
