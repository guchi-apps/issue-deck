import { describe, expect, it } from "vitest";

import {
  buildSessionPlanDecisionCommentBody,
  findPlanRequestForIssue,
  isVisibleSessionPlanRequest,
  parseSessionPlanDecision,
  parseSessionPlanRevision,
  parseSessionPlanWaitSeconds,
  SESSION_PLAN_DECIDED_VISIBLE_MS,
  SESSION_PLAN_REVISION_MAX_LENGTH,
  SESSION_PLAN_STORED_LIMIT,
  SESSION_PLAN_WAIT_SECONDS_DEFAULT,
  SESSION_PLAN_WAIT_SECONDS_MAX,
  SESSION_PLAN_WAIT_SECONDS_MIN,
  truncatePlanForPanel,
  type SessionPlanRequestView,
} from "@/lib/dispatch/session-plan-request";

const NOW = new Date("2026-08-22T10:00:00.000Z");

function view(overrides: Partial<SessionPlanRequestView> = {}): SessionPlanRequestView {
  return {
    id: "req_1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 2061,
    hostName: "subpc",
    plan: "## 要約",
    status: "WAITING",
    createdAt: "2026-08-22T09:58:00.000Z",
    expiresAt: "2026-08-22T10:28:00.000Z",
    decidedAt: null,
    delivered: false,
    ...overrides,
  };
}

describe("parseSessionPlanRevision", () => {
  it("複数行の指摘をそのまま通す（追加指示と違い1行に縛らない）", () => {
    expect(parseSessionPlanRevision("待ち時間を短く。\n理由も書いて。")).toBe(
      "待ち時間を短く。\n理由も書いて。",
    );
  });

  it("空・空白だけ・長すぎる本文は受け取らない", () => {
    expect(parseSessionPlanRevision("")).toBeNull();
    expect(parseSessionPlanRevision("   \n  ")).toBeNull();
    expect(parseSessionPlanRevision("あ".repeat(SESSION_PLAN_REVISION_MAX_LENGTH + 1))).toBeNull();
  });

  it("改行・タブ以外の制御文字は弾く", () => {
    expect(parseSessionPlanRevision("直して\u0007ください")).toBeNull();
    expect(parseSessionPlanRevision("直して\tください")).toBe("直して\tください");
  });

  it("文字列以外は受け取らない", () => {
    expect(parseSessionPlanRevision(null)).toBeNull();
    expect(parseSessionPlanRevision(12)).toBeNull();
  });
});

describe("parseSessionPlanWaitSeconds", () => {
  it("範囲内はそのまま通す", () => {
    expect(parseSessionPlanWaitSeconds(600)).toBe(600);
  });

  it("範囲外は上限・下限へ丸める", () => {
    expect(parseSessionPlanWaitSeconds(30)).toBe(SESSION_PLAN_WAIT_SECONDS_MIN);
    expect(parseSessionPlanWaitSeconds(99999)).toBe(SESSION_PLAN_WAIT_SECONDS_MAX);
  });

  /** ホスト側で`SESSION_PLAN_WAIT_SECONDS=0`にしたときに、下限へ丸めて待たせない */
  it("0は0のまま返す（＝待たない）", () => {
    expect(parseSessionPlanWaitSeconds(0)).toBe(0);
    expect(parseSessionPlanWaitSeconds(-5)).toBe(0);
  });

  it("数値にならない値は既定へ倒す", () => {
    expect(parseSessionPlanWaitSeconds(undefined)).toBe(SESSION_PLAN_WAIT_SECONDS_DEFAULT);
    expect(parseSessionPlanWaitSeconds("あ")).toBe(SESSION_PLAN_WAIT_SECONDS_DEFAULT);
  });
});

describe("parseSessionPlanDecision", () => {
  it("3つの決め方だけを通す", () => {
    expect(parseSessionPlanDecision("approve")).toBe("approve");
    expect(parseSessionPlanDecision("revise")).toBe("revise");
    expect(parseSessionPlanDecision("defer")).toBe("defer");
    expect(parseSessionPlanDecision("reject")).toBeNull();
  });
});

