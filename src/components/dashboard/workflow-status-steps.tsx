import { Check, CircleAlert, MessageCircleQuestion, Minus } from "lucide-react";

import {
  describeIssueExecutionTarget,
  type IssueExecutionTarget,
} from "@/lib/dispatch/issue-execution-target";
import { shortIssueSessionLabel } from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import {
  checkUserReason,
  CHECK_USER_REASON_TEXT,
  isApprovalPending,
} from "@/lib/github/approval-labels";
import { isDispatchedStatusKey } from "@/lib/github/project-status-dispatch";
import { getSimpleStepLabel } from "@/lib/github/workflow-step-label";
import { getWorkflowStepIndex, WORKFLOW_STEPS } from "@/lib/github/workflow-status";
import { resolveProgressStatus } from "@/lib/issue-progress";
import { cn } from "@/lib/utils";
import { isWorkflowBadgeSpinning } from "@/lib/workflow-badge-activity";
import type { IssueLabel } from "@/types/issue";

/**
 * 進捗状態の判定に使う値。判定材料はProject Statusだけ（@/lib/issue-progress）。
 * `labels`は進捗の判定には使わず、承認待ち（`00.check-user`）の表示切り替えにのみ使う。
 */
type ProgressProps = {
  labels: IssueLabel[];
  /** GitHub Projects v2のStatus。Projectに未登録なら省略・null（この場合は何も表示しない） */
  projectStatus?: string | null;
};

type WorkflowStatusStepsProps = ProgressProps & {
  /** このIssueがどこで走っているか（#1262）。着手後もPC・スマホの詳細から実行先が分かるようにする */
  executionTarget?: IssueExecutionTarget;
  /**
   * 確認待ちのバッジ（「ユーザー確認待ち・PRのマージ」）を出すか（#2057）。
   *
   * **直下に案内パネル（`CheckUserReasonNotice`）が出ているときはfalseにする。**
   * あちらの見出し（「Pull Requestのマージが必要です」）が同じ用件を書いており、バッジは
   * その1行上で同じことを繰り返すだけになる。理由ラベル（`01.check-*`）が配られておらず
   * 案内パネルを出せないリポジトリでは、従来どおりバッジが唯一の表示になる。
   *
   * **バッジを消しても現在ステップの琥珀色は残す**——確認待ちであること自体は形で読めるようにする。
   */
  showApprovalBadge?: boolean;
  /**
   * 実行先（「サブPCで実行中」）を出すか（#2057）。
   *
   * **セッションの行（`IssueSessionStatus`）が出ているときはfalseにする。** 同じホスト名を
   * 2行で言っているうえ、こちらはProject Statusと`11.local`から組み立てているため
   * セッションが終わった後も「実行中」のまま残り、「サブPC・応答を終えています」と食い違う。
   */
  showExecutionTarget?: boolean;
  /**
   * 計画フェーズ（`Planning`）を通らずに実装へ入ったIssueかどうか（#2069。
   * 判定は`isPlanningPhaseSkipped`）。
   *
   * **既定は`false`＝従来どおり済みのチェックを出す。** 判定にはIssueのコメントが要り、
   * 呼び出し側がそれを持っているとは限らない（一覧・取得中）。分からないまま
   * 「スキップ」と言い切ると、計画を通したIssueにまで出てしまう。
   */
  planningSkipped?: boolean;
};

