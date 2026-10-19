import { describeSessionPermission } from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { describeSessionStall } from "@/lib/dispatch/session-stall";
import {
  isPlanReviewListStateHolding,
  type PlanReviewListState,
} from "@/lib/dispatch/plan-review-list-state";

/**
 * Issueの「いま何を待っているか」と「次に何をするか」を1つにまとめた表示用の状態（#4425）。
 *
 * 一覧の行・Issue詳細（PC・スマホ）が同じ入力から同じ結果を得るための純関数。
 * 判定の材料は呼び出し側が既存の関数（`findPlanRequestForIssue`・`describeSessionPermission`・
 * `resolvePlanReviewListState`など）で解決して渡す。ここで材料を取り直さない。
 *
 * **ボタンの名前は、押して起きることと一致させる。** 一覧の行のボタンは詳細へ移動するだけで
 * 承認・マージはその場で行わないため、「計画を確認」「PRを確認」「質問を確認」と書く。
 */
export type IssueAttentionKind =
  | "permission"
  | "question"
  | "plan"
  | "merge"
  | "plan-review-creating"
  | "error"
  | "stalled"
  | "responded"
  | "dependency"
  | "reserved"
  | "running"
  | "queued"
  | "not-started";

/** 色の意味。色だけで伝えないため、表示側は必ずアイコンと文言を併用する */
export type IssueAttentionTone = "needs-user" | "blocked" | "error" | "running" | "idle";

export type IssueAttentionInput = {
  /** 外部（Claude Codeアプリ・端末）でしか解消できない権限待ち */
  permissionPending: boolean;
  questionPending: boolean;
  planPending: boolean;
  mergePending: boolean;
  planReviewState: PlanReviewListState | null;
  /** 起動ジョブの失敗など、人が見ないと進まないエラー */
  failed?: boolean;
  /** 依存先の完了待ち。依存先の表示名（`#4375`など） */
  dependencyWaitLabel?: string | null;
  /**
   * セッションが停滞の引き上げ（`describeSessionStall`）を受けたまま動いていない（#4562）。
   * 計画を提示せずに止まった・文章で問いかけて止まった、など。人が続け方を送るまで進まない
   */
  stalled?: boolean;
  /**
   * セッションは生きているが応答を終えている（`activity === "RESPONDED"`。#4562）。
   * 作業完了か次の指示待ちで、**「実装を進めています」とは言えない**
   */
  responded?: boolean;
  /** 予約実行に積まれている */
  reserved: boolean;
  /** 実行キューでの待ち（「順番待ち 2番目」「起動中」） */
  queueLabel?: string | null;
  running: boolean;
  /** まだ着手していない（openで、進捗がReady・未設定のとき）。他の待ちが無ければ「未着手」を返す */
  notStarted: boolean;
};

export type IssueAttention = {
  kind: IssueAttentionKind;
  tone: IssueAttentionTone;
  /** 代表状態（短い名詞） */
  label: string;
  /** 次の行動。人の操作が要らないときは「操作は不要です」を含む文 */
  nextAction: string;
  /** 人が何かをする必要があるか。要対応の判別に使う */
  needsUser: boolean;
  /** 一覧の行に出す遷移ボタンの名前（押すと詳細が開くだけ）。無ければnull */
  openButtonLabel: string | null;
};

