import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchHostName, parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import { postSessionStartedComment } from "@/lib/dispatch/session-start";
import { parseDispatchSessionName } from "@/lib/dispatch/session-state";

/**
 * ローカルの実装セッションが起動したことの報告（#1119）。
 *
 * 送るのは`scripts/run-issue-session.sh`で、`claude`の起動直前に1回だけ叩く。
 * ここがGitHub App名義で受付コメントを投稿する。経緯は`src/lib/dispatch/session-start.ts`と
 * [docs/multi-agent/session-notify.md](../../../../../../docs/multi-agent/session-notify.md)。
 *
 * **入口を`../activity`・`../ended`と分ける理由は`../plan`と同じ。** あちらはDBの行を更新する
 * だけで、対象の行が無ければ何もしない。受付コメントはGitHubへ書く操作で、pollerが1巡して
 * `DispatchSession`の行ができているかとは無関係に成立させる必要がある（受付は起動と同時に
 * 出るので、行の有無を理由に落とすと必ず取りこぼす）。
 *
 * **pollerの一括報告（`../`）へも相乗りできない。** あちらは「そのホストで今見えている
 * セッションの全て」を前提に、含まれない行を`GONE`へ倒す作りなので、1件だけ流すと他の
 * セッションが全部消えたことになる。
 *
 * 認証は`/claim`・`/report`・`/hosts`・`/sessions`と同じ共有シークレット（`DISPATCH_SECRET`）。
 */
export async function POST(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const target = parseDispatchTarget(payload?.repository, payload?.issue);
  const hostName = parseDispatchHostName(payload?.host);
  const tmuxSessionName = parseDispatchSessionName(payload?.tmuxSessionName);
  // **ホスト名・tmuxセッション名は必須にする。** どちらも本文へそのまま埋め、実行の様子を
  // 見に行く唯一の手掛かり（`tmux attach -t <名前>`）になる。欠けた受付コメントを出しても
  // 「押したのに何も起きていない」の解消にならない
  if (!target || !hostName || !tmuxSessionName) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const posted = await postSessionStartedComment({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
    hostName,
    tmuxSessionName,
  });

  // 投稿できなくても200で返す。呼び出し側（起動スクリプト）は再送の判断ができる相手ではなく、
  // 非0を返してもセッションの起動ログにエラーが増えるだけになる
  return NextResponse.json(
    { ok: true, posted },
    { headers: { "Cache-Control": "no-store" } },
  );
}
