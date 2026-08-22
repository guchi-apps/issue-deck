import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import {
  parsePlanBaseSha,
  parseSessionHostName,
  parseSessionPlanText,
  postSessionPlan,
} from "@/lib/dispatch/session-plan";
import { createSessionPlanRequest } from "@/lib/dispatch/plan-requests";
import { parseSessionPlanWaitSeconds } from "@/lib/dispatch/session-plan-request";
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
  const hostName = parseSessionHostName(payload?.hostName);
  const posted = await postSessionPlan({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
    plan,
    remoteControlUrl: parseRemoteControlUrl(payload?.remoteControlUrl),
    planBaseSha: parsePlanBaseSha(payload?.planBaseSha),
    hostName,
  });

  // 画面からの返事を待つ（#2061）。**投稿できたときだけ作る。** 投稿できていない＝画面に
  // 計画が出ないので、待たせても押す材料が無い（フックは`planRequestId`が返らなければ
  // 待たずに終え、端末に従来どおりの承認プロンプトが出る）。
  //
  // **待ち時間が`0`（ホスト側で無効にしている）なら作らない。** 作ると、フックは待たないのに
  // 画面には押しても誰も受け取らないパネルが残る。
  const waitSeconds = parseSessionPlanWaitSeconds(payload?.waitSeconds);
  let planRequestId: string | null = null;
  if (posted && waitSeconds > 0) {
    try {
      const request = await createSessionPlanRequest({
        repositoryFullName: target.repositoryFullName,
        issueNumber: target.issueNumber,
        hostName,
        plan,
        waitSeconds,
      });
      planRequestId = request.id;
    } catch (error) {
      // **作れなくても計画の投稿は成功として扱う。** 待てないだけで、答える経路
      // （端末・Remote Control）はそのまま残っている
      console.error(
        `[dispatch] 計画の返事待ちを作れませんでした（${target.repositoryFullName}#${target.issueNumber}）`,
        error,
      );
    }
  }

  // 投稿できなくても200で返す。呼び出し側（フック）は再送の判断ができる相手ではなく、
  // 非0を返してもセッションのログにエラーが増えるだけになる
  return NextResponse.json(
    { ok: true, posted, planRequestId },
    { headers: { "Cache-Control": "no-store" } },
  );
}
