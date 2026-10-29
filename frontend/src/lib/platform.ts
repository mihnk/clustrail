// On macOS the native window uses a hidden-inset title bar, so the traffic
// lights sit inside our toolbar and need reserved space. Windows and Linux
// keep their native frame and controls.
export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

export const modKey = isMac ? "⌘" : "Ctrl+";