describe("truncatePlanForPanel", () => {
  it("長すぎる計画は切って、全文の在り処を案内する", () => {
    const truncated = truncatePlanForPanel("あ".repeat(SESSION_PLAN_STORED_LIMIT + 10));
    expect(truncated.length).toBeLessThan(SESSION_PLAN_STORED_LIMIT + 200);
    expect(truncated).toContain("全文はIssueのコメントで確認してください");
  });
});

describe("isVisibleSessionPlanRequest", () => {
  it("待っている間は必ず出す", () => {
    expect(isVisibleSessionPlanRequest({ status: "WAITING", decidedAt: null }, NOW)).toBe(true);
  });

  it("決まった直後は結果を出し、しばらく経ったら引っ込める", () => {
    const justNow = new Date(NOW.getTime() - 1000).toISOString();
    const old = new Date(NOW.getTime() - SESSION_PLAN_DECIDED_VISIBLE_MS - 1000).toISOString();
    expect(isVisibleSessionPlanRequest({ status: "APPROVED", decidedAt: justNow }, NOW)).toBe(true);
    expect(isVisibleSessionPlanRequest({ status: "APPROVED", decidedAt: old }, NOW)).toBe(false);
  });

  /** 待ち時間切れは押した人がいないので、結果として出し続ける相手がいない */
  it("誰も押さないまま期限切れになったものは出さない", () => {
    expect(isVisibleSessionPlanRequest({ status: "EXPIRED", decidedAt: null }, NOW)).toBe(false);
  });
});

describe("findPlanRequestForIssue", () => {
  it("別のIssue・別リポジトリのものは拾わない", () => {
    const requests = [
      view({ id: "other-repo", repositoryFullName: "guchi-apps/vps" }),
      view({ id: "other-issue", issueNumber: 2060 }),
    ];
    expect(findPlanRequestForIssue(requests, "guchi-apps/issue-deck", 2061, NOW)).toBeNull();
  });

  /**
   * 計画を出し直すと前の行は`EXPIRED`になるが、押した直後の結果表示（数分残る）と
   * 同時に並ぶことがある。新しい計画が出ているならそちらが唯一の操作対象。
   */
  it("待っている行を、押した直後の結果表示より優先する", () => {
    const requests = [
      view({
        id: "decided",
        status: "REVISION_REQUESTED",
        decidedAt: new Date(NOW.getTime() - 1000).toISOString(),
      }),
      view({ id: "waiting", status: "WAITING" }),
    ];
    expect(findPlanRequestForIssue(requests, "guchi-apps/issue-deck", 2061, NOW)?.id).toBe(
      "waiting",
    );
  });
});

describe("buildSessionPlanDecisionCommentBody", () => {
  it("承認は末尾に投稿者マーカーを置く（画面で押した本人の発言として出すため）", () => {
    const body = buildSessionPlanDecisionCommentBody({
      decision: "approve",
      revisionText: null,
      posterMarker: "<!-- issue-deck:posted-by:m-guchi -->",
    });
    expect(body).toContain("計画を承認しました");
    expect(body.endsWith("\n\n<!-- issue-deck:posted-by:m-guchi -->")).toBe(true);
  });

  it("修正は本文を引用として残す（後から計画の変遷を追えるようにする）", () => {
    const body = buildSessionPlanDecisionCommentBody({
      decision: "revise",
      revisionText: "待ち時間を短く。\n理由も書いて。",
      posterMarker: "<!-- issue-deck:posted-by:m-guchi -->",
    });
    expect(body).toContain("> 待ち時間を短く。");
    expect(body).toContain("> 理由も書いて。");
  });

  it("端末で答える場合も、そう決めたことを残す", () => {
    const body = buildSessionPlanDecisionCommentBody({
      decision: "defer",
      revisionText: null,
      posterMarker: "<!-- issue-deck:posted-by:m-guchi -->",
    });
    expect(body).toContain("端末で答えることにしました");
  });
});
