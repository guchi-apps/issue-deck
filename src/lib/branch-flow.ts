import { resolveProgressStatus, type ProgressStatusKey } from "@/lib/issue-progress";
import { classifyPullRequest, extractLinkedIssueNumber } from "@/lib/pull-request-list";
import type {
  BranchFlowIssueRef,
  BranchFlowLane,
  BranchFlowLaneStatus,
  BranchFlowReleaseState,
  BranchFlowRepository,
  RepositoryBranchStatus,
} from "@/types/branch-flow";
import type { PullRequestSummary } from "@/types/pull-request";

/** issue-deckのブランチ運用モデルの幹（docs/multi-agent/branching.md） */
export const MAIN_BRANCH = "main";
export const DEVELOP_BRANCH = "develop";

/**
 * まだdevelopへ入っていない＝作業ブランチが生きているはずの進捗（#1455）。
 *
 * `ready`・`planning`はまだブランチが無くて当然、`develop`以降はマージ済みなので、
 * ブランチの有無を確かめる意味があるのはこの2つだけ。
 * ブランチ存在確認の対象（`GET /api/branch-flow`）と、「ブランチもPRも無いのに実装中の
 * Issue」の抽出の、どちらもこの集合を使う。
 */
export const ACTIVE_ISSUE_PROGRESS_STATUSES: readonly ProgressStatusKey[] = [
  "implementation",
  "develop-pr",
];

const ACTIVE_ISSUE_PROGRESS_SET: ReadonlySet<ProgressStatusKey> = new Set(
  ACTIVE_ISSUE_PROGRESS_STATUSES,
);

/** Issue番号から作業ブランチ名を作る（`scripts/start-issue.sh`が作る命名規約） */
export function issueBranchName(issueNumber: number): string {
  return `issue-${issueNumber}`;
}

/**
 * リリースPR・バンプPRのタイトルからバージョンを取る（`v3.17.0をmainへリリースする`）。
 * 文面は`.github/workflows/reusable-release-develop-to-main.yml`が作る。
 */
const VERSION_PATTERN = /v(\d+\.\d+\.\d+)/;

/**
 * 完了として畳んでよいレーン（既定では隠す）。
 *
 * **区切りはdevelopへのマージではなく、mainへの反映に置く。** developへ入っただけの変更は
 * まだ本番に出ておらず、次のリリースに乗る「進行中の作業」なので既定で見えている必要がある
 * （このリポジトリ群ではブランチをマージ後も消さないため、残っているブランチの大半は
 * 本番へ出たあとの残骸で、そちらは畳んでよい）。
 *
 * 本番へ出たか判定できない場合（リリースPRを取得できていない）は畳む側に倒す。
 * 判定できないものを全部出すと、リリース運用をしていないリポジトリで一覧が埋まってしまう。
 */
export function isCompletedLane(lane: BranchFlowLane): boolean {
  if (lane.status === "closed") return true;
  return lane.status === "merged" && lane.releaseState?.kind !== "pending";
}

/** レーンの並び順。手を動かす必要があるものから順に並べる */
function laneOrder(lane: BranchFlowLane): number {
  if (lane.status === "open") return 0;
  if (lane.status === "no-pull-request") return 1;
  // developには入ったが本番未反映＝次のリリース待ち。完了済みより前に置く
  if (lane.status === "merged" && lane.releaseState?.kind === "pending") return 2;
  return lane.status === "closed" ? 3 : 4;
}

/** 進捗の判定に必要な最小限のIssue。表示用の`Issue`型からそのまま渡せる */
export type BranchFlowIssueSource = {
  number: number;
  title: string;
  repositoryFullName: string;
  state: "open" | "closed";
  projectStatus: string | null;
};

export type BuildBranchFlowInput = {
  repositories: { fullName: string; private: boolean }[];
  pullRequests: PullRequestSummary[];
  issues: BranchFlowIssueSource[];
  /** `GET /api/branch-flow`の結果。未取得のリポジトリはPRだけから組み立てる */
  branchStatuses: RepositoryBranchStatus[];
};

