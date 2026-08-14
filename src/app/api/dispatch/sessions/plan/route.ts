import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import {
  parsePlanBaseSha,
  parseSessionHostName,
  parseSessionPlanText,
  postSessionPlan,
} from "@/lib/dispatch/session-plan";
import { parseRemoteControlUrl } from "@/lib/dispatch/session-state";

/**
 * 実装セッションが提示した計画の受け口（#1342）。
 *
 * 送るのは`scripts/session-notify.sh`で、`ExitPlanMode`の`PreToolUse`フックから叩く。
 * **計画がセッションの中にしか無い状態を無くすための入口。** 詳しい経緯は
 * `src/lib/dispatch/session-plan.ts`と[docs/multi-agent/session-notify.md](../../../../../../docs/multi-agent/session-notify.md)。
 *
 * **様子の報告（`../activity`）とは別の入口にする。** あちらはDBの行を更新するだけで、
 * 対象の行が無ければ何もしない。計画の投稿はGitHubへ書く操作で、pollerが1巡してDispatchSessionの
 * 行ができているかとは無関係に成立させる必要がある（計画は起動から数分で出ることがあり、
 * 行が無いことを理由に落とすと計画がどこにも残らない）。
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
  const plan = parseSessionPlanText(payload?.plan);
  if (!target || !plan) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // 形が想定外のものは**受け付けずにnullへ倒す**（リクエスト自体は拒否しない）。
  // 計画本文が載ることの方が価値が高く、付随情報が欠けても投稿する意味は変わらない
  const posted = await postSessionPlan({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
    plan,
    remoteControlUrl: parseRemoteControlUrl(payload?.remoteControlUrl),
    planBaseSha: parsePlanBaseSha(payload?.planBaseSha),
    hostName: parseSessionHostName(payload?.hostName),
  });

  // 投稿できなくても200で返す。呼び出し側（フック）は再送の判断ができる相手ではなく、
  // 非0を返してもセッションのログにエラーが増えるだけになる
  return NextResponse.json(
    { ok: true, posted },
    { headers: { "Cache-Control": "no-store" } },
  );
}
