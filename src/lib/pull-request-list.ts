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
 * （`issue-<番号>` / `release/vX.Y.Z` / `develop` / `main`）に依存しているため
 * （[docs/multi-agent/branching.md](../../docs/multi-agent/branching.md)）。規約から外れた
 * ブランチは`other`になるだけで、一覧からは落とさない。
 */
export function classifyPullRequest(pullRequest: {
  baseRef: string;
  headRef: string;
}): PullRequestKind {
  const { baseRef, headRef } = pullRequest;
  if (baseRef === MAIN_BRANCH && headRef === "develop") return "release";
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
 */
export function filterPullRequestsByView(
  pullRequests: PullRequestSummary[],
  view: PullRequestViewId,
): PullRequestSummary[] {
  return pullRequests.filter((pullRequest) => {
    if (pullRequest.state !== "open") return false;
    if (view === "all") return true;
    const completed = !pullRequest.draft && ["success", "failure"].includes(pullRequest.ciState);
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
 */
export function canMergeFromDeck(pullRequest: PullRequestSummary): boolean {
  return pullRequest.state === "open" && !pullRequest.draft;
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
 * 「ユーザーの確認待ち」へ一緒に出すPull Requestを選ぶ（#1613）。
 *
 * `requiresUserMerge`なPRのうち、**対応Issueが同じ一覧に並んでいないものだけ**を返す。
 * develop向けPRは判定結果を対応Issueの`00.check-user`として書く（`requiresUserMerge`の
 * コメント参照）ので、そのままでは同じ案件がIssueとPRで二重に並ぶ。逆に、develop→mainの
 * リリースPRは対応Issueを持たないため、除外しなければどの確認待ちにも現れない。これが
 * この一覧にPRを混ぜる主な理由。
 *
 * @param checkUserIssues 「ユーザーの確認待ち」ビューに並んでいるIssue（リポジトリ名と番号だけ見る）
 */
export function pullRequestsAwaitingUserMerge(
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
 * そのままマージすると意図しない結果になりうる状態の説明。空配列なら確認なしでマージしてよい。
 * 画面はこの内容を確認ダイアログに並べる。
 */
export function mergeWarnings(pullRequest: PullRequestSummary): string[] {
  const warnings: string[] = [];
  // mainへのマージは本番へ出す操作そのもので、押した瞬間にdeploy.ymlが走る。CI通過済みで
  // 待ちが無いPRは1クリックでマージする既定のままだと、確認なしで本番反映まで進んでしまう。
  // **警告を1つ返すことで、既存の「警告があれば確認ダイアログを挟む」経路に必ず乗せる**（#1548）。
  if (pullRequest.baseRef === MAIN_BRANCH) {
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
