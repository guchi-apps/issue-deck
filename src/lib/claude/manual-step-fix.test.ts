import { describe, expect, it } from "vitest";

import {
  buildManualStepFixPrompt,
  pickManualStepFix,
  MANUAL_STEP_FIX_OUTPUT_MAX_LENGTH,
  MANUAL_STEP_FIX_STEPS_MAX_COUNT,
  MANUAL_STEP_FIX_STEP_TEXT_MAX_LENGTH,
  type ManualStepFixCurrent,
  type ManualStepFixInput,
} from "@/lib/claude/manual-step-fix";
import {
  MANUAL_STEP_COMMAND_MAX_LENGTH,
  MANUAL_STEP_INSTRUCTION_MAX_LENGTH,
} from "@/lib/manual-step-command";

/**
 * 想定外だった手作業の診断（#1869・#2299）。
 *
 * ここが出すのは提案までで、適用するのは人。**壊れた直し案を出さないこと**
 * （読めない応答・使えないコマンド・使えない文言は`manual`へ倒す）を中心に確かめる。
 */

const INPUT: ManualStepFixInput = {
  issueTitle: "[手作業] サブPC: pollerを更新して再起動する",
  kind: "step",
  where: { device: "サブPC", directory: "~/apps/issue-deck", branch: "develop" },
  markdown: "pollerを再起動する\n\n```bash\nsystemctl --user restart issue-deck-poller.service\n```",
  command: "systemctl --user restart issue-deck-poller.service",
  exitCode: 5,
  output: "Failed to restart issue-deck-poller.service: Unit issue-deck-poller.service not found.",
  instruction: "pollerを再起動する",
  report: null,
};

/** 代行できない手順（ブラウザでの操作）でのつまずき。#2299で足りた経路 */
const BROWSER_INPUT: ManualStepFixInput = {
  issueTitle: "[手作業] ブラウザ: 1Passwordに接続情報を登録する",
  kind: "step",
  where: { device: "ブラウザ", directory: null, branch: null },
  markdown: "（ブラウザ）1Passwordで「新規アイテム」から aide-bot の項目を作る",
  command: null,
  exitCode: null,
  output: "",
  instruction: "（ブラウザ）1Passwordで「新規アイテム」から aide-bot の項目を作る",
  report: {
    category: "display",
    detail: "1Passwordの画面に「新規アイテム」がありません。右上に「＋」があるだけでした。",
    pasted: "",
  },
};

