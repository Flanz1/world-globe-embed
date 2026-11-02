import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", ".e2e/", "public/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      "no-console": ["error", { allow: ["warn", "error", "log"] }],
    },
  },
  {
    // The admin page handles a personal access token: never log anything there.
    files: ["src/admin/**"],
    rules: { "no-console": "error" },
  },
);
