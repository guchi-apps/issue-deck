"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  ClipboardCheck,
  ExternalLink,
  LayoutTemplate,
  Keyboard,
  Loader2,
  Pencil,
  ScrollText,
  TriangleAlert,
} from "lucide-react";

import { ModelChip } from "@/components/dashboard/agent-model-chips";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { MentionTextarea } from "@/components/dashboard/mention-textarea";
import { PlanReviewFindings } from "@/components/dashboard/plan-review-findings";
import { Button } from "@/components/ui/button";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { resolvePlanReviewJobPhase, type DispatchJobView } from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  PLAN_ARTIFACT_REQUEST_TEXT,
  SESSION_PLAN_REVISION_MAX_ATTACHMENTS,
  SESSION_PLAN_REVISION_MAX_LENGTH,
} from "@/lib/dispatch/session-plan-request";
import type { SessionPlanRequestView } from "@/lib/dispatch/session-plan-request";
import { summarizeIssueSession } from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { formatRemaining, useRemainingMs } from "@/components/dashboard/use-remaining-ms";
import { formatRelativeDate } from "@/lib/format-relative-date";
import type { PendingPlanReview, PlanReviewNotice } from "@/lib/github/plan-review";
import { splitAttachments } from "@/lib/markdown-attachments";
import {
  CODEX_LOCAL_MODEL_VALUES,
  CODEX_MODEL_FIT_LABELS,
  describeCodexModel,
} from "@/lib/app-settings";

/**
 * ローカルセッションが提示した計画を読んで、その場で承認・修正を送るパネル（#2061）。
 *
 * **これまで、計画の承認・修正はRemote Controlからしか送れなかった。** 計画はIssueコメントに
 * 残る（#1342）ので読むことはできたが、画面に出ていたのは
 * 「承認・修正はRemote Controlから伝えてください」という案内だけ（`LocalSessionWaitingInputNotice`）で、
 * スマホから承認するにも一度Remote Controlを開いてTUIを操作する必要があった。
 *
 * **端末へキーを送る経路（`send-keys`）は持たない。** ここが押された内容はサーバーの
 * `SessionPlanRequest`に入り、計画を出した`PreToolUse(ExitPlanMode)`フックがそれを受け取って
 * Claude Code自身の許可判定として返す（`src/lib/dispatch/session-plan-request.ts`）。
 * 選択フォームに答えさせる操作はどこにも無いので、
 * [docs/multi-agent/gates.md](../../../docs/multi-agent/gates.md)の禁止に触れない。
 *
 * **押せない状態でもボタンを消さずに理由を出す**（起動ボタン・代行実行と同じ作法）。
 * 待ち時間が切れた・セッションが終了した、のどちらなのかが分からないと、人は次に
 * どこで答えればよいかを判断できない。
 *
 * **PC・スマホで同じコンポーネントを使う**（`manual-step-run-panel.tsx`と同じ方針）。
 * ボタンはスマホで縦積み・全幅になる。
 */

/** 折り畳んだときに見せる高さ。計画は30〜40行が目安なので、要約が読み切れるくらいに取る */
const COLLAPSED_PLAN_CLASS = "max-h-72 overflow-hidden";

