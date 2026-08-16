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

export type QuickSuggestKind = IssueDraftKind;

export type QuickSuggestResult = {
  /** 推定できなかった場合はnull（確認ステップでユーザーが選ぶ） */
  repositoryFullName: string | null;
  /** 種別が「質問」のとき、および生成に失敗したときはnull */
  title: string | null;
  labels: string[];
};

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
