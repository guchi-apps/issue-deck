import { describe, expect, it } from "vitest";

import { decideRcPublish, describeRcPrimaryAction, isPreviousVerificationResult } from "@/lib/release-rc-action";

describe("decideRcPublish（#4635）", () => {
  const base = { phase: "awaiting_approval" as const, draft: false, headMatchesFinalization: true };

  it("公開準備が済み、ドラフトでなく、最終headと一致するときだけ通す", () => {
    expect(decideRcPublish(base)).toEqual({ ok: true });
  });
  it("記録が引けなければ推測で通さない", () => {
    expect(decideRcPublish({ ...base, phase: null })).toMatchObject({ ok: false, error: "rc_record_missing", next: "recheck" });
  });
  it("公開準備前（review）は公開準備へ案内し、405を待たずに止める", () => {
    expect(decideRcPublish({ ...base, phase: "review", draft: true })).toMatchObject({ ok: false, error: "rc_not_prepared", next: "verify" });
  });
  it("公開準備中は待機へ案内する", () => {
    expect(decideRcPublish({ ...base, phase: "preparing" })).toMatchObject({ ok: false, error: "rc_preparing", next: "wait" });
  });
  it("承認待ちでもドラフトのままなら通さない（ドラフト解除だけで公開準備を飛ばさない）", () => {
    expect(decideRcPublish({ ...base, draft: true })).toMatchObject({ ok: false, error: "rc_draft" });
  });
  it("ドラフト状態が未取得なら通さない", () => {
    expect(decideRcPublish({ ...base, draft: undefined })).toMatchObject({ ok: false, error: "rc_pull_request_unobserved" });
  });
  it("公開準備後に候補が動いていたら通さない", () => {
    expect(decideRcPublish({ ...base, headMatchesFinalization: false })).toMatchObject({ ok: false, error: "rc_head_mismatch" });
  });
  it("公開済み・取り消し済みは進める操作が無い", () => {
    expect(decideRcPublish({ ...base, phase: "completed" })).toMatchObject({ ok: false, error: "rc_already_published", next: "none" });
    expect(decideRcPublish({ ...base, phase: "cancelled" })).toMatchObject({ ok: false, error: "rc_cancelled", next: "none" });
  });
});

describe("describeRcPrimaryAction（#4635）", () => {
  it("受付済み・検証中・公開準備中は待機", () => {
    for (const status of ["creating", "verifying", "fixing", "preparing"] as const) {
      expect(describeRcPrimaryAction({ status, publishable: false }).kind).toBe("wait");
    }
  });
  it("全体レビューの実行失敗は再実行へ案内し、待機にしない", () => {
    expect(describeRcPrimaryAction({ status: "needs_fix", reviewRunFailed: true, publishable: false }).kind).toBe("rerun_review");
    expect(describeRcPrimaryAction({ status: "awaiting_verification", reviewRunFailed: true, publishable: false }).kind).toBe("rerun_review");
  });
  it("コード要修正は修正へ、合格後は公開準備へ", () => {
    expect(describeRcPrimaryAction({ status: "needs_fix", publishable: false }).kind).toBe("fix");
    expect(describeRcPrimaryAction({ status: "ready_to_prepare", publishable: false })).toEqual({ kind: "prepare", label: "本番公開へ進む（公開承認）" });
  });
  it("本番公開は承認待ちで公開可能なときだけ", () => {
    expect(describeRcPrimaryAction({ status: "awaiting_approval", publishable: true }).kind).toBe("publish");
    expect(describeRcPrimaryAction({ status: "awaiting_approval", publishable: false }).kind).toBe("wait");
    expect(describeRcPrimaryAction({ status: "ready_to_prepare", publishable: true }).kind).not.toBe("publish");
  });
});

describe("isPreviousVerificationResult（#4635）", () => {
  const series = { status: "reverifying", releasePrNumber: 7, originHeadSha: "old" };
  it("対象が修正前のheadなら履歴", () => {
    expect(isPreviousVerificationResult({ series, pullRequestNumber: 7, targetHeadSha: "old" })).toBe(true);
  });
  it("最新のheadの結果は現在の結果（同じPRで早送りされていても隠さない）", () => {
    expect(isPreviousVerificationResult({ series, pullRequestNumber: 7, targetHeadSha: "new" })).toBe(false);
  });
  it("対象が未取得の間は現在の結果として見せない", () => {
    expect(isPreviousVerificationResult({ series, pullRequestNumber: 7, targetHeadSha: null })).toBe(true);
  });
  it("系列が無い・別PR・進行外なら履歴にしない", () => {
    expect(isPreviousVerificationResult({ series: null, pullRequestNumber: 7, targetHeadSha: "old" })).toBe(false);
    expect(isPreviousVerificationResult({ series: { ...series, releasePrNumber: 8 }, pullRequestNumber: 7, targetHeadSha: "old" })).toBe(false);
    expect(isPreviousVerificationResult({ series: { ...series, status: "stopped" }, pullRequestNumber: 7, targetHeadSha: "old" })).toBe(false);
  });
});

describe("describeRcPrimaryAction — 稼働確認の停止（#4712）", () => {
  it("停止は待機（自動で進む）にせず、確かめ直す操作を出す", () => {
    expect(describeRcPrimaryAction({ status: "production_stopped", publishable: false })).toEqual({ kind: "recheck_production", label: "稼働確認をやり直す" });
  });
});