export type BranchFlow = {
  repositories: BranchFlowRepository[];
  /**
   * 表示すべき動きが何も無かったリポジトリ。カードを出すと画面が空のカードで埋まるため
   * 除いているが、「集計から漏れている」のではないことを画面に出せるよう名前は返す。
   */
  quietRepositories: string[];
};

/**
 * Issue・ブランチ・PRを、リポジトリごとの「流れ」へ組み立てる（#1455）。
 *
 * 一覧画面がIssueとPRを別々に並べるのに対し、ここでは**ブランチ名を軸に3つを1本へ束ねる**。
 * `issue-<番号>` → `develop` → `main` というブランチ規約
 * （[docs/multi-agent/branching.md](../../docs/multi-agent/branching.md)）があるため、
 * ブランチ名だけで「どのIssueの作業か」「どこへ向かっているか」が決まる。
 *
 * レーンは**ブランチとPRの和集合**で作る。PRがまだ無いブランチも、ブランチが消えたPRも
 * 落とさずに1本のレーンとして扱い、片方しか無いことを`status`で表す。これが無いと
 * 「PRを作り忘れているブランチ」「マージ後に消し忘れたブランチ」が画面のどこにも現れない。
 */
export function buildBranchFlow(input: BuildBranchFlowInput): BranchFlow {
  const branchStatusByRepo = new Map(
    input.branchStatuses.map((status) => [status.repositoryFullName, status]),
  );

  const repositories: BranchFlowRepository[] = [];
  const quietRepositories: string[] = [];

  for (const repository of input.repositories) {
    const built = buildRepository({
      repository,
      pullRequests: input.pullRequests.filter(
        (pullRequest) => pullRequest.repositoryFullName === repository.fullName,
      ),
      issues: input.issues.filter((issue) => issue.repositoryFullName === repository.fullName),
      branchStatus: branchStatusByRepo.get(repository.fullName) ?? null,
    });

    if (isQuiet(built)) {
      quietRepositories.push(repository.fullName);
    } else {
      repositories.push(built);
    }
  }

  return { repositories, quietRepositories };
}

/**
 * 出すものが何も無いリポジトリか。
 *
 * `develop`が`main`より進んでいる（＝未リリースの変更がある）場合は、レーンが1本も無くても
 * 「リリース待ち」という状態そのものが情報なので、静かとはみなさない。
 */
function isQuiet(repository: BranchFlowRepository): boolean {
  return (
    repository.lanes.length === 0 &&
    repository.orphanIssues.length === 0 &&
    repository.release.pullRequest === null &&
    (repository.release.comparison?.aheadBy ?? 0) === 0
  );
}

