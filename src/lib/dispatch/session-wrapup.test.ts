import { describe, expect, it } from "vitest";

import { SESSION_STARTED_MARKER } from "@/lib/dispatch/session-start";
import {
  SESSION_WRAPUP_MARKER,
  buildSessionWrapupCommentBody,
  hasIssueRecordSince,
  resolveSessionRecordSince,
} from "@/lib/dispatch/session-wrapup";
import type { GithubApiComment } from "@/lib/github/issues-api";

function comment(createdAt: string, body: string | null): GithubApiComment {
  return { id: 1, user: { login: "issue-deck" }, body, created_at: createdAt };
}

const SESSION_START = new Date("2026-08-14T10:00:00Z");
const FIRST_SEEN = new Date("2026-08-14T10:01:00Z");

describe("resolveSessionRecordSince", () => {
  /**
   * `firstSeenAt`はpollerが最初に見た時刻で、起動から最大1巡（既定60秒）遅れる。その差の間に
   * 計画が出ると「記録なし」と誤判定するため、受付コメントの時刻を優先する。
   */
  it("受付コメントがあればその投稿時刻を基準にする", () => {
    const comments = [comment(SESSION_START.toISOString(), `受付\n${SESSION_STARTED_MARKER}`)];
    expect(resolveSessionRecordSince(comments, FIRST_SEEN)).toEqual(SESSION_START);
  });

  it("同じIssueで起こし直した場合は最後の受付コメントを基準にする", () => {
    const comments = [
      comment("2026-08-13T09:00:00Z", `前回の受付\n${SESSION_STARTED_MARKER}`),
      comment(SESSION_START.toISOString(), `今回の受付\n${SESSION_STARTED_MARKER}`),
    ];
    expect(resolveSessionRecordSince(comments, FIRST_SEEN)).toEqual(SESSION_START);
  });

  it("受付コメントが無ければfirstSeenAtへ落とす", () => {
    expect(resolveSessionRecordSince([comment("2026-08-14T09:00:00Z", "人の発言")], FIRST_SEEN)).toEqual(
      FIRST_SEEN,
    );
  });
});

describe("hasIssueRecordSince", () => {
  it("実装ボットの完了報告は記録として数える", () => {
    const comments = [
      comment("2026-08-14T11:00:00Z", "PRを作りました\n<!-- issue-deck-agent:implementer -->"),
    ];
    expect(hasIssueRecordSince(comments, SESSION_START)).toBe(true);
  });

  it("自動投稿された計画コメントも記録として数える（#1342）", () => {
    const comments = [comment("2026-08-14T11:00:00Z", "計画\n<!-- issue-deck:session-plan -->")];
    expect(hasIssueRecordSince(comments, SESSION_START)).toBe(true);
  });

  it("ワークフローからのPR作成報告も記録として数える", () => {
    const comments = [
      comment("2026-08-14T11:00:00Z", "PRを作成しました\n<!-- issue-deck-source:issue-labels -->"),
    ];
    expect(hasIssueRecordSince(comments, SESSION_START)).toBe(true);
  });

  /** 2つの呼び出し経路（trapとpollerの巡回）から呼ばれても投稿を1回に留めるための鍵 */
  it("自分が投稿した締めコメントも記録として数える（二重投稿の抑止）", () => {
    const comments = [comment("2026-08-14T11:00:00Z", `締め\n${SESSION_WRAPUP_MARKER}`)];
    expect(hasIssueRecordSince(comments, SESSION_START)).toBe(true);
  });

  /** 受付はこの仕組み自身が出したもので、セッションが何かをした証拠にはならない */
  it("受付コメントは記録として数えない", () => {
    const comments = [
      comment(
        "2026-08-14T10:00:00Z",
        `受付\n${SESSION_STARTED_MARKER}\n<!-- issue-deck-agent:guide -->`,
      ),
    ];
    expect(hasIssueRecordSince(comments, SESSION_START)).toBe(false);
  });

  it("セッションが始まる前のコメントは数えない", () => {
    const comments = [
      comment("2026-08-13T09:00:00Z", "前回の完了報告\n<!-- issue-deck-agent:implementer -->"),
    ];
    expect(hasIssueRecordSince(comments, SESSION_START)).toBe(false);
  });

  /** `11.local`が付いている間、人のコメントはそもそもセッションに届かない（#1287） */
  it("マーカーの無い人のコメントは数えない", () => {
    const comments = [comment("2026-08-14T11:00:00Z", "これもお願いします")];
    expect(hasIssueRecordSince(comments, SESSION_START)).toBe(false);
  });

  it("本文がnullのコメントで落ちない", () => {
    expect(hasIssueRecordSince([comment("2026-08-14T11:00:00Z", null)], SESSION_START)).toBe(false);
  });
});

describe("buildSessionWrapupCommentBody", () => {
  const params = {
    hostName: "subpc",
    tmuxSessionName: "issue-deck-issue-1119",
    issueNumber: 1119,
    elapsedMs: 80 * 60 * 1000,
  };

  it("ホスト・tmuxセッション名・稼働時間と再開コマンドを載せる", () => {
    const body = buildSessionWrapupCommentBody(params);
    expect(body).toContain("サブPCのローカルセッションが終了しましたが");
    expect(body).toContain("- tmuxセッション: `issue-deck-issue-1119`");
    expect(body).toContain("- 稼働時間: 1時間20分");
    expect(body).toContain("```bash\nscripts/start-issue.sh 1119\n```");
  });

  it("稼働時間が取れなければその行ごと落とす", () => {
    expect(buildSessionWrapupCommentBody({ ...params, elapsedMs: null })).not.toContain("稼働時間");
  });

  it("締めコメントのマーカーと案内ボットの役割マーカーを末尾に付ける", () => {
    const body = buildSessionWrapupCommentBody(params);
    expect(body).toContain(SESSION_WRAPUP_MARKER);
    expect(body.trimEnd().endsWith("<!-- issue-deck-agent:guide -->")).toBe(true);
  });
});