const CURRENT: ManualStepFixCurrent = {
  command: INPUT.command,
  instruction: INPUT.instruction,
};
const BROWSER_CURRENT: ManualStepFixCurrent = {
  command: null,
  instruction: BROWSER_INPUT.instruction,
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
    expect(buildManualStepFixPrompt({ ...INPUT, kind: "verification" })).toContain("確認コマンド");
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

  // #2299。代行実行が無い手順では、コマンドの直し案を選ばせない
  it("コマンドが無い手順では`command`を選択肢に出さない", () => {
    const prompt = buildManualStepFixPrompt(BROWSER_INPUT);

    expect(prompt).not.toContain("`command`");
    expect(prompt).toContain("`instruction`");
    expect(prompt).toContain("issue-deckからは実行していません");
  });

  it("人が書いたつまずきを載せる（分類・起きたこと）", () => {
    const prompt = buildManualStepFixPrompt(BROWSER_INPUT);

    expect(prompt).toContain("分類: 外部ツールの表示が違う");
    expect(prompt).toContain("右上に「＋」があるだけでした");
  });

  it("貼り付けた内容は渡されたときだけ載せる", () => {
    expect(buildManualStepFixPrompt(BROWSER_INPUT)).not.toContain("貼り付けた出力");
    expect(
      buildManualStepFixPrompt({
        ...BROWSER_INPUT,
        report: { ...BROWSER_INPUT.report!, pasted: "Error: item not found" },
      }),
    ).toContain("Error: item not found");
  });

  // #2310。「確認してください」で終わる助言では、読んだ人が次に何を打てばよいか決まらない
  it("この後にやることを求め、原因が分からないときは調べ直す手順を書かせる", () => {
    const prompt = buildManualStepFixPrompt(BROWSER_INPUT);

    expect(prompt).toContain("# この後にやること（`steps`）");
    expect(prompt).toContain("必ず1件以上");
    expect(prompt).toContain("決まらない書き方をしないでください");
    expect(prompt).toContain("「何を調べれば分かるか」を手順にしてください");
  });

  it("直せる文言が無い（確認節など）ときは`instruction`を選択肢に出さない", () => {
    const prompt = buildManualStepFixPrompt({ ...INPUT, kind: "verification", instruction: "" });

    expect(prompt).not.toContain("`instruction`");
    expect(prompt).toContain("`command`");
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
      CURRENT,
    );

    expect(result).toEqual({
      kind: "command",
      cause: "ユニット名が実際と違います。",
      command: "systemctl --user restart issue-deck-dispatch-poller.service",
      instruction: null,
      advice: null,
      steps: [],
    });
  });

  // #2299
  it("手順の説明文の直し案を取り出す", () => {
    const result = pickManualStepFix(
      JSON.stringify({
        kind: "instruction",
        cause: "1Passwordのアイテム作成の入口が変わっています。",
        instruction: "（ブラウザ）1Passwordの右上「＋」から aide-bot の項目を作る",
      }),
      BROWSER_CURRENT,
    );

    expect(result.kind).toBe("instruction");
    expect(result.instruction).toBe("（ブラウザ）1Passwordの右上「＋」から aide-bot の項目を作る");
    expect(result.command).toBeNull();
  });

  it("コードフェンスで囲まれた応答も読む", () => {
    const result = pickManualStepFix(
      '```json\n{"kind": "retry", "cause": "一時的にロックされていました。"}\n```',
      CURRENT,
    );

    expect(result.kind).toBe("retry");
    expect(result.command).toBeNull();
  });

  it("助言だけの応答（本文を直しても解決しない）", () => {
    const result = pickManualStepFix(
      JSON.stringify({
        kind: "manual",
        cause: "権限が足りません。",
        advice: "sudoで実行してください。",
      }),
      CURRENT,
    );

    expect(result.kind).toBe("manual");
    expect(result.advice).toBe("sudoで実行してください。");
  });

  // 壊れた直し案を出すくらいなら、出さない方がよい
  it("使えない修正案（空・フェンス入り・長すぎ・元と同じ）はmanualへ倒す", () => {
    const proposals = [
      "",
      "```bash\nls\n```",
      "a".repeat(MANUAL_STEP_COMMAND_MAX_LENGTH + 1),
      INPUT.command!,
    ];

    for (const command of proposals) {
      const result = pickManualStepFix(
        JSON.stringify({ kind: "command", cause: "原因", command }),
        CURRENT,
      );
      expect(result.kind).toBe("manual");
      expect(result.command).toBeNull();
    }
  });

  it("実行したコマンドが無いのに`command`を返してきたらmanualへ倒す", () => {
    const result = pickManualStepFix(
      JSON.stringify({ kind: "command", cause: "原因", command: "op item create" }),
      BROWSER_CURRENT,
    );

    expect(result.kind).toBe("manual");
    expect(result.command).toBeNull();
  });

  it("使えない直し案（空・複数行・長すぎ・元と同じ）はmanualへ倒す", () => {
    const proposals = [
      "",
      "1行目\n2行目",
      "あ".repeat(MANUAL_STEP_INSTRUCTION_MAX_LENGTH + 1),
      BROWSER_INPUT.instruction,
    ];

    for (const instruction of proposals) {
      const result = pickManualStepFix(
        JSON.stringify({ kind: "instruction", cause: "原因", instruction }),
        BROWSER_CURRENT,
      );
      expect(result.kind).toBe("manual");
      expect(result.instruction).toBeNull();
    }
  });

  // #2310
  it("この後にやることを取り出す（コマンドが無い手順も残す）", () => {
    const result = pickManualStepFix(
      JSON.stringify({
        kind: "manual",
        cause: "DBのマイグレーションが当たっていません。",
        steps: [
          { text: "（サブPC）マイグレーションを流す", command: "pnpm prisma migrate deploy" },
          { text: "（ブラウザ）画面を開き直してテーブルが出ることを見る", command: null },
        ],
      }),
      CURRENT,
    );

    expect(result.kind).toBe("manual");
    expect(result.steps).toEqual([
      { text: "（サブPC）マイグレーションを流す", command: "pnpm prisma migrate deploy" },
      { text: "（ブラウザ）画面を開き直してテーブルが出ることを見る", command: null },
    ]);
  });

  it("使えない手順は落とし、コマンドだけが使えない場合は説明文を残す", () => {
    const result = pickManualStepFix(
      JSON.stringify({
        kind: "manual",
        cause: "原因",
        steps: [
          "文字列だけの手順",
          { text: "", command: "ls" },
          { text: "1行目\n2行目", command: null },
          { text: "あ".repeat(MANUAL_STEP_FIX_STEP_TEXT_MAX_LENGTH + 1), command: null },
          { text: "（サブPC）ログを見る", command: "```bash\njournalctl\n```" },
        ],
      }),
      CURRENT,
    );

    expect(result.steps).toEqual([{ text: "（サブPC）ログを見る", command: null }]);
  });

  it("手順が多すぎる応答は上限で打ち切る", () => {
    const steps = Array.from({ length: MANUAL_STEP_FIX_STEPS_MAX_COUNT + 3 }, (_, index) => ({
      text: `${index + 1}件目`,
      command: null,
    }));
    const result = pickManualStepFix(JSON.stringify({ kind: "manual", cause: "原因", steps }), CURRENT);

    expect(result.steps).toHaveLength(MANUAL_STEP_FIX_STEPS_MAX_COUNT);
  });

  // 手順書を直せないことと、人が手元で何をすればよいか分からないことは別
  it("使えない直し案でmanualへ倒すときも、この後にやることは残す", () => {
    const result = pickManualStepFix(
      JSON.stringify({
        kind: "command",
        cause: "原因",
        command: INPUT.command,
        steps: [{ text: "（サブPC）ユニット名を調べる", command: "systemctl --user list-units" }],
      }),
      CURRENT,
    );

    expect(result.kind).toBe("manual");
    expect(result.command).toBeNull();
    expect(result.steps).toHaveLength(1);
  });

  it("JSONとして読めない応答・未知の種別はmanualへ倒す", () => {
    expect(pickManualStepFix("直し方が分かりません", CURRENT).kind).toBe("manual");
    expect(pickManualStepFix("直し方が分かりません", CURRENT).steps).toEqual([]);
    expect(pickManualStepFix(JSON.stringify({ kind: "explode", cause: "x" }), CURRENT).kind).toBe(
      "manual",
    );
  });
});
