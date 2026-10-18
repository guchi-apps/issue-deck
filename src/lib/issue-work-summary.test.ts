import { describe, expect, it } from "vitest";

import {
  countAchievedCriteria,
  parseIssueWorkSummary,
  resolveWorkStatus,
} from "@/lib/issue-work-summary";

describe("parseIssueWorkSummary", () => {
  it("通常Issueの目的と完了条件のチェックリストを読む", () => {
    const s = parseIssueWorkSummary("## 目的\n通知を直す\n\n## 完了条件\n- [x] 一つ目\n- [ ] 二つ目\n");
    expect(s.purpose).toBe("通知を直す");
    expect(s.criteriaSource).toBe("completion-criteria");
    expect(s.criteria).toEqual([
      { text: "一つ目", checked: true },
      { text: "二つ目", checked: false },
    ]);
    expect(countAchievedCriteria(s, false)).toEqual({ achieved: 1, total: 2 });
  });

  it("旧手作業Issueは「できるようになること」と「完了の確認方法」をフォールバックで読む", () => {
    const body = [
      "## この作業でできるようになること",
      "メールが届く",
      "## 完了の確認方法",
      "```bash",
      "curl -sf https://example.com",
      "```",
    ].join("\n");
    const s = parseIssueWorkSummary(body);
    expect(s.purpose).toBe("メールが届く");
    expect(s.criteriaSource).toBe("verification-method");
    expect(s.criteria).toHaveLength(1);
    // 完了検証が成功するまでは未達成
    expect(countAchievedCriteria(s, false).achieved).toBe(0);
    expect(countAchievedCriteria(s, true).achieved).toBe(1);
  });

  it("見出しが無ければ架空の条件を作らない", () => {
    const s = parseIssueWorkSummary("ただの説明");
    expect(s).toEqual({ purpose: null, criteria: [], criteriaSource: null });
  });

  it("コードフェンス内の見出し風の行は節として扱わない", () => {
    const s = parseIssueWorkSummary("## 目的\nA\n```\n## 完了条件\n- [ ] x\n```\n");
    expect(s.criteria).toEqual([]);
  });
});

describe("resolveWorkStatus", () => {
  const base = { phase: null, blockingCount: 0, sessionRunning: false, questionPending: false, isOpen: true } as const;

  it("依存待ちと本人操作待ちを取り違えない", () => {
    expect(resolveWorkStatus({ ...base, blockingCount: 1 })).toBe("dependency_wait");
    expect(resolveWorkStatus({ ...base, blockingCount: 1, phase: "user_action" })).toBe("user_action");
    expect(resolveWorkStatus({ ...base, blockingCount: 1, questionPending: true })).toBe("user_action");
  });

  it("完了検証の失敗・停止は依存待ちより優先する", () => {
    expect(resolveWorkStatus({ ...base, blockingCount: 1, phase: "verify_failed" })).toBe("failed");
  });

  it("実行中・AI検証中・完了・完了検証なしのクローズを区別する", () => {
    expect(resolveWorkStatus({ ...base, phase: "ai_working" })).toBe("running");
    expect(resolveWorkStatus({ ...base, phase: "ai_verifying" })).toBe("ai_verifying");
    expect(resolveWorkStatus({ ...base, phase: "done", isOpen: false })).toBe("done");
    expect(resolveWorkStatus({ ...base, phase: "closed", isOpen: false })).toBe("closed");
    expect(resolveWorkStatus({ ...base, isOpen: false })).toBe("done");
    expect(resolveWorkStatus(base)).toBe("idle");
  });
});
