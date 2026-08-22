import type { Issue, LabelSummary, NavViewId, OverviewStat } from "@/types/issue";
import type { IssueFilters, IssueSort } from "@/hooks/use-issue-filters";
import { isAskRepoQuestionIssue } from "@/lib/github/ask-claude";
import { isCodeReviewIssue } from "@/lib/github/code-review";
import { resolveProgressStatus } from "@/lib/issue-progress";
import { computeManualStepAttention } from "@/lib/manual-step-attention";
import {
  getNavView,
  getNavViewDefaultState,
  navViewIgnoresIssueFilters,
  navViews,
} from "@/lib/nav-views";
import { matchesSearchQuery } from "@/lib/search-query";

const DAY_MS = 1000 * 60 * 60 * 24;
const RECENTLY_ADDED_WINDOW_MS = DAY_MS;

/**
 * 同一リリースでcloseされたIssueとみなす、closedAtの許容差。
 * develop→mainのPRがマージされると、対象Issueは1つのworkflow run内で連続して
 * `Done`への報告・closeが行われる（.github/workflows/reusable-issue-labels.yml の main-pr-merged）。
 * 実際の間隔は数秒〜数分だが、リリース同士は通常それよりずっと離れているため
 * 1時間を境界とする。
 */
const RELEASE_CLOSE_BATCH_WINDOW_MS = 1000 * 60 * 60;

/**
 * 最新リリースでcloseされたIssueだけを残す。
 * `Done`は一度入ると戻らないため、Statusだけで絞ると過去の全リリース分が累積する。
 * リポジトリごとにclosedAtの最大値（＝最新リリースのclose時刻）を求め、そこから
 * 一定時間内にcloseされたIssueを同じリリースの分とみなす。
 * closedAtの基準は、検索・状態などの絞り込み前の集合（referenceIssues）から求める。
 */
function filterLatestReleaseIssues(issues: Issue[], referenceIssues: Issue[]): Issue[] {
  const latestClosedAtByRepo = new Map<string, number>();
  for (const issue of referenceIssues) {
    if (!issue.closedAt) continue;
    const closedAt = new Date(issue.closedAt).getTime();
    const latest = latestClosedAtByRepo.get(issue.repositoryFullName);
    if (latest === undefined || closedAt > latest) {
      latestClosedAtByRepo.set(issue.repositoryFullName, closedAt);
    }
  }

  return issues.filter((issue) => {
    if (!issue.closedAt) return false;
    const latest = latestClosedAtByRepo.get(issue.repositoryFullName);
    if (latest === undefined) return false;
    return latest - new Date(issue.closedAt).getTime() <= RELEASE_CLOSE_BATCH_WINDOW_MS;
  });
}

