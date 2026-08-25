/**
 * `lib/claude/`のうち、**画面（クライアントコンポーネント）からも読む純粋なもの**を置く（#2347）。
 *
 * AI呼び出し本体（`issue-search.ts`・`issue-order.ts`・`new-app-consult.ts`）は
 * `request.ts` → `api-usage.ts`（消費量の集計。プロセス内に直近ぶんのバケットを持つ
 * サーバー側の仕組み）を辿るため、そこから定数を値importするとクライアントバンドルへ
 * 集計モジュールごと載る。`lib/github/issues-api.ts`と同じ分け方で、**判定・定数のような
 * 純粋なものと、Anthropic APIを叩くものはファイルを分ける**（docs/code-map.md）。
 *
 * ここに置くのは「プロンプトの組み立てにも画面の注記にも使う値」で、**型は対象外**
 * （`import type`はバンドルに残らないため、各機能のモジュールに置いたままでよい）。
 */

/**
 * あいまい検索で1回の判定でClaudeへ渡す候補Issueの上限（#1788）。
 *
 * 候補はプロンプトへそのまま並ぶため、母集団が数千件あると入力だけで枠を食い潰す。
 * 一覧に並んでいる順（＝新しい順）の先頭から数えてここまでを対象にし、
 * 超過分は対象外である旨を画面に出す。
 */
export const ISSUE_SEARCH_CANDIDATE_LIMIT = 300;

/**
 * 着手順の判定で1回にClaudeへ渡す候補Issueの上限（#1853）。
 *
 * あいまい検索（300件）より少ないのは、こちらは1件ごとに本文の冒頭も載せるため。
 * 未着手がこれより多い場合は一覧に並んでいる順（＝新しい順）の先頭から数えて
 * ここまでを対象にし、超過分は対象外である旨を画面に出す。
 */
export const ISSUE_ORDER_CANDIDATE_LIMIT = 60;

/** 候補1件につきプロンプトへ載せる本文の文字数。 */
export const ISSUE_ORDER_BODY_HEAD_LENGTH = 200;

export type ConsultRole = "user" | "assistant";

export type ConsultMessage = {
  role: ConsultRole;
  content: string;
};

/**
 * 新規アプリの相談の往復数の上限。**超えたら設定ステップへ進んでもらう。**
 *
 * 構想を固めるのが目的で、仕様を詰めきる場ではない。細かい決めごとは設定ステップの
 * 入力欄と、そこから起票される初期化Issueで扱う。
 */
export const MAX_CONSULT_TURNS = 8;

/** 最初にこちらから話しかける一言。**APIを呼ばずに出す**（開いただけでプラン枠を使わない）。 */
export const CONSULT_OPENING_MESSAGE = "どんなアプリを作りたいですか。ざっくりで大丈夫です。";

/** 会話の往復数（ユーザーの発言の数）。 */
export function countConsultTurns(messages: ConsultMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

/** 上限に達したか。達していたら設定ステップへ促す。 */
export function isConsultExhausted(messages: ConsultMessage[]): boolean {
  return countConsultTurns(messages) >= MAX_CONSULT_TURNS;
}
