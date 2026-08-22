import { NextResponse, type NextRequest } from "next/server";

import {
  checkManualStepBody,
  renderManualStepBodyCheckComment,
} from "@/lib/manual-step-body-check";
import { authorizeProgressReport } from "@/lib/progress-report-auth";

/**
 * 手作業Issueの本文の書式検査（#2048）。
 *
 * **判定の正をissue-deck側に置くための受け口。** 検査するのは画面のパーサーが読む書式なので、
 * 規則をワークフロー側へ写すと、検査を通った本文を画面が読めない（またはその逆）という
 * 食い違いが必ず出る。呼ぶのは`reusable-issue-labels.yml`の`manual-step-body-check`ジョブで、
 * 返ってきたコメント本文をそのままIssueへ投稿する。
 *
 * 認証は`/api/progress`と同じ共有シークレット（`PROGRESS_REPORT_SECRET`）。呼び出し元は
 * 無人実行でログインセッションを持たない。**進捗報告と同じ「ワークフローからの報告」の
 * 系統なので、専用のシークレットは増やさない。**
 *
 * **本文はリクエストで受け取り、GitHubから引き直さない。** 呼び出し元は`issues`イベントの
 * ペイロードで既に本文を持っており、引き直してもGitHub APIの枠を使うだけで内容は同じになる。
 *
 * **状態を持たない。** 受け取った本文はその場で検査して捨てる（保存も記録もしない）。
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
  const body = typeof payload?.body === "string" ? payload.body : null;
  if (body === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  // 検査に要らない大きさは受けない。手作業Issueの本文はテンプレートに収まる
  if (body.length > MAX_BODY_LENGTH) {
    return NextResponse.json({ error: "body_too_large" }, { status: 413 });
  }

  const repositoryFullName =
    typeof payload?.repository === "string" && payload.repository.includes("/")
      ? payload.repository
      : undefined;

  const findings = checkManualStepBody(body, { repositoryFullName });
  return NextResponse.json({
    findings,
    comment: renderManualStepBodyCheckComment(findings),
  });
}

/** 受け付ける本文の長さ。実測でいちばん長い手作業Issueでも1万字に届かない */
const MAX_BODY_LENGTH = 100_000;
