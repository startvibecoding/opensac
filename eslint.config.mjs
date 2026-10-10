import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Flat ESLint config for the Node toolchain.
// This config keeps the lint signal focused on real defects and downgrades
// the ported code's deliberate `any` and unused-binding noise to warnings so a
// clean checkout still lints.
export default tseslint.config(
  {
    ignores: [
      "dist/",
      "bin/",
      "node_modules/",
      "coverage/",
      "src/platform/busybox_assets/",
      "src/context/tokenizerdata/",
      "src/expert/builtin/",
      "src/skills/builtin/",
      "src/stats/dashboard.html",
      "skills/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unsafe-function-type": "warn",
      // Ported idioms: a try/catch that rethrows, `const self = this` in the
      // runtime core, an intentionally-yield-less generator stub, and ANSI/regex
      // escapes. These are deliberate in the ported code, not defects.
      "no-useless-catch": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-this-alias": "off",
      "require-yield": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
      "no-unused-private-class-members": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-constant-condition": ["warn", { checkLoops: false }],
    },
  },
);
