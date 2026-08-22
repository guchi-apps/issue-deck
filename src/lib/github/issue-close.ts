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

/** クローズ理由ラベル（`90.Close: *`）の接頭辞 */
export const CLOSE_REASON_LABEL_PREFIX = "90.Close: ";

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
 *
 * **並びは「よく使う順」ではなく「判断の軽い順」。** 重複・見送りは起票の重複や優先度の話で
 * 済むが、`invalid`・`another`は中身を確かめた結果なので後ろへ置く。
 */
export const CLOSE_REASON_LABELS: readonly CloseReasonLabel[] = [
  { name: `${CLOSE_REASON_LABEL_PREFIX}duplicate`, label: "重複しているとしてクローズ" },
  { name: `${CLOSE_REASON_LABEL_PREFIX}wonfix`, label: "見送りとしてクローズ" },
  { name: `${CLOSE_REASON_LABEL_PREFIX}invalid`, label: "正しくない・再現しないとしてクローズ" },
  { name: `${CLOSE_REASON_LABEL_PREFIX}another`, label: "他リポジトリで対応したとしてクローズ" },
];

/** 画面から受け取った文字列が、扱ってよいクローズ理由ラベルか（APIの入力検証用） */
export function isCloseReasonLabelName(name: string): boolean {
  return CLOSE_REASON_LABELS.some((reason) => reason.name === name);
}
