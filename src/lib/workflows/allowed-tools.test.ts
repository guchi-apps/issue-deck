import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 実装・自動修正・コンフリクト解消の3つの再利用可能ワークフローは、Claude Codeに
// 渡す許可ツールを同一に保つ必要がある（#1147）。ここが食い違うと「CIは自動修正
// できるのに実装はできない」といった不揃いな挙動になる。
//
// 実際に踏んだ事故: reusable-issue-dispatch だけが Bash(pnpm:*) 固定のまま残り、
// #1047 で導入した npm のリポジトリ6件で、実装ステップのテスト・Lint・型チェック・
// ビルドが全て権限拒否される状態になっていた。issue-deck 自身は pnpm のため
// セルフホスティングでは表面化しなかった。
const WORKFLOWS = [
  "reusable-issue-dispatch.yml",
  "reusable-claude-ci-fix.yml",
  "reusable-claude-conflict-resolve.yml",
] as const;

function readWorkflow(name: string): string {
  return readFileSync(join(process.cwd(), ".github", "workflows", name), "utf8");
}

// 実装用の許可リストだけを取り出す。同じファイル内には計画提示・質問応答用の
// 読み取り専用の許可リストもあるため、Edit,Write で始まるものに限定する。
function extractImplementAllowedTools(source: string): string {
  const matches = source.match(/--allowedTools "Edit,Write,[^"]*"/g) ?? [];
  expect(matches).toHaveLength(1);
  return matches[0] as string;
}

describe("再利用可能ワークフローの許可ツール", () => {
  it("3つのワークフローで完全に一致している", () => {
    const [dispatch, ciFix, conflict] = WORKFLOWS.map((name) =>
      extractImplementAllowedTools(readWorkflow(name)),
    );

    expect(ciFix).toBe(dispatch);
    expect(conflict).toBe(dispatch);
  });

  it("package-manager で npm と pnpm を出し分けている", () => {
    const allowedTools = extractImplementAllowedTools(readWorkflow(WORKFLOWS[0]));

    // pnpm を直接ハードコードしていないこと。inputs の条件式の中に現れるのは正しい。
    expect(allowedTools).toContain(
      "${{ inputs.package-manager == 'pnpm' && 'Bash(pnpm:*),Bash(npx:*)' || 'Bash(npm:*),Bash(node:*)' }}",
    );
    expect(allowedTools).not.toMatch(/,Bash\(pnpm:\*\),Bash\(npx:\*\),/);
  });

  it("Python の検証コマンドを許可している", () => {
    // myroom（#1056）が pytest でバックエンドを検証するため。Python を使わない
    // リポジトリでは単に使われないだけなので、呼び出し元ごとの出し分けはしない。
    const allowedTools = extractImplementAllowedTools(readWorkflow(WORKFLOWS[0]));

    for (const tool of ["Bash(python:*)", "Bash(python3:*)", "Bash(pip:*)", "Bash(pytest:*)"]) {
      expect(allowedTools).toContain(tool);
    }
  });

  it("状態確認の読み取り専用コマンドを許可している", () => {
    // 実測（#931のベースライン）で `ls node_modules/.bin/playwright`・
    // `cat .claude/settings.json` が拒否されていた。どちらも「今どうなっているか」を
    // 見るだけの操作で、拒否されるとエージェントが回避策を積み重ねて往復が増える。
    const allowedTools = extractImplementAllowedTools(readWorkflow(WORKFLOWS[0]));

    for (const tool of ["Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)"]) {
      expect(allowedTools).toContain(tool);
    }
  });

  it("書き込み・削除系のコマンドは許可しない", () => {
    // 一時ファイルは /tmp 直下へ直接書けばディレクトリ作成が要らず、ランナーは実行ごとに
    // 破棄されるため掃除も要らない。プロンプト側でそう案内して、そもそも使わせない（#931）。
    const allowedTools = extractImplementAllowedTools(readWorkflow(WORKFLOWS[0]));

    for (const tool of ["Bash(mkdir:*)", "Bash(rm:*)", "Bash(mv:*)", "Bash(sed:*)"]) {
      expect(allowedTools).not.toContain(tool);
    }
  });

  it("パッケージマネージャの用意を迂回する手段は許可しない", () => {
    // corepack は依存インストールをワークフロー側で常に行うようにしたため不要（#931）。
    // 許可すると「環境構築をやり直さない」という前提が崩れる。
    const allowedTools = extractImplementAllowedTools(readWorkflow(WORKFLOWS[0]));

    expect(allowedTools).not.toContain("Bash(corepack:*)");
  });

  it("編集とgit操作を許可している（デグレ検知）", () => {
    const allowedTools = extractImplementAllowedTools(readWorkflow(WORKFLOWS[0]));

    for (const tool of ["Edit", "Write", "Bash(git:*)", "Bash(gh:*)"]) {
      expect(allowedTools).toContain(tool);
    }
  });
});
