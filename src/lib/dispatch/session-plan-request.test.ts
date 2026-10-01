import { describe, expect, it } from "vitest";

import {
  buildPlanReviewDecisionRequestText,
  buildSessionPlanDecisionCommentBody,
  findPlanRequestForIssue,
  isVisibleSessionPlanRequest,
  parseSessionPlanDecision,
  parseSessionPlanHandoffModel,
  buildPlanRevisionReason,
  parseSessionPlanRevision,
  parseSessionPlanWaitSeconds,
  SESSION_PLAN_DECIDED_VISIBLE_MS,
  SESSION_PLAN_REVISION_MAX_ATTACHMENTS,
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

  /**
   * #2425。画像1枚のURLで100文字前後を使うため、同じ枠で数えると
   * 「3枚貼っただけで書ける文章が1割減る」ことになる。
   */
  it("末尾の添付（画像記法）は文字数に数えない", () => {
    const body = "あ".repeat(SESSION_PLAN_REVISION_MAX_LENGTH);
    const value = `${body}\n\n![shot.png](https://example.com/api/issues/images/shot.png)`;
    expect(parseSessionPlanRevision(value)).toBe(value);
    expect(parseSessionPlanRevision(`${body}あ`)).toBeNull();
  });

  /** 「この見た目にして」と1枚渡すのは、文章を書くより速くて正確な伝え方 */
  it("画像だけ（文章なし）の修正も通す", () => {
    expect(parseSessionPlanRevision("![shot.png](/api/issues/images/shot.png)")).toBe(
      "![shot.png](/api/issues/images/shot.png)",
    );
  });

  it("添付の枚数には上限がある", () => {
    const line = (n: number) => `![${n}.png](/api/issues/images/${n}.png)`;
    const ok = Array.from({ length: SESSION_PLAN_REVISION_MAX_ATTACHMENTS }, (_, i) => line(i));
    expect(parseSessionPlanRevision(ok.join("\n"))).toBe(ok.join("\n"));
    expect(parseSessionPlanRevision([...ok, line(99)].join("\n"))).toBeNull();
  });
});

/**
 * #2425。フックが運べるのは文字列だけで、画像そのものは渡らない。取りに行き方を書かないと、
 * 貼った本人は見せたつもりで見せられていない状態になる。
 */
