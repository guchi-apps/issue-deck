import { NextResponse, type NextRequest } from "next/server";

import { COMMENT_RELAY_SESSION_INSTRUCTION } from "@/lib/dispatch/comment-relay";
import { parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import { enqueueSessionControlJob } from "@/lib/dispatch/jobs";
import { findDispatchSessionForIssue } from "@/lib/dispatch/sessions";
import { authorizeProgressReport } from "@/lib/progress-report-auth";

/**
 * `11.local`付きIssueへの`@claude`コメントを、生きているローカルセッションへ転送する（#3331）。
 *
 * `reusable-issue-dispatch.yml`のtriageジョブが、`11.local`によるskip判定のときに呼ぶ。
 * 従来は「`11.local`を外して改めて`@claude`とコメントしてください」という案内を返すだけで、
 * 実際に動いているローカルセッションへは何も伝わっていなかった。
 *
 * 呼ぶのはGitHub Actionsでログインセッションを持たないため、進捗報告API（`POST /api/progress`）
 * と同じ共有シークレット（`PROGRESS_REPORT_SECRET`）で認証する（`/api/dispatch/actions-usage`と
 * 同じ前例。ディスパッチ専用の`DISPATCH_SECRET`はpollerの「キューからジョブを取り出す」権限用で、
 * ここは「Actions→issue-deckへの通知」という進捗報告と同じ性質のため転用しない）。
 *
 * **セッションが生きていないときはエラーにせず`relayed: false`を返す。** 呼び出し側の
 * ワークフローはこの結果を見て、転送できなければ従来どおりの案内コメントへフォールバックする
 * （`POST /api/progress`と同じく、このAPIの失敗・不達でワークフロー自体は止めない設計）。
 */
export async function POST(request: NextRequest) {
  const auth = authorizeProgressReport(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const target = parseDispatchTarget(payload?.repository, payload?.issue);
  if (!target) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const session = await findDispatchSessionForIssue({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
  });
  if (!session || session.state !== "ALIVE") {
    return NextResponse.json(
      { ok: true, relayed: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await enqueueSessionControlJob({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
    hostName: session.host,
    kind: "INSTRUCTION",
    instruction: COMMENT_RELAY_SESSION_INSTRUCTION,
    // 00.check-userの管理対象ではない（そもそもこの経路にIssueが来た時点で11.local付きであり、
    // 確認待ちのラベルは載っていない）ので、届いたかどうかで外すラベルは無い
    recovery: false,
    requestedByUserId: null,
  });

  return NextResponse.json(
    { ok: true, relayed: result.ok },
    { headers: { "Cache-Control": "no-store" } },
  );
}
