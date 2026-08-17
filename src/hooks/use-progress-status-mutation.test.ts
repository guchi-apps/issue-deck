import { describe, expect, it } from "vitest";

import { progressChangeErrorMessage } from "@/hooks/use-progress-status-mutation";

describe("progressChangeErrorMessage", () => {
  it("書き込めた場合は何も出さない", () => {
    expect(progressChangeErrorMessage({ ok: true, applied: true, reason: null })).toBeNull();
  });

  it("既に同じStatusだった場合（unchanged）は失敗として出さない", () => {
    expect(progressChangeErrorMessage({ ok: true, applied: false, reason: "unchanged" })).toBeNull();
  });

  it("書けなかった理由はその内容が伝わる文言になる", () => {
    expect(progressChangeErrorMessage({ ok: true, applied: false, reason: "issue_closed" })).toBe(
      "クローズ済みのIssueは「本番反映済」「対応終了」以外の進捗へ変更できません。",
    );
    expect(
      progressChangeErrorMessage({ ok: true, applied: false, reason: "project_disabled" }),
    ).toMatch(/GitHub Projects/);
  });

  it("通信・非2xxの失敗は共通の再試行を促す文言になる", () => {
    expect(progressChangeErrorMessage({ ok: false, message: "unauthorized" })).toBe(
      "進捗を変更できませんでした。時間をおいて試してください。",
    );
  });
});