export function PlanApprovalPanel({
  request,
  session,
  dispatch,
  onCheckUserResolved,
  artifactsMissing = false,
  planReview = null,
  planReviewNotice = null,
  planReviewJob = null,
}: {
  request: SessionPlanRequestView;
  /** 計画を出したセッション。見つかっていなければ`null` */
  session: DispatchSessionView | null;
  dispatch: DispatchStateHandle;
  /**
   * 承認・修正を送って確認待ちが解けたときに呼ぶ（#2341）。**サーバーが`00.check-user`と
   * 理由ラベルを外すのと同じことを、手元のIssueにも先に反映させる**ためのもの——
   * Issue一覧のポーリングは10秒間隔で、押した直後の画面にはラベルも
   * 「計画の承認が必要です」のカードも残ったままになる。
   * 「端末・Remote Controlで答える」では呼ばない（人はまだ答えていない）。
   */
  onCheckUserResolved?: () => void;
  /**
   * このIssueに見た目のアーティファクトが1件も無いと確かめられているとき`true`（#3493）。
   * 読み込み中・取得失敗は`false`にして、無いと決めつけない。
   */
  artifactsMissing?: boolean;
  /**
   * 計画の後に届いていて未反映の計画レビュー（#3521・#3554）。無ければ`null`。
   * 指摘ごとのカードにして、承認・修正のボタンより上に出す
   */
  planReview?: PendingPlanReview | null;
  /** 計画レビューの省略・打ち止め・未解消の記録（#3765）。レビューが無い理由を示し、待たせない */
  planReviewNotice?: PlanReviewNotice | null;
  /**
   * この計画に対して積まれている計画レビュー（G1）ジョブ。無ければ`null`（#3565）。
   * `resolvePlanReviewJobPhase`で「起動待ち」「作成中」かを判定し、承認パネルのヘッダー直下へ出す。
   */
  planReviewJob?: DispatchJobView | null;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRevising, setIsRevising] = useState(false);
  const [revision, setRevision] = useState("");
  // 画像のアップロード中に送ると、まだURLの入っていない本文がClaudeへ渡る（#2425）
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  // nullは元の会話をそのまま続ける（既定）。モデルを入れたときだけ新しい会話へ引き継ぐ。
  const [handoffModel, setHandoffModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 押した結果は**どの計画に対して押したのか**まで持つ（#2158）。`"approve"`だけを覚えると、
  // 別の計画に差し替わってもその表示が残り、**押していない計画に「承認を送りました」が出る**
  // （Issue詳細はIssueを切り替えてもマウントされたままで、計画を出し直したときも同じ）
  const [sent, setSent] = useState<{
    requestId: string;
    decision: "approve" | "revise" | "defer";
  } | null>(null);

  // 押した結果はカウントダウンと同じ1秒刻みで見せる。**返事はサーバーに入っているので、
  // 画面のポーリングが追い付く前でも「送った」ことは確定している**
  const remainingMs = useRemainingMs(request.expiresAt);

  const hostLabel = request.hostName ? formatDispatchHostName(request.hostName) : "ローカル";
  const sessionGone = session !== null && session.state !== "ALIVE";
  // 「ここからは送れない」と言うだけでは、どこで答えればよいのかが画面から辿れない（#2108）
  const remoteControlUrl = session ? summarizeIssueSession(session).remoteControlUrl : null;

  async function send(decision: "approve" | "revise" | "defer", text?: string) {
    setError(null);
    const result = await dispatch.decidePlan({
      id: request.id,
      decision,
      text: decision === "revise" ? (text ?? revision) : undefined,
      ...(decision === "approve" && handoffModel ? { handoffModel } : {}),
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSent({ requestId: request.id, decision });
    setIsRevising(false);
    if (decision !== "defer") onCheckUserResolved?.();
  }

  // 送った直後、または他の経路（フックの受け取り・期限切れ）で決まった後の表示。
  // **押した本人が「効いたのか」を確かめられれば足りる**ので、結果だけを出して枠を畳む。
  // **いま出ている計画に対して押したものだけを見る**（#2158。別の計画の結果は持ち越さない）
  const sentForThisRequest = sent?.requestId === request.id ? sent.decision : null;
  const decided = sentForThisRequest ?? decisionOf(request.status);
  if (decided) {
    return (
      <PlanDecisionResult
        decision={decided}
        hostLabel={hostLabel}
        remoteControlUrl={remoteControlUrl}
        autoReflected={request.autoReflected === true && sentForThisRequest === null}
        deliveryStatus={request.deliveryStatus}
        deliveryExitCode={request.deliveryExitCode}
        deliverySummary={request.deliverySummary}
      />
    );
  }

  const canSend = !sessionGone && remainingMs > 0;
  // 指摘コメントが届いていない間だけ、ジョブの状態から「作成中」を出す（#3565）。
  // 届いた後は下の`PlanReviewFindings`カードがそちらを表す。
  // **起動待ち（`QUEUED`）は作成中と分けて出す**（#3772）。サブPCが空きを待っている間も
  // 「作成中」と出していたため、5時間超その表示のままになっていた
  const planReviewPhase =
    planReview === null ? resolvePlanReviewJobPhase(planReviewJob ?? null, new Date()) : null;
  const planReviewCreating = planReviewPhase === "creating" || planReviewPhase === "queued";
  // 計画レビューの作成中は、オレンジの承認枠ごと出さず作成中カードだけを出す（#3726）。
  // 採否が決まるまで人が押す場面が無く、Push通知も保留している間なので、目を引く枠は要らない。
  // 完成後は`PlanReviewFindings`カードと承認枠へ入れ替わる（#3573）
  if (planReviewCreating) {
    return (
      <section
        className="w-full overflow-hidden rounded-md border bg-card"
        aria-label="計画レビュー"
      >
        <div className="flex items-center gap-1.5 border-b bg-blue-500/10 px-3 py-2 text-sm font-semibold text-blue-700 dark:text-blue-300">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {planReviewPhase === "queued" ? "計画レビューの起動を待っています" : "計画レビューを作成中"}
        </div>
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {planReviewPhase === "queued" &&
            "サブPCが計画レビューを取りに来るのを待っています（通常1分以内）。10分を超えても起動しないときは、このまま計画を承認・修正できるようにします。"}
          届くとJevが重大な指摘を採用するか判断し、採用なら自動で計画へ反映します（反映後の解消確認は1回だけで、自動の見直しはそこで終わります。不採用・判断できないとき、人が選ぶ「判断」を含むレビューは、ここで選んでもらいます）。採否が決まるまでPush通知は送りません。
        </p>
      </section>
    );
  }

  const planReviewHasFindings =
    planReview !== null &&
    (planReview.review.findings.length > 0 || !planReview.review.noFindings);
  // 推奨が「このまま承認」で、人が選ぶ判断が残っていないときだけ承認を主ボタンにする（#3670）
  const approveRecommended =
    planReview !== null &&
    planReview.review.recommendation?.kind === "approve" &&
    planReview.review.decisions.length === 0;
  const canHandoff = session !== null && session.codexThreadKnown !== null;
  // **数えるのは人が書いた文章だけ**（#2425）。末尾の画像記法は添付なので枚数で見る
  // （サーバー側の`parseSessionPlanRevision`と同じ勘定にしておかないと、押せたのに400で弾かれる）
  const { body: revisionBody, attachments: revisionAttachments } = splitAttachments(revision);
  const tooManyAttachments = revisionAttachments.length > SESSION_PLAN_REVISION_MAX_ATTACHMENTS;

  return (
    <section className="overflow-hidden rounded-md border border-amber-500/50 bg-card">
      <header className="flex items-start gap-2.5 border-b border-amber-500/50 bg-amber-500/10 p-3">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-amber-500/80 text-amber-950">
          <ScrollText className="size-3.5" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-400">
            計画の承認を待っています
          </h3>
          <p className="text-xs text-muted-foreground">
            {hostLabel}のセッションが{formatRelativeDate(request.createdAt)}に提示しました
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-sm font-medium tabular-nums text-amber-700 dark:text-amber-400">
            {formatRemaining(remainingMs)}
          </div>
          <div className="text-[10px] text-muted-foreground">あと</div>
        </div>
      </header>

      <div className="flex flex-col gap-3 p-3">
        {planReviewPhase === "queued_overdue" && (
          // 起動待ちが猶予を超えた（#3772）。待っていても届く時刻が読めないので、承認枠を出して
          // 人に委ねる。ジョブは残っているので、起動すれば指摘のカードへ切り替わる
          <p className="flex items-center gap-1.5 rounded-md border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
            計画レビューがサブPCの空きを待っていて、まだ起動していません。届くのを待たずに承認・修正することもできます。
          </p>
        )}
        <div className="relative rounded-md border bg-muted/60 px-3 py-2">
          <div className={isExpanded ? undefined : COLLAPSED_PLAN_CLASS}>
            <MarkdownBody content={request.plan} repositoryFullName={request.repositoryFullName} />
          </div>
          {!isExpanded && (
            <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-b from-transparent to-muted pt-8 pb-2">
              <Button variant="outline" size="sm" onClick={() => setIsExpanded(true)}>
                <ChevronDown />
                全文を表示
              </Button>
            </div>
          )}
        </div>

        {isRevising ? (
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium" htmlFor={`plan-revision-${request.id}`}>
              修正してほしいこと
            </label>
            {/* **素の`Textarea`ではなく`MentionTextarea`を使う**（#2425）。貼り付け・
                ドラッグ&ドロップ・「画像を添付」がそのまま手に入り、画面の見た目を直して
                ほしいときに「こうしたい」を1枚で渡せる。文章で書き起こすより速くて正確 */}
            <MentionTextarea
              id={`plan-revision-${request.id}`}
              value={revision}
              onChange={setRevision}
              onUploadingChange={setIsUploadingImage}
              repositoryFullName={request.repositoryFullName}
              maxLength={SESSION_PLAN_REVISION_MAX_LENGTH}
              rows={4}
              placeholder="どこを・なぜ・どう直してほしいかを書いてください。この文がそのままClaudeへ渡ります。画像はここへ貼り付け・ドロップできます。"
            />
            {tooManyAttachments && (
              <p className="flex items-start gap-1.5 text-xs text-destructive">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                添付できる画像は{SESSION_PLAN_REVISION_MAX_ATTACHMENTS}枚までです。
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {revisionBody.length} / {SESSION_PLAN_REVISION_MAX_LENGTH}
                {revisionAttachments.length > 0 && (
                  <span className={tooManyAttachments ? "ml-1.5 text-destructive" : "ml-1.5"}>
                    画像{revisionAttachments.length}枚
                  </span>
                )}
              </span>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setIsRevising(false)}>
                  やめる
                </Button>
                <Button
                  size="sm"
                  disabled={
                    !canSend ||
                    dispatch.isSubmitting ||
                    isUploadingImage ||
                    tooManyAttachments ||
                    revision.trim().length === 0
                  }
                  onClick={() => void send("revise")}
                >
                  {dispatch.isSubmitting ? <Loader2 className="animate-spin" /> : <Pencil />}
                  修正を送る
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {planReview === null && planReviewNotice && (
              <p
                role="status"
                className="w-full rounded-md border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
              >
                {planReviewNotice.kind === "skipped" ? "レビュー省略: " : ""}
                {planReviewNotice.text}
              </p>
            )}
            {planReview && (
              /* 指摘を読んで、どれを取り込ませるかをここで決める（#3554）。承認・修正のボタンより
                 上に置く——読んでから押す順にする */
              <div className="w-full">
                <PlanReviewFindings
                  key={planReview.commentId}
                  review={planReview.review}
                  reviewedAtLabel={planReview.createdAtLabel}
                  round={planReview.round}
                  kind={planReview.kind}
                  repositoryFullName={request.repositoryFullName}
                  submitLabel="選んだ指摘で計画を出し直す"
                  remainingMs={remainingMs}
                  fallbackSubmitLabel="レビューを反映して計画を出し直す"
                  disabled={!canSend || dispatch.isSubmitting}
                  isSubmitting={dispatch.isSubmitting}
                  deemphasizeSubmit={approveRecommended}
                  approveHint="下の「承認して実装へ進む」を押す"
                  unavailable={sessionGone ? "session-gone" : remainingMs <= 0 ? "expired" : undefined}
                  onSubmit={(text) => send("revise", text)}
                />
              </div>
            )}
            {session && !sessionGone && canHandoff && (
              <div className="w-full rounded-md border bg-muted/40 p-3">
                <p className="text-xs font-medium">実装に使うモデル</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  同じ会話を続けると計画時の文脈とキャッシュを保てます。切り替えると軽いモデルで始められますが、新しい会話になるため直近のやり取りの抜粋とブランチ状態を引き継ぎます。
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={handoffModel === null ? "default" : "outline"}
                    onClick={() => setHandoffModel(null)}
                  >
                    同じモデルで継続（推奨）
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={handoffModel === null ? "outline" : "default"}
                    onClick={() => setHandoffModel("gpt-5.6-terra")}
                  >
                    軽いモデルへ引き継ぐ
                  </Button>
                </div>
                {handoffModel && (
                  <div className="mt-2" role="radiogroup" aria-label="引き継ぎ先のモデル">
                    <p className="mb-1.5 text-xs text-muted-foreground">引き継ぎ先</p>
                    <div className="grid grid-cols-2 gap-2">
                      {CODEX_LOCAL_MODEL_VALUES.map((model) => (
                        <ModelChip
                          key={model}
                          label={describeCodexModel(model)}
                          fit={CODEX_MODEL_FIT_LABELS[model]}
                          selected={handoffModel === model}
                          onSelect={() => setHandoffModel(model)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <Button
              size="sm"
              /* 反映させる指摘が残っているときは、出し直しを主ボタンにする。ただし推奨が
                 「このまま承認」なら承認を主ボタンにしてリングで強調する（#3670） */
              variant={planReviewHasFindings && !approveRecommended ? "outline" : "default"}
              className={approveRecommended ? "ring-2 ring-emerald-500 ring-offset-2 ring-offset-background" : undefined}
              disabled={!canSend || dispatch.isSubmitting}
              onClick={() => void send("approve")}
            >
              {dispatch.isSubmitting ? <Loader2 className="animate-spin" /> : <Check />}
              承認して実装へ進む
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canSend || dispatch.isSubmitting}
              onClick={() => setIsRevising(true)}
            >
              <Pencil />
              修正を送る
            </Button>
            {artifactsMissing && (
              <Button
                variant="outline"
                size="sm"
                disabled={!canSend || dispatch.isSubmitting}
                onClick={() => void send("revise", PLAN_ARTIFACT_REQUEST_TEXT)}
              >
                <LayoutTemplate />
                アーティファクトの作成を依頼
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={!canSend || dispatch.isSubmitting}
              onClick={() => void send("defer")}
            >
              <Keyboard />
              端末・Remote Controlで答える
            </Button>
          </div>
        )}

        {sessionGone && planReview === null && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            このセッションは終了しています。承認・修正は届きません。続きを頼むには
            「セッションを復旧」から起こし直してください。
          </p>
        )}
        {error && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * 判断が実際にセッションへ届いたかの1行。**待ち受けの形がエージェントで違う**ので、
 * ここも2系統になる。
 *
 * - Claude Code: フックが`GET …/plan/decision`で取りに来て、処理の結果を`report_delivery`で
 *   返す（`PROCESSED`・`PROCESS_FAILED`・`COMMUNICATION_FAILED`・`DECISION_OBSERVED`）
 * - Codex: 取りに来ない（#3218）。issue-deckが`INSTRUCTION`ジョブを積めたかだけを書く
 *   （`CODEX_QUEUED`・`CODEX_QUEUE_FAILED`。`src/lib/dispatch/codex-decision-notify.ts`）
 */
function describeDelivery(
  status: string | null | undefined,
  exitCode: number | null | undefined,
  summary: string | null | undefined,
): string {
  switch (status) {
    case "CODEX_QUEUED":
      return "Codexのセッションへ継続指示を積みました。次のターンで再開します。";
    case "CODEX_QUEUE_FAILED":
      return `Codexのセッションへ継続指示を積めませんでした（${summary ?? "理由不明"}）。端末から続きを指示してください。`;
    case "PROCESSED":
      return "サブPCのセッション側から処理完了の報告を受けました。";
    case "PROCESS_FAILED":
      return `サブPCは判断を取得しましたが、セッション処理が失敗しました（終了コード: ${exitCode ?? "不明"}）。`;
    case "COMMUNICATION_FAILED":
      return "サブPCとの通信に失敗したため、判断の処理結果を確認できません。";
    case "DECISION_OBSERVED":
      return "サブPCが判断を取得しました。セッション側の処理完了報告を待っています。";
    default:
      return "サブPCからの取得・処理完了報告を待っています。";
  }
}

function PlanDecisionResult({
  decision,
  hostLabel,
  remoteControlUrl,
  autoReflected,
  deliveryStatus,
  deliveryExitCode,
  deliverySummary,
}: {
  decision: "approve" | "revise" | "defer" | "expired";
  hostLabel: string;
  /** 端末で答えることになったときの行き先。無ければリンクを出さない */
  remoteControlUrl: string | null;
  /** 計画レビューを受けて自動で修正を送った回（人が押した回ではない） */
  autoReflected?: boolean;
  deliveryStatus?: string | null;
  deliveryExitCode?: number | null;
  deliverySummary?: string | null;
}) {
  const tone =
    decision === "approve"
      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : decision === "defer" || decision === "expired"
        ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "border-border bg-muted text-muted-foreground";

  const answerElsewhere = decision === "defer" || decision === "expired";

  return (
    <section className={`flex flex-col gap-2 rounded-md border p-3 text-xs ${tone}`}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          {decision === "approve" ? (
            <ClipboardCheck className="size-3.5" aria-hidden />
          ) : decision === "revise" ? (
            <Pencil className="size-3.5" aria-hidden />
          ) : (
            <Keyboard className="size-3.5" aria-hidden />
          )}
        </span>
        <span className="leading-relaxed">
          {decision === "approve" && (
            <>
              <strong className="font-semibold">承認を送りました。</strong>
              {hostLabel}のセッションが実装に入ります。この結果はIssueコメントにも残しました。
            </>
          )}
          {decision === "revise" && (
            <>
              <strong className="font-semibold">
                {autoReflected ? "計画レビューの指摘を自動で反映しました。" : "修正を送りました。"}
              </strong>
              計画を練り直しています。新しい計画が出たら、またここに出ます。
            </>
          )}
          {answerElsewhere && (
            <>
              <strong className="font-semibold">端末に承認プロンプトを出しました。</strong>
              ここからは送れません。Remote Controlか
              <code className="mx-1 rounded bg-background/60 px-1 py-0.5 font-mono">tmux attach</code>
              で答えてください。
            </>
          )}
        </span>
      </div>
      {(decision === "approve" || decision === "revise") && (
        <p className="border-t border-current/15 pt-2 text-[11px] leading-relaxed">
          {describeDelivery(deliveryStatus, deliveryExitCode, deliverySummary)}
        </p>
      )}
      {answerElsewhere && remoteControlUrl && (
        <Button variant="outline" size="sm" className="self-start" asChild>
          <a href={remoteControlUrl} target="_blank" rel="noreferrer">
            Remote Controlで答える
            <ExternalLink />
          </a>
        </Button>
      )}
    </section>
  );
}

function decisionOf(
  status: SessionPlanRequestView["status"],
): "approve" | "revise" | "defer" | "expired" | null {
  switch (status) {
    case "APPROVED":
      return "approve";
    case "REVISION_REQUESTED":
      return "revise";
    case "DEFERRED":
      return "defer";
    case "EXPIRED":
      return "expired";
    case "WAITING":
      return null;
  }
}
