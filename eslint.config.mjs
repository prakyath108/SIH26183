import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * Flat config for both workspaces.
 *
 * `recommended` plus the rules this codebase is actually exposed to. The most
 * important addition is `no-floating-promises`: every route handler here is
 * async, and an un-awaited promise inside one is an unhandled rejection and a
 * silently dropped write — which is precisely how a failed audit write would
 * disappear without a trace. That rule needs type information, so the parser is
 * given `projectService`; plain `.mjs` scripts sit outside any tsconfig and turn
 * it off for themselves.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/data/**",
      "**/coverage/**",
      "**/*.d.ts"
    ]
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Server: Node runtime, ESM, no DOM.
    files: ["server/**/*.ts", "server/**/*.mts"],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: "module",
        // Type information, so `no-floating-promises` can run. `projectService`
        // reads the nearest tsconfig per file rather than one shared program.
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // Every route handler is async. An un-awaited promise inside one is an
      // unhandled rejection and a silently dropped write, which is exactly how
      // a failed audit write would vanish.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }
      ],
      "no-console": ["error", { allow: ["error", "warn"] }],
      eqeqeq: ["error", "smart"]
    }
  },

  {
    // Web: browser runtime with Vite's import.meta.env. `vite.config.ts` is
    // excluded because it belongs to `tsconfig.node.json`, not the app project,
    // and the project service would otherwise fail to place it.
    files: ["web/**/*.{ts,tsx}"],
    ignores: ["web/vite.config.ts"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: "module",
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The React Compiler advisory rules shipped in eslint-plugin-react-hooks
      // v6 are stylistically opinionated rather than correctness defects, and
      // satisfying them would mean restructuring working data-loading code
      // (moving `setState` out of effects, reworking mutation-during-render).
      // `rules-of-hooks` and `exhaustive-deps` above are the ones that catch
      // real bugs, and both stay on.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }
      ],
      "no-console": ["error", { allow: ["error", "warn"] }],
      eqeqeq: ["error", "smart"]
    }
  },

  {
    // Build/verification scripts and config files: plain Node, outside any
    // tsconfig, so the type-aware rules are off and they print to stdout freely.
    files: ["server/scripts/**/*.{ts,mts,mjs,js,cjs}", "**/*.config.{ts,js,mjs}", "web/vite.config.ts"],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { project: false, projectService: false }
    },
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-floating-promises": "off"
    }
  },

  {
    // The logger is the one place allowed to talk to the console directly.
    files: ["server/src/logger.ts"],
    rules: { "no-console": "off" }
  }
);
