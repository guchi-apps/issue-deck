import { MANUAL_STEP_LABEL } from "@/lib/github/approval-labels";
import { resolveProgressStatus, type ProgressStatusKey } from "@/lib/issue-progress";
import {
  classifyPullRequest,
  extractLinkedIssueNumber,
  requiresUserMerge,
} from "@/lib/pull-request-list";
import type {
  BranchFlowIssueRef,
  BranchFlowLane,
  BranchFlowLaneStatus,
  BranchFlowManualStep,
  BranchFlowReleaseGroup,
  BranchFlowReleaseState,
  BranchFlowRepository,
  BranchFlowRepositorySummary,
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
 * 既定では隠すレーン（#1510）。
 *
 * **区切りは「本番へ出たか」ではなく「まだ流れているか」に置く。** バージョンごとの束
 * （`BranchFlowReleaseGroup`）が「どの版で本番へ出たか」を表すようになったため、
 * マージ済みのレーンを畳む必要はもう無い。既定で隠すのは、どこにも合流しないまま終わった
 * **未マージのクローズ**だけ。
 */
export function isClosedLane(lane: BranchFlowLane): boolean {
  return lane.status === "closed";
}

/** どのバージョンにも乗っていないレーンの並び順。手を動かす必要があるものから並べる */
function laneOrder(lane: BranchFlowLane): number {
  if (lane.status === "open") return 0;
  if (lane.status === "no-pull-request") return 1;
  return 2;
}

/** 進捗の判定に必要な最小限のIssue。表示用の`Issue`型からそのまま渡せる */
export type BranchFlowIssueSource = {
  number: number;
  title: string;
  repositoryFullName: string;
  state: "open" | "closed";
  projectStatus: string | null;
  /** 手作業Issueの起点を引くために使う（#1510）。DBキャッシュ由来 */
  body?: string | null;
  /** ラベル名だけ。手作業Issue（`71.manual-step`）の判定に使う（#1510） */
  labels?: string[];
};

export type BuildBranchFlowInput = {
  repositories: {
    fullName: string;
    private: boolean;
  }[];
  pullRequests: PullRequestSummary[];
  issues: BranchFlowIssueSource[];
  /** `GET /api/branch-flow`の結果。未取得のリポジトリはPRだけから組み立てる */
  branchStatuses: RepositoryBranchStatus[];
};

export type BranchFlow = {
  /**
   * 表示対象のリポジトリ。**動きの無いリポジトリも除かない**（#1510）。
   * 既定で1行に畳むようになったため、隠す理由が「場所を取るから」でなくなり、
   * 隠すと「集計から漏れていないか」を画面で確かめられなくなる方が問題になった。
   */
  repositories: BranchFlowRepository[];
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

  const repositories = input.repositories.map((repository) =>
    buildRepository({
      repository,
      pullRequests: input.pullRequests.filter(
        (pullRequest) => pullRequest.repositoryFullName === repository.fullName,
      ),
      issues: input.issues.filter((issue) => issue.repositoryFullName === repository.fullName),
      branchStatus: branchStatusByRepo.get(repository.fullName) ?? null,
    }),
  );

  return { repositories };
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

  // **バージョンバンプPR（`release/vX.Y.Z`→develop）も幹の一部**（#1548）。レーンとして扱うと、
  // PR本文に並ぶ「今回のリリース対象issue」の番号を`linkedIssueNumbers`が拾い、無関係なIssueが
  // そのレーンの「対応Issue」「関連」としてぶら下がる（#1547で実際にそう見えていた）。
  // マージ済みのバンプPRは出さない——どの版で本番へ出たかはリリースの束の見出しが表しているため。
  const bumpPullRequest =
    pullRequests.find(
      (pullRequest) => pullRequest.kind === "version-bump" && pullRequest.state === "open",
    ) ?? null;

  const lanePullRequests = pullRequests.filter(
    (pullRequest) => pullRequest.kind !== "release" && pullRequest.kind !== "version-bump",
  );

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
  const manualStepsByIssue = collectManualSteps(issues);
  const lanes = [...laneKeys].map((key) =>
    buildLane({
      branchName: key,
      pullRequests: lanePullRequests.filter((pullRequest) => pullRequest.headRef === key),
      issueByNumber,
      releases,
      manualStepsByIssue,
    }),
  );

  // どこかのレーンに現れたIssueは「関連が見つからない」側に出さない。**関連として出したぶんも
  // 含める**——1本のPRが複数のIssueを扱っている場合、2件目以降も画面には現れているため。
  const linkedIssueNumbers = new Set(
    lanes.flatMap((lane) => [
      ...(lane.issue ? [lane.issue.number] : []),
      ...lane.relatedIssues.map((issue) => issue.number),
    ]),
  );

  const { activeLanes, releaseGroups, unassignedLanes } = groupLanesByRelease({
    lanes,
    releases,
    openReleasePullRequest: releasePullRequest,
    openBumpPullRequest: bumpPullRequest,
    unreleasedCommits: branchStatus?.developVsMain?.aheadBy ?? 0,
  });

  const openLanePullRequests = lanePullRequests.filter(
    (pullRequest) => pullRequest.state === "open",
  );
  const summary: BranchFlowRepositorySummary = {
    activeLaneCount: activeLanes.filter((lane) => !isClosedLane(lane)).length,
    // バンプPRもレーンから外したぶんここで数える（#1548）。CIが落ちたバンプPRは
    // auto-mergeが効かず止まっている状態そのもので、畳んだ行から気づけないと困る。
    hasCiFailure: [
      ...openLanePullRequests,
      ...(releasePullRequest ? [releasePullRequest] : []),
      ...(bumpPullRequest ? [bumpPullRequest] : []),
    ].some((pullRequest) => pullRequest.ciState === "failure"),
    needsUserMerge: openLanePullRequests.some(requiresUserMerge),
    // バンプPRが開いている間もリリースは進行中。レーンとして数えていたころは
    // `activeLaneCount`が畳んだ行に「進行中1」として出ていた（#1548）。
    releaseInProgress: releasePullRequest !== null || bumpPullRequest !== null,
  };

  // リリース用workflow（`release-develop-to-main.yml`）を実際に持つリポジトリだけで押させる
  // （#1538）。`claude-issue-dispatch.yml`の有無で代用していたころは、Claude運用には載って
  // いてもリリース用workflowを持たないリポジトリでボタンが出て、押すとdispatchが404になった。
  // ブランチ状況を取得できていないリポジトリでは判定できないためfalse（＝出さない）。
  const canRelease = branchStatus?.hasReleaseWorkflow ?? false;

  return {
    repositoryFullName: repository.fullName,
    repositoryPrivate: repository.private,
    release: {
      pullRequest: releasePullRequest,
      comparison: branchStatus?.developVsMain ?? null,
      latestVersion: releases.at(-1)?.version ?? null,
    },
    activeLanes,
    releaseGroups,
    unassignedLanes,
    summary,
    canRelease,
    // openなバンプPRがある間は、リリースworkflowを起こし直すと二重に走る。
    // 未リリースの変更が無い場合も押させない（出すものが無い）。
    canTriggerRelease:
      canRelease &&
      releasePullRequest === null &&
      bumpPullRequest === null &&
      (branchStatus?.developVsMain?.aheadBy ?? 0) > 0,
    orphanIssues: issues
      .filter(
        (issue) =>
          issue.state === "open" &&
          !isManualStepIssue(issue) &&
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
  pullRequest: PullRequestSummary;
};

function collectReleases(pullRequests: PullRequestSummary[]): MergedRelease[] {
  return pullRequests
    .filter((pullRequest) => pullRequest.kind === "release" && pullRequest.mergedAt !== null)
    .map((pullRequest) => ({
      mergedAt: new Date(pullRequest.mergedAt as string).getTime(),
      version: VERSION_PATTERN.exec(pullRequest.title)?.[1] ?? null,
      pullRequestNumber: pullRequest.number,
      pullRequest,
    }))
    .sort((a, b) => a.mergedAt - b.mergedAt);
}

/**
 * レーンを「どのバージョンで本番へ出たか」の束へ分ける（#1510）。
 *
 * 束の作り方は`resolveReleaseState`が既に済ませているので、ここはその結果で仕分けるだけ。
 * **追加のGitHub API取得は要らない。**
 *
 * - まだdevelopへ入っていないレーン（マージ待ち・PR未作成・未マージのクローズ）は`activeLanes`
 * - developへ入ったが本番未反映のレーンは、先頭の束（未リリース）
 * - 本番へ出たレーンは、それを運んだリリースPRごとの束
 * - どの版か特定できないレーン（取得したPRの範囲より古い）は`unassignedLanes`
 *
 * 先頭の未リリースの束は、**中身が空でもリリースPRか未リリースのコミットがあれば作る**——
 * 「これから何を出すのか」を置く場所であり、「リリースする」ボタンの居場所でもあるため。
 */
function groupLanesByRelease({
  lanes,
  releases,
  openReleasePullRequest,
  openBumpPullRequest,
  unreleasedCommits,
}: {
  lanes: BranchFlowLane[];
  releases: MergedRelease[];
  openReleasePullRequest: PullRequestSummary | null;
  /** openなバージョンバンプPR。先頭（未リリース）の束へ幹の一部として乗せる（#1548） */
  openBumpPullRequest: PullRequestSummary | null;
  unreleasedCommits: number;
}): {
  activeLanes: BranchFlowLane[];
  releaseGroups: BranchFlowReleaseGroup[];
  unassignedLanes: BranchFlowLane[];
} {
  const activeLanes: BranchFlowLane[] = [];
  const pendingLanes: BranchFlowLane[] = [];
  const unassignedLanes: BranchFlowLane[] = [];
  const lanesByRelease = new Map<number, BranchFlowLane[]>();

  for (const lane of lanes) {
    if (lane.status !== "merged") {
      activeLanes.push(lane);
      continue;
    }
    // マージ時刻が無い（`releaseState`がnull）レーンも、版を決められない点は`unknown`と同じ
    if (lane.releaseState === null || lane.releaseState.kind === "unknown") {
      unassignedLanes.push(lane);
    } else if (lane.releaseState.kind === "pending") {
      pendingLanes.push(lane);
    } else {
      const number = lane.releaseState.pullRequestNumber;
      lanesByRelease.set(number, [...(lanesByRelease.get(number) ?? []), lane]);
    }
  }

  const releaseGroups: BranchFlowReleaseGroup[] = [];
  if (
    pendingLanes.length > 0 ||
    openReleasePullRequest !== null ||
    openBumpPullRequest !== null ||
    unreleasedCommits > 0
  ) {
    releaseGroups.push(
      toReleaseGroup({
        key: "unreleased",
        // 版はリリースPRのタイトルから取り、まだ無ければバンプPRのブランチ名（`release/vX.Y.Z`）
        // から取る（#1548）。バンプ中は次に出る版が既に決まっているため、「次のリリース」より
        // 版数を出すほうが状況を表す。
        version:
          (openReleasePullRequest
            ? (VERSION_PATTERN.exec(openReleasePullRequest.title)?.[1] ?? null)
            : null) ??
          (openBumpPullRequest
            ? (VERSION_PATTERN.exec(openBumpPullRequest.headRef)?.[1] ?? null)
            : null),
        pullRequest: openReleasePullRequest,
        bumpPullRequest: openBumpPullRequest,
        mergedAt: null,
        lanes: pendingLanes.sort(compareLanes),
      }),
    );
  }

  // 本番へ出た束は新しい順。中身が1本も無い版は、画面に出しても線が増えるだけなので作らない
  for (const release of [...releases].reverse()) {
    const groupLanes = lanesByRelease.get(release.pullRequestNumber);
    if (!groupLanes || groupLanes.length === 0) continue;
    releaseGroups.push(
      toReleaseGroup({
        key: `release-${release.pullRequestNumber}`,
        version: release.version,
        pullRequest: release.pullRequest,
        // 本番へ出た束にバンプPRは出さない（版の見出しがそれを表している）
        bumpPullRequest: null,
        mergedAt: release.pullRequest.mergedAt,
        lanes: groupLanes.sort(compareLanes),
      }),
    );
  }

  return {
    activeLanes: activeLanes.sort(compareLanes),
    releaseGroups,
    unassignedLanes: unassignedLanes.sort(compareLanes),
  };
}

function toReleaseGroup(
  group: Omit<BranchFlowReleaseGroup, "openManualStepCount">,
): BranchFlowReleaseGroup {
  return {
    ...group,
    openManualStepCount: group.lanes.reduce(
      (count, lane) =>
        count + lane.manualSteps.filter((manualStep) => manualStep.state === "open").length,
      0,
    ),
  };
}

function isManualStepIssue(issue: BranchFlowIssueSource): boolean {
  return (issue.labels ?? []).includes(MANUAL_STEP_LABEL);
}

/**
 * 手作業Issue（`71.manual-step`）を、起点Issueの番号ごとにまとめる（#1510）。
 *
 * 手作業Issueの本文は`## 関連`の見出しに起点Issueの番号を書く決まり
 * （[docs/multi-agent/labels.md](../../docs/multi-agent/labels.md)）なので、そこを読む。
 * 見出しが無い場合だけ「起点」の語を含む行へ落とす——**本文の先頭から最初の`#番号`を
 * 拾うのは誤り**で、`## 前提条件`に「#1461がdevelopへマージされた後」のような
 * 別のIssueへの参照が入るため。
 */
function collectManualSteps(
  issues: BranchFlowIssueSource[],
): Map<number, BranchFlowManualStep[]> {
  const byOrigin = new Map<number, BranchFlowManualStep[]>();

  for (const issue of issues) {
    if (!isManualStepIssue(issue)) continue;
    const origin = extractManualStepOrigin(issue.body ?? null);
    if (origin === null || origin === issue.number) continue;
    byOrigin.set(origin, [
      ...(byOrigin.get(origin) ?? []),
      { number: issue.number, title: issue.title, state: issue.state },
    ]);
  }

  for (const manualSteps of byOrigin.values()) {
    // 未完了を先に、あとは番号の新しい順。手を動かす必要があるものが上に来る
    manualSteps.sort((a, b) => {
      if (a.state !== b.state) return a.state === "open" ? -1 : 1;
      return b.number - a.number;
    });
  }

  return byOrigin;
}

const ISSUE_REFERENCE_PATTERN = /#(\d+)/;
const RELATED_HEADING_PATTERN = /^##\s*関連\s*$/;
const HEADING_PATTERN = /^##\s/;

/** 手作業Issueの本文から起点Issueの番号を取る。見つからなければnull */
export function extractManualStepOrigin(body: string | null): number | null {
  if (!body) return null;
  const lines = body.split("\n");

  const headingIndex = lines.findIndex((line) => RELATED_HEADING_PATTERN.test(line.trim()));
  if (headingIndex >= 0) {
    const rest = lines.slice(headingIndex + 1);
    const nextHeading = rest.findIndex((line) => HEADING_PATTERN.test(line));
    const section = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).join("\n");
    const number = ISSUE_REFERENCE_PATTERN.exec(section)?.[1];
    if (number) return Number(number);
  }

  const originLine = lines.find((line) => line.includes("起点"));
  const fromOriginLine = originLine ? ISSUE_REFERENCE_PATTERN.exec(originLine)?.[1] : undefined;
  return fromOriginLine ? Number(fromOriginLine) : null;
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
  manualStepsByIssue,
}: {
  branchName: string;
  pullRequests: PullRequestSummary[];
  issueByNumber: Map<number, BranchFlowIssueSource>;
  releases: MergedRelease[];
  manualStepsByIssue: Map<number, BranchFlowManualStep[]>;
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
    // 手作業は「対応Issueから生まれたもの」なので、関連Issueぶんまでは拾わない
    manualSteps: issueNumber === null ? [] : (manualStepsByIssue.get(issueNumber) ?? []),
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
