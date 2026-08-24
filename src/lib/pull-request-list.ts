import type {
  AiReview,
  AiReviewState,
  MergeJudgement,
  MergeJudgementStep,
} from "@/lib/github/check-rollup";
import type {
  PullRequestKind,
  PullRequestSummary,
  PullRequestViewId,
} from "@/types/pull-request";

/** Issue専用ブランチの命名規約（`scripts/start-issue.sh`が作成する`issue-<番号>`） */
const ISSUE_BRANCH_PATTERN = /^issue-(\d+)$/;

/** バージョンバンプPRのheadブランチ（`release-develop-to-main.yml`が作る`release/vX.Y.Z`） */
const VERSION_BUMP_BRANCH_PREFIX = "release/v";

/**
 * リリースPR（→`main`）のheadブランチ（`release-develop-to-main.yml`が作る
 * `release-main/vX.Y.Z`。#2117）。
 *
 * **`develop`そのものではなく固定したブランチをheadにする**のは、PRのheadが常にブランチの
 * 先端を追うため、`develop`のままだとバンプ後にdevelopへ入った変更まで同じリリースで
 * mainへ出てしまうから（更新履歴にも対象issueにも載らないまま出る）。
 *
 * `release/v`（バンプPR）と接頭辞が重ならない名前にしてある。ここを変えると
 * `classifyPullRequest`がリリースPRを`other`と判定し、リリース画面・ブランチ画面から
 * リリースPRが消える。
 */
export const RELEASE_BRANCH_PREFIX = "release-main/v";

/** リリースPR（→`main`）のheadか。`develop`は`release-main/v`導入前の形式（#2117） */
export function isReleaseHeadRef(headRef: string): boolean {
  return headRef === "develop" || headRef.startsWith(RELEASE_BRANCH_PREFIX);
}

/**
 * 本番のリリース用ブランチ。`lib/branch-flow.ts`の`MAIN_BRANCH`と同じ値だが、あちらが
 * こちらをimportしているため定数の向きを逆にできず、ここでも持つ。
 */
const MAIN_BRANCH = "main";

/** タイトル・本文中の`#123`形式のIssue参照 */
const ISSUE_REFERENCE_PATTERN_GLOBAL = /#(\d+)/g;

/**
 * PRのbase/headブランチから種別を判定する。
 *
 * ブランチ名だけで判定できるのは、issue-deckのマルチエージェント運用がブランチ名の規約
 * （`issue-<番号>` / `release/vX.Y.Z` / `release-main/vX.Y.Z` / `develop` / `main`）に
 * 依存しているため（[docs/multi-agent/branching.md](../../docs/multi-agent/branching.md)）。
 * 規約から外れたブランチは`other`になるだけで、一覧からは落とさない。
 *
 * **`main`宛のリリースPRはheadが2通りある。** `release-main/vX.Y.Z`（#2117以降）と`develop`
 * （それ以前・共有ワークフローの参照タグが古いリポジトリ）で、どちらも`release`として扱う。
 */
export function classifyPullRequest(pullRequest: {
  baseRef: string;
  headRef: string;
}): PullRequestKind {
  const { baseRef, headRef } = pullRequest;
  if (baseRef === MAIN_BRANCH && isReleaseHeadRef(headRef)) return "release";
  if (headRef.startsWith(VERSION_BUMP_BRANCH_PREFIX)) return "version-bump";
  if (ISSUE_BRANCH_PATTERN.test(headRef)) return "issue";
  return "other";
}

/**
 * PRに対応するIssue番号を推定する。`issue-<番号>`ブランチ名を最優先し、規約から外れた
 * ブランチではタイトル→本文の順に最初の`#<番号>`参照を使う。特定できなければnull。
 *
 * Issue側の「対応PR」表示（`pull-request-link.ts`）がコメント本文のPR URLから逆方向に
 * 引くのに対し、こちらはPR側からIssueを引く。PR一覧はIssueのコメントを取得しないため、
 * 同じ対応関係を別の手掛かりで解決している。
 */
export function extractLinkedIssueNumber(pullRequest: {
  headRef: string;
  title: string;
  body: string | null;
}): number | null {
  return extractLinkedIssueNumbers(pullRequest)[0] ?? null;
}

