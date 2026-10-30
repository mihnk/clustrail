// Clustrail is a local, agentless Kubernetes desktop workspace.
//
// The Go side owns everything that talks to clusters (client-go, watches,
// caches, exec and log streams) and exposes it to the React frontend through
// Wails services. The frontend never contacts a Kubernetes API server.
package main

import (
	"embed"
	"log"

	"github.com/mihnk/clustrail/internal/app"
	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

// App icon (1024px, from build/appicon.svg). Used for the window and dock on
// Linux and Windows; packaged builds also derive platform icons from it.
//
//go:embed build/appicon.png
var appIcon []byte

func main() {
	wails := application.New(application.Options{
		Name:        "Clustrail",
		Description: "Kubernetes desktop workspace",
		Icon:        appIcon,
		// The Workspace service is the only way the UI reaches clusters.
		Services: []application.Service{
			application.NewService(&app.Workspace{}),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	wails.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "Clustrail",
		Width:     1440,
		Height:    900,
		MinWidth:  1280,
		MinHeight: 800,
		// surface-app (dark) so the window does not flash white before the UI paints.
		BackgroundColour: application.NewRGB(13, 16, 19),
		// macOS: native traffic lights inside the app's 40px toolbar, which is
		// marked as a drag region in CSS (--wails-draggable).
		Mac: application.MacWindow{
			TitleBar:                application.MacTitleBarHiddenInset,
			InvisibleTitleBarHeight: 40,
		},
		URL: "/",
	})

	if err := wails.Run(); err != nil {
		log.Fatal(err)
	}
}
