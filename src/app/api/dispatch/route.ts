import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import {
  isSessionControlJobKind,
  parseDispatchHostName,
  parseDispatchJobKind,
  parseDispatchTarget,
  parseSessionInstruction,
} from "@/lib/dispatch/dispatch-job";
import {
  enqueueCrossRepoQuestionJob,
  enqueueDispatchJob,
  enqueueSessionControlJob,
  listDispatchState,
} from "@/lib/dispatch/jobs";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * サブPCへのディスパッチ（#1179）の、画面側から使う入口。
 *
 * 方式はpull型で、ここはジョブを**置くだけ**。サブPCのpollerが
 * `POST /api/dispatch/claim`で取りに来る（VPSがtailnetに参加しておらず、Tailscale SSHに
 * forced commandが無いためpush型は採れない。#1176）。
 *
 * 認証はSupabaseのログインセッション。サブPC側の3本（claim・report・hosts）だけが
 * 共有シークレット認証で、そちらとは値も経路も分けている。
 */

/**
 * ディスパッチの状態一式（ホストの申告・未完了ジョブ・直近の終了ジョブ・同時実行数）。
 * #1180の起動先選択と状態表示がこれを読む。
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const state = await listDispatchState();
  return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
}

/**
 * ジョブを積む。
 *
 * **実行できない組み合わせは積む前に弾き、理由を本文で返す**（「ディスパッチ前に弾く」。
 * #1179のコメント）。無言で失敗すると、無人実行では何も起きないまま終わってしまう。
 *
 * `kind`（#1332）を省略すると従来どおりの起動ジョブ。`interrupt`・`kill`・`instruction`（#1012）は
 * 既に立っているセッションへの操作で、**同じ経路に載せる**（受信経路・認証・状態報告を増やさないため）。
 * `instruction`のときは本文（`instruction`）が要り、`parseSessionInstruction`を通らなければ400。
 * `question`（#1294）は種別としては存在するが、**まだここでは受け付けない**（実行するpollerが
 * 無い段階で積めるようにすると、`QUEUED`のまま誰も取りに来ないジョブが残る。開けるのはStep 3）。
 * `cross_repo_question`（#1454）は受け付ける。こちらはpoller側の実行（`start-cross-repo-question.sh`）と
 * 対応の申告（`crossRepoQuestion`）が揃っており、申告のあるホストにしか払い出さない。
 */
export async function POST(request: NextRequest) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const target = parseDispatchTarget(payload?.repository, payload?.issue);
  const hostName = parseDispatchHostName(payload?.host);
  const kind = parseDispatchJobKind(payload?.kind);
  if (!target || !hostName || !kind) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // 質問ジョブ（#1294）を積む経路はまだ無い（種別と保存の形だけを先に入れている）。
  // 受け口をここで開けると、実行するpollerが無いまま`QUEUED`のジョブだけが積まれる
  if (kind === "QUESTION") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // 横断質問（#1454）。**起動ジョブとは判定が違う**（記録先リポジトリがサブPCにcloneされて
  // いる必要は無く、代わりに参照できるリポジトリが1件以上あることとpollerの対応を見る）ため、
  // `enqueueDispatchJob`とは別の関数へ振る
  if (kind === "CROSS_REPO_QUESTION") {
    const questionResult = await enqueueCrossRepoQuestionJob({
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      hostName,
      requestedByUserId: userId,
    });
    if (!questionResult.ok) {
      const status = questionResult.rejection === "already_queued" ? 409 : 400;
      return NextResponse.json(
        { error: questionResult.rejection, message: questionResult.message },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { ok: true, job: questionResult.job },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (isSessionControlJobKind(kind)) {
    // 追加指示（#1012）の本文はここで検証する。**pollerでも同じ検証を重ねる**が、
    // 弾いた理由を人へ返せるのは押した側のこちらだけ（pollerが弾くと、届いてから
    // 最大1分後にジョブの失敗として出る）
    let instruction: string | null = null;
    if (kind === "INSTRUCTION") {
      instruction = parseSessionInstruction(payload?.instruction);
      if (!instruction) {
        return NextResponse.json({ error: "invalid_instruction" }, { status: 400 });
      }
    }

    const controlResult = await enqueueSessionControlJob({
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      hostName,
      kind,
      instruction,
      requestedByUserId: userId,
    });
    if (!controlResult.ok) {
      const status = controlResult.rejection === "already_queued" ? 409 : 400;
      return NextResponse.json(
        { error: controlResult.rejection, message: controlResult.message },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { ok: true, job: controlResult.job },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await enqueueDispatchJob({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
    hostName,
    requestedByUserId: userId,
  });

  if (!result.ok) {
    // 既にジョブがある場合だけ409。それ以外は「今は投げられない」なので400で理由を返す
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