/**
 * PRが参照しているIssue番号を、確度の高い順にすべて返す（#1455）。
 *
 * 1本のPRで複数のIssueに対応することがあるため、`extractLinkedIssueNumber`（先頭1件）では
 * 関連を取りこぼす。先頭は「そのブランチが何の作業か」を最もよく表すもの
 * （`issue-<番号>`ブランチ名 → タイトル → 本文の順）で、以降は同じ順で拾った参照。
 *
 * **本文中の`#番号`は単なる言及も混ざる**ため、2件目以降は「対応Issue」ではなく
 * 「関連Issue」として扱う（画面もその文言で出す）。
 */
export function extractLinkedIssueNumbers(pullRequest: {
  headRef: string;
  title: string;
  body: string | null;
}): number[] {
  const numbers: number[] = [];
  const add = (value: number) => {
    if (!numbers.includes(value)) numbers.push(value);
  };

  const branchMatch = ISSUE_BRANCH_PATTERN.exec(pullRequest.headRef);
  if (branchMatch) add(Number(branchMatch[1]));

  for (const text of [pullRequest.title, pullRequest.body ?? ""]) {
    for (const match of text.matchAll(ISSUE_REFERENCE_PATTERN_GLOBAL)) {
      add(Number(match[1]));
    }
  }
  return numbers;
}

/**
 * 作成が古い順（＝最も長くマージを待っている順）に並べる。作成日時が同じ場合は
 * リポジトリ名・PR番号で安定させる。
 */
export function sortOpenPullRequests(pullRequests: PullRequestSummary[]): PullRequestSummary[] {
  return [...pullRequests].sort((a, b) => {
    const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (diff !== 0) return diff;
    const byRepo = a.repositoryFullName.localeCompare(b.repositoryFullName);
    return byRepo !== 0 ? byRepo : a.number - b.number;
  });
}

/**
 * 更新が新しい順に並べる。更新日時が同じ場合はリポジトリ名・PR番号で安定させる。
 * 「すべてのPR」ビュー向け（#1312）。滞留の長さで並べる他のビューと違い、こちらは
 * 「いま何が動いたか」を追う一覧なので、直近に動いたPRを上に出す。
 */
export function sortPullRequestsByUpdated(
  pullRequests: PullRequestSummary[],
): PullRequestSummary[] {
  return [...pullRequests].sort((a, b) => {
    const diff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (diff !== 0) return diff;
    const byRepo = a.repositoryFullName.localeCompare(b.repositoryFullName);
    return byRepo !== 0 ? byRepo : a.number - b.number;
  });
}

/**
 * ビューごとの絞り込み（#1312）。母集団の広さ（closedを取りに行くか）は
 * `scopeForPullRequestView`が決め、ここは受け取った一覧を絞るだけ。
 *
 * **どのビューもopenなPRしか通さない**（#1613）。「すべてのPR」もマージ済み・クローズ済みを
 * 含めるのをやめたため、`scope`が`all`の取得結果（ブランチ画面が要求する）を渡しても
 * 一覧の内容は変わらない。
 *
 * ドラフトとCI状態不明を`in-progress`側へ入れているのは、どちらも「まだ結果が確定していない」
 * ためにマージの判断ができない点で同じだから（ドラフトはCI状態を取得していないので常に`unknown`）。
 *
 * **CIが通ったあと自動マージ可否の判定が動いている間（`isMergeJudgementPending`）も
 * `in-progress`側へ入れる**（#2283）。判定ワークフロー（`claude-review-develop.yml`）の
 * check-runはCI状態の集約から外してあるため（#1799）、Claudeがレビューしている最中でも
 * `ciState`は`success`になり「マージ待ち」に並んでいた。だが判定中は画面のマージボタン自体が
 * 無効で（#1968）、押せる操作が何も無い。ベルの「対応が必要なもの」もこの母集団を使うため、
 * 一覧・件数バッジからも同時に外れる（`lib/notifications.ts`）。
 *
 * **CI失敗（`ciState`が`failure`）だけは判定中でも`completed`に残す。** 判定はCIと並行に走り、
 * `wait-for-ci`はCIのconclusionを見ずに抜ける（#2066）ため、**CIが落ちた後も判定が終わるまでの
 * 数分は`pending`のまま**になる。この窓で外すと、ベルの赤い「チェック失敗」がその間だけ消える。
 * 判定の結果がどうであれCIが落ちたPRは人が直すしかなく、`isMergeWaitingForChecks`が
 * 「待っても解消しないもの」としてCI失敗を外さないのと同じ扱いにそろえる。
 */
