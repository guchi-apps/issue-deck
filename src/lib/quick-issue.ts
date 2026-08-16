import type { IssueDraftKind } from "@/hooks/use-issue-draft";

/**
 * Issue作成ダイアログのステップ（#1605）。
 *
 * - `input`: 種別と本文だけを書く。リポジトリ・タイトル・ラベルは画面に出さない
 * - `confirm`: 推定結果が入った状態で確かめる。従来のフォームそのもの
 *
 * **`confirm`を飛ばして作成する経路は作らない。** リポジトリの推定を外したまま作成すると、
 * 押した本人からは間違いが見えないまま別リポジトリへIssueが立つ。
 */
export type QuickIssueStep = "input" | "confirm";

/**
 * 入力ステップのリポジトリ欄で「自動で決める」を表す値（#1733）。
 *
 * 選んでいない状態（`repositoryFullName`が空文字）を`Select`の選択肢として出すための番兵で、
 * **空文字は使えない**——Radixの`SelectItem`は空文字を値に取れず、プレースホルダーの解除に
 * 使っている内部の仕様と衝突する。担当者欄の`__none__`（未設定）と同じ形にしてある。
 */
export const AUTO_REPOSITORY_VALUE = "__auto__";

export type QuickSuggestKind = IssueDraftKind;

export type QuickSuggestResult = {
  /** 推定できなかった場合はnull（確認ステップでユーザーが選ぶ） */
  repositoryFullName: string | null;
  /**
   * 内容から推定したリポジトリ候補（確からしい順・最大3件・#1710）。
   * 確認ステップにチップとして並べ、1タップで選び直せるようにする。
   * `repositoryFullName`が画面から渡された値のときは、ここに別のリポジトリが並ぶことがある。
   */
  repositoryCandidates: string[];
  /** 種別が「質問」のとき、および生成に失敗したときはnull */
  title: string | null;
  labels: string[];
};

/**
 * 確認ステップに出すリポジトリ候補の並びを作る（#1710）。
 *
 * **選択中のものを必ず先頭に置く。** 押せる候補の中に今の値が無いと、切り替えた後に
 * 元へ戻す先が消える。画面から渡されたリポジトリ（表示中のリポジトリ）は推定結果に
 * 入っていないことがあるため、ここで合流させる。
 */
export function buildRepositoryChoices(
  selected: string,
  candidates: string[],
  limit = 3,
): string[] {
  const choices = selected ? [selected] : [];
  for (const candidate of candidates) {
    if (choices.includes(candidate)) continue;
    choices.push(candidate);
    if (choices.length >= limit) break;
  }
  return choices;
}

/**
 * ダイアログを開いたときのステップを決める。
 *
 * **タイトル・本文がすでに渡されているときは`confirm`から始める。** 引き継ぎ作成（#169）や
 * コメントからの起票（#1322）は書く内容が決まっている状態で開くため、1段目に戻すと
 * 「もう書いてあるのにもう一度書け」と言っているように見える。
 */
export function resolveInitialQuickStep(defaults: {
  defaultTitle?: string | null;
  defaultBody?: string | null;
}): QuickIssueStep {
  return defaults.defaultTitle || defaults.defaultBody ? "confirm" : "input";
}

/** 入力ステップから先へ進めるか（本文が空なら推定する材料が無い） */
export function canProceedFromInput(body: string): boolean {
  return body.trim().length > 0;
}
