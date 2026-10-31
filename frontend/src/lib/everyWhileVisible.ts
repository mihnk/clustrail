/**
 * Calls fn every ms while the window is visible. A hidden window stops the
 * timer; when it becomes visible again fn runs once and the timer restarts.
 * Returns the cleanup. For data that must stay fresh while it is on screen,
 * and costs nothing while it is not.
 */
export function everyWhileVisible(fn: () => void, ms: number): () => void {
  let timer: number | undefined;
  const start = () => {
    if (timer === undefined && document.visibilityState === "visible") timer = window.setInterval(fn, ms);
  };
  const stop = () => {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      fn();
      start();
    } else stop();
  };
  start();
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    stop();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