export function filterPullRequestsByView(
  pullRequests: PullRequestSummary[],
  view: PullRequestViewId,
): PullRequestSummary[] {
  return pullRequests.filter((pullRequest) => {
    if (pullRequest.state !== "open") return false;
    if (view === "all") return true;
    const completed =
      !pullRequest.draft &&
      (pullRequest.ciState === "failure" ||
        (pullRequest.ciState === "success" &&
          !isMergeJudgementPending(pullRequest.mergeJudgement)));
    return view === "completed" ? completed : !completed;
  });
}


/**
 * 左メニュー「Pull Request」セクションに出す件数（#1389）。`null`は「件数を出さない」。
 */
export type PullRequestNavCounts = Record<PullRequestViewId, number | null>;

/**
 * ビューごとの件数を数える（#1389）。Issue側の`computeNavCounts`と同じく、渡すのは
 * ビューの絞り込みを掛ける前・それ以外（リポジトリ絞り込みなど）は掛けた後の集合にする。
 * そうしないとメニューの件数と一覧の件数が食い違う。
 *
 * `null`になるのは**未取得**（`loaded`がfalse）のときだけ。PR一覧はDBキャッシュを持たず取得に
 * 時間がかかるため、取得前に`0`を出すと「PRが無い」と読めてしまう。
 *
 * 「すべてのPR」は以前、母集団が`scope`（openだけか、直近のクローズ済みまで含むか）に依存して
 * 「全PR数」として読める数にならないため件数を出していなかった（#1389）。openなPRだけを出す
 * ビューになったので（#1613）、どの`scope`の取得結果を渡しても同じ値になり、件数を出せる。
 */
export function computePullRequestNavCounts(
  pullRequests: PullRequestSummary[],
  loaded: boolean,
): PullRequestNavCounts {
  if (!loaded) return { all: null, "in-progress": null, completed: null };
  return {
    all: filterPullRequestsByView(pullRequests, "all").length,
    "in-progress": filterPullRequestsByView(pullRequests, "in-progress").length,
    completed: filterPullRequestsByView(pullRequests, "completed").length,
  };
}

/** ビューごとの、リポジトリ内・リポジトリ間の並び順（#1312） */
export function sortPullRequestsForView(
  pullRequests: PullRequestSummary[],
  view: PullRequestViewId,
): PullRequestSummary[] {
  return view === "all"
    ? sortPullRequestsByUpdated(pullRequests)
    : sortOpenPullRequests(pullRequests);
}

export type PullRequestRepositoryGroup = {
  repositoryFullName: string;
  repositoryPrivate: boolean;
  pullRequests: PullRequestSummary[];
};

/**
 * リポジトリごとにまとめる。グループの並び順はリポジトリ名順ではなく、`view`が決める並びで
 * 最初に来るPRを持つリポジトリから順に並ぶ。マージ待ち系のビューは「最も古いPRの作成日時」の
 * 昇順で、滞留が長いリポジトリを上に出す。「全てのPR」だけは更新が新しい順。
 */
export function groupPullRequestsByRepository(
  pullRequests: PullRequestSummary[],
  view: PullRequestViewId,
): PullRequestRepositoryGroup[] {
  const groups = new Map<string, PullRequestRepositoryGroup>();
  for (const pullRequest of sortPullRequestsForView(pullRequests, view)) {
    const existing = groups.get(pullRequest.repositoryFullName);
    if (existing) {
      existing.pullRequests.push(pullRequest);
    } else {
      groups.set(pullRequest.repositoryFullName, {
        repositoryFullName: pullRequest.repositoryFullName,
        repositoryPrivate: pullRequest.repositoryPrivate,
        pullRequests: [pullRequest],
      });
    }
  }
  // 並べ替え済みの結果を順に詰めているため、Mapの挿入順が既にグループの並び順になる。
  return [...groups.values()];
}

