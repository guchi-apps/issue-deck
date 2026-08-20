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
  enqueueManualStepAbortJob,
  enqueueManualStepJob,
  enqueuePlanReviewJob,
  enqueueSessionControlJob,
  enqueueSelfUpdateJob,
  listDispatchState,
} from "@/lib/dispatch/jobs";
import { MANUAL_STEP_COMMAND_MAX_LENGTH } from "@/lib/manual-step-command";
import { listManualStepRunViews } from "@/lib/manual-step-run";
import { runManualStepVerificationPatrol } from "@/lib/manual-step-verification-patrol";
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

  // 手作業Issueの完了確認の定期巡回（#2008）を、この読み取りのついでに1歩進める。
  // **常駐プロセスは置かない**（`expireStaleDispatchJobs`と同じ方針）。1日1回で足りる
  // 巡回のために、動かす仕組みを別に用意する理由が無い。
  // **失敗しても状態の取得は続ける**——巡回はあれば嬉しい程度のもので、画面を止める理由にしない
  try {
    await runManualStepVerificationPatrol();
  } catch (error) {
    console.error("[GET /api/dispatch] 完了確認の巡回を進められませんでした:", error);
  }

  // 手作業アシスタントの自動実行（#1882）も同じ応答に載せる。**取得口を増やさない**
  // （セッション・#1217と同じ理由で、分けると同じ画面のためにポーリングが2本走る）。
  // **`listDispatchState`の中では呼ばない**——あちらを呼ぶのは自動実行の側（ジョブを積む）で、
  // 逆向きの参照を足すと相互参照になる
  const [state, manualStepRuns] = await Promise.all([
    listDispatchState(),
    listManualStepRunViews(),
  ]);
  return NextResponse.json(
    { ...state, manualStepRuns },
    { headers: { "Cache-Control": "no-store" } },
  );
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
 * `manual_step`（#1828）も受け付ける。**画面から届いたコマンド文字列は照合にしか使わず**、
 * 実行するのはサーバーが手作業Issueの本文から抽出し直したもの。
 * `plan_review`（#1855）も受け付ける。**こちらの主経路は自動起動**（計画コメントの投稿を契機に
 * `postSessionPlan`が積む）で、ここは自動で走らなかったとき・計画を直してもう一度かけたいときに
 * 人が押す入口。
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
  if (!hostName || !kind) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // チェックアウトの更新（#1875）は**ホストに対する操作でIssueを持たない**。
  // 他の種別より先に返し、`target`の必須チェックから外す。
  if (kind === "SELF_UPDATE") {
    const result = await enqueueSelfUpdateJob({ hostName, requestedByUserId: userId });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.rejection, message: result.message },
        { status: 409 },
      );
    }
    return NextResponse.json({ job: result.job }, { status: 201 });
  }

  if (!target) {
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

  // 手作業の代行実行（#1828）。**受け取るのは「どの手順か」と「人が承認したコマンド」だけ**で、
  // 実際に実行するのは`enqueueManualStepJob`がIssue本文から抽出し直したもの。届いた文字列は
  // 「押した人が見ていたのはこれか」の照合にしか使わない
  if (kind === "MANUAL_STEP") {
    const stepLine = payload?.stepLine;
    const approvedCommand = payload?.command;
    if (
      typeof stepLine !== "number" ||
      !Number.isInteger(stepLine) ||
      stepLine < 1 ||
      typeof approvedCommand !== "string" ||
      approvedCommand === "" ||
      approvedCommand.length > MANUAL_STEP_COMMAND_MAX_LENGTH
    ) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }

    const manualStepResult = await enqueueManualStepJob({
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      hostName,
      stepLine,
      approvedCommand,
      requestedByUserId: userId,
    });
    if (!manualStepResult.ok) {
      const status = manualStepResult.rejection === "already_queued" ? 409 : 400;
      return NextResponse.json(
        { error: manualStepResult.rejection, message: manualStepResult.message },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { ok: true, job: manualStepResult.job },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // 走っている代行実行の中断（#1882）。**止める対象はジョブのidで指す**（コマンドは渡さない。
  // pollerがユニット名を組み立て直して止めるので、任意の`systemctl stop`を流す口にならない）
  if (kind === "MANUAL_STEP_ABORT") {
    const targetJobId = payload?.targetJobId;
    if (typeof targetJobId !== "string" || targetJobId === "") {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const abortResult = await enqueueManualStepAbortJob({
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      hostName,
      targetJobId,
      requestedByUserId: userId,
    });
    if (!abortResult.ok) {
      const status = abortResult.rejection === "already_queued" ? 409 : 400;
      return NextResponse.json(
        { error: abortResult.rejection, message: abortResult.message },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { ok: true, job: abortResult.job },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // 計画レビュー（G1・#1855）。**動いているセッションでは弾かない**（計画を出したセッションは
  // 承認待ちで生きているのが常態）ので、`enqueueDispatchJob`とは別の関数へ振る。
  // ここは人が押したときの経路で、自動起動（計画コメントの投稿）は`postSessionPlan`が直接積む
  if (kind === "PLAN_REVIEW") {
    const planReviewResult = await enqueuePlanReviewJob({
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      hostName,
      requestedByUserId: userId,
    });
    if (!planReviewResult.ok) {
      const status = planReviewResult.rejection === "already_queued" ? 409 : 400;
      return NextResponse.json(
        { error: planReviewResult.rejection, message: planReviewResult.message },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { ok: true, job: planReviewResult.job },
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