function buildRepository({
  repository,
  pullRequests,
  issues,
  branchStatus,
}: {
  repository: { fullName: string; private: boolean };
  pullRequests: PullRequestSummary[];
  issues: BranchFlowIssueSource[];
  branchStatus: RepositoryBranchStatus | null;
}): BranchFlowRepository {
  // リリースPR（develop→main）はレーンではなく幹の一部なので、作業レーンからは外す。
  // マージ済みのリリースPRは「今どうなっているか」を表さないため、openなものだけを出す。
  const releasePullRequest =
    pullRequests.find(
      (pullRequest) => pullRequest.kind === "release" && pullRequest.state === "open",
    ) ?? null;
  const lanePullRequests = pullRequests.filter((pullRequest) => pullRequest.kind !== "release");

  // 実在が確認できた作業ブランチ。PRを持たないものだけがレーンを増やす（PRを持つブランチは
  // PR側から拾えるため）。確認していないブランチについては何も言えないので触れない。
  const existingBranches = (branchStatus?.existingBranches ?? []).filter(
    (name) => name !== MAIN_BRANCH && name !== DEVELOP_BRANCH,
  );

  const laneKeys = new Set<string>([
    ...existingBranches,
    ...lanePullRequests.map((pullRequest) => pullRequest.headRef),
  ]);

  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const releases = collectReleases(pullRequests);
  const lanes = [...laneKeys]
    .map((key) =>
      buildLane({
        branchName: key,
        pullRequests: lanePullRequests.filter((pullRequest) => pullRequest.headRef === key),
        issueByNumber,
        releases,
      }),
    )
    .sort(compareLanes);

  // どこかのレーンに現れたIssueは「関連が見つからない」側に出さない。**関連として出したぶんも
  // 含める**——1本のPRが複数のIssueを扱っている場合、2件目以降も画面には現れているため。
  const linkedIssueNumbers = new Set(
    lanes.flatMap((lane) => [
      ...(lane.issue ? [lane.issue.number] : []),
      ...lane.relatedIssues.map((issue) => issue.number),
    ]),
  );

  return {
    repositoryFullName: repository.fullName,
    repositoryPrivate: repository.private,
    release: {
      pullRequest: releasePullRequest,
      comparison: branchStatus?.developVsMain ?? null,
      latestVersion: releases.at(-1)?.version ?? null,
    },
    lanes,
    orphanIssues: issues
      .filter(
        (issue) =>
          issue.state === "open" &&
          ACTIVE_ISSUE_PROGRESS_SET.has(resolveProgressStatus(issue)) &&
          !linkedIssueNumbers.has(issue.number),
      )
      .map(toIssueRef)
      .sort((a, b) => b.number - a.number),
    branchesLoaded: branchStatus !== null,
  };
}

/** マージ済みのリリースPR（develop→main）を、マージが古い順に並べたもの */
type MergedRelease = {
  mergedAt: number;
  version: string | null;
  pullRequestNumber: number;
};

function collectReleases(pullRequests: PullRequestSummary[]): MergedRelease[] {
  return pullRequests
    .filter((pullRequest) => pullRequest.kind === "release" && pullRequest.mergedAt !== null)
    .map((pullRequest) => ({
      mergedAt: new Date(pullRequest.mergedAt as string).getTime(),
      version: VERSION_PATTERN.exec(pullRequest.title)?.[1] ?? null,
      pullRequestNumber: pullRequest.number,
    }))
    .sort((a, b) => a.mergedAt - b.mergedAt);
}

/**
 * マージ済みの作業が本番へ届いているかを判定する（#1455）。
 *
 * develop→mainのリリースPRは、マージした時点のdevelopをそのままmainへ入れる。よって
 * **作業PRがdevelopへ入った後、最初にマージされたリリースPRがその変更を本番へ運んだ**ことになり、
 * タイムスタンプの比較だけで版が決まる（追加のAPI呼び出しが要らない）。
 *
 * クローズ済みPRの取得は直近30件（更新が新しい順）で打ち切っているが、**作業PRが取得できて
 * いれば、その後にマージされたリリースPRも取得できている**——後からマージされたPRの方が
 * 更新が新しく、先に切り捨てられることはないため。よって「後続のリリースが1件も無い」は
 * 「まだ本番へ出ていない」と読んでよい。
 *
 * 例外はリリースPRを1件も取得できていない場合で、そのときは比較の材料が無いだけかもしれない
 * ので`unknown`にする——**間違った版を出すより「分からない」と出す方がよい。**
 */
function resolveReleaseState(
  mergedAtIso: string | null,
  releases: MergedRelease[],
): BranchFlowReleaseState {
  if (mergedAtIso === null || releases.length === 0) return { kind: "unknown" };
  const mergedAt = new Date(mergedAtIso).getTime();

  const carrier = releases.find((release) => release.mergedAt > mergedAt);
  return carrier
    ? { kind: "released", version: carrier.version, pullRequestNumber: carrier.pullRequestNumber }
    : { kind: "pending" };
}