/** 何も言うことが無い（進行中の通常段階・完了済みなど）ときはnullを返し、表示側は何も出さない */
export function resolveIssueAttention(input: IssueAttentionInput): IssueAttention | null {
  if (input.permissionPending) {
    return {
      kind: "permission",
      tone: "blocked",
      label: "権限待ち",
      nextAction: "Claude Codeアプリまたは端末でアクセスの許可を選んでください（この画面では解消できません）",
      needsUser: true,
      openButtonLabel: null,
    };
  }
  if (input.failed) {
    return {
      kind: "error",
      tone: "error",
      label: "エラー",
      nextAction: "実行に失敗しています。詳細で原因を確認してください",
      needsUser: true,
      openButtonLabel: "詳細を確認",
    };
  }
  if (input.questionPending) {
    return {
      kind: "question",
      tone: "needs-user",
      label: "質問への回答待ち",
      nextAction: "質問を確認して回答してください",
      needsUser: true,
      openButtonLabel: "質問を確認",
    };
  }
  if (input.planPending) {
    return {
      kind: "plan",
      tone: "needs-user",
      label: "計画の承認待ち",
      nextAction: "計画を確認して、承認または修正を送ってください",
      needsUser: true,
      openButtonLabel: "計画を確認",
    };
  }
  if (input.mergePending) {
    return {
      kind: "merge",
      tone: "needs-user",
      label: "マージの確認待ち",
      nextAction: "自動マージされなかった理由とPRを確認してください",
      needsUser: true,
      openButtonLabel: "PRを確認",
    };
  }
  if (input.stalled) {
    return {
      kind: "stalled",
      tone: "blocked",
      label: "停止中・要確認",
      nextAction: "セッションが止まっています。詳細の「セッションが停滞しています」で理由を確認し、続け方を送ってください",
      needsUser: true,
      openButtonLabel: "詳細を確認",
    };
  }
  if (isPlanReviewListStateHolding(input.planReviewState)) {
    return {
      kind: "plan-review-creating",
      tone: "running",
      label: "計画レビュー作成中",
      nextAction: "操作は不要です（レビューの完成を待っています）",
      needsUser: false,
      openButtonLabel: null,
    };
  }
  if (input.dependencyWaitLabel) {
    return {
      kind: "dependency",
      tone: "idle",
      label: "依存待ち",
      nextAction: `操作は不要です（${input.dependencyWaitLabel}の完了を待っています）`,
      needsUser: false,
      openButtonLabel: null,
    };
  }
  // 応答を終えたセッションに「実装を進めています・操作不要」を出し続けない（#4562）。
  // 正常完了・PR作成後もこの形になるため、要対応（`needsUser`）にはしない
  if (input.responded) {
    return {
      kind: "responded",
      tone: "idle",
      label: "応答終了",
      nextAction: "セッションは応答を終えています（作業完了か次の指示待ち）。続ける場合は追加指示を送ってください",
      needsUser: false,
      openButtonLabel: null,
    };
  }
  if (input.running) {
    return {
      kind: "running",
      tone: "running",
      label: "実行中",
      nextAction: "操作は不要です（実装を進めています）",
      needsUser: false,
      openButtonLabel: null,
    };
  }
  if (input.queueLabel) {
    return {
      kind: "queued",
      tone: "idle",
      label: input.queueLabel,
      nextAction: "操作は不要です（実行の開始を待っています）",
      needsUser: false,
      openButtonLabel: null,
    };
  }
  if (input.reserved) {
    return {
      kind: "reserved",
      tone: "idle",
      label: "予約済み",
      nextAction: "操作は不要です（予約した枠で自動的に始まります）",
      needsUser: false,
      openButtonLabel: null,
    };
  }
  if (!input.notStarted) return null;
  return {
    kind: "not-started",
    tone: "idle",
    label: "未着手",
    nextAction: "実装を開始するか、計画を立案できます",
    needsUser: false,
    openButtonLabel: null,
  };
}

/**
 * Issue詳細（PC・スマホ）が`resolveIssueAttention`を呼ぶための材料の組み立て。
 *
 * 詳細は一覧と違い、セッションの要約・計画／質問のリクエストを直接持っている。PCとスマホで
 * 同じ組み立てを2回書かないよう、ここで1回だけ書く（#4425）。
 */
