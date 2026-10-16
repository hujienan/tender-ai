import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    files: ["scripts/**/*.ts", "tests/**/*.ts", "eslint.config.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    ignores: [
      "node_modules/**",
      ".pnpm-store/**",
      "dist/**",
      "coverage/**",
      "build/**",
      ".next/**",
      ".turbo/**",
      "tmp/**",
    ],
  },
]);
