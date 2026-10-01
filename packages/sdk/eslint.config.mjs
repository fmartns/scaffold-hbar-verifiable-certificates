import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import prettierPlugin from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";

export default defineConfig([
  globalIgnores(["**/node_modules/", "**/generated/**"]),
  {
    files: ["**/*.ts"],
    plugins: {
      "@typescript-eslint": tsPlugin,
      prettier: prettierPlugin,
    },
    languageOptions: {
      globals: { ...globals.node },
      parser: tsParser,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...prettierConfig.rules,
      "@typescript-eslint/no-unused-vars": "error",
      "prettier/prettier": ["warn", { endOfLine: "auto" }],
    },
  },
  {
    files: ["**/*.ts"],
    // `cli/demo-event-attendance.ts` (#42) is the one deliberate exception: a dev/demo-only script, isolated from
    // the core, whose whole point is to run the credential cycle offline against the shared fake Hedera (never
    // against a real network). It is not "runtime" in the sense this rule protects (nothing production imports it).
    ignores: ["**/*.test.ts", "**/test-fixtures.ts", "testing/**", "cli/demo-event-attendance.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["**/testing", "**/testing/*"], message: "Test fixtures are for tests only." }] },
      ],
    },
  },
]);