/**
 * issue-deckの画面からマージ操作を出してよいPRか。draft以外はすべて対象にする（#1087）。
 *
 * 以前はCI通過済み・Auto-merge無効のPRだけにボタンを出していたが、CIが落ちたPRを確認のうえ
 * マージする、Auto-mergeの完了を待たずに今すぐ入れる、といった操作のためだけにGitHubへ
 * 移動する必要があった。「そのままマージしてよいか」の判断材料は`mergeWarnings`が文言で返し、
 * 実行前に確認を挟む形にしている。draftだけはGitHub側がマージを受け付けないため対象外。
 *
 * 画面内のリンクからマージ済み・クローズ済みのPRも開けるようになったため（#1260）、
 * openでないPRも対象外にする。
 *
 * **コンフリクトしているPR（`mergeable`が`false`）も対象外**（#1742）。CI失敗と違って
 * 「確認のうえマージする」余地が無く、押してもGitHubが受け付けないため。代わりに同じ場所へ
 * 「コンフリクトを自動解消」が出る（`repairKindsFor`）。`null`（判定中・未取得）のときは
 * 従来どおりボタンを出す——判定前を「コンフリクトあり」として扱わないため。
 */
export function canMergeFromDeck(pullRequest: PullRequestSummary): boolean {
  return pullRequest.state === "open" && !pullRequest.draft && pullRequest.mergeable !== false;
}

/**
 * 自動ではマージされず、ユーザーが手でマージする必要があるPRか（#1469）。
 *
 * develop向けPRを「自動マージしてよい」「ユーザーのマージが必要」のどちらかへ確定させるのは
 * `claude-review-develop.yml`（`risk-check` → `auto-merge`）だけで、そのcallerを持たない
 * リポジトリでは`reusable-issue-labels.yml`の`develop-pr-opened`がPR作成時に保険として
 * 確定させる（#1470）。**どちらも結論をPRではなく対応Issueの`00.check-user`として書く**ため、
 * ここでは`linkedIssueCheckUser`をその確定結果として読む。
 *
 * - `release`（develop→main）は`CLAUDE.md`の自動マージ不可カテゴリで、常にユーザーがマージする。
 * - `version-bump`（`release/vX.Y.Z`→develop）は`release-develop-to-main.yml`がAuto-mergeで
 *   developへ入れるため対象外。
 * - `other`（規約から外れたブランチ）は判定材料が無いため出さない。対応Issueの推定が
 *   タイトル・本文の`#123`参照頼りになり、単なる言及を拾って誤検知しうる。
 * - Auto-merge有効なPRは待てば入るので出さない。
 * - **CIの結果は見ない。** #1433がCI実行中を「要操作」から外しているのは押しても弾かれる
 *   ボタンの強調についてで、こちらは「自動ではマージされない」という事実の表示にあたる。
 *
 * **理由ラベル（`01.check-*`）が読めるならそれで判定する**（#1490）。`01.check-merge`だけを
 * マージ待ちとして扱い、計画の承認待ち・質問の回答待ちで付いた`00.check-user`は除く。
 * 理由ラベルが配られていないリポジトリでは`linkedIssueCheckReason`が`null`になり、
 * 従来どおり`00.check-user`の有無だけで判定する。そちらでも、ここで見るのは「そのIssueに
 * openなdevelop向けPRがある」場面に限られるため、マージ保留以外の意味にはなりにくい。
 */
export function requiresUserMerge(pullRequest: PullRequestSummary): boolean {
  if (pullRequest.state !== "open" || pullRequest.merged || pullRequest.draft) return false;
  if (pullRequest.autoMergeEnabled) return false;
  if (pullRequest.kind === "release") return true;
  if (pullRequest.kind !== "issue") return false;
  if (pullRequest.linkedIssueCheckReason !== null) {
    return pullRequest.linkedIssueCheckReason === "merge";
  }
  return pullRequest.linkedIssueCheckUser;
}

