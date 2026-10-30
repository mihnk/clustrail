package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/mihnk/clustrail/internal/kube"
)

// UpdateInfo compares this build with the latest GitHub release.
type UpdateInfo struct {
	Current  string `json:"current"`
	Latest   string `json:"latest"`
	URL      string `json:"url"`
	UpToDate bool   `json:"upToDate"`
}

const releasesURL = "https://api.github.com/repos/mihnk/clustrail/releases/latest"

// CheckForUpdates asks GitHub for the latest release. Nothing else is sent.
func (w *Workspace) CheckForUpdates() (UpdateInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, releasesURL, nil)
	if err != nil {
		return UpdateInfo{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return UpdateInfo{}, err
	}
	defer resp.Body.Close()
	info := UpdateInfo{Current: Version}
	if resp.StatusCode == http.StatusNotFound {
		info.UpToDate = true // no release published yet
		return info, nil
	}
	if resp.StatusCode != http.StatusOK {
		return info, fmt.Errorf("GitHub answered %s", resp.Status)
	}
	var rel struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return info, err
	}
	info.Latest, info.URL = strings.TrimPrefix(rel.TagName, "v"), rel.HTMLURL
	info.UpToDate = info.Latest == "" || !newer(info.Latest, strings.TrimPrefix(Version, "v"))
	return info, nil
}

// newer compares dotted versions numerically ("0.10.0" > "0.9.3").
func newer(a, b string) bool {
	pa, pb := strings.Split(strings.SplitN(a, "-", 2)[0], "."), strings.Split(strings.SplitN(b, "-", 2)[0], ".")
	for i := 0; i < max(len(pa), len(pb)); i++ {
		var x, y int
		if i < len(pa) {
			fmt.Sscan(pa[i], &x)
		}
		if i < len(pb) {
			fmt.Sscan(pb[i], &y)
		}
		if x != y {
			return x > y
		}
	}
	return false
}

// SetMetricsInterval applies Settings › Refresh & watch › Metrics refresh.
func (w *Workspace) SetMetricsInterval(seconds int) { kube.SetMetricsInterval(seconds) }
