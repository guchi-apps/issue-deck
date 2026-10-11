import type { ManualStepReports } from "@/lib/manual-step-investigation";

/**
 * 手作業Issue詳細の代表状態（#4426）。
 *
 * 詳細の先頭に「いまどうなっていて、自分は何をするのか」を1つだけ出すための判定。
 * **新しいデータは作らず、既存の判断材料だけで決める**——セッションの事前調査・完了検証の
 * 報告コメント（#4315）、手作業セッションの生存と起動ジョブ、質問の回答待ち、Issueの開閉。
 *
 * - `not_investigated`: 事前調査の報告が無く、セッションもジョブも無い（調査前）
 * - `ai_working`: セッションかジョブが動いていて、あなたへの質問は出ていない
 * - `user_action`: あなたの操作が要る（質問待ち、またはセッション終了後に操作が残っている）
 * - `ai_verifying`: 質問に答えた直後で、セッションが結果を確かめている
 * - `ai_stopped`: 調査報告はあるが、あなたの操作は無く、セッションも完了検証も無い（途中で止まった）
 * - `verify_failed`: 最新の完了検証が成功していない
 * - `done`: 最新の完了検証がすべて終了コード0
 * - `closed`: 完了検証が成功しないままクローズされた
 *
 * **未確認を実施済み・完了として扱わない。** 完了は最新の完了検証が調査報告より新しく、
 * すべて成功しているときだけで、定期巡回の結果（`manualStepVerifiedAt`）は根拠として出すだけ。
 */
export type ManualStepPhase =
  | "not_investigated"
  | "ai_working"
  | "user_action"
  | "ai_verifying"
  | "ai_stopped"
  | "verify_failed"
  | "done"
  | "closed";

export type ManualStepPhaseInput = {
  reports: ManualStepReports;
  isOpen: boolean;
  /** 手作業セッション（tmux）が生きている */
  sessionAlive: boolean;
  /** 手作業セッションの起動ジョブが未処理（届くまで最大30秒ほど） */
  jobActive: boolean;
  /** このIssueへの質問が回答待ち（`WAITING`） */
  questionPending: boolean;
  /** 質問に答えた直後（結果表示の行が残っている間） */
  questionAnswered: boolean;
};

export function resolveManualStepPhase(input: ManualStepPhaseInput): ManualStepPhase {
  const { reports, isOpen, sessionAlive, jobActive, questionPending, questionAnswered } = input;
  const { investigation, verification } = reports;
  // 調査が検証より新しければ、検証の結果は「その前の試み」のもの
  const latestVerification =
    verification && reports.verificationIndex > reports.investigationIndex ? verification : null;
  const running = sessionAlive || jobActive;

  if (latestVerification?.passed) return "done";
  if (!isOpen) return "closed";
  if (questionPending) return "user_action";
  if (running) {
    if (questionAnswered && sessionAlive) return "ai_verifying";
    return "ai_working";
  }
  if (latestVerification) return "verify_failed";
  if (!investigation) return "not_investigated";
  if (investigation.user.length > 0) return "user_action";
  return "ai_stopped";
}

/** 状態ごとに、主操作として何を出すか */
export type ManualStepPrimaryAction =
  /** 既存の手作業セッションを起動して、調査から始める */
  | "start"
  /** 回答待ちの質問パネルへ移動する（回答は既存の質問フローで送る） */
  | "answer_question"
  /** セッションを起動し直して、あなたの操作の結果を確かめてもらう */
  | "request_check"
  /** セッションを起動し直して、完了検証をやり直してもらう */
  | "request_recheck"
  /** 待つだけでよい（操作不要） */
  | "none";

export function resolveManualStepPrimaryAction(
  phase: ManualStepPhase,
  questionPending: boolean,
): ManualStepPrimaryAction {
  switch (phase) {
    case "not_investigated":
      return "start";
    case "user_action":
      return questionPending ? "answer_question" : "request_check";
    case "verify_failed":
    case "ai_stopped":
      return "request_recheck";
    default:
      return "none";
  }
}
