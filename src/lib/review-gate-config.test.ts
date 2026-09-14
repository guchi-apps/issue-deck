import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { claudeReviewOfContexts } from "@/lib/github/check-rollup";
import {
  isChangedFromDefault,
  isIssueBranch,
  readReviewCallerConfig,
  reviewOutcomeOf,
  sortByRiskPathsState,
  summarizeReviewOutcomes,
  templateRiskPatterns,
} from "@/lib/review-gate-config";

// 雛形はリポジトリの実物を読む。雛形を改訂したときに判定が黙ってずれないようにする
const TEMPLATE = readFileSync(
  path.join(process.cwd(), ".github/templates/callers/claude-review-develop.yml"),
  "utf8",
);
const ISSUE_DECK_CALLER = readFileSync(
  path.join(process.cwd(), ".github/workflows/claude-review-develop.yml"),
  "utf8",
);
const TEMPLATE_PATTERNS = templateRiskPatterns(TEMPLATE);

function caller(withBlock: string): string {
  return `on:
  pull_request:
    branches: [develop]

jobs:
  review:
    uses: guchi-apps/issue-deck/.github/workflows/reusable-claude-review-develop.yml@workflows/v34
    with:
${withBlock}
    secrets: inherit
`;
}

const TEMPLATE_RISK_PATHS = `      risk-paths: |
        ^deploy(ment)?/|\\.env\\.tpl$ :: 本番環境設定の変更 (deploy/**, deployment/**, **/*.env.tpl)
        ^\\.github/secrets-manifest\\.tsv$ :: シークレット定義の変更 (.github/secrets-manifest.tsv)
        (^|/)requirements[^/]*\\.txt$|(^|/)pyproject\\.toml$|(^|/)Pipfile$ :: 依存関係の変更 (requirements*.txt, pyproject.toml, Pipfile)
        /package\\.json$ :: ルート以外の依存関係の変更 (frontend/package.json など。dependency-checkはルートしか見ない)`;

describe("templateRiskPatterns", () => {
  it("配布雛形のrisk-pathsを行ごとに読む", () => {
    expect(TEMPLATE_PATTERNS).toHaveLength(4);
    expect(TEMPLATE_PATTERNS[0]).toBe(String.raw`^deploy(ment)?/|\.env\.tpl$`);
  });
});

describe("readReviewCallerConfig", () => {
  it("雛形をそのまま配ったcallerは「雛形のまま」で、入力は既定値", () => {
    const config = readReviewCallerConfig(
      caller(`${TEMPLATE_RISK_PATHS}\n      prompts-ref: workflows/v34`),
      TEMPLATE_PATTERNS,
    );
    expect(config?.riskPathsState).toBe("template");
    expect(config?.riskPaths).toHaveLength(4);
    expect(config?.inputs["review-file-threshold"]).toEqual({ value: "10", explicit: false });
    expect(config?.inputs["merge-policy"]).toEqual({ value: "relaxed", explicit: false });
  });

  it("雛形の生成物そのもの（コメント入り）も「雛形のまま」と読める", () => {
    const config = readReviewCallerConfig(
      TEMPLATE.replaceAll("__TAG__", "workflows/v34"),
      TEMPLATE_PATTERNS,
    );
    expect(config?.riskPathsState).toBe("template");
  });

  it("雛形に固有の行を足したcallerは「固有パス」。ブロック内の#行は数えない", () => {
    const config = readReviewCallerConfig(
      caller(`      # 差分があれば毎回レビューする
      review-file-threshold: "1"
${TEMPLATE_RISK_PATHS}
        # ここから固有
        ^src/app/api/ :: APIルートの変更
      prompts-ref: workflows/v34`),
      TEMPLATE_PATTERNS,
    );
    expect(config?.riskPathsState).toBe("custom");
    expect(config?.customRiskPathCount).toBe(1);
    expect(config?.riskPaths.at(-1)).toEqual({
      pattern: "^src/app/api/",
      reason: "APIルートの変更",
      fromTemplate: false,
    });
    expect(config?.inputs["review-file-threshold"]).toEqual({ value: "1", explicit: true });
    expect(isChangedFromDefault("review-file-threshold", config!.inputs["review-file-threshold"])).toBe(
      true,
    );
    // 閾値のコメント行やprompts-refが次のキーとして混ざらない
    expect(config?.inputs["review-line-threshold"].explicit).toBe(false);
  });

  it("固有の行だけで雛形の行が欠けていれば「固有パスのみ」", () => {
    const config = readReviewCallerConfig(
      caller(`      lock-files: "pnpm-lock.yaml"
      risk-paths: |
        ^src/(proxy\\.ts$|lib/supabase/) :: 認証の変更
        ^deploy/|^\\.github/secrets-manifest\\.tsv$ :: 本番環境設定の変更
      prompts-ref: workflows/v34`),
      TEMPLATE_PATTERNS,
    );
    expect(config?.riskPathsState).toBe("replaced");
    expect(config?.customRiskPathCount).toBe(2);
    expect(config?.missingTemplateRiskPathCount).toBe(4);
    expect(config?.inputs["lock-files"]).toEqual({ value: "pnpm-lock.yaml", explicit: true });
  });

  it("risk-pathsを書いていないissue-deck本体は「内蔵パターンのみ」。閾値は明示だが既定と同じ", () => {
    const config = readReviewCallerConfig(ISSUE_DECK_CALLER, TEMPLATE_PATTERNS);
    expect(config?.riskPathsState).toBe("none");
    expect(config?.inputs["review-file-threshold"]).toEqual({ value: "10", explicit: true });
    expect(isChangedFromDefault("review-file-threshold", config!.inputs["review-file-threshold"])).toBe(
      false,
    );
  });

  it("strictなど値の書き方（引用符・行末コメント）を問わず読む", () => {
    const config = readReviewCallerConfig(
      caller(`      merge-policy: strict # カテゴリで止める
      dependency-check: 'any'`),
      TEMPLATE_PATTERNS,
    );
    expect(config?.inputs["merge-policy"]).toEqual({ value: "strict", explicit: true });
    expect(config?.inputs["dependency-check"]).toEqual({ value: "any", explicit: true });
  });

  it("雛形を取得できなければrisk-pathsは比べず「unknown」", () => {
    const config = readReviewCallerConfig(caller(TEMPLATE_RISK_PATHS), null);
    expect(config?.riskPathsState).toBe("unknown");
    expect(config?.riskPaths.every((line) => line.fromTemplate === null)).toBe(true);
  });

  it("再利用ワークフローを呼んでいないファイルはcallerとみなさない", () => {
    expect(readReviewCallerConfig("jobs:\n  ci:\n    runs-on: ubuntu-latest\n", TEMPLATE_PATTERNS)).toBeNull();
  });
});

