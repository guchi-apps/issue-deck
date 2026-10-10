import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prompt = readFileSync(path.join(repoRoot, "scripts/prompts/manual-step-agent.md"), "utf8");

describe("手作業セッションの自律実行プロンプト（#3870）", () => {
  it("本文に無い安全な作業も、目的達成のために自動で進める", () => {
    expect(prompt).toContain("本文にコマンドや詳細な手順が無くても");
    expect(prompt).toContain("本文に無いコマンドであること、本文の手順が曖昧であること、単に終了コードが0以外であることは、確認待ちにする理由ではありません");
    expect(prompt).toContain("本文に有無にかかわらず");
  });

  it("秘密値・本人操作・未確定の不可逆な変更は引き続き質問へ戻す", () => {
    expect(prompt).toContain("ユーザー本人の操作・秘密値・対話認証が必要なとき");
    expect(prompt).toContain("外部状態を大きく変える判断が未確定なとき");
  });

  it("完了は検証結果だけで判定し、確認質問も自己申告も使わない（#4315）", () => {
    expect(prompt).toContain("<!-- issue-deck:manual-step-investigation -->");
    expect(prompt).toContain("<!-- issue-deck:manual-step-verification -->");
    expect(prompt).toContain("すべて終了コード0のときだけ");
    expect(prompt).toContain("1つでも失敗した・権限が足りない・確認自体ができないときはクローズしません");
    expect(prompt).not.toContain("クローズだけは自動で決めません");
    expect(prompt).not.toContain("完了としてクローズする」「画面からクローズする");
  });

  it("VPSでは所有者を確認し、cd && …とユーザー切り替えを1行に含める（#4315）", () => {
    expect(prompt).toContain("対象サービス・ファイルの所有者と実行環境を先に確認します");
    expect(prompt).toContain("`cd … && …`から始めます");
    expect(prompt).toContain("別ユーザーのPM2を誤って起動しない");
  });
});
