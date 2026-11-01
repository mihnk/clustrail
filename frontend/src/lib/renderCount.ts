// Render counting for tests (e2e/render-isolation.spec.ts): a test sets
// window.__renders before the app loads, and instrumented components count
// their renders there. Without it this is one property check per render.
export function countRender(name: string): void {
  const r = (globalThis as { __renders?: Record<string, number> }).__renders;
  if (r) r[name] = (r[name] ?? 0) + 1;
}