describe("claudeReviewOfContexts・reviewOutcomeOf", () => {
  const JUDGEMENT = "/guchi-apps/ops-dashboard/actions/workflows/claude-review-develop.yml";
  const run = (
    name: string,
    conclusion: string | null,
    { status = "COMPLETED", workflow = JUDGEMENT } = {},
  ) => ({
    __typename: "CheckRun",
    name,
    status,
    conclusion,
    checkSuite: { workflowRun: { workflow: { resourcePath: workflow } } },
  });
  const outcomeOf = (nodes: ReturnType<typeof run>[]) => {
    const { aiReview, riskCheckFailed } = claudeReviewOfContexts(nodes);
    return reviewOutcomeOf(aiReview.state, riskCheckFailed);
  };

  it("PR一覧と同じ語彙で実行・skip・失敗・実行中を分ける", () => {
    expect(outcomeOf([run("review / claude-review", "SUCCESS")])).toBe("reviewed");
    expect(outcomeOf([run("review / claude-review", "SKIPPED")])).toBe("skipped");
    expect(outcomeOf([run("review / claude-review", "CANCELLED")])).toBe("failed");
    expect(outcomeOf([run("review / claude-review", null, { status: "IN_PROGRESS" })])).toBe("pending");
  });

  it("risk-checkが落ちてskipになったものは「判定エラー」として分ける", () => {
    expect(
      outcomeOf([run("review / risk-check", "FAILURE"), run("review / claude-review", "SKIPPED")]),
    ).toBe("error");
  });

  it("callerのジョブIDを問わず、再実行したら最後のcheck-runを採る", () => {
    expect(
      outcomeOf([run("gate / claude-review", "SKIPPED"), run("gate / claude-review", "SUCCESS")]),
    ).toBe("reviewed");
  });

  it("判定ワークフロー以外の同名ジョブとfallbackは拾わず、無ければ数えない", () => {
    expect(
      outcomeOf([
        run("review / claude-review", "SUCCESS", { workflow: "/o/r/actions/workflows/other.yml" }),
        run("review / claude-review-fallback", "SKIPPED"),
      ]),
    ).toBeNull();
  });
});

describe("isIssueBranch・summarizeReviewOutcomes・sortByRiskPathsState", () => {
  it("issue-<番号>だけを数える", () => {
    expect(isIssueBranch("issue-233")).toBe(true);
    expect(isIssueBranch("release/v2.6.0")).toBe(false);
    expect(isIssueBranch("workflow-tag/v34")).toBe(false);
  });

  it("分母は実行とskipだけ。判定エラーは別に数える", () => {
    const item = (outcome: "reviewed" | "skipped" | "error" | "failed" | "pending") => ({
      number: 1,
      url: "",
      outcome,
    });
    expect(
      summarizeReviewOutcomes([
        item("reviewed"),
        item("skipped"),
        item("skipped"),
        item("error"),
        item("failed"),
        item("pending"),
      ]),
    ).toEqual({ reviewed: 1, skipped: 2, errors: 1, counted: 3 });
  });

  it("雛形のままを先頭に、同じ状態は名前順", () => {
    const repo = (fullName: string, state: string) =>
      ({ fullName, config: { riskPathsState: state } }) as never;
    const sorted = sortByRiskPathsState([
      repo("o/issue-deck", "none"),
      repo("o/stockly", "custom"),
      repo("o/myroom", "template"),
      repo("o/car-care", "template"),
    ]) as { fullName: string }[];
    expect(sorted.map((r) => r.fullName)).toEqual(["o/car-care", "o/myroom", "o/stockly", "o/issue-deck"]);
  });
});