describe("buildPlanRevisionReason", () => {
  it("画像が無ければ本文をそのまま返す", () => {
    expect(buildPlanRevisionReason("待ち時間を短く。")).toBe("待ち時間を短く。");
  });

  it("画像があれば、curlで落として`Read`で開く手順を添える", () => {
    const reason = buildPlanRevisionReason(
      "この見た目にして。\n\n![shot.png](https://example.com/api/issues/images/shot.png)",
    );
    expect(reason).toContain("![shot.png](https://example.com/api/issues/images/shot.png)");
    expect(reason).toContain("curl");
    expect(reason).toContain("`Read`");
  });

  it("文中に書かれた画像記法でも案内する", () => {
    expect(buildPlanRevisionReason("ここ→![a](/img/a.png)←を直して")).toContain("curl");
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

describe("parseSessionPlanHandoffModel", () => {
  it("現在のCLIに対応するローカル実行用モデルだけを通す", () => {
    expect(parseSessionPlanHandoffModel("sonnet", "claude")).toBe("sonnet");
    expect(parseSessionPlanHandoffModel("gpt-6-luna", "codex")).toBe("gpt-6-luna");
    expect(parseSessionPlanHandoffModel("gpt-6-luna", "claude")).toBeNull();
    expect(parseSessionPlanHandoffModel("haiku", "claude")).toBeNull();
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
  /** 端末に承認プロンプトが残っているのに画面から計画が消える不具合（#3711） */
  it("セッションが入力待ちなら、畳まれた計画の案内を出し続ける", () => {
    const requests = [view({ id: "deferred", status: "DEFERRED", decidedAt: null })];
    expect(findPlanRequestForIssue(requests, "guchi-apps/issue-deck", 2061, NOW)).toBeNull();
    expect(
      findPlanRequestForIssue(requests, "guchi-apps/issue-deck", 2061, NOW, {
        sessionWaitingInput: true,
      })?.id,
    ).toBe("deferred");
  });

  it("最新の計画が承認済みなら、古い期限切れの行は掘り起こさない", () => {
    const requests = [
      view({ id: "old", status: "EXPIRED", createdAt: new Date(NOW.getTime() - 60000).toISOString() }),
      view({ id: "new", status: "APPROVED", createdAt: NOW.toISOString(), decidedAt: null }),
    ];
    expect(
      findPlanRequestForIssue(requests, "guchi-apps/issue-deck", 2061, NOW, {
        sessionWaitingInput: true,
      }),
    ).toBeNull();
  });

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

describe("buildPlanReviewDecisionRequestText（#3554）", () => {
  it("反映する指摘と見送る指摘を分けて、見送る理由を添える", () => {
    const text = buildPlanReviewDecisionRequestText([
      { number: 1, title: "テストが型で落ちる", decision: "apply" },
      { number: 2, title: "docsに言及が残る", decision: "skip", reason: "別Issueで\nまとめる" },
      { number: 3, title: "再生成は不要", decision: "skip" },
    ]);
    expect(text).toContain("<!-- supervisor:plan-review -->");
    expect(text).toContain("<!-- issue-deck-agent:plan-reviser -->");
    expect(text).toContain("反映する:\n- 1. テストが型で落ちる");
    expect(text).toContain("見送る:\n- 2. docsに言及が残る（理由: 別Issueで まとめる）\n- 3. 再生成は不要");
  });

  it("見送りが無ければ見送るの節を出さない", () => {
    const text = buildPlanReviewDecisionRequestText([{ number: 1, title: "a", decision: "apply" }]);
    expect(text).not.toContain("見送る:");
  });

  it("指摘が多く見出し・理由が長くても、修正の上限を超えず parseSessionPlanRevision を通る", () => {
    const decisions = Array.from({ length: 30 }, (_, i) => ({
      number: i + 1,
      title: "長い見出し".repeat(40),
      decision: i % 2 === 0 ? ("apply" as const) : ("skip" as const),
      reason: "長い理由".repeat(100),
    }));
    const text = buildPlanReviewDecisionRequestText(decisions);
    expect(text.length).toBeLessThanOrEqual(SESSION_PLAN_REVISION_MAX_LENGTH);
    expect(parseSessionPlanRevision(text)).toBe(text);
    // 全件の番号は残す（どの指摘をどう判断したかが読める）
    expect(text).toContain("- 30. ");
  });

  it("3件程度なら見出しも理由も切り詰めない", () => {
    const title = "あ".repeat(100);
    const reason = "い".repeat(250);
    const text = buildPlanReviewDecisionRequestText([
      { number: 1, title, decision: "apply" },
      { number: 2, title, decision: "skip", reason },
      { number: 3, title, decision: "skip", reason },
    ]);
    expect(text).toContain(`- 2. ${title}（理由: ${reason}）`);
  });

  it("判断の選択を「判断:」の節に載せ、任せるも書く（#3660）", () => {
    const text = buildPlanReviewDecisionRequestText(
      [{ number: 1, title: "指摘", decision: "apply" }],
      [
        { number: 1, title: "書式をどうするか", letter: "A", label: "専用の判断見出し" },
        { number: 2, title: "範囲", letter: null },
      ],
    );
    expect(text).toContain("判断:\n- 判断1. 書式をどうするか → A. 専用の判断見出し\n- 判断2. 範囲 → セッションに任せる");
    expect(parseSessionPlanRevision(text)).toBe(text);
  });

  it("指摘が無く判断だけでも、指摘の節を出さず上限内に収まる（#3660）", () => {
    const choices = Array.from({ length: 20 }, (_, i) => ({
      number: i + 1,
      title: "長い見出し".repeat(40),
      letter: "B",
      label: "長い選択肢".repeat(40),
    }));
    const text = buildPlanReviewDecisionRequestText([], choices);
    expect(text).not.toContain("反映する:");
    expect(text.length).toBeLessThanOrEqual(SESSION_PLAN_REVISION_MAX_LENGTH);
  });
});
