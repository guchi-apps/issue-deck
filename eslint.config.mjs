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

      // 画面に出す時刻は日本時間へ固定する（#1977）。`toLocaleDateString`などは
      // 実行環境のタイムゾーンで整形するため、UTCで動く本番VPS・CIとブラウザとで
      // 9時間ずれた時刻が出る。整形は`lib/format-date-time.ts`だけが持つ。
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name=/^toLocale(Date|Time)String$/]",
          message:
            "実行環境のタイムゾーンで整形されます。@/lib/format-date-time のフォーマッタを使ってください（#1977）。",
        },
        {
          selector:
            "CallExpression[callee.object.callee.name='Date'][callee.property.name='toLocaleString']",
          message:
            "実行環境のタイムゾーンで整形されます。@/lib/format-date-time のフォーマッタを使ってください（#1977）。",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^get(FullYear|Month|Date|Day|Hours|Minutes|Seconds)$/]",
          message:
            "ローカルタイムで読むと日付の境界がずれます。@/lib/format-date-time の toJstParts を使ってください（#1977）。",
        },
      ],
    },
  },
  {
    // 唯一の例外。ここが日本時間への換算そのものを持つ
    files: ["src/lib/format-date-time.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
]);

export default eslintConfig;