type WorkflowStepBadgeProps = ProgressProps & {
  /**
   * GitHub Actions実行状況（一覧のポーリング結果）。省略時は実行中表示を行わない。
   * `runId`がnull（実行が1つも紐づいていない）ことを起動待ちの判定に使う（#991 Phase 3）
   */
  running?: { isRunning: boolean; currentStep: string | null; runId?: number | null };
  /**
   * 「質問する」ボタン経由の質問コメントが投稿済みで、まだ回答コメントが
   * 投稿されていない状態かどうか（@/lib/github/ask-claudeのisQaAnswerPending相当）
   */
  qaAnswerPending?: boolean;
  /**
   * このIssueがどこで走っているか（#1262）。**省略時は従来どおりActionsの実行を期待する。**
   *
   * サブPC実行では実行ログのリンクを含むコメントがPR作成まで出ないため、これが無いと
   * `runId`がnullのまま「起動待ち」を出し続けてしまう。
   */
  executionTarget?: IssueExecutionTarget;
  /**
   * そのIssueのサブPCセッション（#1264・`findSessionForIssue`の結果）。無ければnull。
   *
   * 添える文言（`shortIssueSessionLabel`。入力待ち・終了・異常終了のときだけ出す）と、
   * 外周リングを回すかどうか（#1439）の**両方をここから決める**。別々に渡すと、片方だけ
   * 更新された状態（例: 「入力待ち」と出ているのに回り続ける）が作れてしまう。
   */
  session?: DispatchSessionView | null;
  /**
   * 現在時刻(epoch ms)。`useNow()`から渡す。**マウント前はnull**で、そのときは
   * セッションの報告の古さを判定しない（`isWorkflowBadgeSpinning`）。
   */
  now?: number | null;
  /**
   * 確認待ち（`00.check-user`）だが、まだエージェントが動いているか（#2358）。
   * 一覧が持っている`checkUserRunningIssueIds`（#2174の判定）をそのまま渡す。
   * **省略時は従来どおり**、確認待ちの間は回さない。
   */
  checkUserRunning?: boolean;
};

const BADGE_SIZE = 18;

/** 計画フェーズ（`Planning`）の段の位置。スキップの判定に使う（#2069） */
const PLANNING_STEP_INDEX = WORKFLOW_STEPS.findIndex((step) => step.key === "planning");

/** 計画フェーズを通らなかった段のラベル・ツールチップ（#2069） */
const SKIPPED_STEP_LABEL = "計画スキップ";
const SKIPPED_STEP_TITLE = "計画フェーズを通らずに実装へ入りました";

/**
 * 一覧などの省スペースな箇所向けに、現在の実装状況ステップを円グラフ（パイ）で示す。
 * ユーザーの確認待ち（00.check-user）の場合はamber色に切り替えたうえで中央にアラート
 * アイコンを重ね、一覧をざっと流し見しただけでも要対応Issueだと判別できるようにする。
 * Claudeへの質問が回答待ちの場合はblue色に切り替えたうえで中央に質問アイコンを重ねる
 * （承認待ちとは別系統の状態のため、両方成立する場合はより緊急度の高い承認待ち表示を優先する）。
 * 実行中は円の外周にスピン用のリングを重ねて回転させ、進捗（塗り分け）と実行中（回転）を
 * 同じ円で同時に表現する。**回すかどうかの条件はGitHub ActionsとサブPCで材料が違うため、
 * `isWorkflowBadgeSpinning`（#1439）に集約している。**
 *
 * リングは**常時見えるトラックの上を半周ぶんの弧が回る**形にしている（#2358）。細い弧だけを
 * 出していた頃は、18pxのバッジの周りで回っているかどうかが読み取れなかった。
 */
