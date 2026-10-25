import { describe, expect, it } from "vitest";

import {
  resolveIssueAttention,
  resolveSessionAttentionFlags,
  type IssueAttentionInput,
} from "@/lib/issue-attention-state";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const base: IssueAttentionInput = {
  permissionPending: false,
  questionPending: false,
  planPending: false,
  mergePending: false,
  planReviewState: null,
  reserved: false,
  running: false,
  notStarted: false,
};

describe("resolveIssueAttention", () => {
  it("何も無ければnull", () => {
    expect(resolveIssueAttention(base)).toBeNull();
  });

  it("着手前なら未着手", () => {
    expect(resolveIssueAttention({ ...base, notStarted: true })?.kind).toBe("not-started");
  });

  it("権限待ちは外部でしか解消できない旨を状態説明へ出し、遷移ボタンは持たない", () => {
    const a = resolveIssueAttention({ ...base, permissionPending: true, planPending: true });
    expect(a?.kind).toBe("permission");
    expect(a?.nextAction).toContain("この画面では解消できません");
    expect(a?.openButtonLabel).toBeNull();
  });

  it("入力待ち（権限待ちでない）は要対応で、質問・計画・マージ・権限より後に見る（#5025）", () => {
    const a = resolveIssueAttention({ ...base, inputPending: true, running: true });
    expect(a?.kind).toBe("input");
    expect(a?.needsUser).toBe(true);
    expect(resolveIssueAttention({ ...base, inputPending: true, questionPending: true })?.kind).toBe("question");
    expect(resolveIssueAttention({ ...base, inputPending: true, permissionPending: true })?.kind).toBe("permission");
  });

  it("入力待ちはALIVEのセッションだけ（落ちたセッションの古い値で残さない）", () => {
    const session = (state: string) =>
      ({ state, activity: "WAITING_INPUT", waitingTool: null }) as unknown as DispatchSessionView;
    expect(resolveSessionAttentionFlags(session("ALIVE")).inputPending).toBe(true);
    expect(resolveSessionAttentionFlags(session("DEAD")).inputPending).toBe(false);
    expect(resolveSessionAttentionFlags(null).inputPending).toBe(false);
  });

  it("遷移だけのボタンを「承認」「マージ」と呼ばない", () => {
    expect(resolveIssueAttention({ ...base, planPending: true })?.openButtonLabel).toBe("計画を確認");
    expect(resolveIssueAttention({ ...base, mergePending: true })?.openButtonLabel).toBe("PRを確認");
    expect(resolveIssueAttention({ ...base, questionPending: true })?.openButtonLabel).toBe("質問を確認");
  });

  it("質問は計画より、計画はマージより優先する", () => {
    expect(resolveIssueAttention({ ...base, questionPending: true, planPending: true })?.kind).toBe("question");
    expect(resolveIssueAttention({ ...base, planPending: true, mergePending: true })?.kind).toBe("plan");
  });

  it("計画レビュー作成中は人の操作が要らない", () => {
    const a = resolveIssueAttention({ ...base, planReviewState: "creating" });
    expect(a?.kind).toBe("plan-review-creating");
    expect(a?.needsUser).toBe(false);
  });

  it("猶予内の起動待ちは作成中と同じ、超過した起動待ちは作成中にしない（#4869）", () => {
    expect(resolveIssueAttention({ ...base, planReviewState: "queued" })?.kind).toBe("plan-review-creating");
    expect(resolveIssueAttention({ ...base, planReviewState: "queued_overdue" })).toBeNull();
  });

  it("依存待ち・実行中・順番待ち・予約を区別する", () => {
    expect(resolveIssueAttention({ ...base, dependencyWaitLabel: "#1" })?.kind).toBe("dependency");
    expect(resolveIssueAttention({ ...base, running: true })?.kind).toBe("running");
    expect(resolveIssueAttention({ ...base, queueLabel: "順番待ち 2番目" })?.label).toBe("順番待ち 2番目");
    expect(resolveIssueAttention({ ...base, reserved: true })?.kind).toBe("reserved");
  });

  it("失敗は待機扱いにせず要対応にする", () => {
    const a = resolveIssueAttention({ ...base, failed: true, running: true });
    expect(a?.kind).toBe("error");
    expect(a?.needsUser).toBe(true);
  });
});

describe("応答終了・停止中の区別（#4562）", () => {
  it("応答を終えたセッションは「実行中・操作不要」ではなく応答終了にする", () => {
    const a = resolveIssueAttention({ ...base, running: true, responded: true });
    expect(a?.kind).toBe("responded");
    expect(a?.nextAction).not.toContain("実装を進めています");
    // 正常完了・PR作成後も同じ形なので、要対応にはしない
    expect(a?.needsUser).toBe(false);
  });

  it("停滞の引き上げを受けたセッションは要対応にし、理由の確認先を示す", () => {
    const a = resolveIssueAttention({ ...base, running: true, stalled: true });
    expect(a?.kind).toBe("stalled");
    expect(a?.needsUser).toBe(true);
    expect(a?.openButtonLabel).toBe("詳細を確認");
  });

  it("計画の承認待ち・質問・依存待ちは応答終了より優先する", () => {
    expect(resolveIssueAttention({ ...base, planPending: true, responded: true })?.kind).toBe("plan");
    expect(resolveIssueAttention({ ...base, questionPending: true, stalled: true })?.kind).toBe("question");
    expect(resolveIssueAttention({ ...base, dependencyWaitLabel: "#1", responded: true })?.kind).toBe(
      "dependency",
    );
  });
});