export function filterIssuesByView(
  issues: Issue[],
  view: NavViewId,
  currentUserLogin: string | null,
  // 「最新リリース」の基準時刻を求めるための、絞り込み前の集合（省略時はissuesと同じ）
  referenceIssues: Issue[] = issues,
): Issue[] {
  switch (view) {
    case "favorites":
      return issues.filter((issue) => issue.favorite);
    case "recently-added":
      return issues.filter(
        (issue) => Date.now() - new Date(issue.createdAt).getTime() < RECENTLY_ADDED_WINDOW_MS,
      );
    case "all":
      return issues;
    default: {
      // 定型ビューの絞り込み条件は4種類。進捗（実行中・本番反映待ちなど）はProject Status
      // のOR一致（#991 Phase 5）、条件系（ユーザーの確認待ち）はラベルのOR一致、
      // 「未着手」のように特定ラベルの不在で定義するものはexcludeLabelsの不一致、
      // 質問Issueかどうか（#1514）はタイトル接頭辞で絞り込む。
      const navView = getNavView(view);
      const viewLabels = navView.labels;
      const excludeLabels = navView.excludeLabels;
      const viewStatuses = navView.statuses;
      const hasNoCondition =
        (!viewLabels || viewLabels.length === 0) &&
        (!excludeLabels || excludeLabels.length === 0) &&
        (!viewStatuses || viewStatuses.length === 0) &&
        !navView.questionOnly &&
        !navView.excludeQuestions &&
        !navView.codeReviewOnly &&
        !navView.excludeCodeReviews;
      if (hasNoCondition) return issues;

      const matchesView = (issue: Issue) => {
        // 質問Issueの振り分け（#1514）。**他のどの特例よりも先に判定する。** 特に
        // excludeQuestionsを下のqaAnswerPendingAt特例より後ろに置くと、回答待ちの質問Issueが
        // 「実行中」へ抜けてしまう。
        const isQuestion = isAskRepoQuestionIssue(issue);
        if (navView.questionOnly && !isQuestion) return false;
        if (navView.excludeQuestions && isQuestion) return false;
        // レビューIssue（#698）も質問と同じ扱い。**下の`dispatchPendingAt`の特例より先に
        // 判定する。** 後ろに置くと、レビューを積んだ直後のIssueが「実行中」へ抜ける
        const isCodeReview = isCodeReviewIssue(issue);
        if (navView.codeReviewOnly && !isCodeReview) return false;
        if (navView.excludeCodeReviews && isCodeReview) return false;
        // 「リポジトリに質問する」等（@claude 質問: コメント）の回答待ちは、進捗を進めない
        // （付与元のmode=askは進捗の報告を行わない）ため、Statusだけでは実行中ビューに
        // 出てこない。qaAnswerPendingAtが立っている間は実行中とみなし、他の条件より優先する
        // （#978）。質問Issue自体は上で除外済みで、ここに残るのは通常のIssueへ質問した場合。
        if (view === "in-progress" && issue.qaAnswerPendingAt) return true;
        // サブPCへ積んだジョブが未完了の間も、進捗Statusは起動したセッションが報告するまで
        // `Ready`のまま。押した直後のIssueが「未着手」に居座ると、そこから同じIssueを
        // もう一度選んでしまうため、「実行中」へ移す（#1347）。
        if (view === "in-progress" && issue.dispatchPendingAt) return true;
        if (view === "not-started" && issue.dispatchPendingAt) return false;
        if (viewStatuses && viewStatuses.length > 0) {
          if (!viewStatuses.includes(resolveProgressStatus(issue))) return false;
        }
        const issueLabelNames = issue.labels.map((label) => label.name);
        if (viewLabels && viewLabels.length > 0) {
          if (!issueLabelNames.some((name) => viewLabels.includes(name))) return false;
        }
        if (excludeLabels && excludeLabels.length > 0) {
          if (issueLabelNames.some((name) => excludeLabels.includes(name))) return false;
        }
        return true;
      };
      const matched = issues.filter(matchesView);
      if (!navView.latestReleaseOnly) return matched;
      return filterLatestReleaseIssues(matched, referenceIssues.filter(matchesView));
    }
  }
}

/** 一覧の母集団を減らす絞り込み条件（＝ユーザーがTopBar・左メニューで指定するもの） */
export type IssueFilterInput = Pick<
  IssueFilters,
  "q" | "repos" | "state" | "labels" | "assignee"
> & {
  /**
   * AIあいまい検索で選ばれたIssueのid集合（#1788）。URLには載らない一時的な状態なので
   * `IssueFilters`（＝クエリパラメータ）ではなくここにだけ持つ。
   *
   * **一覧も左メニューの件数も同じ`applyIssueFilters`を通すため、ここへ足しておけば数字は
   * 食い違わない**（#1689・#1750と同じ理由）。
   */
  aiMatchedIds?: ReadonlySet<string> | null;
};

export function applyIssueFilters(
  issues: Issue[],
  filters: IssueFilterInput,
): Issue[] {
  const q = filters.q.trim();
  const aiMatchedIds = filters.aiMatchedIds ?? null;

  return issues.filter((issue) => {
    if ((q || aiMatchedIds) && !matchesSearchQuery(issue, q, { aiMatchedIds })) return false;
    if (filters.repos.length > 0 && !filters.repos.includes(issue.repositoryFullName)) {
      return false;
    }
    if (filters.state !== "all" && issue.state !== filters.state) return false;
    if (filters.labels.length > 0) {
      const issueLabelNames = new Set(issue.labels.map((label) => label.name));
      if (!filters.labels.some((name) => issueLabelNames.has(name))) return false;
    }
    if (filters.assignee) {
      if (filters.assignee === "unassigned") {
        if (issue.assignee) return false;
      } else if (issue.assignee?.login !== filters.assignee) {
        return false;
      }
    }
    return true;
  });
}

