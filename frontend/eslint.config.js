// Static analysis for the frontend (npm run lint). Only rules that find
// real bugs: hooks called conditionally, stale closures in hooks, and
// promises nobody waits for or catches. Formatting is not linted.
//
// A dependency left out on purpose (an effect that runs on one key and reads
// the rest as they are then) uses useEffectEvent, or is suppressed on its line
// with the reason.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "playwright-report/", "test-results/"] },
  {
    files: ["src/**/*.{ts,tsx}", "e2e/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "react-hooks": reactHooks, "@typescript-eslint": tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
);