/**
 * 「ユーザーの確認待ち」へ一緒に出す候補のPull Request（#1613）。
 *
 * `requiresUserMerge`なPRのうち、**対応Issueが同じ一覧に並んでいないものだけ**を返す。
 * develop向けPRは判定結果を対応Issueの`00.check-user`として書く（`requiresUserMerge`の
 * コメント参照）ので、そのままでは同じ案件がIssueとPRで二重に並ぶ。逆に、develop→mainの
 * リリースPRは対応Issueを持たないため、除外しなければどの確認待ちにも現れない。これが
 * この一覧にPRを混ぜる主な理由。
 *
 * ここから先、「いま押せるもの」（`pullRequestsAwaitingUserMerge`）と「CI・判定の完了待ち」
 * （`pullRequestsWaitingForMergeChecks`）へ分かれる。母集団を1か所に持つのは、2つの数を
 * 足したものが従来の件数と必ず一致するようにするため。
 */
function pullRequestsRequiringUserMerge(
  pullRequests: PullRequestSummary[],
  checkUserIssues: readonly { repositoryFullName: string; number: number }[],
): PullRequestSummary[] {
  const listedIssues = new Set(
    checkUserIssues.map((issue) => `${issue.repositoryFullName}#${issue.number}`),
  );
  return sortOpenPullRequests(
    pullRequests.filter((pullRequest) => {
      if (!requiresUserMerge(pullRequest)) return false;
      // 本文の`#番号`参照から拾った2件目以降（`linkedIssueNumbers`）は単なる言及のことがあり、
      // それで重複と見なすと確認待ちからPRが消えてしまうため、対応Issueの1件だけで判定する。
      if (pullRequest.linkedIssueNumber === null) return true;
      return !listedIssues.has(
        `${pullRequest.repositoryFullName}#${pullRequest.linkedIssueNumber}`,
      );
    }),
  );
}

/**
 * ユーザーのマージを待ってはいるが、**いま押しても入らない**PRか（#2081）。
 *
 * 外すのは「待てば勝手に状態が変わるもの」だけに絞る。CI実行中（`ciState`が`pending`）は
 * GitHubがマージを弾き、自動マージ可否の判定中（`isMergeJudgementPending`）は画面側が
 * マージボタンを無効化する（#1968）ので、どちらも並べたところで押す先が無い。
 * リリースPRを各リポジトリへ一斉に起票した直後は、この2つで一覧が埋まっていた。
 *
 * **CI失敗・コンフリクトは外さない。** 待っても解消せず人が動くしかないもので、CI失敗は
 * 確認ダイアログを挟めば画面からマージでき（`mergeWarnings`）、コンフリクトは同じ場所が
 * 「コンフリクトを自動解消」の入口になる（`repairKindsFor`）。
 *
 * `ciState`が`unknown`（`Checks: read`が無い・CIを持たないリポジトリ・取得失敗）も外さない。
 * #1433がリリースボタンの「要操作」判定で取った倒し方と同じで、状態が取れないことを理由に
 * マージの導線まで消さない。
 */
export function isMergeWaitingForChecks(pullRequest: PullRequestSummary): boolean {
  return pullRequest.ciState === "pending" || isMergeJudgementPending(pullRequest.mergeJudgement);
}

/**
 * 詳細のヘッダーに出す`PullRequestSummary`を、一覧の項目と詳細APIの`summary`から選ぶ
 * （#1578・#2149）。
 *
 * 一覧に載っていればそれを使う（CI状態まで揃っていて即座に描ける）。載っていない場合は
 * 詳細APIが返す`summary`で補う——画面内のリンクからマージ済み・クローズ済みのPRを開いた
 * 経路（#1260）。
 *
 * **両方あるときは取得が新しい方を採る**（#1578）。一覧はPR画面を開いている間しか自動更新
 * されず、詳細ヘッダーの更新ボタンは詳細しか取り直さない。一覧を無条件に優先すると、更新を
 * 押してCIが通ったことを取り直しても、一覧を開いた時点の「CI失敗」が出たまま消えなかった。
 *
 * 取得中・別のPRへ切り替えた直後に前のPRのヘッダーが残らないよう、`detail`はidの一致を
 * 確認してから使う。
 *
 * @param pullRequestId 詳細を開いているPRのid（`<owner>/<repo>#<番号>`）。未選択はnull
 * @param pullRequests 一覧の母集団
 * @param pullRequestsFetchedAt 一覧の取得時刻（ISO8601）。未取得はnull
 * @param detail 詳細APIの結果。取得前・取得失敗時はnull
 */
