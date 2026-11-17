import { describe, expect, it } from "vitest";

import {
  buildReviewFixFailureComment,
  buildReviewFixRequestComment,
  buildReviewFixRequestText,
  issueReviewFixRequestState,
  isReviewFixSessionBody,
  resolveReviewFixSessionRoute,
  REVIEW_FIX_SESSION_INSTRUCTION,
  reviewFixJobFailureReason,
  reviewFixSessionActionLabel,
} from "@/lib/dispatch/review-fix-session";
import { findCurrentFixRequest, findInterruptedFixRequest } from "@/lib/github/pull-request-fix-request-service";

const HEAD = "3f047c8aa1b2c3d4e5f60718293a4b5c6d7e8f90";

describe("resolveReviewFixSessionRoute", () => {
  it("動いていれば送る・記録があれば同じエージェントで再開・無ければ起動", () => {
    expect(resolveReviewFixSessionRoute({ host: "subpc", state: "ALIVE", codexThreadKnown: null })).toEqual({
      kind: "session",
      host: "subpc",
    });
    expect(resolveReviewFixSessionRoute({ host: "subpc", state: "EXITED", codexThreadKnown: null })).toEqual({
      kind: "resume",
      host: "subpc",
      agent: "claude",
    });
    // Codexで進んでいたIssueはCodexで呼び戻す（黙ってClaude Codeで立てない）
    expect(
      resolveReviewFixSessionRoute({ host: "subpc", state: "FAILED", codexThreadKnown: true }),
    ).toMatchObject({ kind: "resume", agent: "codex" });
    expect(resolveReviewFixSessionRoute(null)).toEqual({ kind: "launch" });
  });

  it("確定ボタンの文言は送り先で変わる", () => {
    expect(reviewFixSessionActionLabel({ kind: "session", host: "subpc" })).toBe("セッションへ送る");
    expect(reviewFixSessionActionLabel({ kind: "resume", host: "subpc", agent: "claude" })).toBe("再開して依頼する");
    expect(reviewFixSessionActionLabel({ kind: "launch" })).toBe("起動して依頼する");
  });
});

describe("固定の1行", () => {
  it("1行で、一致したものだけを認める", () => {
    expect(REVIEW_FIX_SESSION_INSTRUCTION).not.toContain("\n");
    expect(isReviewFixSessionBody(REVIEW_FIX_SESSION_INSTRUCTION)).toBe(true);
    expect(isReviewFixSessionBody(`${REVIEW_FIX_SESSION_INSTRUCTION} `)).toBe(false);
    expect(isReviewFixSessionBody("任意の指示")).toBe(false);
  });
});

describe("buildReviewFixRequestText", () => {
  it("PR番号・HEAD・指摘・ブランチ・方針メモを書き、新しいIssue・PRを作らないと伝える", () => {
    const text = buildReviewFixRequestText({
      pullRequestNumber: 659,
      headSha: HEAD,
      headRef: "issue-657",
      verdictLabel: "要修正",
      reviewUrl: "https://github.com/o/r/pull/659#issuecomment-1",
      concerns: ["agent.sh:937 — tmux セッション名の取り違え"],
      note: "存在確認は不要\n取り違えだけ直す",
    });
    expect(text).toContain("PR #659 の自動レビューが「要修正」");
    expect(text).toContain("`3f047c8`");
    expect(text).toContain("https://github.com/o/r/pull/659#issuecomment-1");
    expect(text).toContain("  - agent.sh:937 — tmux セッション名の取り違え");
    expect(text).toContain("  > 存在確認は不要\n  > 取り違えだけ直す");
    expect(text).toContain("`issue-657`");
    expect(text).toContain("新しいIssue・PRは作りません");
  });

  it("方針メモが空なら方針の項目を出さない", () => {
    const text = buildReviewFixRequestText({
      pullRequestNumber: 1,
      headSha: HEAD,
      headRef: "issue-2",
      verdictLabel: "要確認",
      reviewUrl: null,
      concerns: [],
      note: "  ",
    });
    expect(text).not.toContain("方針メモ");
    expect(text).not.toContain("指摘の全文");
  });
});

describe("依頼コメントの印", () => {
  it("既存の「依頼済み」「中断」の判定にそのまま載る", () => {
    const request = {
      id: 42,
      body: buildReviewFixRequestComment({ text: "依頼", headSha: HEAD, key: "18f2a", posterMarker: "<!-- p -->" }),
      html_url: "https://x/req",
      created_at: "2026-11-17T00:00:00Z",
    };
    expect(findCurrentFixRequest([request], HEAD)).toEqual({ commentUrl: "https://x/req", createdAt: "2026-11-17T00:00:00Z" });

    const failure = {
      body: buildReviewFixFailureComment({ requestCommentId: 42, reason: "host_offline", message: "ホストがオフラインです" }),
      html_url: "https://x/fail",
    };
    expect(findCurrentFixRequest([request, failure], HEAD)).toBeNull();
    expect(findInterruptedFixRequest([request, failure], HEAD)).toMatchObject({
      kind: "failed",
      reason: "host_offline",
      requestUrl: "https://x/req",
    });
  });
});

describe("reviewFixJobFailureReason", () => {
  it("届かずに終わったジョブだけ理由を返す", () => {
    expect(reviewFixJobFailureReason(null)).toBeNull();
    for (const status of ["QUEUED", "CLAIMED", "RUNNING", "SUCCEEDED"] as const) {
      expect(reviewFixJobFailureReason({ status, message: null })).toBeNull();
    }
    expect(reviewFixJobFailureReason({ status: "SKIPPED", message: "承認プロンプトの表示中" })).toContain("承認プロンプトの表示中");
    expect(reviewFixJobFailureReason({ status: "FAILED", message: null })).toContain("渡せませんでした");
    expect(reviewFixJobFailureReason({ status: "TIMEOUT", message: null })).not.toBeNull();
    expect(reviewFixJobFailureReason({ status: "CANCELED", message: null })).not.toBeNull();
  });
});

describe("issueReviewFixRequestState", () => {
  const request = (id: string, sha: string) => ({
    id,
    body: buildReviewFixRequestComment({ text: "依頼", headSha: sha, key: "a1", posterMarker: "" }),
  });

  it("いまのHEADへの依頼が無ければnone、あればrequested、届かなかった印があればinterrupted", () => {
    expect(issueReviewFixRequestState([], HEAD)).toBe("none");
    // 前のHEADへの依頼は数えない
    expect(issueReviewFixRequestState([request("1", "0".repeat(40))], HEAD)).toBe("none");
    expect(issueReviewFixRequestState([request("2", HEAD)], HEAD)).toBe("requested");
    const failure = {
      id: "3",
      body: buildReviewFixFailureComment({ requestCommentId: 2, reason: "host_offline", message: "x" }),
    };
    expect(issueReviewFixRequestState([request("2", HEAD), failure], HEAD)).toBe("interrupted");
    // 送り直した新しい依頼は、古い依頼の失敗の印に引きずられない
    expect(issueReviewFixRequestState([request("2", HEAD), failure, request("4", HEAD)], HEAD)).toBe("requested");
  });
});
