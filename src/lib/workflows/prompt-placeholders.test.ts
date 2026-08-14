import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 無人実行プロンプトは他リポジトリからも参照される（prompts-ref）。issue-deck自身を
// 前提にした記述が残っていると、そのまま他リポジトリのエージェントへ渡る（#1158）。
//
// 実際に踏んだ事故: guchi-apps/car-care の実装ステップに
// 「あなたはissue-deckリポジトリのIssueごとの実装エージェントです」が渡っていた。
const PROMPTS_DIR = join(process.cwd(), ".github", "prompts");
const WORKFLOWS_DIR = join(process.cwd(), ".github", "workflows");

// どのプロンプトがどのワークフローから使われるか。**変数リストがワークフローごとに違う**ため、
// プロンプト単位で対応付けないと検証できない（ci-fixは${VERIFY_COMMANDS}を使うが、
// dispatchは使わない）。
const OWNERS: Record<string, string> = {
  "implement.md": "reusable-issue-dispatch.yml",
  "plan.md": "reusable-issue-dispatch.yml",
  "split.md": "reusable-issue-dispatch.yml",
  "question.md": "reusable-issue-dispatch.yml",
  "ci-fix.md": "reusable-claude-ci-fix.yml",
  "conflict-resolve.md": "reusable-claude-conflict-resolve.yml",
  "pr-repair.md": "reusable-claude-pr-repair.yml",
  "review-develop.md": "reusable-claude-review-develop.yml",
};

// 「issue-deck」を残してよい文脈。issue-deck の画面・API・マーカー名を指すものは正しい。
const INTENTIONAL = [
  /<!-- issue-deck-[a-z-]+/, // コメントマーカーそのもの
  /`issue-deck-[a-z-]+`/, // 本文中でマーカー名に言及している箇所
  /issue-deck画面/,
  /issue-deck独自の画像アップロードAPI/,
  /guchi-apps\/issue-deck/,
];

function readPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, name), "utf8");
}

// ワークフローが envsubst へ渡している変数名を取り出す
function substitutedBy(workflow: string): string[] {
  const source = readFileSync(join(WORKFLOWS_DIR, workflow), "utf8");
  const calls = [...new Set(source.match(/envsubst '[^']*'/g) ?? [])];
  expect(calls, `${workflow} の envsubst 呼び出し`).toHaveLength(1);
  return [...((calls[0] as string).matchAll(/\$\{([A-Z_]+)\}/g) as Iterable<RegExpMatchArray>)].map(
    (m) => m[1] as string,
  );
}

// プロンプト本文で使われているプレースホルダ
function placeholdersIn(body: string): string[] {
  return [
    ...new Set(
      [...(body.matchAll(/\$\{([A-Z_]+)\}/g) as Iterable<RegExpMatchArray>)].map(
        (m) => m[1] as string,
      ),
    ),
  ];
}

describe("無人実行プロンプト", () => {
  it("エージェントが呼び出し元リポジトリを名乗る", () => {
    for (const name of Object.keys(OWNERS)) {
      const firstLine = readPrompt(name).split("\n")[0] ?? "";
      // 1行目が名乗りのプロンプトだけを対象にする
      if (!firstLine.startsWith("あなたは")) continue;

      expect(firstLine, `${name} の1行目`).not.toContain("issue-deckリポジトリ");
      expect(firstLine, `${name} の1行目`).toContain("${REPOSITORY}");
    }
  });

  it("呼び出し元で誤りになる issue-deck の記述が無い", () => {
    for (const name of Object.keys(OWNERS)) {
      readPrompt(name)
        .split("\n")
        .forEach((line, index) => {
          if (!line.includes("issue-deck")) return;
          if (INTENTIONAL.some((pattern) => pattern.test(line))) return;

          expect.fail(`${name}:${index + 1} に意図しない issue-deck の記述がある\n  ${line.trim()}`);
        });
    }
  });

  it("パッケージマネージャを直接書かず、プレースホルダを使う", () => {
    for (const name of Object.keys(OWNERS)) {
      // 直書きすると許可ツールの出し分け（#1147）と食い違い、権限拒否になる
      expect(readPrompt(name), name).not.toMatch(/`(pnpm|npm) run /);
    }
  });

  it("プロンプトが使う変数を、所属ワークフローが全て渡している", () => {
    for (const [name, workflow] of Object.entries(OWNERS)) {
      const provided = substitutedBy(workflow);

      for (const placeholder of placeholdersIn(readPrompt(name))) {
        expect(provided, `${name} が使う \${${placeholder}} は ${workflow} が渡していない`).toContain(
          placeholder,
        );
      }
    }
  });

  it("envsubst を実際に走らせると未展開のプレースホルダが残らない", () => {
    const values: Record<string, string> = {
      ISSUE_NUMBER: "36",
      BRANCH: "issue-36",
      PR_NUMBER: "37",
      PR_URL: "https://example.test/pr/37",
      MODE: "implement",
      REPOSITORY: "guchi-apps/car-care",
      RUN_URL: "https://example.test/run/1",
      PACKAGE_MANAGER: "npm",
      VERIFY_COMMANDS: "npm run lint",
      BASE_REF: "main",
      HEAD_REF: "develop",
      WORK_BRANCH: "pr-repair/37-1",
      PUSH_MODE: "pull-request",
    };

    for (const [name, workflow] of Object.entries(OWNERS)) {
      const vars = substitutedBy(workflow);
      const expanded = execFileSync("envsubst", [vars.map((key) => `$\{${key}}`).join(" ")], {
        input: readPrompt(name),
        // envsubstへ渡す変数だけの環境にする。型定義がNODE_ENVを要求するため補う
        env: {
          NODE_ENV: "test",
          ...Object.fromEntries(vars.map((key) => [key, values[key] as string])),
        },
        encoding: "utf8",
      });

      expect(expanded, name).not.toMatch(/\$\{[A-Z_]+\}/);
    }
  });

  it("展開後の実装プロンプトが呼び出し元の値になっている", () => {
    const vars = substitutedBy("reusable-issue-dispatch.yml");
    const expanded = execFileSync("envsubst", [vars.map((key) => `$\{${key}}`).join(" ")], {
      input: readPrompt("implement.md"),
      env: {
        NODE_ENV: "test",
        ISSUE_NUMBER: "36",
        BRANCH: "issue-36",
        PR_URL: "",
        MODE: "implement",
        REPOSITORY: "guchi-apps/car-care",
        RUN_URL: "",
        PACKAGE_MANAGER: "npm",
      },
      encoding: "utf8",
    });

    expect(expanded.split("\n")[0]).toContain("guchi-apps/car-careリポジトリ");
    expect(expanded).toContain("npm run capture:issue-screenshots");
    expect(expanded).not.toContain("pnpm run capture:issue-screenshots");
  });
});
