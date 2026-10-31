import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { detectBackend } from "./backend/client";
import { installWakeCounters } from "./features/bench/monitor";
import { setMockMode } from "./data/mock";
import { loadLanguage } from "./i18n";
import { ViewErrorBoundary, logClientError } from "./components/ViewErrorBoundary";

// Errors outside React's render (event handlers, timers, promises) are logged too.
window.addEventListener("error", (e) => logClientError(`uncaught: ${e.message}`, e.error instanceof Error ? (e.error.stack ?? "") : ""));
window.addEventListener("unhandledrejection", (e) => {
  const r: unknown = e.reason;
  logClientError(`unhandled rejection: ${r instanceof Error ? r.message : String(r)}`, r instanceof Error ? (r.stack ?? "") : "");
});

// A benchmark (the app opens /?bench=1) counts the page's timer and frame
// callbacks from the start.
if (new URLSearchParams(location.search).has("bench")) installWakeCounters();

// Decide once, before the first render, whether real clusters or mock data
// back the UI, and load the language's strings; the app's modules load after
// that, so their module-level labels are translated.
void Promise.all([detectBackend(), loadLanguage()]).then(async ([desktop]) => {
  setMockMode(!desktop);
  const { App } = await import("./app/App");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ViewErrorBoundary label="app" whole>
        <App />
      </ViewErrorBoundary>
    </StrictMode>,
  );
});