/**
 * そのビューで実際に適用する絞り込み条件を求める（#1750）。
 *
 * 「ユーザーの確認待ち」「ユーザーの作業待ち」「質問」はリポジトリ横断で全体を見る場所なので、
 * ユーザーが指定した条件（キーワード・リポジトリ・状態・ラベル・担当者）を一切適用しない。
 * **状態だけはビューの既定値へ戻す**——ビューの定義の一部（`00.check-user`はopenのものを見る）で
 * あって、ユーザーの絞り込みではないため。
 *
 * 一覧・件数の両方が必ずここを通す。片方だけ素の`filters`を使うと、左メニューの件数と
 * 一覧に並ぶ件数が食い違う（#1689と同じ失敗）。
 */
export function resolveFiltersForView<T extends IssueFilterInput>(
  filters: T,
  view: NavViewId,
): T {
  if (!navViewIgnoresIssueFilters(view)) return filters;
  return {
    ...filters,
    q: "",
    // キーワードを外すビューでは、その結果であるAI検索の絞り込み（#1788）も一緒に外す。
    // 片方だけ残すと「キーワードは効かないのに件数だけAIで絞られている」状態になる。
    aiMatchedIds: null,
    repos: [],
    state: getNavViewDefaultState(view),
    labels: [],
    assignee: null,
  };
}

/**
 * 絞り込みが指定されているのに、そのビューでは適用されない状態か（#1750）。
 * 黙って無視すると「キーワードを入れても件数が変わらない」理由が画面から読めないため、
 * 一覧のヘッダーに注記を出すかどうかの判定に使う。
 */
export function hasIgnoredIssueFilters(filters: IssueFilterInput, view: NavViewId): boolean {
  if (!navViewIgnoresIssueFilters(view)) return false;
  return (
    filters.q.trim() !== "" ||
    filters.repos.length > 0 ||
    filters.labels.length > 0 ||
    filters.assignee !== null ||
    filters.state !== getNavViewDefaultState(view)
  );
}

/**
 * 「ユーザーの確認待ち」ビュー（view=check-user）では、TopBarの並び順選択によらず
 * 確認待ちの起点となった日時の古い順に固定する。先に確認待ちになったIssueから順番に
 * 確認してもらうため。実際の未読コメント投稿日時（lastCommentAt）を優先し、
 * Webhook経由でまだ記録されていないIssueは00.check-userラベルが付与された日時
 * （checkUserLabeledAt）にフォールバックする。どちらも取れないIssueは最も古いものとして
 * 先頭に寄せる。
 */
export function sortIssues(issues: Issue[], sort: IssueSort, view?: NavViewId): Issue[] {
  if (view === "check-user") {
    return [...issues].sort(
      (a, b) => checkUserPendingSinceTime(a) - checkUserPendingSinceTime(b),
    );
  }

  const key: keyof Pick<Issue, "updatedAt" | "createdAt"> =
    sort === "created" ? "createdAt" : "updatedAt";
  return [...issues].sort(
    (a, b) => new Date(b[key]).getTime() - new Date(a[key]).getTime(),
  );
}

function checkUserPendingSinceTime(issue: Issue): number {
  const basis = issue.lastCommentAt ?? issue.checkUserLabeledAt;
  return basis ? new Date(basis).getTime() : -Infinity;
}

export type IssueRepositoryGroup = {
  repositoryFullName: string;
  repositoryPrivate: boolean;
  repositoryArchived: boolean;
  issues: Issue[];
};

/**
 * リポジトリごとにIssueをグループ化する（#849）。issuesの並び順（＝呼び出し側で
 * 確定済みのソート順）はグループ内でそのまま保つ。グループ自体の並び順は既定では
 * repositoryFullNameの昇順（サイドバーの既定順と同じ）だが、`sortByLatestClosedAt`を
 * 指定すると、リポジトリごとのclosedAt最大値（＝最後に本番反映されたissueの日時）の
 * 降順で並べる（#922）。「直近本番に反映した」ビューでは、最後に反映したリポジトリを
 * 上に表示したいため。closedAtを持つissueが1件もないリポジトリは末尾に回す。
 */