export function WorkflowStepBadge({
  labels,
  projectStatus = null,
  running,
  qaAnswerPending = false,
  executionTarget,
  session = null,
  now = null,
  checkUserRunning = false,
}: WorkflowStepBadgeProps) {
  const currentIndex = getWorkflowStepIndex({ projectStatus });
  if (currentIndex === null) return null;

  const approvalPending = isApprovalPending(labels);
  // 何を求められているかを添える（#1490）。理由ラベルが配られていないリポジトリではnullになり、
  // 従来どおり「ユーザーの確認待ち」だけを出す
  const reason = checkUserReason(labels);
  const showQaAnswerPending = qaAnswerPending && !approvalPending;
  const step = WORKFLOW_STEPS[currentIndex];
  const progress = (currentIndex + 1) / WORKFLOW_STEPS.length;
  const progressDeg = progress * 360;
  const actionsRunning = running?.isRunning ?? false;
  // 外周を回すかどうか（#1439）。Actionsの実行中に加えて、サブPCのセッションが生きて動いている
  // 間も回す。人待ち（承認待ち・入力待ち）と、終わった・報告が途絶えたセッションでは回さない
  const isSpinning = isWorkflowBadgeSpinning({
    actionsRunning: running,
    session,
    approvalPending,
    // 確認待ちでも、エージェントが動いている間は回し続ける（#2358）
    checkUserRunning,
    // 回答を待っているあいだも回す（#2309）。実行が紐づかない質問（サブPCの質問セッション）
    // でも待ち時間は数十秒〜数分あり、回さないと一覧では止まって見える
    qaAnswerPending: showQaAnswerPending,
    now,
  });
  // セッションの様子の短い表現（#1264）。入力待ち・終了・異常終了のときだけ出す
  const sessionLabel = session ? shortIssueSessionLabel(session) : null;
  // Statusは起動後の段階なのに実行が1つも紐づいていない状態（#991 Phase 3）。カンバンの
  // ドラッグ起点の起動はWebhookの到達に依存するため、届かなかったことを画面から見えるようにする。
  // ポーリング結果が未取得（running未定義）のうちは判定しない
  // Actionsの実行を期待してよい場合にだけ「起動待ち」を判定する（#1262）。サブPC実行では
  // 実行が最初から存在しないため、ここを見ないと実装中ずっと誤警告が出続ける。
  const awaitingDispatch =
    executionTarget?.expectsActionsRun !== false &&
    running !== undefined &&
    !actionsRunning &&
    running.runId === null &&
    isDispatchedStatusKey(resolveProgressStatus({ projectStatus }));
  // ステップ名を出せるのはActionsの実行だけ（サブPCにはジョブの段階に相当するものが無い）
  const simpleStep = actionsRunning ? getSimpleStepLabel(running?.currentStep ?? null) : null;
  // 実行先が分かっている場合はそれを出す。押す前だけでなく**着手後も**どちらで動いているかが
  // 分かるようにするため（#1262）。実行中のステップ名が出せるならそちらを優先する
  const targetLabel =
    executionTarget && !executionTarget.expectsActionsRun
      ? describeIssueExecutionTarget(executionTarget)
      : null;
  // 実行先とセッションの様子は両方出す（例:「サブPC・入力待ち」）。どちらが欠けても意味が変わる
  const localSuffix = [targetLabel, sessionLabel].filter(Boolean).join("・") || null;
  const suffix = simpleStep ?? (awaitingDispatch ? "起動待ち" : localSuffix);
  const stepText = `${step.label}${suffix ? `（${suffix}）` : ""}`;
  const accentColorClass = approvalPending
    ? "text-amber-500"
    : showQaAnswerPending
      ? "text-blue-500"
      : "text-primary";

  return (
    <span
      title={`${step.projectStatus} ${step.label}${
        approvalPending
          ? `（ユーザーの確認待ち${reason ? `・${CHECK_USER_REASON_TEXT[reason]}` : ""}）`
          : showQaAnswerPending
            ? "（Claudeの回答待ち）"
            : awaitingDispatch
              ? "（起動待ち。Statusは進んでいますがGitHub Actionsの実行がまだ紐づいていません）"
              : localSuffix
                ? `（${localSuffix}）`
                : ""
      }`}
      className="flex min-w-0 shrink-0 items-center gap-1.5"
    >
      <span className="max-w-[7rem] truncate text-[10px] text-muted-foreground">{stepText}</span>
      <span
        className="relative flex shrink-0 items-center justify-center"
        style={{ width: BADGE_SIZE, height: BADGE_SIZE }}
      >
        {/* 実行中の回転（#1439・#2358）。**常時見えるトラックの上を、半周ぶんの弧が回る。**
            以前は2pxの弧が1/4周だけで、18pxのバッジの周りでは回っているかどうかが分からず、
            スマホでは動きに気付けなかった（#2358の「一瞬だけしか出ていない」）。トラックが
            あると弧の位置に関わらず輪郭が見えるので、止まっているのか回っているのかを
            視線を止めずに読める。
            色は円グラフと同じ系統に合わせる。**承認待ち（amber）のリングも出る**——確認待ちの
            まま処理が動いている状態を回転で表すため（`isWorkflowBadgeSpinning`） */}
        {isSpinning && (
          <>
            <span
              aria-hidden="true"
              className={cn(
                "absolute rounded-full border-[2.5px]",
                approvalPending
                  ? "border-amber-500/25"
                  : showQaAnswerPending
                    ? "border-blue-500/25"
                    : "border-primary/25",
              )}
              style={{ inset: -4 }}
            />
            <span
              aria-hidden="true"
              className={cn(
                "absolute animate-spin rounded-full border-[2.5px] border-transparent",
                approvalPending
                  ? "border-t-amber-500 border-r-amber-500"
                  : showQaAnswerPending
                    ? "border-t-blue-500 border-r-blue-500"
                    : "border-t-primary border-r-primary",
              )}
              style={{ inset: -4 }}
            />
          </>
        )}
        <span
          aria-hidden="true"
          className={cn("block rounded-full", accentColorClass)}
          style={{
            width: BADGE_SIZE,
            height: BADGE_SIZE,
            background: `conic-gradient(currentColor 0deg ${progressDeg}deg, color-mix(in oklch, currentColor ${approvalPending || showQaAnswerPending ? 20 : 15}%, transparent) ${progressDeg}deg 360deg)`,
          }}
        />
        {approvalPending && (
          <span className="absolute inset-0 flex items-center justify-center">
            <CircleAlert className="size-2.5 text-background" />
          </span>
        )}
        {showQaAnswerPending && (
          <span className="absolute inset-0 flex items-center justify-center">
            <MessageCircleQuestion className="size-2.5 text-background" />
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * Planning〜Doneの実装状況（Project Status）をstep形式で可視化する。Statusを持たないissueでは何も表示しない。
 * 円＋接続線の行はPC・スマホ共通で常時表示する。各ステップ下の個別ラベル（6個同時表示）はスマホの
 * 狭い横幅では重なって崩れるため`md`以上でのみ表示し、スマホでは代わりに現在ステップのみを示す
 * 1行キャプション（例:「実装中（2/6）」）を表示する。
 *
 * **計画フェーズ（`Planning`）は、通らずに実装へ入ったIssueでは済み扱いにしない**（#2069）。
 * `21.plan-required`を付けないIssueはそこを通らないのに、済みのチェックが出ていたため、
 * 「計画を立てて承認まで通した」Issueと画面上まったく同じに見えていた。通らなかった段は
 * 塗らずに破線の輪郭＋マイナスにし、次の段までの接続線も破線にする（判定は
 * `isPlanningPhaseSkipped`で、材料になるコメントを持つIssue詳細だけが渡す）。
 */
export function WorkflowStatusSteps({
  labels,
  projectStatus = null,
  executionTarget,
  showApprovalBadge = true,
  showExecutionTarget = true,
  planningSkipped = false,
}: WorkflowStatusStepsProps) {
  const currentIndex = getWorkflowStepIndex({ projectStatus });
  if (currentIndex === null) return null;

  const approvalPending = isApprovalPending(labels);
  // 何を求められているかをバッジへ添える（#1490）。理由ラベルが配られていないリポジトリでは
  // nullになり、従来どおり「ユーザー確認待ち」だけを出す
  const reason = checkUserReason(labels);
  const approvalPendingText = reason
    ? `ユーザー確認待ち・${CHECK_USER_REASON_TEXT[reason]}`
    : "ユーザー確認待ち";
  // バッジを出すかどうか（#2057）。状態そのもの（`approvalPending`）は色の判定に使い続ける
  const showBadge = approvalPending && showApprovalBadge;
  const currentStep = WORKFLOW_STEPS[currentIndex];
  // 実行先が分かっている場合だけ添える。Actionsを期待している（＝従来どおり）ときは出さない。
  // 常に出すと、実行先が1つしか無かった頃と同じ情報量なのに行が増えるだけになる
  const targetLabel =
    showExecutionTarget && executionTarget && !executionTarget.expectsActionsRun
      ? describeIssueExecutionTarget(executionTarget)
      : null;
  // 通り過ぎた計画フェーズだけをスキップ扱いにする（#2069）。まだそこにいる（`Planning`）
  // 間は現在ステップの表示が優先で、スキップかどうかはそもそも決まらない
  const skippedIndex = planningSkipped && currentIndex > PLANNING_STEP_INDEX ? PLANNING_STEP_INDEX : null;
  // スマホでは段のラベルが出ないため、キャプションの側でも文字で言う（#2069）
  const captionSuffix =
    [skippedIndex !== null ? SKIPPED_STEP_LABEL : null, targetLabel ? `${targetLabel}で実行中` : null]
      .filter(Boolean)
      .join("・") || null;

  return (
    <div>
      <div className="overflow-x-auto">
        <div className="flex min-w-max" role="list" aria-label="実装状況">
          {WORKFLOW_STEPS.map((step, index) => {
            const isSkipped = index === skippedIndex;
            // スキップした段は「済み」にしない。塗ってチェックを出すと、計画を通した
            // Issueと見分けが付かなくなる（#2069）
            const isDone = index < currentIndex && !isSkipped;
            const isCurrent = index === currentIndex;
            const showApprovalPending = isCurrent && showBadge;
            const StepIcon = step.icon;
            // 接続線も、スキップした段の前後だけ破線にする。実線のままだと進捗が計画から
            // 続いてきたように読める
            const skipLineClass = "h-0 border-t border-dashed border-muted-foreground/60";
            return (
              <div
                key={step.key}
                className="relative flex min-w-16 flex-1 flex-col items-center gap-1.5 px-1"
              >
                {index !== 0 && (
                  <div
                    aria-hidden
                    className={cn(
                      "absolute left-0 top-3 w-1/2",
                      index - 1 === skippedIndex
                        ? skipLineClass
                        : cn("h-px", isDone || isCurrent ? "bg-primary" : "bg-border"),
                    )}
                  />
                )}
                {index !== WORKFLOW_STEPS.length - 1 && (
                  <div
                    aria-hidden
                    className={cn(
                      "absolute right-0 top-3 w-1/2",
                      isSkipped ? skipLineClass : cn("h-px", isDone ? "bg-primary" : "bg-border"),
                    )}
                  />
                )}
                <div
                  role="listitem"
                  aria-current={isCurrent ? "step" : undefined}
                  /* スマホでは段のラベルが出ないため、読み上げ向けの名前はここに持たせる（#2069） */
                  aria-label={isSkipped ? SKIPPED_STEP_LABEL : undefined}
                  title={isSkipped ? `${step.projectStatus} ${SKIPPED_STEP_TITLE}` : step.projectStatus}
                  className={cn(
                    "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-inset",
                    isDone && "bg-primary text-primary-foreground ring-primary",
                    isCurrent &&
                      (approvalPending
                        ? "bg-amber-500 text-white ring-2 ring-amber-500 dark:bg-amber-500 dark:text-background"
                        : "bg-[color-mix(in_oklch,var(--primary)_15%,var(--background))] text-primary ring-primary"),
                    // 通っていない段は塗らず、破線の輪郭にする（#2069）。未着手の段（実線の輪郭）
                    // とも、済みの段（塗りつぶし）とも重ならない見た目にする
                    isSkipped &&
                      "border border-dashed border-muted-foreground/70 text-muted-foreground ring-0",
                    !isDone && !isCurrent && !isSkipped && "text-muted-foreground ring-border",
                  )}
                >
                  {isDone ? (
                    <Check className="size-3.5" />
                  ) : isSkipped ? (
                    <Minus className="size-3.5" />
                  ) : (
                    <StepIcon className="size-3.5" />
                  )}
                </div>
                {/* 折り返しを許す（#1577）。`whitespace-nowrap`だと「developへマージ」のような
                    長いラベルが列からはみ出し、隣のラベルと重なって読めなくなっていた */}
                <span
                  className={cn(
                    "hidden text-center text-[11px] leading-tight text-balance md:block",
                    isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {isSkipped ? SKIPPED_STEP_LABEL : step.label}
                </span>
                {showApprovalPending && (
                  <span className="hidden whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-500 md:inline-block dark:text-amber-400">
                    {approvalPendingText}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {targetLabel && (
        <p className="mt-1.5 hidden text-center text-[11px] text-muted-foreground md:block">
          {targetLabel}で実行中
        </p>
      )}
      {/* 確認待ちのバッジは行に流し込まず、段を分けて隙間を取る（#1676）。同じ`<p>`に並べると
          折り返したときに行間ぶんしか空かず、丸みのあるバッジが上の行に貼り付いて見えていた */}
      <div className="mt-1.5 flex flex-col items-center gap-1.5 text-center text-[11px] md:hidden">
        <p>
          <span className={cn("font-medium", approvalPending ? "text-amber-700 dark:text-amber-400" : "text-foreground")}>
            {currentStep.label}（{currentIndex + 1}/{WORKFLOW_STEPS.length}）
          </span>
          {captionSuffix && <span className="ml-1.5 text-muted-foreground">{captionSuffix}</span>}
        </p>
        {showBadge && (
          <span className="whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-500 dark:text-amber-400">
            {approvalPendingText}
          </span>
        )}
      </div>
    </div>
  );
}
