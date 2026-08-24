import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import { requestSessionCheckUser, resolveSessionPlanCheckUser } from "@/lib/dispatch/session-plan";
import {
  parseDispatchSessionActivity,
  parsePreviewUrl,
  parseRemoteControlUrl,
} from "@/lib/dispatch/session-state";
import { recordDispatchSessionActivity } from "@/lib/dispatch/sessions";

/**
 * 実装セッション自身が、フック（#1219）から送ってくる直近の様子の受け口（#1264）。
 *
 * 送るのは`scripts/session-notify.sh`（Claude Codeのフックと、pollerが合成する
 * `SessionInterrupted`）。**#2280でSignalyへの通知を消してからは、ここがセッションの様子を
 * 外へ出す唯一の経路**で、画面の表示も確認待ちのPush通知もこの報告から出る。
 *
 * **pollerの一括報告（`../route.ts`）とは別の入口。** あちらは「そのホストで今見えている
 * セッションの全て」を前提に、含まれない行を`GONE`へ倒す。フックの1件を同じ経路へ流すと
 * 他のセッションが全部消えたことになる。
 *
 * 認証は`/claim`・`/report`・`/hosts`・`/sessions`と同じ共有シークレット（`DISPATCH_SECRET`）。
 *
 * **失敗しても呼び出し側は実装を止めない。** `session-notify.sh`は何が起きても`exit 0`で返す
 * 約束なので、ここが落ちているときは画面にも通知にも出ないだけになる。
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
  const activity = parseDispatchSessionActivity(payload?.activity);
  // 形が想定外なら**受け付けずにnullへ倒す**（リクエスト自体は拒否しない）。URLが載らない
  // だけで、入力待ちであること自体は画面に出す価値がある
  const remoteControlUrl = parseRemoteControlUrl(payload?.remoteControlUrl);
  const previewUrl = parsePreviewUrl(payload?.previewUrl);
  // 自分で付けた`00.check-user`を解いてよいかどうか（#1342・#1417）。**判断はホスト側が持つ。**
  // 「このセッションがラベルを付けた」印はホストの状態ファイルにあり
  // （`scripts/lib/session-state.sh`の`.check-user`）、こちらはその報告を受け取るだけ。
  // `Stop`はturnごとに飛ぶため、無条件に外すと人が別の理由で付けた`00.check-user`まで落とす。
  // **キー名が`planResolved`のままなのは、サブPCとissue-deck本体のデプロイ順がずれても
  // 壊れないようにするため**（#1417で意味を計画以外の入力待ちにも広げた）
  const planResolved = payload?.planResolved === true;
  // セッションが入力待ちに入ったこと（#1417）。質問・権限の承認プロンプト・プレビューや
  // スクリーンショットの承認依頼は、ローカルセッションではどれもこの形になる
  const checkUserRequested = payload?.checkUserRequested === true;
  // 中身が1つも無いリクエストだけを拒む。**セッション起動時のプレビュー公開（#1265）と
  // APIエラーで中断したセッションの引き上げ（#1971・#2280）は`activity`を伴わない**ので、
  // そちらを必須にはできない（中断は「今どうしているか」を言えないまま`00.check-user`だけを
  // 付けに来る）
  if (
    !target ||
    (!activity && !remoteControlUrl && !previewUrl && !planResolved && !checkUserRequested)
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // **DBの更新より先に行う。** ラベルはGitHub側の状態で、画面の様子（DB）が書けたかどうかとは
  // 独立している。失敗しても報告自体は受け付ける（`postSessionPlan`と同じく例外は投げない）。
  // 付ける側と外す側は排他（フックが載せるイベントが別）だが、**両方来た場合は付ける方を
  // 後に実行して「確認待ちが残る」側へ倒す**。余分に残ったラベルは画面の承認ボタンで外せるが、
  // 付き損なうと人を待っていること自体が画面から消える
  if (planResolved) {
    await resolveSessionPlanCheckUser({
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
    });
  }

  if (checkUserRequested) {
    await requestSessionCheckUser({
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
    });
  }

  const result = await recordDispatchSessionActivity({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
    activity,
    remoteControlUrl,
    previewUrl,
  });

  // 対象の行が無い（pollerがまだ1巡していない）場合も200で返す。呼び出し側に再送の判断を
  // させないため。次のフックかpollerの1巡で載る
  return NextResponse.json(
    { ok: true, updated: result.updated },
    { headers: { "Cache-Control": "no-store" } },
  );
}
