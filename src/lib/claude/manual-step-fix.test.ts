import { describe, expect, it } from "vitest";

import {
  buildManualStepFixPrompt,
  pickManualStepFix,
  MANUAL_STEP_FIX_OUTPUT_MAX_LENGTH,
  type ManualStepFixInput,
} from "@/lib/claude/manual-step-fix";
import { MANUAL_STEP_COMMAND_MAX_LENGTH } from "@/lib/manual-step-command";

/**
 * 失敗した手作業の診断（#1869）。
 *
 * ここが出すのは提案までで、適用するのは人。**壊れた修正案を出さないこと**
 * （読めない応答・使えないコマンドは`manual`へ倒す）を中心に確かめる。
 */

const INPUT: ManualStepFixInput = {
  issueTitle: "[手作業] サブPC: pollerを更新して再起動する",
  kind: "step",
  where: { device: "サブPC", directory: "~/apps/issue-deck", branch: "develop" },
  markdown: "pollerを再起動する\n\n```bash\nsystemctl --user restart issue-deck-poller.service\n```",
  command: "systemctl --user restart issue-deck-poller.service",
  exitCode: 5,
  output: "Failed to restart issue-deck-poller.service: Unit issue-deck-poller.service not found.",
};

describe("buildManualStepFixPrompt", () => {
  it("実行したコマンド・終了コード・出力・実行する場所を載せる", () => {
    const prompt = buildManualStepFixPrompt(INPUT);

    expect(prompt).toContain("systemctl --user restart issue-deck-poller.service");
    expect(prompt).toContain("終了コード: 5");
    expect(prompt).toContain("Unit issue-deck-poller.service not found.");
    expect(prompt).toContain("実行するデバイス: サブPC");
    expect(prompt).toContain("カレントディレクトリ: ~/apps/issue-deck");
  });

  it("手順と完了の確認を書き分ける（確認は環境を変えない）", () => {
    expect(buildManualStepFixPrompt(INPUT)).toContain("実行すると環境が変わります");
    expect(buildManualStepFixPrompt({ ...INPUT, kind: "verification" })).toContain(
      "確認コマンド",
    );
  });

  it("長い出力は末尾を残して切る（エラーは最後に出る）", () => {
    const output = `${"x".repeat(MANUAL_STEP_FIX_OUTPUT_MAX_LENGTH * 2)}\nlast error line`;
    const prompt = buildManualStepFixPrompt({ ...INPUT, output });

    expect(prompt).toContain("last error line");
    expect(prompt).toContain("(先頭を省略)");
    expect(prompt.length).toBeLessThan(MANUAL_STEP_FIX_OUTPUT_MAX_LENGTH * 2);
  });

  it("実行する場所が書かれていなくても組み立てられる", () => {
    const prompt = buildManualStepFixPrompt({
      ...INPUT,
      where: { device: null, directory: null, branch: null },
    });

    expect(prompt).toContain("実行したコマンド");
  });
});

describe("pickManualStepFix", () => {
  it("修正案を取り出す", () => {
    const result = pickManualStepFix(
      JSON.stringify({
        kind: "command",
        cause: "ユニット名が実際と違います。",
        command: "systemctl --user restart issue-deck-dispatch-poller.service",
        advice: null,
      }),
      INPUT.command,
    );

    expect(result).toEqual({
      kind: "command",
      cause: "ユニット名が実際と違います。",
      command: "systemctl --user restart issue-deck-dispatch-poller.service",
      advice: null,
    });
  });

  it("コードフェンスで囲まれた応答も読む", () => {
    const result = pickManualStepFix(
      '```json\n{"kind": "retry", "cause": "一時的にロックされていました。"}\n```',
      INPUT.command,
    );

    expect(result.kind).toBe("retry");
    expect(result.command).toBeNull();
  });

  it("助言だけの応答（コマンドでは直せない）", () => {
    const result = pickManualStepFix(
      JSON.stringify({ kind: "manual", cause: "権限が足りません。", advice: "sudoで実行してください。" }),
      INPUT.command,
    );

    expect(result.kind).toBe("manual");
    expect(result.advice).toBe("sudoで実行してください。");
  });

  // 壊れた修正案を出すくらいなら、出さない方がよい
  it("使えない修正案（空・フェンス入り・長すぎ・元と同じ）はmanualへ倒す", () => {
    const proposals = [
      "",
      "```bash\nls\n```",
      "a".repeat(MANUAL_STEP_COMMAND_MAX_LENGTH + 1),
      INPUT.command,
    ];

    for (const command of proposals) {
      const result = pickManualStepFix(
        JSON.stringify({ kind: "command", cause: "原因", command }),
        INPUT.command,
      );
      expect(result.kind).toBe("manual");
      expect(result.command).toBeNull();
    }
  });

  it("JSONとして読めない応答・未知の種別はmanualへ倒す", () => {
    expect(pickManualStepFix("直し方が分かりません", INPUT.command).kind).toBe("manual");
    expect(
      pickManualStepFix(JSON.stringify({ kind: "explode", cause: "x" }), INPUT.command).kind,
    ).toBe("manual");
  });
});