export function groupIssuesByRepository(
  issues: Issue[],
  options?: { sortByLatestClosedAt?: boolean },
): IssueRepositoryGroup[] {
  const groups = new Map<string, IssueRepositoryGroup>();
  for (const issue of issues) {
    const existing = groups.get(issue.repositoryFullName);
    if (existing) {
      existing.issues.push(issue);
    } else {
      groups.set(issue.repositoryFullName, {
        repositoryFullName: issue.repositoryFullName,
        repositoryPrivate: issue.repositoryPrivate,
        repositoryArchived: issue.repositoryArchived,
        issues: [issue],
      });
    }
  }
  const groupList = [...groups.values()];

  if (options?.sortByLatestClosedAt) {
    const latestClosedAtByRepo = new Map<string, number>();
    for (const issue of issues) {
      if (!issue.closedAt) continue;
      const closedAt = new Date(issue.closedAt).getTime();
      const latest = latestClosedAtByRepo.get(issue.repositoryFullName);
      if (latest === undefined || closedAt > latest) {
        latestClosedAtByRepo.set(issue.repositoryFullName, closedAt);
      }
    }
    return groupList.sort((a, b) => {
      const aLatest = latestClosedAtByRepo.get(a.repositoryFullName) ?? -Infinity;
      const bLatest = latestClosedAtByRepo.get(b.repositoryFullName) ?? -Infinity;
      return bLatest - aLatest;
    });
  }

  return groupList.sort((a, b) => a.repositoryFullName.localeCompare(b.repositoryFullName));
}

export function getAssigneeOptions(issues: Issue[]): string[] {
  const logins = new Set<string>();
  for (const issue of issues) {
    if (issue.assignee) logins.add(issue.assignee.login);
  }
  return [...logins].sort();
}

/**
 * 表示中の絞り込み（状態・ラベル・担当者など）を適用したうえで、ビューごとの件数を数える
 * （#1689）。絞り込み前の全Issueを数えると、一覧に並ぶ件数と食い違う（例: 状態がopenの
 * 一覧なのに、ビュー名の隣にclose済みを含めた総数が出る）。
 *
 * **絞り込みはビューごとに解決する**（#1750）。「ユーザーの確認待ち」のように条件を適用しない
 * ビューがあるため、絞り込み済みの集合を外から受け取る形（旧`computeNavCounts`）は成立しない。
 * PC（`issue-deck-shell`）・スマホの一覧のどちらもここを通す。
 *
 * - 状態（open/closed）の絞り込みを外した集合を基準にするビューがあるのは、「直近本番に
 *   反映した」のようにclose済みIssueが対象のビューを、現在の状態絞り込みで0件にしないため。
 * - 「最新リリース」の基準時刻（`filterIssuesByView`のreferenceIssues）は絞り込み前の
 *   issuesから求める。一覧側も絞り込み前の集合を基準にしているため、揃えないと
 *   「直近本番に反映した」の件数だけがズレる。
 *
 * **「ユーザーの作業待ち」（`manual-step`）だけは、いま実行できる件数を出す**
 * （#1763。`lib/manual-step-attention.ts`）。前提待ちを含む総数は「いま手を動かせば片付く数」
 * として読めないため`actionable`を返す。**数え方をここで差し替えることで、左メニュー・スマホの
 * ホーム・スマホの一覧のビュー切替が同じ数字になる。** 一覧のヘッダーだけは行数を出す場所なので、
 * そちらは`formatManualStepListCount`が内訳（`2件・前提待ち2件`）を添えて食い違いを説明する。
 *
 * **「質問」は#1910で未確認の件数へ差し替えていたが、#2070で一覧と同じ件数へ戻した。**
 * 読み終えた質問しか無いと、質問が何件も開いたままでも`0`と出て「質問は無い」と読めていた。
 * 「回答が届いていてまだ読んでいない」という合図はオレンジの丸（`computeQuestionAttention`）に
 * 残してあり、件数の内訳は一覧ヘッダーの`formatQuestionListCount`（`3件・未確認1件`）で読む。
 *
 * **「ユーザーの確認待ち」（`check-user`）は、まだエージェントが動いているものを外す**
 * （#2174。`lib/check-user-attention.ts`）。`00.check-user`が付いていてもCI・自動マージ判定・
 * サブPCのセッションが動いている間は押せる操作が無く、数えるとオレンジの丸が「手を動かせば
 * 減る数」として読めない。**一覧には今までどおり並べ**、食い違いは一覧ヘッダーの
 * `formatCheckUserListCount`（`2件・実行中1件`）で説明する（手作業待ちと同じ形）。
 *
 * @param referenceIssues 「最新リリース」の基準時刻と、手作業Issueの前提条件（#1763）を
 *   解決するための母集団。**リポジトリで絞り込んだ一覧を数えるときは、絞り込む前の全Issueを
 *   渡す**（`mobile-repo-issues-screen.tsx`）。手作業Issueは`guchi-apps/vps#88`のように別
 *   リポジトリを待っていることがあり、母集団から外れていると「状態不明＝実行できる」と
 *   数えてしまう。省略時は`issues`（＝この一覧の母集団）。
 * @param checkUserRunningIssueIds まだエージェントが動いている確認待ちIssueのid（#2174）。
 *   **省略時は従来どおり全件を数える**——材料（PR一覧・セッション）を持たない呼び出し元
 *   （リポジトリ別の一覧など）で、判定できないことを理由に件数を減らさないため。
 */
