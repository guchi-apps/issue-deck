import { removeIssueLabel } from "@/lib/github/issues-api";
import { isLabelClearedOnClose } from "@/lib/github/issue-close";

/**
 * closeされたIssueから、残ると害になるラベルをGitHub上で外す（#2178）。**外せたラベル名を返す。**
 *
 * 何を外すかの判定は`issue-close.ts`の`isLabelClearedOnClose`（画面からも読むため純粋なまま）。
 *
 * **付いているものだけを叩く。** 呼び出し側は同期のために取ったラベル一覧を既に持っており、
 * それで絞れば無関係なcloseでGitHubへ1回も出て行かない。`removeIssueLabel`は付いていない
 * ラベル・リポジトリに定義が無いラベルの404を成功として扱うため、取りこぼしても害は無い。
 *
 * **投げない。** 呼び出し元はIssueの同期処理（`upsertIssueRow`）で、ここでの失敗がcloseそのものや
 * DB同期を巻き込むと、後片付けのための機能でIssueが閉じられなくなる（#1856の
 * `closeStrandedProgress`と同じ約束）。1枚外せなくても残りは続ける。
 */
export async function clearLabelsOnIssueClose(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  token: string;
  /** そのIssueにいま付いているラベル名（同期に使ったペイロードのもの） */
  currentLabelNames: readonly string[];
}): Promise<string[]> {
  const targets = params.currentLabelNames.filter(isLabelClearedOnClose);
  const removed: string[] = [];

  for (const name of targets) {
    try {
      await removeIssueLabel(params.owner, params.repo, params.issueNumber, params.token, name);
      removed.push(name);
    } catch (error) {
      console.error(
        `[issue-close] クローズ時のラベル除去に失敗しました（${params.owner}/${params.repo}#${params.issueNumber} ${name}）`,
        error,
      );
    }
  }

  return removed;
}
