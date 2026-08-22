import type { RepositoryReleaseStatus } from "@/hooks/use-repository-release-statuses";
import type { ConnectedRepository } from "@/types/repository";

/**
 * リリース・デプロイが片付いていないリポジトリの件数（#2167）。
 *
 * 数えるのは**リポジトリ（プロジェクト）の数**であって、PRの本数でもIssueの件数でもない。
 * メニューの「ブランチ」行は「いくつのプロジェクトが片付いていないか」を出す場所で、
 * 開いた先のブランチ画面もリポジトリ単位で並ぶため、そこと数え方を揃える。
 *
 * **手作業（`71.manual-step`）は数えない。** あれは「ユーザーの作業待ち」の行が持つ別の項目で、
 * 両方の行に同じものが出ると、どちらを押せば片付くのか分からなくなる。
 */
export type ReleaseActivityCounts = {
  /** リリース・デプロイが片付いていないリポジトリ数（`idle`以外のすべて） */
  total: number;
  /** 待っていれば進むもの（workflow実行中・CI実行中のPRがある） */
  progressing: number;
  /** 人のマージ操作を待っているもの（バージョンバンプPR・リリースPR） */
  mergePending: number;
  /**
   * リリース・本番デプロイの実行が失敗しているもの。
   *
   * **`progressing`と混ぜて「実行中」と言わない**（#2167のレビュー指摘）。判定の元になる
   * `hasFailed`は`cancelled`・`skipped`も失敗として扱い、しかも次に成功する実行が現れるまで
   * 消えないため、動いていないものを「実行中」と書くと数字が信用できなくなる。
   */
  failed: number;
  /**
   * `mergePending + failed`。**オレンジの丸を点ける条件**——どちらも人が手を動かすまで進まない。
   * 丸を点けたまま数字を`0`にはできない（丸の中に出るのが数字そのもの）ので、`total`からは
   * 失敗を外さず、言葉のほうで「実行中」と「失敗」を書き分ける。
   */
  actionRequired: number;
};

/**
 * リリース状況のサマリ（`GET /api/repositories/release-pending-merges`）から、
 * リリース・デプロイが片付いていないリポジトリ数と、その内訳を数える。
 *
 * **APIは`idle`のリポジトリを返さない**（`api/repositories/release-pending-merges/route.ts`）ため、
 * 返ってきたものがそのまま「片付いていないプロジェクト」になる。
 *
 * **左メニューで非表示にしたリポジトリは数えない**（#2167のレビュー指摘）。APIの母集団は
 * `archived: false`だけで絞っており非表示のものも返すが、この件数を押して開くブランチ画面は
 * `visibleRepositories`（`hidden`を除いた集合）で組み立てられる（`issue-deck-shell.tsx`）。
 * 揃えないと「1件と出ているのに開いた先に無い」が起こる。`repositories`を渡さない場合は
 * 絞り込まない。
 *
 * **未取得（`null`）と0件を区別して返す。** 未取得のうちは`null`を返し、呼ぶ側は数字を出さない。
 * 0を出すと「片付いていないものが無い」と読めてしまうため（`countReleaseMergePending`と同じ作法）。
 */
export function countReleaseActivity(
  releaseStatuses: RepositoryReleaseStatus[] | null,
  repositories?: Pick<ConnectedRepository, "fullName" | "hidden">[],
): ReleaseActivityCounts | null {
  if (releaseStatuses === null) return null;

  const hiddenFullNames = new Set(
    (repositories ?? []).filter((repo) => repo.hidden).map((repo) => repo.fullName),
  );
  const visible = releaseStatuses.filter(
    (releaseStatus) => !hiddenFullNames.has(releaseStatus.repoFullName),
  );

  const countOf = (status: RepositoryReleaseStatus["status"]) =>
    visible.filter((releaseStatus) => releaseStatus.status === status).length;

  const mergePending = countOf("action_required");
  const failed = countOf("error");

  return {
    total: visible.length,
    progressing: countOf("progressing"),
    mergePending,
    failed,
    actionRequired: mergePending + failed,
  };
}

/** ブランチ画面が何を見せる場所かの説明。件数が無いときはこれだけを出す */
const FLOW_NAV_TITLE = "Issue・ブランチ・Pull Requestの関係とマージ先までの流れ";

/**
 * メニューの「ブランチ」行に添える文言（`title`）。
 *
 * **数字と丸で意味が違う**ため、行のラベル（「ブランチ」）からは何を数えているのか読めない。
 * 数字は片付いていないプロジェクト数、オレンジの丸は「そのうち人が操作するまで進まないものが
 * ある」という合図なので、内訳をここで補う（「質問」の行の`formatQuestionNavTitle`と同じ考え方）。
 *
 * **「実行中」と「失敗」を必ず書き分ける。** 失敗は動いていないので、まとめて「実行中」と
 * 書くと数字の意味が崩れる（#2167のレビュー指摘）。
 */
export function describeReleaseActivity(counts: ReleaseActivityCounts | null): string {
  if (counts === null || counts.total === 0) {
    return `${FLOW_NAV_TITLE}（未完了のリリース・デプロイはありません）`;
  }

  const breakdown = [
    counts.progressing > 0 ? `実行中${counts.progressing}件` : null,
    counts.mergePending > 0 ? `マージ待ち${counts.mergePending}件` : null,
    counts.failed > 0 ? `失敗${counts.failed}件` : null,
  ]
    .filter((part) => part !== null)
    .join("・");

  return `${FLOW_NAV_TITLE}（リリース・デプロイが未完了のプロジェクト${counts.total}件: ${breakdown}）`;
}