export function resolvePullRequestHeader(
  pullRequestId: string | null,
  pullRequests: readonly PullRequestSummary[],
  pullRequestsFetchedAt: string | null,
  detail: { id: string; summary: PullRequestSummary; fetchedAt: string } | null,
): PullRequestSummary | null {
  if (!pullRequestId) return null;
  const fromList = pullRequests.find((pullRequest) => pullRequest.id === pullRequestId) ?? null;
  const fromDetail = detail && detail.id === pullRequestId ? detail : null;
  if (!fromDetail) return fromList;
  if (!fromList) return fromDetail.summary;
  return pullRequestsFetchedAt && pullRequestsFetchedAt > fromDetail.fetchedAt
    ? fromList
    : fromDetail.summary;
}

/**
 * 「ユーザーの確認待ち」へ一緒に出すPull Requestを選ぶ（#1613・#2081）。
 *
 * 返すのは`pullRequestsRequiringUserMerge`のうち**いまマージを押せるもの**だけ。件数
 * （左メニュー・一覧ヘッダー・スマホホームの「要対応」）もこの結果から数えるため、
 * 一覧の中身と数字は今までどおり一致する（#1713）。
 *
 * @param checkUserIssues 「ユーザーの確認待ち」ビューに並んでいるIssue（リポジトリ名と番号だけ見る）
 */
export function pullRequestsAwaitingUserMerge(
  pullRequests: PullRequestSummary[],
  checkUserIssues: readonly { repositoryFullName: string; number: number }[],
): PullRequestSummary[] {
  return pullRequestsRequiringUserMerge(pullRequests, checkUserIssues).filter(
    (pullRequest) => !isMergeWaitingForChecks(pullRequest),
  );
}

/**
 * 一覧から外した「CI・判定の完了待ち」のPull Request（#2081）。
 *
 * 外したものを画面から完全に消すと、リリースPRのように対応Issueを持たないPRは
 * **どこにも現れないまま数分後に突然6件現れる**。一覧には並べないが、枠の下に件数だけ
 * 1行出して「あと何件来るのか」を読めるようにする。**件数には足さない**——手作業待ちが
 * 前提待ちを件数から外して一覧の見出しにだけ出すのと同じ扱い（#1763）。
 */
export function pullRequestsWaitingForMergeChecks(
  pullRequests: PullRequestSummary[],
  checkUserIssues: readonly { repositoryFullName: string; number: number }[],
): PullRequestSummary[] {
  return pullRequestsRequiringUserMerge(pullRequests, checkUserIssues).filter(
    isMergeWaitingForChecks,
  );
}

/** 判定中でマージボタンを押せないときに、ボタンへ出す短い表示（#1968） */
export const MERGE_JUDGEMENT_PENDING_LABEL = "判定中";

/**
 * 判定のどの段階を待っているかを表す、画面のバッジの文言（#2059）。
 *
 * ジョブ名をそのまま出さないのは、待っている人が知りたいのが「いま何が動いているか」では
 * なく「あと何が終われば押せるのか」だから。とくに`claude-review`は数分かかり、CIより長い
 * ことが多いため、CIと並行して走るようにした後（#2066）も「CI通過」が出た後にここだけが
 * 動いている窓は残る。
 */
export const MERGE_JUDGEMENT_STEP_LABEL: Record<MergeJudgementStep, string> = {
  "wait-for-ci": "CIの完了待ち",
  "risk-check": "マージ可否を判定中",
  "claude-review": "Claudeがレビュー中",
  "auto-merge": "自動マージの判定中",
};

/** 段階を特定できないときの表示。ジョブ名が想定外・チェックが多すぎて1件ずつ見られない場合（#2059） */
export const MERGE_JUDGEMENT_FALLBACK_LABEL = "マージ可否を判定中";

/** 判定中のバッジに出す文言。段階が分からなければ`MERGE_JUDGEMENT_FALLBACK_LABEL`（#2059） */
export function mergeJudgementLabel(step: MergeJudgementStep | null): string {
  return step === null ? MERGE_JUDGEMENT_FALLBACK_LABEL : MERGE_JUDGEMENT_STEP_LABEL[step];
}

/**
 * 判定中でマージボタンを押せない理由。ボタンとバッジの`title`に出す（#1968・#2059）。
 *
 * **`title`は補助でしかない。** スマホではツールチップが表示されないため、待っている相手は
 * バッジ（`MergeJudgementBadge`）として画面に出す。理由の文言をここへ寄せているのは、
 * PCでマウスを載せたときに「押せない理由」まで読めるようにするため。
 */
