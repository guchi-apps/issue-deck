import { MANUAL_STEP_LABEL } from "@/lib/github/approval-labels";
import { resolveProgressStatus, type ProgressStatusKey } from "@/lib/issue-progress";
import {
  classifyPullRequest,
  extractLinkedIssueNumber,
  requiresUserMerge,
} from "@/lib/pull-request-list";
import type {
  BranchFlowDeployRun,
  BranchFlowDeployState,
  BranchFlowIssuePriority,
  BranchFlowIssueRef,
  BranchFlowLane,
  BranchFlowLaneStatus,
  BranchFlowManualStep,
  BranchFlowPlannedIssue,
  BranchFlowReleaseGroup,
  BranchFlowReleaseState,
  BranchFlowRepository,
  BranchFlowRepositorySummary,
  RepositoryBranchStatus,
  RepositoryDeployStatus,
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

/**
 * これから着手する＝まだブランチが無くて当然の進捗（#1704）。
 *
 * **`ready`（未着手）まで含める。** issue-deckの運用では、計画が要らないIssueは`Ready`から直接
 * 実装へ入る（`21.plan-required`が付いたものだけ`Planning`を経由する）ため、`planning`だけに
 * 絞ると「次に流れてくるもの」がほとんど映らない。件数が多くなるぶんは画面側で頭出しする。
 *
 * **ブランチの存在確認（`ACTIVE_ISSUE_PROGRESS_STATUSES`）には足さない。** この集合のIssueは
 * ブランチが無いのが正常で、名指しで問い合わせてもGitHub APIの消費が増えるだけになる。
 */
export const PLANNED_ISSUE_PROGRESS_STATUSES: readonly ProgressStatusKey[] = ["planning", "ready"];

const PLANNED_ISSUE_PROGRESS_SET: ReadonlySet<ProgressStatusKey> = new Set(
  PLANNED_ISSUE_PROGRESS_STATUSES,
);

/** 優先度ラベル。`11.local`と番号帯が重ならないよう80・89番台へリネーム済み（CLAUDE.md） */
export const HIGH_PRIORITY_LABEL = "80.Priority: High";
export const LOW_PRIORITY_LABEL = "89.Priority: low";

/** 優先度ラベルから優先度を取る。付いていなければnull（#1704） */
export function resolveIssuePriority(labels: readonly string[]): BranchFlowIssuePriority | null {
  if (labels.includes(HIGH_PRIORITY_LABEL)) return "high";
  if (labels.includes(LOW_PRIORITY_LABEL)) return "low";
  return null;
}

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
 * リリースPRのタイトル（やバンプPRのブランチ名）から版を取り出す。取れなければnull。
 * PR詳細のデプロイ表示（`lib/pull-request-deploy.ts`。#1814）も同じ取り出し方に揃えるため、
 * 正規表現を写さずここを共用する。
 */
export function releaseVersionFromTitle(title: string): string | null {
  return VERSION_PATTERN.exec(title)?.[1] ?? null;
}

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

/**
 * リリースを進めているPRのCIが実行中か（#1931）。**回るアイコンを出してよいかの唯一の判定。**
 *
 * 「リリース中」のバッジは、CIが走っている間も、CIが終わって人のマージを待っている間も
 * 同じ見た目だったため、行を開くまで「待てばよいのか、自分が押す番なのか」が分からなかった。
 * 畳んだ1行（`summary.releaseCiPending`）と束の見出しで同じ規則にするためここに置く。
 *
 * **`unknown`（`Checks: read`が無い・チェックが0件・取得失敗）では回さない。** 実行中だと
 * 言い切れないものを「進行中」と見せると、止まっているものを待ち続けることになる。
 */
export function isReleaseCiPending(...pullRequests: (PullRequestSummary | null)[]): boolean {
  return pullRequests.some((pullRequest) => pullRequest?.ciState === "pending");
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
  /**
   * `GET /api/branch-flow/deploy`の結果（#1579）。未取得のリポジトリはデプロイの状態を出さない
   * （＝マージ済みの束は従来どおり「◯/◯に本番反映」のまま）。
   */
  deployStatuses?: RepositoryDeployStatus[];
  /** 現在時刻（ミリ秒）。デプロイ待ちの打ち切り判定に使う。テストから注入する */
  now?: number;
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
  const deployRunByRepo = new Map(
    (input.deployStatuses ?? []).map((status) => [status.repositoryFullName, status.deployRun]),
  );
  const now = input.now ?? Date.now();

  const repositories = input.repositories.map((repository) =>
    buildRepository({
      repository,
      pullRequests: input.pullRequests.filter(
        (pullRequest) => pullRequest.repositoryFullName === repository.fullName,
      ),
      issues: input.issues.filter((issue) => issue.repositoryFullName === repository.fullName),
      branchStatus: branchStatusByRepo.get(repository.fullName) ?? null,
      deployRun: deployRunByRepo.get(repository.fullName) ?? null,
      now,
    }),
  );

  return { repositories };
}

/**
 * 選択中のリポジトリを一覧の先頭へ寄せる（#1750）。
 *
 * ブランチ画面はリポジトリ絞り込みを適用せず全リポジトリを並べるため、選択したリポジトリを
 * 展開しても、連携数が増えると画面の外にあって気付けない。左メニューのリポジトリ一覧（#1480）と
 * 同じ考え方で先頭へ寄せる。**グループ内の並びは元のまま保ち**、選択が0件なら並びは変わらない。
 */
export function orderRepositoriesBySelection<T extends { fullName: string }>(
  repositories: readonly T[],
  selectedFullNames: readonly string[],
): T[] {
  if (selectedFullNames.length === 0) return [...repositories];
  const selected = repositories.filter((repo) => selectedFullNames.includes(repo.fullName));
  const rest = repositories.filter((repo) => !selectedFullNames.includes(repo.fullName));
  return [...selected, ...rest];
}

function buildRepository({
  repository,
  pullRequests,
  issues,
  branchStatus,
  deployRun,
  now,
}: {
  repository: { fullName: string; private: boolean };
  pullRequests: PullRequestSummary[];
  issues: BranchFlowIssueSource[];
  branchStatus: RepositoryBranchStatus | null;
  deployRun: BranchFlowDeployRun | null;
  now: number;
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

  // 本番デプロイの状態は、いちばん新しくmainへ入ったリリースに対してだけ決まる（#1579）
  const deployState = resolveDeployState({
    deployRun,
    releaseMergedAt: releases.at(-1)?.pullRequest.mergedAt ?? null,
    now,
  });

  const { activeLanes, releaseGroups, unassignedLanes } = groupLanesByRelease({
    lanes,
    releases,
    openReleasePullRequest: releasePullRequest,
    openBumpPullRequest: bumpPullRequest,
    unreleasedCommits: branchStatus?.developVsMain?.aheadBy ?? 0,
    deployState,
  });

  // これから着手するIssue（#1704）。レーンに現れているものは除くので、`linkedIssueNumbers`を
  // 作った後でなければ組み立てられない。
  const plannedIssues = collectPlannedIssues(issues, linkedIssueNumbers);

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
    // 既定で出す束を「次のリリースに乗る分」まで畳んだぶん（#1586）、畳んだ行で件数だけ出す。
    // 本番へ出た版に紐づいたまま残る手作業があるため、リポジトリ全体のレーンから数える。
    openManualStepCount: countOpenManualSteps([
      ...activeLanes,
      ...releaseGroups.flatMap((group) => group.lanes),
      ...unassignedLanes,
    ]),
    // バンプPRが開いている間もリリースは進行中。レーンとして数えていたころは
    // `activeLaneCount`が畳んだ行に「進行中1」として出ていた（#1548）。
    releaseInProgress: releasePullRequest !== null || bumpPullRequest !== null,
    // CIが走っている間だけ畳んだ1行の「リリース中」を回す（#1931）。マージ待ちで止まって
    // いるのか自動で進んでいるのかを、行を開かずに見分けられるようにするため。
    releaseCiPending: isReleaseCiPending(releasePullRequest, bumpPullRequest),
    // 畳んだ1行にアイコンと数字だけで出す（#1704・#1886）。手が要るものではないので、
    // 「手が要るもの◯件」の判定（`needsAttention`）には入れない。
    plannedIssueCount: plannedIssues.length,
    deploy: deployState,
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
    // 「本番へ再デプロイ」（#2020）。**リリースの可否とは条件が別物**——`main`をそのまま
    // 出し直すだけなので、未リリースの変更があってもなくても押してよい。
    // デプロイが動いている間だけ押させない（`deploy.yml`の`concurrency`は
    // `cancel-in-progress: true`で、重ねて起動すると走っているデプロイを打ち切るため）。
    canTriggerDeploy:
      (branchStatus?.hasDeployWorkflow ?? false) &&
      (deployState === null || deployState.kind === "success" || deployState.kind === "failure"),
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
    plannedIssues,
    branchesLoaded: branchStatus !== null,
  };
}

/** 実装予定の並び順。計画検討中を先に、次に優先度の高い順（`orphanIssues`と同じく最後は番号の新しい順） */
const PLANNED_PROGRESS_ORDER: Record<string, number> = { planning: 0, ready: 1 };
const PLANNED_PRIORITY_ORDER: Record<string, number> = { high: 0, low: 2 };

/**
 * これから着手するIssueを集める（#1704）。
 *
 * **`orphanIssues`と条件がよく似ているが、意味が違う。** あちらは「実装中なのにブランチが
 * 見つからない」異常で、こちらはまだブランチが無くて当然の上流。除外はどちらも同じで、
 * すでにレーンとして画面に出ているIssueは重ねて出さない。
 *
 * 手作業Issue（`71.manual-step`）は実装するものではなく、既にレーンの下と束の外へ出している
 * （#1510・#1586）ため、ここには混ぜない。
 */
function collectPlannedIssues(
  issues: BranchFlowIssueSource[],
  laneIssueNumbers: ReadonlySet<number>,
): BranchFlowPlannedIssue[] {
  return issues
    .filter(
      (issue) =>
        issue.state === "open" &&
        !isManualStepIssue(issue) &&
        PLANNED_ISSUE_PROGRESS_SET.has(resolveProgressStatus(issue)) &&
        !laneIssueNumbers.has(issue.number),
    )
    .map((issue) => ({
      ...toIssueRef(issue),
      priority: resolveIssuePriority(issue.labels ?? []),
    }))
    .sort(comparePlannedIssues);
}

function comparePlannedIssues(a: BranchFlowPlannedIssue, b: BranchFlowPlannedIssue): number {
  const byProgress =
    (PLANNED_PROGRESS_ORDER[a.progress ?? ""] ?? 1) - (PLANNED_PROGRESS_ORDER[b.progress ?? ""] ?? 1);
  if (byProgress !== 0) return byProgress;
  const byPriority =
    (PLANNED_PRIORITY_ORDER[a.priority ?? ""] ?? 1) - (PLANNED_PRIORITY_ORDER[b.priority ?? ""] ?? 1);
  if (byPriority !== 0) return byPriority;
  return b.number - a.number;
}

/** マージ済みのリリースPR（develop→main）を、マージが古い順に並べたもの */
type MergedRelease = {
  mergedAt: number;
  version: string | null;
  pullRequestNumber: number;
  pullRequest: PullRequestSummary;
};

/**
 * リポジトリごとの「直近でmainへ入ったリリースPRのマージ時刻」（#1579）。
 *
 * デプロイの状態を決めるのに要るのはこの1点だけなので、**流れ図を組み立てずに取り出せる形**で
 * 出しておく。デプロイ状況の取得（`hooks/use-deploy-status.ts`）が「まだ追いかける必要があるか」を
 * 自分で判断するために使う。
 */
export function latestReleaseMergedAtByRepository(
  pullRequests: PullRequestSummary[],
): Map<string, string> {
  const byRepository = new Map<string, string>();
  for (const pullRequest of pullRequests) {
    if (pullRequest.kind !== "release" || pullRequest.mergedAt === null) continue;
    const current = byRepository.get(pullRequest.repositoryFullName);
    if (current === undefined || current < pullRequest.mergedAt) {
      byRepository.set(pullRequest.repositoryFullName, pullRequest.mergedAt);
    }
  }
  return byRepository;
}

function collectReleases(pullRequests: PullRequestSummary[]): MergedRelease[] {
  return pullRequests
    .filter((pullRequest) => pullRequest.kind === "release" && pullRequest.mergedAt !== null)
    .map((pullRequest) => ({
      mergedAt: new Date(pullRequest.mergedAt as string).getTime(),
      version: releaseVersionFromTitle(pullRequest.title),
      pullRequestNumber: pullRequest.number,
      pullRequest,
    }))
    .sort((a, b) => a.mergedAt - b.mergedAt);
}

/**
 * mainへマージしてから、そのデプロイ実行が現れるまで「デプロイ待ち」と出し続ける上限（#1579）。
 *
 * **`deploy.yml`がmainへのpushで走らないリポジトリでは、待っている実行が永久に現れない。**
 * その場合まで「待ち」と言い続けると、いつまでも本番の状態を言い当てられないバッジが残るため、
 * この時間を過ぎたら判定できなかったもの（＝従来どおりの表示）へ縮退させる。
 */
const DEPLOY_WAIT_LIMIT_MS = 15 * 60 * 1000;

/**
 * mainへ入った変更が本番へ届いたかを、`deploy.yml`の最新実行から判定する（#1579）。
 *
 * **リリースPRのマージ＝本番反映ではない。** マージの後に`deploy.yml`が数分走り、その結果が
 * 出るまで本番には出ていない。画面はマージした瞬間に「◯/◯に本番反映」と言い切っていたため、
 * デプロイが実行中なのか落ちたのかが分からなかった（Issue #1579）。
 *
 * 突き合わせは**リリースPRのマージ時刻と実行の開始時刻の比較だけ**で行う。mainへのpushで走る
 * workflowなので、そのマージ以降に始まった実行が今回のデプロイになる。追加の取得は要らない。
 *
 * 判定できない場合（実行を1件も取得できない・比較する版が無い）はnullを返し、画面は
 * 従来の表示のままにする——**間違った状態を出すより「何も言わない」方がよい。**
 */
export function resolveDeployState({
  deployRun,
  releaseMergedAt,
  now,
}: {
  deployRun: BranchFlowDeployRun | null;
  /** いちばん新しくmainへ入ったリリースPRのマージ時刻（ISO8601）。無ければnull */
  releaseMergedAt: string | null;
  now: number;
}): BranchFlowDeployState | null {
  if (deployRun === null) return null;

  if (releaseMergedAt !== null) {
    const mergedAt = new Date(releaseMergedAt).getTime();
    if (new Date(deployRun.createdAt).getTime() < mergedAt) {
      // 今回のマージに対する実行がまだ現れていない。上限を過ぎたら判定を諦める
      return now - mergedAt < DEPLOY_WAIT_LIMIT_MS ? { kind: "waiting", htmlUrl: null } : null;
    }
  }

  if (deployRun.status !== "completed") return { kind: "running", htmlUrl: deployRun.htmlUrl };
  return deployRun.conclusion === "success"
    ? { kind: "success", htmlUrl: deployRun.htmlUrl }
    : { kind: "failure", htmlUrl: deployRun.htmlUrl };
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
  deployState,
}: {
  lanes: BranchFlowLane[];
  releases: MergedRelease[];
  openReleasePullRequest: PullRequestSummary | null;
  /** openなバージョンバンプPR。先頭（未リリース）の束へ幹の一部として乗せる（#1548） */
  openBumpPullRequest: PullRequestSummary | null;
  unreleasedCommits: number;
  /** 本番デプロイの状態。**いちばん新しくmainへ入った束にだけ乗せる**（#1579） */
  deployState: BranchFlowDeployState | null;
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
          (openReleasePullRequest ? releaseVersionFromTitle(openReleasePullRequest.title) : null) ??
          (openBumpPullRequest ? releaseVersionFromTitle(openBumpPullRequest.headRef) : null),
        pullRequest: openReleasePullRequest,
        bumpPullRequest: openBumpPullRequest,
        mergedAt: null,
        // まだmainへ入っていない束にデプロイの状態は無い
        deploy: null,
        lanes: pendingLanes.sort(compareLanes),
      }),
    );
  }

  const latestReleaseNumber = releases.at(-1)?.pullRequestNumber ?? null;

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
        // 判定に使うのはmainの最新の実行なので、それ以前の版については何も言えない（#1579）
        deploy: release.pullRequestNumber === latestReleaseNumber ? deployState : null,
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
    openManualStepCount: countOpenManualSteps(group.lanes),
  };
}

/**
 * 未完了の手作業Issueの件数（#1586）。
 *
 * **番号で重複を除く。** 同じIssueが複数のブランチで作業された場合、手作業は起点Issue番号で
 * 引いているためレーンの本数だけ現れ、そのまま数えると二重に数えることになる。
 */
export function countOpenManualSteps(lanes: BranchFlowLane[]): number {
  return new Set(
    lanes.flatMap((lane) =>
      lane.manualSteps
        .filter((manualStep) => manualStep.state === "open")
        .map((manualStep) => manualStep.number),
    ),
  ).size;
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