export function computeNavCountsForFilters(
  issues: Issue[],
  filters: IssueFilterInput,
  currentUserLogin: string | null,
  referenceIssues: Issue[] = issues,
  checkUserRunningIssueIds?: ReadonlySet<string>,
): Record<NavViewId, number> {
  const counts = {} as Record<NavViewId, number>;
  for (const view of navViews) {
    const viewFilters = resolveFiltersForView(filters, view.id);
    const base = applyIssueFilters(
      issues,
      view.defaultState === "all" ? { ...viewFilters, state: "all" } : viewFilters,
    );
    const matched = filterIssuesByView(base, view.id, currentUserLogin, referenceIssues);
    counts[view.id] =
      view.id === "manual-step"
        ? computeManualStepAttention(matched, referenceIssues).actionable
        : view.id === "check-user" && checkUserRunningIssueIds
          ? matched.filter((issue) => !checkUserRunningIssueIds.has(issue.id)).length
          : matched.length;
  }
  return counts;
}

/**
 * スマホのホーム画面の先頭に出す3枚のカード（#1690）。
 *
 * **盤面の流れをそのまま並べる。** 「要対応」（人が動くまで進まない）→「実行中」（いま動いている）
 * →「本番反映待ち」（developまで来ていて本番へ出ていない）の順で、上から読めば今どこに滞留して
 * いるかが分かる。以前は「確認待ち・24時間以内の本番反映・オープンIssue」だったが、
 * オープンIssue数は下のメニューの「すべてのIssue」と重複し、24時間以内の本番反映は
 * 済んだことの振り返りで、どちらも次に何をするかを決める材料にならなかった。
 *
 * **件数は数え直さず`navCounts`から引く。** 同じ画面のすぐ下に同じ数字のメニュー行が並ぶため、
 * 別々に数えると絞り込みの適用範囲がずれた瞬間にカードと行で違う数字が出る。
 * 「要対応」にマージ待ちPRを足すのもPCの左メニュー（`sidebar-nav.tsx`）と同じ数え方。
 *
 * **PCには概要カードが無く、これを使うのはスマホのホームだけ。**
 */
export function computeOverviewStats(
  navCounts: Record<NavViewId, number>,
  checkUserPullRequestCount: number,
): OverviewStat[] {
  return [
    {
      label: "要対応",
      value: String(navCounts["check-user"] + checkUserPullRequestCount),
      linkedView: "check-user",
    },
    { label: "実行中", value: String(navCounts["in-progress"]), linkedView: "in-progress" },
    {
      label: "本番反映待ち",
      value: String(navCounts["release-pending"]),
      linkedView: "release-pending",
    },
  ];
}

// ポーリング等で取得した最新のIssue一覧を、内容が変わっていないIssueについては
// 直前のオブジェクト参照を再利用してマージする。これにより、ポーリングのたびに
// 全Issueのオブジェクト参照が入れ替わることで発生する不要な再レンダリング・副作用の
// 再実行（コメント欄の一瞬の再読み込み表示など）を防ぐ。
/**
 * 作成したIssueを一覧へ入れる。**すでに同じIssueがあれば置き換える**——作成直後は
 * ポーリングが先に反映していることがあり、単純に先頭へ足すと同じIssueが2行並ぶ（#449）。
 * 自分の画面で作った場合（`handleIssueCreated`）と、別ウィンドウで作られた場合（#1728）の
 * どちらもここを通す。
 */
export function upsertIssue(issues: Issue[], issue: Issue): Issue[] {
  return issues.some((item) => item.id === issue.id)
    ? issues.map((item) => (item.id === issue.id ? issue : item))
    : [issue, ...issues];
}

export function reconcileIssues(prevIssues: Issue[], nextIssues: Issue[]): Issue[] {
  const prevById = new Map(prevIssues.map((issue) => [issue.id, issue] as const));
  return nextIssues.map((issue) => {
    const prevIssue = prevById.get(issue.id);
    return prevIssue && isIssueContentEqual(prevIssue, issue) ? prevIssue : issue;
  });
}