function buildLane({
  branchName,
  pullRequests,
  issueByNumber,
  releases,
}: {
  branchName: string;
  pullRequests: PullRequestSummary[];
  issueByNumber: Map<number, BranchFlowIssueSource>;
  releases: MergedRelease[];
}): BranchFlowLane {
  // openなPRを先頭に、あとは更新が新しい順。1本のブランチで作り直した2本目のPRがある場合に、
  // 「今生きているPR」が先に来るようにする。
  const sorted = [...pullRequests].sort((a, b) => {
    if (a.state !== b.state) return a.state === "open" ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  const issueNumber =
    sorted.find((pullRequest) => pullRequest.linkedIssueNumber !== null)?.linkedIssueNumber ??
    // PRが無い（＝タイトル・本文が無い）ブランチは、ブランチ名の規約からだけ引く。
    extractLinkedIssueNumber({ headRef: branchName, title: "", body: null });

  const issue = issueNumber === null ? null : issueByNumber.get(issueNumber) ?? null;

  // 1本のPRが複数のIssueを扱っている場合の残り（#1455）。レーンにぶら下がる全PRから集め、
  // 主のIssueを除く。順序はPRの並び（openが先）と参照の確度をそのまま引き継ぐ。
  const relatedIssueNumbers = [
    ...new Set(sorted.flatMap((pullRequest) => pullRequest.linkedIssueNumbers)),
  ].filter((number) => number !== issueNumber);

  // 版が意味を持つのは「マージされた変更」だけ。複数PRがぶら下がるレーンでは、
  // 実際にdevelopへ入ったマージ（最後にマージされたもの）を基準にする。
  const mergedAt = pullRequests
    .filter((pullRequest) => pullRequest.merged && pullRequest.mergedAt !== null)
    .map((pullRequest) => pullRequest.mergedAt as string)
    .sort()
    .at(-1);

  return {
    key: branchName,
    branchName,
    kind: sorted[0]?.kind ?? classifyPullRequest({ baseRef: DEVELOP_BRANCH, headRef: branchName }),
    pullRequests: sorted,
    issue: issueNumber === null ? null : toIssueRefOrNumber(issueNumber, issue),
    relatedIssues: relatedIssueNumbers.map((number) =>
      toIssueRefOrNumber(number, issueByNumber.get(number) ?? null),
    ),
    status: resolveLaneStatus(sorted),
    releaseState: mergedAt === undefined ? null : resolveReleaseState(mergedAt, releases),
    updatedAt: sorted[0]?.updatedAt ?? null,
  };
}

/**
 * レーンの状態。PRが1件も無いレーンは、実在が確認できたブランチからしか作られないので
 * 「ブランチはあるがPRが無い」と読んでよい。
 */
function resolveLaneStatus(pullRequests: PullRequestSummary[]): BranchFlowLaneStatus {
  if (pullRequests.length === 0) return "no-pull-request";
  if (pullRequests.some((pullRequest) => pullRequest.state === "open")) return "open";
  return pullRequests.some((pullRequest) => pullRequest.merged) ? "merged" : "closed";
}

function compareLanes(a: BranchFlowLane, b: BranchFlowLane): number {
  const byStatus = laneOrder(a) - laneOrder(b);
  if (byStatus !== 0) return byStatus;
  // 更新日時を持たない（PRが無い）レーン同士はブランチ名で安定させる。
  if (a.updatedAt && b.updatedAt) {
    const byUpdated = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (byUpdated !== 0) return byUpdated;
  } else if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt ? -1 : 1;
  }
  return a.branchName.localeCompare(b.branchName);
}

/** DBキャッシュに無いIssueでも、番号だけは残して画面に出す */
function toIssueRefOrNumber(
  number: number,
  issue: BranchFlowIssueSource | null,
): BranchFlowIssueRef {
  return issue ? toIssueRef(issue) : { number, title: null, progress: null, state: null };
}

function toIssueRef(issue: BranchFlowIssueSource): BranchFlowIssueRef {
  return {
    number: issue.number,
    title: issue.title,
    progress: resolveProgressStatus(issue),
    state: issue.state,
  };
}
