import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import {
  parseDispatchHostName,
  parseDispatchTarget,
  parseSessionInstruction,
} from "@/lib/dispatch/dispatch-job";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { enqueueSessionControlJob } from "@/lib/dispatch/jobs";
import { buildSessionRecoveryCommentBody } from "@/lib/dispatch/session-escalation";
import { describeSessionStall, isSessionStallRecoveryBody } from "@/lib/dispatch/session-stall";
import { findDispatchSessionForIssue } from "@/lib/dispatch/sessions";
import { createComment } from "@/lib/github/issues-api";
import { posterMarker } from "@/lib/github/project-status-dispatch";
import { parseRepositoryFullName } from "@/lib/local-session";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 停滞したセッションへ固定の復旧文面を送る入口（#2886）。
 *
 * **押すのは人。** ここが受け取るのは「どの原因の、どの固定文面を押したか」だけで、状況を
 * 読んで本文を組み立てる余地はどこにも無い（文面の正は`session-stall.ts`）。送出は既存の
 * 追加指示（#1012）の`INSTRUCTION`ジョブをそのまま使うので、pollerの3段階プロトコル
 * （状態確認 → 本文のみ送出 → 反映の再確認 → 確定キーを別送）と、承認プロンプト・選択
 * フォームの表示中は送らないという歯止めがそのまま効く（`docs/multi-agent/gates.md`の例外2）。
 *
 * **`POST /api/dispatch`の`INSTRUCTION`と分けたのは、この経路だけが確認待ちを外すから。**
 * 任意の本文を送れるうえに`00.check-user`まで外れる操作にすると、追加指示と分けた意味が
 * 消える。したがって本文は固定文面のどれかに限り、**停滞していないセッションでは断る**。
 *
 * 認証はSupabaseのログインセッション（`plan-decision`・`question-answer`と同じ）。サブPC側が
 * 叩く`sessions/`配下だけが共有シークレット認証で、経路ごとに認証の境界を分けている。
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
  // 本文の形（1行・制御文字なし・長さ）は追加指示と同じ関数で見る。中身が固定文面かどうかは
  // セッションの原因が分かってから確かめる
  const body = parseSessionInstruction(payload?.body);
  if (!target || !hostName || !body) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // **停滞しているかはサーバー側で確かめ直す**（画面の言い分をそのまま信じない）。
  // 判定は画面と同じ関数を使う——片方だけ緩いと、押せたのに断られる・断られるはずが通る
  const session = await findDispatchSessionForIssue({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
  });
  const stall = session ? describeSessionStall(session) : null;
  if (!stall) {
    return NextResponse.json(
      {
        error: "not_stalled",
        message: "このIssueのセッションは停滞していません（もう動き出しているか、終了しています）。",
      },
      { status: 409 },
    );
  }
  if (!isSessionStallRecoveryBody(stall.reason, body)) {
    return NextResponse.json(
      {
        error: "invalid_body",
        message: "この原因に用意されていない文面です。任意の指示は「追加指示を送る」から送ってください。",
      },
      { status: 400 },
    );
  }

  const result = await enqueueSessionControlJob({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
    hostName,
    kind: "INSTRUCTION",
    instruction: body,
    // **復旧として積む**（#2886）。pollerが許可する状態イベントに`working`を足し（APIエラーで
    // 中断したセッションは`Stop`が飛ばないまま止まるため）、`succeeded`の報告を受けた時点で
    // 確認待ちが外れる
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

  // **押したことをIssueへ残す**（引き上げのコメントと対にする）。**失敗しても成功として返す**
  // ——指示はもうキューに入っていてセッションへ届くので、ここで失敗を返すと押し直すことになる
  await recordRecoveryComment({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
    body,
    login: user.githubLogin,
  });

  // **確認待ちはここでは外さない**（#2886のG1レビュー）。送出は非同期で、承認プロンプトの
  // 表示中・作業中・入力欄に打ちかけがある場合はpollerが見送る（5通りある）。積んだ時点で
  // 外すと、何も届いていないのに札だけ消えてPush通知も一覧の印も無いまま放置される。
  // 外すのは`POST /api/dispatch/report`が`succeeded`を受けた時点（`recovery`が立った
  // `INSTRUCTION`ジョブに限る）。
  return NextResponse.json(
    { ok: true, job: result.job },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function recordRecoveryComment(params: {
  repositoryFullName: string;
  issueNumber: number;
  body: string;
  login: string;
}): Promise<void> {
  const parsed = parseRepositoryFullName(params.repositoryFullName);
  if (!parsed) return;

  try {
    const token = await resolveInstallationToken(params.repositoryFullName);
    if (!token) return;
    await createComment(parsed.owner, parsed.repo, params.issueNumber, token, {
      body: buildSessionRecoveryCommentBody({
        body: params.body,
        posterMarker: posterMarker(params.login),
      }),
    });
  } catch (error) {
    console.error(
      `[dispatch] 復旧文面の送信をIssueへ残せませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
  }
}