export function resolveIssueDetailAttention(params: {
  issue: { state: string; projectStatus: string | null };
  session: { state: string } | null;
  permissionPending: boolean;
  planDecisionPending: boolean;
  questionAnswerPending: boolean;
  mergeApprovalPending: boolean;
  /** 計画レビューを作成中か（`isPlanReviewAttentionHeld`の結果。一覧の`creating`と同じ集合） */
  planReviewCreating: boolean;
  dependencyWaitLabel?: string | null;
  /** `resolveSessionAttentionFlags`の結果（#4562） */
  stalled?: boolean;
  responded?: boolean;
  reserved: boolean;
  queueLabel?: string | null;
}): IssueAttention | null {
  const planReviewCreating = params.planReviewCreating;
  return resolveIssueAttention({
    permissionPending: params.permissionPending,
    questionPending: params.questionAnswerPending,
    planPending: params.planDecisionPending && !planReviewCreating,
    mergePending: params.mergeApprovalPending,
    planReviewState: planReviewCreating ? "creating" : null,
    failed: params.session?.state === "FAILED",
    dependencyWaitLabel: params.dependencyWaitLabel ?? null,
    stalled: params.stalled ?? false,
    responded: params.responded ?? false,
    reserved: params.reserved,
    queueLabel: params.queueLabel ?? null,
    running: params.session?.state === "ALIVE",
    notStarted:
      params.issue.state === "open" &&
      (params.issue.projectStatus === null || params.issue.projectStatus === "Ready"),
  });
}

/**
 * PC・スマホの詳細が、手元の状態からそのまま代表状態を引くための入口（#4436）。
 *
 * 許可待ちの判定と依存待ちの引き当てまでここで行い、画面側に同じ組み立てを2回書かない。
 */
export function resolveIssueDetailAttentionFromState(params: {
  issue: { state: string; projectStatus: string | null; repositoryFullName: string; number: number };
  session: Parameters<typeof describeSessionPermission>[0] | null;
  dependencyWaits: Parameters<typeof findActiveDependencyWaitLabel>[0] | undefined;
  planDecisionPending: boolean;
  questionAnswerPending: boolean;
  mergeApprovalPending: boolean;
  planReviewCreating: boolean;
  reserved: boolean;
}): IssueAttention | null {
  return resolveIssueDetailAttention({
    issue: params.issue,
    session: params.session,
    permissionPending: params.session ? describeSessionPermission(params.session) !== null : false,
    planDecisionPending: params.planDecisionPending,
    questionAnswerPending: params.questionAnswerPending,
    mergeApprovalPending: params.mergeApprovalPending,
    planReviewCreating: params.planReviewCreating,
    dependencyWaitLabel: findActiveDependencyWaitLabel(
      params.dependencyWaits ?? [],
      params.issue.repositoryFullName,
      params.issue.number,
    ),
    ...resolveSessionAttentionFlags(params.session),
    reserved: params.reserved,
  });
}

/**
 * セッションが「停滞の引き上げを受けたまま」か「応答を終えている」かを、一覧と詳細で同じ材料から
 * 引く（#4562）。生きていないセッション・作業中・入力待ちはどちらも偽。
 */
export function resolveSessionAttentionFlags(
  session: DispatchSessionView | null,
): { stalled: boolean; responded: boolean } {
  if (!session || session.state !== "ALIVE") return { stalled: false, responded: false };
  const stalled = describeSessionStall(session) !== null;
  return { stalled, responded: !stalled && session.activity === "RESPONDED" };
}

/** 実装セッションの依存待ち（#4321）のうち、いま待っているものの表示名（`#4375`など）。無ければnull */
export function findActiveDependencyWaitLabel(
  waits: readonly {
    repositoryFullName: string;
    issueNumber: number;
    status: string;
    dependency: { number: number };
  }[],
  repositoryFullName: string,
  issueNumber: number,
): string | null {
  const wait = waits.find(
    (w) =>
      w.repositoryFullName === repositoryFullName &&
      w.issueNumber === issueNumber &&
      w.status !== "RESUMED" &&
      w.status !== "CANCELLED",
  );
  return wait ? `#${wait.dependency.number}` : null;
}
