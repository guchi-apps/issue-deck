/**
 * Issueを作った直後に開く画面（#2862）。
 *
 * 以前は「作成」「作成+実装開始」のどちらを押しても、必ず作ったIssueの詳細へ移動していた
 * （`issue-deck-shell.tsx`の`handleIssueCreated`）。まとめて起票しているときは毎回一覧へ
 * 戻る操作が要るため、作成の直後に選択画面を1枚はさみ、そこで選んだ先へ進む。
 *
 * **既定は`ask`（毎回選ぶ）にする。** 記憶した先をいきなり適用すると、初めて使う人には
 * 「なぜここへ来たのか」が分からないまま挙動だけが変わる。選択画面で「次回からこの画面を
 * 出さない」を入れたときにだけ、押した方が既定として残る。
 */
export type PostCreateDestination = "detail" | "stay";

/** 保存されている設定。`ask`は「毎回選択画面を出す」（既定） */
export type PostCreateDestinationSetting = PostCreateDestination | "ask";

export const POST_CREATE_DESTINATION_DEFAULT: PostCreateDestinationSetting = "ask";

/**
 * 設定の保存キー（端末ごと・localStorage）。**どの端末で作ったかで戻りたい先が変わる**ため、
 * アプリ全体の設定（`AppSetting`）ではなく端末ごとの設定にしている
 * （`use-issue-order-guide.ts`の自動開始と同じ理由）。
 */
export const POST_CREATE_DESTINATION_STORAGE_KEY = "issue-deck:post-create-destination";

const SETTINGS: readonly PostCreateDestinationSetting[] = ["ask", "detail", "stay"];

/**
 * localStorageから読んだ値を設定のいずれかへ正規化する（`auto-refresh.ts`の`parse`と同じ役割）。
 * 未知の値・壊れた値は既定へ落とす——保存しているのは端末のブラウザで、古い版が書いた値や
 * 手で書き換えられた値が入りうるため。
 */
export function normalizePostCreateDestinationSetting(
  value: unknown,
): PostCreateDestinationSetting {
  return SETTINGS.includes(value as PostCreateDestinationSetting)
    ? (value as PostCreateDestinationSetting)
    : POST_CREATE_DESTINATION_DEFAULT;
}

/**
 * 作成直後に選択画面を出すか。`ask`のときだけ出し、それ以外は記憶した先へそのまま進む。
 */
export function shouldAskPostCreateDestination(setting: PostCreateDestinationSetting): boolean {
  return normalizePostCreateDestinationSetting(setting) === "ask";
}

/**
 * 選択画面を出さないときに進む先。`ask`のままここへ来ることは無いが、
 * 呼び出し側で分岐を書き分けずに済むよう、従来の挙動（詳細へ移動）へ落とす。
 */
export function resolvePostCreateDestination(
  setting: PostCreateDestinationSetting,
): PostCreateDestination {
  const normalized = normalizePostCreateDestinationSetting(setting);
  return normalized === "stay" ? "stay" : "detail";
}

/** 設定画面のセレクトに出す文言（画面とテストで同じものを使う） */
export const POST_CREATE_DESTINATION_LABELS: Record<PostCreateDestinationSetting, string> = {
  ask: "毎回選ぶ",
  detail: "Issueを開く",
  stay: "元の画面に戻る",
};
