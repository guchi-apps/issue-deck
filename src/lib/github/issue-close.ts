import { CHECK_USER_LABEL, isCheckUserReasonLabel } from "@/lib/github/approval-labels";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";

// **このファイルはサーバー・クライアントの両方から読む。** クローズのメニュー
// （`issue-detail.tsx`）が`CLOSE_REASON_LABELS`を使うため、GitHubを叩くコードを
// ここへ置いてはいけない——`issues-api.ts`は`node:async_hooks`まで連れてきて、
// クライアントのチャンク生成がその場で落ちる。実際に外す処理は
// `issue-close-cleanup.ts`（サーバー専用）にある。

/**
 * クローズしたIssueに残ると害になるラベルかどうか（#2178）。
 *
 * **一覧をここへベタ書きしない。** 理由ラベル（`01.check-*`と旧名`00.qa-answered`）の判定は
 * `isCheckUserReasonLabel`が持っており、名前を写すと移行中のリネームで片方だけ取り残される。
 *
 * 対象は2種類。
 *
 * - **`00.check-user`と理由ラベル。** 「人の確認待ち」はopenなIssueにしか意味が無い。今も
 *   `reusable-issue-labels.yml`の`cleanup-on-close`が外しているが、あちらは配布先リポジトリの
 *   `workflows/vN`タグが上がるまで効かず、理由ラベルまで外すようになったのはv18より後の
 *   コミット（`docs/supported-repositories.md`「v18では理由ラベル`01.check-*`は外れない」）。
 * - **`11.local`。** 誰も外さないまま残る。closeで走っているセッションは畳まれる（#1518）が、
 *   ラベルはそのままなので、盤面では「ローカルで対応中」（`isIssueExecutionStarted`）のまま
 *   になり、KILLが届かなかったホストや`ALIVE`でないセッションは
 *   `scripts/reap-sessions.sh`のholdでCLOSED経路へ進めず、tmuxセッションの本数上限（#1361）を
 *   埋め続ける。再オープンしたときに無人実行の停止フラグが古いまま残るのも同じ理由。
 *
 * **`21.plan-required`などの実装オプションは外さない。** そのIssueが計画提示を要することは
 * closeしても変わらず、再オープンしたときに選び直させる理由が無い。
 */
export function isLabelClearedOnClose(name: string): boolean {
  if (name === CHECK_USER_LABEL) return true;
  if (name === LOCAL_LABEL_NAME) return true;
  return isCheckUserReasonLabel(name);
}

/**
 * クローズ理由ラベルの名前（`90.`〜`96.`の`Close: *`）。正本は`.github/labels.json`で、
 * 名前が一致していることは`src/lib/labels-manifest.test.ts`が確かめる（#3237）。
 */
export const CLOSE_REASON_LABEL_NAMES = {
  another: "90.Close: another",
  duplicate: "91.Close: duplicate",
  invalid: "92.Close: invalid",
  cannotReproduce: "93.Close: cannot-reproduce",
  wontfix: "94.Close: wontfix",
  obsolete: "95.Close: obsolete",
  completed: "96.Close: completed",
} as const;

export type CloseReasonLabel = {
  /** GitHub上のラベル名 */
  name: string;
  /** メニューに出す文言 */
  label: string;
};

/**
 * 画面の「クローズする」から選べるクローズ理由（#2178）。
 *
 * **どれも`state_reason`は`not_planned`で送る。** 理由ラベルは「計画外の内訳」であって、
 * closeの種類そのものではない。GitHubには`duplicate`という`state_reason`もあるが、
 * Prismaの`IssueStateReason`（`COMPLETED`/`NOT_PLANNED`/`REOPENED`）に無いため使わない。
 * このため**`96.Close: completed`（対応完了）は並べない**。完了は「クローズする」ではなく
 * 「完了としてクローズ」の側（`state_reason=completed`）で、ラベルは対応完了を明示したいときに
 * 人がIssue詳細から付ける。
 *
 * **並びは「よく使う順」ではなく「判断の軽い順」。** 重複・見送り・不要は起票の重複や優先度・
 * 状況変化の話で済むが、`cannot-reproduce`・`invalid`・`another`は中身を確かめた結果なので
 * 後ろへ置く。
 */
export const CLOSE_REASON_LABELS: readonly CloseReasonLabel[] = [
  { name: CLOSE_REASON_LABEL_NAMES.duplicate, label: "重複しているとしてクローズ" },
  { name: CLOSE_REASON_LABEL_NAMES.wontfix, label: "見送りとしてクローズ" },
  { name: CLOSE_REASON_LABEL_NAMES.obsolete, label: "不要になったとしてクローズ" },
  { name: CLOSE_REASON_LABEL_NAMES.cannotReproduce, label: "再現できないとしてクローズ" },
  { name: CLOSE_REASON_LABEL_NAMES.invalid, label: "前提や内容が正しくないとしてクローズ" },
  { name: CLOSE_REASON_LABEL_NAMES.another, label: "他リポジトリで対応したとしてクローズ" },
];

/** 画面から受け取った文字列が、扱ってよいクローズ理由ラベルか（APIの入力検証用） */
export function isCloseReasonLabelName(name: string): boolean {
  return CLOSE_REASON_LABELS.some((reason) => reason.name === name);
}