/**
 * ポーリング前後のIssue配列を比較し、checkUserLabeledAtがnull→非nullに変わった
 * （＝00.check-userラベルが新たに付与された）Issueを抽出する。画面を開いている間の
 * トースト通知（#852）の発火判定に使う。
 * 直前の配列に存在しないIssue（新規作成・初回ポーリング等）はcheckUserLabeledAtが
 * nullだったとみなし、既に付与済みの状態で現れた場合も対象に含める。
 */
export function detectNewlyCheckUserIssues(prevIssues: Issue[], nextIssues: Issue[]): Issue[] {
  const prevById = new Map(prevIssues.map((issue) => [issue.id, issue] as const));
  return nextIssues.filter((issue) => {
    if (!issue.checkUserLabeledAt) return false;
    const prevIssue = prevById.get(issue.id);
    return !prevIssue?.checkUserLabeledAt;
  });
}

function isIssueContentEqual(a: Issue, b: Issue): boolean {
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.state === b.state &&
    // Project Statusが変われば進捗表示も変わるため、再描画の判定に含める（#991）
    a.projectStatus === b.projectStatus &&
    // 順番待ちの開始・終了でビューの振り分けが変わるため同様に含める（#1347）
    a.dispatchPendingAt === b.dispatchPendingAt &&
    // 完了確認の巡回が通ると一覧の印が変わるため含める（#2008）
    a.manualStepVerifiedAt === b.manualStepVerifiedAt &&
    a.commentCount === b.commentCount &&
    a.updatedAt === b.updatedAt &&
    a.favorite === b.favorite &&
    a.hasUnreadComments === b.hasUnreadComments &&
    a.readCommentCount === b.readCommentCount &&
    a.htmlUrl === b.htmlUrl &&
    a.assignee?.login === b.assignee?.login &&
    a.milestone?.name === b.milestone?.name &&
    a.milestone?.progressPercent === b.milestone?.progressPercent &&
    a.labels.length === b.labels.length &&
    a.labels.every((label, i) => label.name === b.labels[i]?.name && label.color === b.labels[i]?.color)
  );
}

export function computeLabelSummary(
  issues: Issue[],
  options?: {
    /**
     * 渡したissuesに1件も無くても、件数0として一覧に残すラベル名（＝選択中のラベル）。
     * 絞り込みを適用した集合を基準にすると、選択中のラベルが該当0件になった瞬間に
     * サイドバーから消えて選択を解除できなくなるため（#1441）。
     */
    keepLabelNames?: string[];
    /** keepLabelNamesの色を引くための、絞り込み前のラベル一覧 */
    fallbackLabels?: LabelSummary[];
  },
): LabelSummary[] {
  const summaryByName = new Map<string, LabelSummary>();

  for (const issue of issues) {
    for (const label of issue.labels) {
      const existing = summaryByName.get(label.name);
      if (existing) {
        existing.count += 1;
      } else {
        summaryByName.set(label.name, { name: label.name, color: label.color, count: 1 });
      }
    }
  }

  for (const name of options?.keepLabelNames ?? []) {
    if (summaryByName.has(name)) continue;
    const fallback = options?.fallbackLabels?.find((label) => label.name === name);
    // 色を引けないラベル（絞り込み前にも1件も無い＝手入力のクエリ等）はグレーで表示する
    summaryByName.set(name, { name, color: fallback?.color ?? "#6e7781", count: 0 });
  }

  return [...summaryByName.values()].sort((a, b) => b.count - a.count);
}

/**
 * 左メニュー「ラベル」に出す一覧と件数を求める（#1441）。
 * 絞り込み前の全Issueから数えると、リポジトリを選んでいても全リポジトリ分の件数が出てしまい、
 * 同じメニューの「全体」の件数（computeNavCounts）とも食い違う。ラベル以外の絞り込み
 * （キーワード・リポジトリ・状態・担当者）を適用した集合を基準にする。ラベルの絞り込み自体を
 * 外すのは、1つ選んだ時点で他のラベルが0件になり選び直せなくなるため。
 * fallbackLabelsは、選択中のラベルが該当0件になったときに色を引くための絞り込み前の一覧。
 */
export function computeFilterLabelSummary(
  issues: Issue[],
  filters: IssueFilterInput,
  fallbackLabels?: LabelSummary[],
): LabelSummary[] {
  return computeLabelSummary(applyIssueFilters(issues, { ...filters, labels: [] }), {
    keepLabelNames: filters.labels,
    fallbackLabels,
  });
}