export function mergeJudgementReason(step: MergeJudgementStep | null): string {
  return `${mergeJudgementLabel(step)}です（claude-review-develop）。判定が終わると、自動マージされるか、確認が必要な場合は00.check-userが付いて押せるようになります。`;
}

/**
 * バッジとして描く、Claudeのレビューの「終わった後」の状態（#2150）。
 * `AiReviewState`から`pending`（実行中）と`none`（check-runが無い）を除いたもの。
 */
export type AiReviewSettledState = Exclude<AiReviewState, "pending" | "none">;

/**
 * Claudeのレビューの状態を表す、画面のバッジの文言（#2150）。
 *
 * **`pending`は入っていない。** 実行中の言い回しは`MERGE_JUDGEMENT_STEP_LABEL`の
 * 「Claudeがレビュー中」が既に持っており、両方出すと同じことを2回言うことになる。
 * このバッジが引き受けるのは「終わった後」の3状態だけ。
 */
export const AI_REVIEW_SETTLED_LABEL: Record<AiReviewSettledState, string> = {
  passed: "Claudeのレビュー完了",
  skipped: "Claudeのレビュー省略",
  failed: "Claudeのレビュー失敗",
};

/** バッジの`title`に出す説明（#2150）。PCでマウスを載せたときに、その状態の意味まで読めるようにする */
export const AI_REVIEW_SETTLED_REASON: Record<AiReviewSettledState, string> = {
  passed: "Claude Codeによるレビューが終わっています（claude-review-develop）。",
  skipped:
    "差分が小さくリスクのあるパスも含まれないため、Claude Codeによるレビューは実行されていません（claude-review-develop / risk-check）。",
  failed:
    "Claude Codeによるレビューが失敗しました（claude-review-develop）。対応Issueへ00.check-userが付き、ユーザーの確認待ちになります。",
};

/**
 * バッジを出す状態か（#2150）。**出すのは終わった3状態だけ。**
 *
 * `pending`は上のとおり「Claudeがレビュー中」が受け持ち、`none`（check-runが無い）は
 * ワークフロー未配布・リリースPR・起動前のいずれかで、言えることが何も無いため出さない。
 */
export function aiReviewSettledState(
  aiReview: AiReview | null | undefined,
): AiReviewSettledState | null {
  const state = aiReview?.state;
  return state === "passed" || state === "skipped" || state === "failed" ? state : null;
}

/**
 * 自動マージ可否の判定がまだ下っていないPRか（#1968）。**真のあいだは画面からマージさせない。**
 *
 * 判定を行う`claude-review-develop.yml`のcheck-runは、CI状態の集約から外してある（#1799）。
 * そのため判定が走っている最中でも`ciState`は`success`になり、`mergeWarnings`が空＝確認
 * ダイアログすら出ないまま1クリックでマージできていた。実際にPR #1959は判定の6分前に
 * 画面のマージボタンでdevelopへ入り、`00.check-user`・`01.check-merge`はマージ後に付いた
 * （マージ前の確認として機能していない）。
 *
 * **この窓のあいだ、人がマージを押す必要は本来ない。** 判定が「自動マージしてよい」なら
 * ワークフロー自身がマージし、「確認が必要」なら対応Issueへ`00.check-user`が付いて
 * `requiresUserMerge`が真になり、ボタンはまた押せるようになる。
 *
 * 警告ダイアログではなく無効化にしているのは、事故が「ダイアログを読み飛ばした」ではなく
 * 「ダイアログが出なかった」ために起きているため。判定のcheck-runが1件も無いリポジトリ
 * （ワークフロー未配布・起動前）は`unknown`で従来どおり押せる。
 *
 * `null`・`undefined`（未取得）も押せる側＝`false`として扱う。呼び出し元
 * （`IssueMergeButton`）でその場しのぎの既定値を組み立てさせないための判定側の責務（#2059）。
 */
export function isMergeJudgementPending(
  mergeJudgement: MergeJudgement | null | undefined,
): boolean {
  return mergeJudgement?.state === "pending";
}

