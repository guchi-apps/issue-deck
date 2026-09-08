import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { parseDispatchHostName, parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import { enqueueSessionControlJob } from "@/lib/dispatch/jobs";
import { PR_FIX_SESSION_INSTRUCTION } from "@/lib/dispatch/pr-fix-request";
import { findDispatchSessionForIssue } from "@/lib/dispatch/sessions";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * マージ待ちの修正依頼を、走っているローカルセッションへ知らせる入口（#2919）。
 *
 * **押すのは人で、送られる本文は1つしかない**（`PR_FIX_SESSION_INSTRUCTION`）。人が書いた
 * 修正依頼は先にIssueコメントとして投稿されており、ここを通るのは「そのコメントを読め」という
 * 固定の1行だけ。送出は既存の追加指示（#1012）の`INSTRUCTION`ジョブをそのまま使うので、
 * pollerの3段階プロトコル（状態確認 → 本文のみ送出 → 反映の再確認 → 確定キーを別送）と、
 * 承認プロンプト・選択フォームの表示中は送らないという歯止めがそのまま効く
 * （`docs/multi-agent/gates.md`の例外2）。
 *
 * **`POST /api/dispatch`の`INSTRUCTION`と分けたのは、この経路だけが確認待ちを外すから**
 * （`session-recovery`と同じ理由）。任意の本文を送れるうえに`00.check-user`まで外れる操作に
 * すると、追加指示と分けた意味が消える。したがって本文は固定文面に限り、**生きていない
 * セッションでは断る**。
 *
 * **外すのは`succeeded`の報告が届いてから**（`POST /api/dispatch/report`が`recovery`の立った
 * `INSTRUCTION`を見る）。積んだ時点で外すと、pollerが見送ったときに何も届いていないのに
 * 札だけ消える（#2886のG1レビューと同じ指摘）。
 */
export async function POST(request: NextRequest) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const target = parseDispatchTarget(payload?.repository, payload?.issue);
  const hostName = parseDispatchHostName(payload?.hostName);
  if (!target || !hostName) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // **本文は固定文面そのものでなければ受けない。** 画面の言い分をそのまま流さないための
  // 一次の歯止めで、`session-recovery`が`isSessionStallRecoveryBody`で行っているのと同じ立場
  if (payload?.body !== PR_FIX_SESSION_INSTRUCTION) {
    return NextResponse.json(
      {
        error: "invalid_body",
        message: "この経路で送れるのは決まった1行だけです。任意の指示は「追加指示を送る」から送ってください。",
      },
      { status: 400 },
    );
  }

  // **セッションが生きているかはサーバー側で確かめ直す。** 画面が送り先を決めてから押されるまでの
  // 間にセッションが畳まれていることがあり、そのまま積むと届かない指示が枠を1つ埋める
  const session = await findDispatchSessionForIssue({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
  });
  if (!session || session.state !== "ALIVE") {
    return NextResponse.json(
      {
        error: "session_not_alive",
        message: "このIssueのセッションは動いていません（終了しているか、記録が残っていません）。",
      },
      { status: 409 },
    );
  }

  const result = await enqueueSessionControlJob({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
    hostName,
    kind: "INSTRUCTION",
    instruction: PR_FIX_SESSION_INSTRUCTION,
    // **届いたことを確かめてから確認待ちを外す**（#2886と同じ扱い）
    recovery: true,
    requestedByUserId: user.id,
  });
  if (!result.ok) {
    const status = result.rejection === "already_queued" ? 409 : 400;
    return NextResponse.json(
      { error: result.rejection, message: result.message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { ok: true, job: result.job },
    { headers: { "Cache-Control": "no-store" } },
  );
}
