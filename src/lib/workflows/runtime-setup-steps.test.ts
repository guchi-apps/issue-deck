import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 実装ステップの前に走るランタイム準備の条件式を固定する（#931）。
//
// 実際に踏んだ事故: 依存インストールが `24.screenshot-required` 付きのときだけ走る条件に
// なっており、通常の実装では node_modules が無い状態でエージェントが起動していた。
// pnpm のリポジトリでは pnpm 自体がランナーに無いため、corepack・npm・シムの直接実行を
// 10回試してすべて権限拒否され、76ターン・10分を費やしてコード変更ゼロで停止した
// （issue-deck #1115 の run で実測）。
const WORKFLOW = join(process.cwd(), ".github", "workflows", "reusable-issue-dispatch.yml");

// `- name: X` から次の `- name:` までを1ステップとして切り出す
function stepCondition(name: string): string {
  const source = readFileSync(WORKFLOW, "utf8");
  const start = source.indexOf(`      - name: ${name}\n`);
  expect(start, `ステップ「${name}」が見つからない`).toBeGreaterThan(-1);

  const next = source.indexOf("\n      - name: ", start + 1);
  const block = source.slice(start, next === -1 ? undefined : next);

  const match = block.match(/^ {8}if: (.*)$/m);
  expect(match, `ステップ「${name}」に if: が無い`).not.toBeNull();
  return (match as RegExpMatchArray)[1] as string;
}

const IMPLEMENT_MODE =
  "(steps.state.outputs.mode == 'implement' || steps.state.outputs.mode == 'additional')";

describe("ランタイム準備のステップ条件", () => {
  it.each([
    "Setup pnpm（実装ステップ用）",
    "Setup Node.js（依存インストール用）",
    "依存関係をインストールする",
  ])("%s は撮影の有無によらず実行する", (name) => {
    const condition = stepCondition(name);

    expect(condition).toContain(IMPLEMENT_MODE);
    expect(condition).toContain("inputs.runtime-setup != 'minimal'");
    // **ここが本題。** screenshot_required で絞ると通常の実装で依存が入らない
    expect(condition).not.toContain("screenshot_required");
  });

  it.each([
    "DBマイグレーションを適用する",
    "CIバイパス用ログインユーザーをシードする",
    "画面確認用のダミーデータをシードする",
    "Playwrightのブラウザをインストールする",
  ])("%s は撮影時のみ実行する", (name) => {
    const condition = stepCondition(name);

    // 撮影でしか使わないものは引き続き絞る。毎回走らせると無駄な待ち時間になる
    expect(condition).toContain("steps.state.outputs.screenshot_required == 'true'");
  });

  it("minimal のリポジトリでは依存インストールを行わない", () => {
    // 依存ゼロ・ロックファイル無しの構成では npm ci / pnpm install が失敗する
    expect(stepCondition("依存関係をインストールする")).toContain(
      "inputs.runtime-setup != 'minimal'",
    );
  });

  it.each(["Setup Node.js（依存インストール用）", "依存関係をインストールする"])(
    "%s はpackage.json作成前の新規アプリでは実行しない",
    (name) => {
      // 新規アプリの初期化Issueでは、package.json自体をClaudeがこの後に作る。
      // キャッシュ解決やinstallを先に走らせると、実装ステップへ到達できない。
      expect(stepCondition(name)).toContain("hashFiles('package.json') != ''");
    },
  );

  it("package.json作成前でもpnpmコマンドを用意する", () => {
    const source = readFileSync(WORKFLOW, "utf8");
    const start = source.indexOf("      - name: Setup pnpm（実装ステップ用）\n");
    const next = source.indexOf("\n      - name: ", start + 1);
    const block = source.slice(start, next);

    expect(block).toContain("version: 10");
    expect(block).not.toContain("hashFiles('package.json')");
  });
});
