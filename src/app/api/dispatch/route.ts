import { NextResponse, type NextRequest } from "next/server";

import { parseClaudeLocalModel } from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import {
  DEFAULT_DISPATCH_AGENT,
  isSessionControlJobKind,
  parseDispatchAgent,
  parseDispatchHostName,
  parseDispatchJobKind,
  parseDispatchTarget,
  parsePreviewAction,
  parseSessionInstruction,
} from "@/lib/dispatch/dispatch-job";
import {
  enqueueCodeReviewJob,
  enqueueCodexPairingJob,
  enqueueCrossRepoQuestionJob,
  enqueueDispatchJob,
  enqueueManualStepAbortJob,
  enqueueManualStepJob,
  enqueuePlanReviewJob,
  enqueuePreviewJob,
  enqueueRebootJob,
  enqueueSessionControlJob,
  enqueueSelfUpdateJob,
  listDispatchState,
} from "@/lib/dispatch/jobs";
import { parseRepositoryFullName } from "@/lib/local-session";
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

  // ホストの再起動（#2496）。**Issueもリポジトリも持たない**ので`SELF_UPDATE`の隣に置く。
  // 積めない理由（セッションが走っている・pollerが対応していない）は画面と同じ関数で判定し、
  // 本文で返す（`resolveRebootRejection`）。**押せる前提にはしない**——画面の申告は最大30秒古い
  if (kind === "REBOOT") {
    const rebootResult = await enqueueRebootJob({ hostName, requestedByUserId: userId });
    if (!rebootResult.ok) {
      return NextResponse.json(
        { error: rebootResult.rejection, message: rebootResult.message },
        { status: rebootResult.rejection === "already_queued" ? 409 : 400 },
      );
    }
    return NextResponse.json({ job: rebootResult.job }, { status: 201 });
  }

  // CodexのRemote Control相当（#2524）。**`REBOOT`と同じくIssueもリポジトリも持たない**
  // （`serverName`はホスト名で、Issueごとには分かれない）ので`target`の必須チェックより手前に置く。
  // 発行したコードは報告（`POST /api/dispatch/report`）で戻ってきて、ログイン必須のこの画面に
  // だけ出る
  if (kind === "CODEX_PAIRING") {
    const pairingResult = await enqueueCodexPairingJob({ hostName, requestedByUserId: userId });
    if (!pairingResult.ok) {
      return NextResponse.json(
        { error: pairingResult.rejection, message: pairingResult.message },
        { status: pairingResult.rejection === "already_queued" ? 409 : 400 },
      );
    }
    return NextResponse.json({ job: pairingResult.job }, { status: 201 });
  }

  // 確認環境（#2444）。**リポジトリは要るがIssueは持たない**ため、`target`の必須チェックより
  // 手前に置く（`SELF_UPDATE`と同じ理由）。`repository`だけを読み、`issue`は見ない。
  if (kind === "PREVIEW") {
    const repositoryFullName =
      typeof payload?.repository === "string" ? payload.repository.trim() : "";
    const action = parsePreviewAction(payload?.action);
    if (parseRepositoryFullName(repositoryFullName) === null || !action) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const previewResult = await enqueuePreviewJob({
      hostName,
      repositoryFullName,
      action,
      requestedByUserId: userId,
    });
    if (!previewResult.ok) {
      return NextResponse.json(
        { error: previewResult.rejection, message: previewResult.message },
        { status: previewResult.rejection === "already_queued" ? 409 : 400 },
      );
    }
    return NextResponse.json({ job: previewResult.job }, { status: 201 });
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

  // 手作業の代行実行（#1828）。**受け取るのは「どの手順か」と「人が承認したコマンド」、
  // それに「人が埋めた値」だけ**で、実際に実行するのは`enqueueManualStepJob`がIssue本文から
  // 抽出し直したもの。届いた文字列は「押した人が見ていたのはこれか」の照合にしか使わない。
  // 値（#2403）はコマンドの穴へ引用付きで差し込まれるだけで、構造を変えられない
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
      // **形の検査はここではしない**（#2403）。差し込んでよい形かどうかは
      // `normalizeManualStepPlaceholderValues`が1か所で決める（2か所に条件を置かない）
      placeholderValues: isPlainObject(payload?.placeholderValues)
        ? payload.placeholderValues
        : null,
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

  // リポジトリ全体のコードレビュー（#698）。**計画レビューと同じく`enqueueDispatchJob`とは
  // 別の関数へ振る**（対象リポジトリのcloneは要るが、動いているセッションでは弾かない）。
  // 押すのは人だけで、自動で積む経路は無い
  if (kind === "CODE_REVIEW") {
    const codeReviewResult = await enqueueCodeReviewJob({
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      hostName,
      requestedByUserId: userId,
    });
    if (!codeReviewResult.ok) {
      const status = codeReviewResult.rejection === "already_queued" ? 409 : 400;
      return NextResponse.json(
        { error: codeReviewResult.rejection, message: codeReviewResult.message },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { ok: true, job: codeReviewResult.job },
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

  // 起こすエージェントCLI（#2505）。**省略は既定（`claude`）＝従来どおり**で、指定した場合だけ
  // 既知の語に絞る。**未知の値は黙って既定へ落とさず400で断る**——Codexを指定したつもりで
  // Claude Codeが立つ方が、その場で断られるより分かりにくい（`agent_cli_resolve_kind`と同じ向き）
  const agent =
    payload?.agent === undefined ? DEFAULT_DISPATCH_AGENT : parseDispatchAgent(payload.agent);
  if (!agent) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // このIssueだけに使うClaudeのモデル（#2717）。**省略は「設定の既定に従う」**で従来どおり。
  // `agent`と同じく**未知の値は黙って既定へ落とさず400で断る**——Fableを指定したつもりで
  // Sonnetが立つ方が、その場で断られるより分かりにくい
  const claudeModel = payload?.model === undefined ? null : parseClaudeLocalModel(payload.model);
  if (payload?.model !== undefined && !claudeModel) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await enqueueDispatchJob({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
    hostName,
    agent,
    claudeModel,
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

/** 素のオブジェクト（配列・nullではない）か。埋めた値のマップを受け取る前の形の確認だけを行う */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