/**
 * mainへ入る＝押した瞬間に本番デプロイが走るPRか（#2080）。
 *
 * 「確認ダイアログを必ず挟む」（`mergeWarnings`）と「ダイアログに含まれる変更を並べる」
 * （`PullRequestMergeChanges`）が同じ条件で動く必要があるため、判定をここへ置いて共有する。
 */
export function isProductionMerge(pullRequest: { baseRef: string }): boolean {
  return pullRequest.baseRef === MAIN_BRANCH;
}

/**
 * そのままマージすると意図しない結果になりうる状態の説明。空配列なら確認なしでマージしてよい。
 * 画面はこの内容を確認ダイアログに並べる。
 *
 * 自動マージ可否の判定中（`isMergeJudgementPending`）はここではなくボタンの無効化で止める。
 * 「確認して押す」余地がある状態ではなく、判定が終わるまで待つべき状態のため（#1968）。
 */
export function mergeWarnings(pullRequest: PullRequestSummary): string[] {
  const warnings: string[] = [];
  // mainへのマージは本番へ出す操作そのもので、押した瞬間にdeploy.ymlが走る。CI通過済みで
  // 待ちが無いPRは1クリックでマージする既定のままだと、確認なしで本番反映まで進んでしまう。
  // **警告を1つ返すことで、既存の「警告があれば確認ダイアログを挟む」経路に必ず乗せる**（#1548）。
  if (isProductionMerge(pullRequest)) {
    warnings.push("mainへのマージです。マージすると本番デプロイが走ります。");
  }
  if (pullRequest.ciState === "failure") {
    warnings.push("CIが失敗しています。");
  } else if (pullRequest.ciState === "pending") {
    warnings.push("CIがまだ実行中です。");
  } else if (pullRequest.ciState === "unknown") {
    warnings.push("CIの状態を確認できていません。");
  }
  if (pullRequest.autoMergeEnabled) {
    warnings.push("Auto-mergeが有効です。待てばCI通過後に自動でマージされます。");
  }
  return warnings;
}

/** 画面からマージして、まだ取得結果に反映されていないPR（#1756） */
export type OptimisticMerge = {
  /** `PullRequestSummary.id`（`<owner>/<repo>#<番号>`） */
  id: string;
  /** マージ操作が成功した時刻（ISO8601）。GitHubが記録する時刻とは数秒ずれる */
  mergedAt: string;
};

/**
 * 画面からマージしたPRを、取得が追いつくまでのあいだマージ済みとして扱う（#1756）。
 *
 * **マージの成否は押した時点で確定しているのに、それが画面へ届くのは次のPR取得が返ってから**で、
 * 数秒のあいだ「マージ待ち」のまま残る。以前はこの間だけ一覧から伏せていたが、伏せるのは
 * PR一覧にとってしか正しくない——ブランチ画面（`lib/branch-flow.ts`）は同じ集合をレーンの
 * 組み立てに使っているため、PRが消えるとレーンが「PR未作成」に化けていた。
 *
 * マージ済みとして差し替えれば、どの画面も「マージした後の状態」を一貫して描ける。
 * PR一覧・左メニューの件数はopenだけを通すので今までどおり消え（`filterPullRequestsByView`）、
 * ブランチ画面のレーンは次のリリースの束へ移り、**マージボタンは`canMergeFromDeck`が
 * falseを返して消える（＝同じPRを二度マージできない）。**
 *
 * 反映は呼び出し側が「次の取得が返るまで」に限る（`components/dashboard/issue-deck-shell.tsx`）。
 * マージできていなければ取得結果にopenのまま現れ、ボタンも戻る。
 */
export function applyOptimisticMerges(
  pullRequests: PullRequestSummary[],
  merges: readonly OptimisticMerge[],
): PullRequestSummary[] {
  if (merges.length === 0) return pullRequests;
  const mergedAtById = new Map(merges.map((merge) => [merge.id, merge.mergedAt]));

  return pullRequests.map((pullRequest) => {
    const mergedAt = mergedAtById.get(pullRequest.id);
    // 取得結果の方が進んでいる（既にマージ済み・クローズ済み）ならそちらを正とする
    if (mergedAt === undefined || pullRequest.state !== "open") return pullRequest;
    return { ...pullRequest, state: "closed", merged: true, mergedAt };
  });
}
