import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import { defaultPlanArtifactSourcePath, splitPlanArtifact } from "@/lib/dispatch/plan-artifact";
import { saveSessionArtifact } from "@/lib/dispatch/session-artifacts";
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
 * **計画にアーティファクトのHTMLが埋め込まれていれば、ここで取り込む**（#2200）。Plan modeで
 * 書けるのは計画ファイルだけなので、承認前に見た目を直す唯一の経路がこれになる
 * （`src/lib/dispatch/plan-artifact.ts`）。
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
  // **計画に埋め込まれたアーティファクトは、長さを見るより前に切り離す**（#2200）。
  // HTMLが載ったままだと`parseSessionPlanText`の上限に掛かり、計画そのものが載らなくなる
  const split = splitPlanArtifact(typeof payload?.plan === "string" ? payload.plan : "");
  const plan = parseSessionPlanText(split.plan);
  if (!target || !plan) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // 形が想定外のものは**受け付けずにnullへ倒す**（リクエスト自体は拒否しない）。
  // 計画本文が載ることの方が価値が高く、付随情報が欠けても投稿する意味は変わらない
  const hostName = parseSessionHostName(payload?.hostName);

  // 埋め込みがあった回だけ、既存のアーティファクトとして保存する（#2200）。**`Artifact`ツール
  // 経由の公開（`../artifact`）と同じ入り口を使う**ので、パスが公開時と同じなら同じカードが
  // 差し替わる。**失敗しても計画の投稿は続ける** — 見た目が古いままになるだけで、
  // 計画が残らないことの方が損失が大きい
  let artifactUpdated = false;
  if (split.artifact) {
    try {
      await saveSessionArtifact({
        repositoryFullName: target.repositoryFullName,
        issueNumber: target.issueNumber,
        hostName,
        title: null,
        description: null,
        favicon: null,
        // claude.aiのURLは埋め込みからは分からない。**`null`を渡しても覚えてあるURLは消えない**
        // （`saveSessionArtifact`は取れた回だけ更新する）
        claudeUrl: null,
        sourcePath:
          split.artifact.sourcePath ??
          defaultPlanArtifactSourcePath(target.repositoryFullName, target.issueNumber),
        html: split.artifact.html,
      });
      artifactUpdated = true;
    } catch (error) {
      console.error(
        `[dispatch] 計画に埋め込まれたアーティファクトを保存できませんでした（${target.repositoryFullName}#${target.issueNumber}）`,
        error,
      );
    }
  }

  const posted = await postSessionPlan({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
    plan,
    remoteControlUrl: parseRemoteControlUrl(payload?.remoteControlUrl),
    planBaseSha: parsePlanBaseSha(payload?.planBaseSha),
    hostName,
    artifactUpdated,
  });

  // 画面からの返事を待つ（#2061）。**Issueコメントの投稿に成功したかどうかとは切り離す**
  // （#2108）。パネルが描いているのはここで保存する`plan`そのもので、コメントの取得には
  // 依存していない。コメントを書けなかったことを理由に待ちを作らないと、端末には計画が
  // 出ているのに**画面からは承認も修正もできない**という、いちばん困る組み合わせになる。
  //
  // **待ち時間が`0`（ホスト側で無効にしている）なら作らない。** 作ると、フックは待たないのに
  // 画面には押しても誰も受け取らないパネルが残る。
  const waitSeconds = parseSessionPlanWaitSeconds(payload?.waitSeconds);
  let planRequestId: string | null = null;
  if (waitSeconds > 0) {
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
