// Static analysis for the frontend (npm run lint). Only rules that find
// real bugs: hooks called conditionally, stale closures in hooks, and
// promises nobody waits for or catches. Formatting is not linted.
//
// exhaustive-deps is a warning for now: the code had 81 findings when it was
// turned on, each to be checked by hand (adding a dependency blindly can
// refetch in a loop). CI allows no more than that number (package.json,
// lint:ci); lower it as they are fixed, and make it an error at 0.
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
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
);
