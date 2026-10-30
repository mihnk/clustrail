// Monaco, bundled locally (the desktop app works offline) and trimmed to the
// editor core, its standard contributions (find, folding, diff) and YAML.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/editor.all";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

/** Registers (or updates) the Clustrail theme from the CSS tokens and returns its name. */
export function applyClustrailTheme(dark: boolean): string {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim().replace("#", "");
  monaco.editor.defineTheme("clustrail", {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "type", foreground: v("--code-key") },
      { token: "string", foreground: v("--code-str") },
      { token: "number", foreground: v("--code-num") },
      { token: "keyword", foreground: v("--code-bool") },
      { token: "comment", foreground: v("--code-comment") },
    ],
    colors: {
      "editor.background": `#${v("--term-bg")}`,
      "editor.foreground": `#${v("--term-fg")}`,
      "editorLineNumber.foreground": `#${v("--fg-muted")}`,
      "editorLineNumber.activeForeground": `#${v("--fg")}`,
      "editor.selectionBackground": `#${v("--accent-soft")}`,
      "editor.lineHighlightBackground": `#${v("--surface-hover")}80`,
      "editorGutter.background": `#${v("--term-bg")}`,
      "diffEditor.insertedLineBackground": `#${v("--diff-add-bg")}`,
      "diffEditor.removedLineBackground": `#${v("--diff-del-bg")}`,
      "diffEditor.insertedTextBackground": `#${v("--diff-add-fg")}33`,
      "diffEditor.removedTextBackground": `#${v("--diff-del-fg")}33`,
      "editorWidget.background": `#${v("--surface-elevated")}`,
      "editorWidget.border": `#${v("--line-strong")}`,
      "input.background": `#${v("--surface-app")}`,
      "focusBorder": `#${v("--accent")}`,
      "scrollbarSlider.background": `#${v("--line-strong")}80`,
    },
  });
  return "clustrail";
}

export { monaco };
