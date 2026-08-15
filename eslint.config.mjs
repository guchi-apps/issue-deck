import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "deploy/**",
  ]),
  {
    rules: {
      // 分割代入の残余（`...rest`）で特定のキーだけを捨てる書き方を許す。react-markdownが
      // 渡すhastの`node`をDOMへ流さないために使う（#1499）。eslint-config-nextは
      // このルールを重大度だけで指定しており、オプションが既定（ignoreRestSiblings: false）に
      // 戻るため、ここで指定し直す。
      "@typescript-eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true }],
    },
  },
]);

export default eslintConfig;
