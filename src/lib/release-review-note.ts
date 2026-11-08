/**
 * 全体レビューの未確認項目・候補全体への判断メモ（#5252）。**純関数と型だけ**を置き、DBの読み書きは
 * `release-review-note-store.ts`が持つ。画面からも読むので`node:crypto`等に依存しない。
 *
 * **メモは記録と表示だけ。** AIの判定（`state`・指摘・未確認範囲）、ゲートの合否、公開承認、修正系列は
 * このメモを読まない。「未確認だが理由はこうなので承知した」を、候補系列の履歴として残すためのもの。
 */

export const REVIEW_NOTE_BODY_MAX = 2000;
export const REVIEW_NOTE_FOLLOW_UP_MAX = 300;

export type ReviewNoteTarget = { kind: "check"; checkId: string } | { kind: "overall" };

/** 保存済みの判断メモ1件 */
export type ReleaseReviewNoteRecord = {
  id: string;
  target: ReviewNoteTarget;
  body: string;
  followUp: string | null;
  prNumber: number;
  baseSha: string;
  headSha: string;
  author: string;
  createdAt: string;
};

export type ReleaseReviewNotes = {
  /** 古い順（追記のみ。編集・削除はしない） */
  records: ReleaseReviewNoteRecord[];
};

export type ReviewNoteInputError = { field: "body" | "followUp" | "target"; message: string };

export function parseReviewNoteTarget(value: unknown): ReviewNoteTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as { kind?: unknown; checkId?: unknown };
  if (v.kind === "overall") return { kind: "overall" };
  if (v.kind === "check" && typeof v.checkId === "string" && /^[a-z0-9_]{1,64}$/.test(v.checkId)) {
    return { kind: "check", checkId: v.checkId };
  }
  return null;
}

/** 保存前の入力検証。理由（本文）だけが必須で、後続の対応先は任意 */
export function validateReviewNoteInput(input: { body: string; followUp: string | null }): ReviewNoteInputError | null {
  if (!input.body.trim()) return { field: "body", message: "承知した理由を入力してください" };
  if (input.body.length > REVIEW_NOTE_BODY_MAX) return { field: "body", message: `理由は${REVIEW_NOTE_BODY_MAX}文字以内にしてください` };
  if (input.followUp && input.followUp.length > REVIEW_NOTE_FOLLOW_UP_MAX) {
    return { field: "followUp", message: `後続の対応先は${REVIEW_NOTE_FOLLOW_UP_MAX}文字以内にしてください` };
  }
  return null;
}

export function sameReviewNoteTarget(a: ReviewNoteTarget, b: ReviewNoteTarget): boolean {
  return a.kind === b.kind && (a.kind === "overall" || (b.kind === "check" && a.checkId === b.checkId));
}

/** 対象ごとのメモ（古い順）。確認項目に付けたメモは、その項目だけ。候補全体は`{ kind: "overall" }` */
export function notesForTarget(notes: ReleaseReviewNotes | null | undefined, target: ReviewNoteTarget): ReleaseReviewNoteRecord[] {
  return (notes?.records ?? []).filter((r) => sameReviewNoteTarget(r.target, target));
}
