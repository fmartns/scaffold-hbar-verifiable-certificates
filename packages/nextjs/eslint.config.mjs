import { FlatCompat } from "@eslint/eslintrc";
import prettierPlugin from "eslint-plugin-prettier";
import { defineConfig, globalIgnores } from "eslint/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
});

export default defineConfig([
  globalIgnores([".next/", "node_modules/", "next-env.d.ts"]),
  {
    plugins: {
      prettier: prettierPlugin,
    },
    extends: compat.extends("next/core-web-vitals", "next/typescript", "prettier"),

    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "off",

      "prettier/prettier": [
        "warn",
        {
          endOfLine: "auto",
        },
      ],
    },
  },
  {
    // Client code runs in the browser: it may import types from the SDK root, but values only from the
    // client-safe subpaths listed in AGENTS.md (docs/dashboard.md, docs/security.md).
    files: ["app/**/_components/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "hooks/**/*.{ts,tsx}"],
    // Tests never reach the browser bundle and import the shared fixtures from @sh/sdk/testing.
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@sh/sdk",
              allowTypeImports: true,
              message:
                "Client code imports values from client-safe subpaths only (@sh/sdk/hedera/wallet, contracts, audit/registry, networks); the SDK root is server-side.",
            },
          ],
          patterns: [
            {
              regex: "^@sh/sdk/(?!hedera/(wallet|contracts|audit/registry|networks)$)",
              allowTypeImports: true,
              message:
                "Client code imports values from client-safe subpaths only (@sh/sdk/hedera/wallet, contracts, audit/registry, networks); the SDK root is server-side.",
            },
          ],
        },
      ],
    },
  },
]);
