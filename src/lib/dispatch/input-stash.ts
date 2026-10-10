/**
 * 追加指示を送れなかった理由の分類と、未送信入力の退避（#4383）の共通ルール。
 *
 * pollerの`instruction_ready`が返す理由文（日本語）を、画面が「次の操作」を出し分けるための
 * 種類へ落とす。**退避を提案してよいのは「未送信入力」だけ**で、作業中・承認待ち・状態不明は
 * 入力欄に触れない（承認プロンプトの保護を迂回しない）。
 */

/** 退避した入力の保持日数。期限を過ぎた行は参照のたびに消す */
export const INPUT_STASH_RETENTION_DAYS = 7;
/** 退避する本文の上限（文字数）。これを超える入力は完全な取得を保証できないものとして扱う */
export const INPUT_STASH_MAX_CHARS = 20000;

export type InstructionSkipKind =
  | "unsent_input"
  | "busy"
  | "approval"
  | "unknown_state"
  | "stash_incomplete"
  | "stash_failed"
  | "other";

export type InstructionSkipNotice = {
  kind: InstructionSkipKind;
  /** 画面に出す短い言い方 */
  label: string;
  /** 未送信入力を退避して送る操作を出してよいか */
  canStash: boolean;
};

export function classifyInstructionSkip(message: string | null | undefined): InstructionSkipNotice {
  const text = message ?? "";
  if (text.includes("完全に取得できない")) {
    return { kind: "stash_incomplete", label: "未送信入力を完全に取得できないため、何も消していません", canStash: false };
  }
  if (text.includes("退避に失敗") || text.includes("退避を保存できません")) {
    return { kind: "stash_failed", label: "退避を保存できなかったため、何も消していません", canStash: false };
  }
  if (text.includes("未送信の文字が残")) {
    return { kind: "unsent_input", label: "入力欄に未送信の文字が残っています", canStash: true };
  }
  if (text.includes("承認プロンプト") || text.includes("選択フォーム")) {
    return { kind: "approval", label: "承認プロンプトまたは選択フォームの表示中です", canStash: false };
  }
  if (text.includes("作業中") || text.includes("処理中")) {
    return { kind: "busy", label: "セッションが作業中です", canStash: false };
  }
  if (
    text.includes("記録されていない") ||
    text.includes("読み取れなかった") ||
    text.includes("入力欄が見つからなかった")
  ) {
    return { kind: "unknown_state", label: "セッションの状態を確認できません", canStash: false };
  }
  return { kind: "other", label: text || "理由は報告されていません", canStash: false };
}

/** ジョブの状態と`message`から、依存待ちの再開失敗に出す理由文を作る（SKIPPEDだけで終えない） */
export function describeInstructionJobFailure(
  status: "FAILED" | "TIMEOUT" | "CANCELED" | "SKIPPED",
  message: string | null | undefined,
): string {
  const detail = message?.trim() ? `: ${message.trim()}` : "";
  switch (status) {
    case "SKIPPED":
    {
      const notice = classifyInstructionSkip(message);
      // 退避の途中で止まった理由（何を消さなかったか）は定型の言い換えにせず、そのまま見せる
      const detailKinds: InstructionSkipKind[] = ["other", "stash_incomplete", "stash_failed"];
      return `再開の指示は見送られました: ${detailKinds.includes(notice.kind) && message?.trim() ? message.trim() : notice.label}`;
    }
    case "FAILED":
      return `再開の指示を送れませんでした（通信失敗・送信失敗）${detail}`;
    case "TIMEOUT":
      return `再開の指示がサブPCに処理されないまま期限を過ぎました${detail}`;
    case "CANCELED":
      return `再開の指示が取り消されました${detail}`;
  }
}

/** 退避の保持期限 */
export function stashExpiry(now: Date): Date {
  return new Date(now.getTime() + INPUT_STASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/** 画面へ返す退避の一覧用の形。本文を含むため、ログイン必須の受け口からだけ返す */
export type InputStashView = {
  id: string;
  jobId: string;
  repositoryFullName: string;
  issueNumber: number;
  host: string;
  charCount: number;
  content: string;
  createdAt: string;
  expiresAt: string;
};
