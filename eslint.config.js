import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import functional from "eslint-plugin-functional";
import importX from "eslint-plugin-import-x";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "node_modules/**",
      ".wrangler/**",
      "dist/**",
      "public/**",
      "worker-configuration.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.worker,
        ...globals.node,
      },
      parserOptions: {
        // A dedicated lint tsconfig covers src + test + root config files
        // (the build tsconfig is intentionally src-only). This is what
        // lets test/ and *.config.ts be typed-linted at all.
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { functional },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],
      // `() => void promise()` fire-and-forget in event handlers is an
      // intentional, readable idiom here — not a confusing return.
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true },
      ],
      "no-console": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      // Value/DTO types must be at least ReadonlyShallow. Live library
      // handles (a Hono app, a TypeGraph store) are not frozen values.
      "functional/type-declaration-immutability": [
        "error",
        {
          rules: [
            {
              identifiers: ".*",
              immutability: "ReadonlyShallow",
              comparator: "AtLeast",
              fixer: [
                {
                  pattern: "^(Array|Map|Set)<(.+)>$",
                  replace: "Readonly$1<$2>",
                },
                { pattern: "^(.+)$", replace: "Readonly<$1>" },
              ],
            },
          ],
        },
      ],
    },
  },
  // Import hygiene. Scoped to order/cycle/dedup/default — NOT the
  // resolution family (no-unresolved/named/…): tsc already guarantees
  // those better, and enabling them only adds false positives on virtual
  // `cloudflare:*` modules.
  {
    files: ["**/*.{ts,js}"],
    plugins: { "import-x": importX },
    settings: {
      "import-x/resolver": {
        typescript: { project: "./tsconfig.eslint.json" },
        node: true,
      },
    },
    rules: {
      "import-x/order": [
        "error",
        {
          groups: [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index",
          ],
          pathGroups: [{ pattern: "@/**", group: "internal" }],
          pathGroupsExcludedImportTypes: ["builtin"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      "import-x/no-cycle": [
        "error",
        { maxDepth: Infinity, ignoreExternal: true },
      ],
      "import-x/no-duplicates": "error",
      "import-x/first": "error",
      "import-x/newline-after-import": "error",
      "import-x/no-default-export": "error",
    },
  },
  // Default export is the required contract for the Workers entry and
  // tool config files.
  {
    files: ["src/worker.ts", "vitest.config.ts", "eslint.config.js"],
    rules: { "import-x/no-default-export": "off" },
  },
  // Test files: vitest correctness rules, plus relaxations for harness
  // code. Test code legitimately works against loosely-typed seams (DO
  // stubs, `cloudflare:test` env); the type-safety strict family is
  // noise there, so keep logic/correctness rules and drop the
  // type-strictness ones.
  {
    files: ["test/**/*.ts"],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      "vitest/no-focused-tests": "error",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/dot-notation": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "functional/type-declaration-immutability": "off",
    },
  },
  prettier,
);
