import { describe, expect, it } from "vitest";

import {
  classifyInstructionSkip,
  describeInstructionJobFailure,
  INPUT_STASH_RETENTION_DAYS,
  stashExpiry,
} from "./input-stash";

describe("classifyInstructionSkip", () => {
  it("未送信入力だけが退避を提案できる", () => {
    const notice = classifyInstructionSkip("入力欄に未送信の文字が残っているため送りませんでした");
    expect(notice.kind).toBe("unsent_input");
    expect(notice.canStash).toBe(true);
  });

  it.each([
    ["セッションが作業中のため送りませんでした（最後のイベント: working）", "busy"],
    ["セッションが処理中のため送りませんでした", "busy"],
    ["承認プロンプトまたは選択フォームの表示中のため送りませんでした", "approval"],
    ["セッションの状態が記録されていないため送りませんでした", "unknown_state"],
    ["入力欄が見つからなかったため送りませんでした", "unknown_state"],
    ["入力が複数行または折り返しを含み、完全に取得できないため退避できません", "stash_incomplete"],
    ["退避を保存できません（応答 500）。入力欄は消していません", "stash_failed"],
  ])("%s は退避を提案しない", (message, kind) => {
    const notice = classifyInstructionSkip(message);
    expect(notice.kind).toBe(kind);
    expect(notice.canStash).toBe(false);
  });

  it("理由が無いときも落ちない", () => {
    expect(classifyInstructionSkip(null).canStash).toBe(false);
  });
});

describe("describeInstructionJobFailure", () => {
  it("SKIPPEDだけで終えず具体的な理由を載せる", () => {
    const text = describeInstructionJobFailure("SKIPPED", "入力欄に未送信の文字が残っているため送りませんでした");
    expect(text).toContain("未送信の文字が残");
    expect(text).not.toBe("SKIPPED");
  });

  it("退避の途中で止まった理由はそのまま見せる", () => {
    const text = describeInstructionJobFailure("SKIPPED", "退避の直前に入力欄の内容が変わったため、何も変更せず中止しました。再確認してください");
    expect(text).toContain("何も変更せず中止");
  });

  it("失敗・期限切れ・取り消しも区別する", () => {
    expect(describeInstructionJobFailure("FAILED", "通信エラー")).toContain("送れませんでした");
    expect(describeInstructionJobFailure("TIMEOUT", null)).toContain("期限");
    expect(describeInstructionJobFailure("CANCELED", null)).toContain("取り消");
  });

  it("退避後の分類が再試行の分岐へ戻る（失敗理由から未送信入力と判定できる）", () => {
    const reason = describeInstructionJobFailure("SKIPPED", "入力欄に未送信の文字が残っているため送りませんでした");
    expect(classifyInstructionSkip(reason).canStash).toBe(true);
  });
});

describe("stashExpiry", () => {
  it("保持日数ぶん先になる", () => {
    const now = new Date("2026-10-11T00:00:00Z");
    expect(stashExpiry(now).getTime() - now.getTime()).toBe(INPUT_STASH_RETENTION_DAYS * 86_400_000);
  });
});
