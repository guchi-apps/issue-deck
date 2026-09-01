import { db } from "@/lib/db";
import { addCheckUserWithReason } from "@/lib/dispatch/check-user-labels";
import {
  CHECK_USER_LABEL,
  MANUAL_STEP_LABEL,
  isCheckUserReasonLabel,
} from "@/lib/github/approval-labels";
import { getInstallationToken } from "@/lib/github/app-auth";
import { compareBranches, fetchBranchHeadSha } from "@/lib/github/branches-api";
import {
  addIssueLabels,
  createComment,
  fetchCommentsForIssue,
  fetchRepositoryLabelNames,
  removeIssueLabel,
} from "@/lib/github/issues-api";
import { getProjectLocation } from "@/lib/github/project-location";
import { fetchProjectItems } from "@/lib/github/projects-api";
import {
  buildClosedStrandedRecoveredComment,
  buildDevelopMergedComment,
  buildStrandedComment,
  decideClosedStrandedIssue,
  decideProgressSweep,
  decideStaleCheckUser,
  hasDevelopMergedNotice,
  hasStrandedNotice,
  needsStrandedCheck,
  progressSweepIntervalMinutes,
  type ClosedStrandedSkipReason,
  type ProgressSweepCompare,
  type ProgressSweepSkipReason,
} from "@/lib/github/progress-sweep";
import { fetchPullRequestsForHead } from "@/lib/github/pull-requests-api";
import { reportProgressStatus } from "@/lib/github/report-progress";
import { matchProjectStatus, type ProgressStatusKey } from "@/lib/issue-progress";

/**
 * developへのマージ後に取り残された進捗を巡回して回収する（#2294）。
 *
 * 何を回収するのか・なぜGitHub Actionsのscheduleから移したのかは
 * [`progress-sweep.ts`](./progress-sweep.ts)のヘッダーコメントを参照。ここはそのIO側で、
 * 「進める／取り残しとして通知する／見送る」の判定は`decideProgressSweep`に閉じている。
 *
 * **連携済みリポジトリ全部を1回の巡回で見る。** 呼ぶのはログインセッションを持たない
 * サブPCのpollerなので、ユーザー単位の絞り込み（`HiddenRepository`・`userInstallations`）は
 * 行わない。画面に出していないリポジトリの進捗が取り残されるのは同じことで、それを直すのに
 * 「誰が見ているか」は関係しない（コンフリクト巡回#2116・デプロイ失敗巡回#2236と同じ方針）。
 *
 * ## GitHub APIの消費
 *
 * **消費先が変わる点に注意。** ジョブだったときは各リポジトリの`GITHUB_TOKEN`（リポジトリごと
 * 1,000 req/時で隔離）だったが、ここではissue-deckのインストールトークン（5,000 req/時〜。
 * PR一覧・Issue同期・CI状態と共有）を使う。共有枠を食い潰すと巻き添えで他の機能が落ちるため
 * （`docs/code-map.md`「条件付きGET」）、平常時にほとんど消費しない形にしてある。
 *
 * - installationごとにProjectのアイテム一覧（GraphQL）を1回
 * - `Develop PR`・`Implementation`にいるopenなIssueぶんだけREST 1回（そのブランチの
 *   クローズ済みPR）。**ETagの条件付きGETを通すので、状況が変わらない間は304になり
 *   レート制限を消費しない**——ジョブだったときの`gh pr list`には無かった性質
 * - マージ済みPRが見つかったIssueについてだけ、先端SHAの取得が1回。先端が食い違うときだけ
 *   developとの比較、さらに取り残しの疑いがあるときだけ開いているPRの確認（こちらも条件付きGET）
 * - **コメント一覧は「書くと決めてから」1回だけ**。見送るだけの巡回では引かない
 *
 * 進めたIssueは次の巡回で対象から外れるので、増え続けるのは「取り残しとして通知済み」の
 * ものだけになる（1件あたり2回・巡回ごと）。
 *
 * 手作業ラベルの埋め直し（`manual-step-label`ジョブのschedule分）は**issue-deckのDBを引く**
 * ので、GitHubへの問い合わせは実際に付けるときだけになる。滞留した`00.check-user`の回収
 * （#2335）も同じで、`Develop`・`Release`にいるopenなIssueに絞るため、対象が無ければ
 * REST 1回も出ない。
 *
 * ## closedなIssueの取り残し回収（#2690）
 *
 * `Develop`・`Release`のまま本番反映後も放置される問題が#2689の調査で見つかった（8リポジトリ
 * 15件）。共通原因は「closeされた後は`queryIssuesByProgressStatus`がcloseなIssueを除外する
 * ため、以後どのリリースの一括遷移にも二度と拾われない」の一点（詳細は
 * `docs/progress-status-architecture.md`「取り残しが本当に起きる原因は3パターンある」）。
 *
 * - **対象は`fetchProjectItems`のスナップショットで拾う。** `queryIssuesByProgressStatus`は
 *   設計上closeを除外するため使えず、ここだけは`item.issueOpen === false`を直接見る
 * - **判定は`issue-<番号>`ブランチの直近マージ済みPRのheadが`main`の祖先か**
 *   （`compare/main...head`の`aheadBy === 0`）だけ。祖先なら`done`を報告する
 *   （Issueは既にcloseされているため`close`は行わない）
 * - **openなIssueは対象にしない。** #2689のパターン3（issue-deck不通で`main-pr-merged`が
 *   対象を1件も特定できなかった場合）はopenなIssueのまま`Release`に残る形で発生するが、
 *   ここでは拾わない。`Develop`には次のリリースを待っているだけの**正常な**openなIssueが
 *   常に一定数いるため、それら全部を巡回のたびに`compare`APIへ問い合わせるとGitHub APIの
 *   消費が跳ね上がる（closedはこの巡回対象になること自体が異常で、定常状態ではほぼ0件）。
 *   openな取りこぼしは、issue-deck復旧後に`main-pr-merged`のrunを再実行する既存の経路に委ねる
 */

/** 巡回が実際に行ったこと1件ぶん */
export type ProgressSweepAction = {
  repositoryFullName: string;
  issueNumber: number;
  kind:
    | "advanced"
    | "stranded"
    | "manual_step_labeled"
    | "check_user_cleared"
    /** closedなIssueの取り残しをdoneへ回収した（#2690） */
    | "closed_advanced";
};

export type ProgressSweepResult = {
  /** 実際に巡回したか。間隔に達していない・無効化されている場合は`false` */
  swept: boolean;
  /** `PROGRESS_SWEEP_INTERVAL_MINUTES=0`で止めているか */
  disabled: boolean;
  /** 見たリポジトリ数 */
  repositories: number;
  /** `Develop PR`・`Implementation`にいて実際に見たopenなIssue数 */
  candidates: number;
  /** `Develop`・`Release`にいて実際に見たclosedなIssue数（#2690） */
  closedCandidates: number;
  /** 進めた・通知した・ラベルを付けたもの */
  actions: ProgressSweepAction[];
  /** 見送った理由ごとの件数 */
  skipped: Partial<
    Record<ProgressSweepSkipReason | ClosedStrandedSkipReason | "fetch_failed" | "action_failed", number>
  >;
  /** 状況を取得できなかったリポジトリ */
  failedRepositories: string[];
};

/** 巡回の対象にする進捗。`develop-pr`へ一度も到達しないまま取り残されるケースがある（#1861） */
const TARGET_STATUSES: readonly ProgressStatusKey[] = ["develop-pr", "implementation"];

/** 進める先。`onlyFrom`で「この段階にいるものだけ」に限る */
const ADVANCE_TO: ProgressStatusKey = "develop";

/**
 * closedなIssueの取り残しを疑って拾い直す進捗（#2690）。`queryIssuesByProgressStatus`は
 * closeなIssueを除外するため、この2段だけは`fetchProjectItems`のスナップショットを直接読む。
 */
const CLOSED_TARGET_STATUSES: readonly ProgressStatusKey[] = ["develop", "release"];

/** Issue用ブランチが向く先。この運用ではdevelop固定（`develop`を持たないリポジトリでは対象0件） */
const BASE_BRANCH = "develop";

/** closedなIssueの取り残し回収で、本番反映済みかを確かめる比較先（#2690） */
const MAIN_BRANCH = "main";

/**
 * 外しそこねた`00.check-user`を探す進捗（#2335）。**マージ後まで進んだものだけ**を見る。
 * `Done`はIssueがcloseされるので`state: "OPEN"`の時点で外れ、`cleanup-on-close`と
 * issue-deckの`clearLabelsOnIssueClose`（#2178）が受け持つ。
 */
const STALE_CHECK_USER_STATUSES = ["Develop", "Release"];

/**
 * 最後に巡回した時刻（epoch ms）。**プロセス内にしか持たない**（既存の巡回2本と同じ）。
 * 再起動で忘れても起きるのは「1回余分に巡回する」だけで、巡回自体は冪等。
 */
let lastSweptAt: number | null = null;

/** テスト用。プロセスをまたがないので本番では呼ばない */
export function resetProgressSweepIntervalForTest(): void {
  lastSweptAt = null;
}

function emptyResult(overrides: Partial<ProgressSweepResult>): ProgressSweepResult {
  return {
    swept: false,
    disabled: false,
    repositories: 0,
    candidates: 0,
    closedCandidates: 0,
    actions: [],
    skipped: {},
    failedRepositories: [],
    ...overrides,
  };
}

export async function runProgressSweep(
  options: { force?: boolean; now?: Date } = {},
): Promise<ProgressSweepResult> {
  const now = options.now ?? new Date();
  const intervalMinutes = progressSweepIntervalMinutes();
  if (intervalMinutes === 0) return emptyResult({ disabled: true });
  // 間隔の判定はサーバー側に置く（pollerは1巡ごとに素直に呼ぶだけでよい）。
  if (
    !options.force &&
    lastSweptAt !== null &&
    now.getTime() - lastSweptAt < intervalMinutes * 60_000
  ) {
    return emptyResult({});
  }
  lastSweptAt = now.getTime();

  const repositories = await db.repository.findMany({
    where: { archived: false },
    orderBy: { fullName: "asc" },
    include: { installation: true },
  });
  if (repositories.length === 0) return emptyResult({ swept: true });

  const skipped: ProgressSweepResult["skipped"] = {};
  function countSkip(reason: keyof ProgressSweepResult["skipped"]): void {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  }

  // 同一installationのリポジトリ間でトークン取得を使い回す（既存の巡回2本と同じ）。
  const tokenPromises = new Map<string, Promise<string>>();
  function tokenFor(installationId: number, cacheKey: string): Promise<string> {
    let token = tokenPromises.get(cacheKey);
    if (!token) {
      token = getInstallationToken(installationId);
      tokenPromises.set(cacheKey, token);
    }
    return token;
  }

  const actions: ProgressSweepAction[] = [];
  const failedRepositories: string[] = [];

  const { openCandidates, closedCandidates } = await collectCandidates({
    repositories,
    tokenFor,
    failedRepositories,
  });

  for (const candidate of openCandidates) {
    try {
      const action = await sweepIssue({ ...candidate, now, countSkip });
      if (action) actions.push(action);
    } catch (error) {
      // 1件の失敗で巡回全体を止めない。次の巡回で拾い直せる。
      console.error(
        `[progress-sweep] ${candidate.repositoryFullName}#${candidate.issueNumber}:`,
        error,
      );
      countSkip("fetch_failed");
    }
  }

  for (const candidate of closedCandidates) {
    try {
      const action = await sweepClosedIssue({ ...candidate, countSkip });
      if (action) actions.push(action);
    } catch (error) {
      // 1件の失敗で巡回全体を止めない。次の巡回で拾い直せる。
      console.error(
        `[progress-sweep] ${candidate.repositoryFullName}#${candidate.issueNumber}（closed）:`,
        error,
      );
      countSkip("fetch_failed");
    }
  }

  actions.push(...(await sweepStaleCheckUser({ tokenFor, countSkip })));
  actions.push(...(await sweepManualStepLabels({ tokenFor, countSkip })));

  return {
    swept: true,
    disabled: false,
    repositories: repositories.length,
    candidates: openCandidates.length,
    closedCandidates: closedCandidates.length,
    actions,
    skipped,
    failedRepositories,
  };
}

type RepositoryRow = {
  id: string;
  githubRepositoryId: number;
  ownerLogin: string;
  name: string;
  fullName: string;
  installation: { id: string; installationId: number };
};

type Candidate = {
  repositoryFullName: string;
  ownerLogin: string;
  name: string;
  issueNumber: number;
  token: string;
};

/** `collectCandidates`が返す、open向け・closed向けそれぞれの対象一覧 */
type CandidateGroups = {
  /** `Develop PR`・`Implementation`にいるopenなIssue */
  openCandidates: Candidate[];
  /** `Develop`・`Release`にいるclosedなIssue（#2690） */
  closedCandidates: Candidate[];
};

/**
 * open向け・closed向け、両方の巡回対象を集める。
 *
 * **Projectのアイテム一覧はinstallationごとに1回だけ引く。** リポジトリごとに
 * `queryIssuesByProgressStatus`を呼ぶと、同じ盤面をリポジトリ数ぶん読み直すことになる
 * （盤面はorganization単位で1つしかない）。openとclosedを同じ一覧から振り分けるのも、
 * 同じ理由で取得を2回に増やさないため。
 */
async function collectCandidates(params: {
  repositories: RepositoryRow[];
  tokenFor: (installationId: number, cacheKey: string) => Promise<string>;
  failedRepositories: string[];
}): Promise<CandidateGroups> {
  const location = getProjectLocation();
  // Project連携が無効なら進捗そのものが無い。手作業ラベルの埋め直しだけを行う。
  if (!location) return { openCandidates: [], closedCandidates: [] };

  const byInstallation = new Map<string, RepositoryRow[]>();
  for (const repository of params.repositories) {
    const rows = byInstallation.get(repository.installation.id) ?? [];
    rows.push(repository);
    byInstallation.set(repository.installation.id, rows);
  }

  const wantedOpen = new Set<ProgressStatusKey>(TARGET_STATUSES);
  const wantedClosed = new Set<ProgressStatusKey>(CLOSED_TARGET_STATUSES);
  const openCandidates: Candidate[] = [];
  const closedCandidates: Candidate[] = [];

  for (const [installationKey, rows] of byInstallation) {
    let token: string;
    let items: Awaited<ReturnType<typeof fetchProjectItems>>;
    try {
      token = await params.tokenFor(rows[0].installation.installationId, installationKey);
      items = await fetchProjectItems(location.owner, location.number, token);
    } catch (error) {
      // このinstallationのぶんは丸ごと次の巡回へ回す（進捗の判断材料が無いため）。
      console.error(`[progress-sweep] installation ${installationKey} の盤面取得:`, error);
      params.failedRepositories.push(...rows.map((row) => row.fullName));
      continue;
    }

    const byRepositoryId = new Map<number, RepositoryRow>(
      rows.map((row) => [row.githubRepositoryId, row]),
    );
    const seenOpen = new Set<string>();
    const seenClosed = new Set<string>();
    for (const item of items) {
      const repository = byRepositoryId.get(item.repositoryDatabaseId);
      if (!repository) continue;
      const status = item.status ? matchProjectStatus(item.status) : null;
      if (!status) continue;
      const key = `${repository.fullName}#${item.issueNumber}`;
      const candidate: Candidate = {
        repositoryFullName: repository.fullName,
        ownerLogin: repository.ownerLogin,
        name: repository.name,
        issueNumber: item.issueNumber,
        token,
      };
      if (item.issueOpen) {
        if (!wantedOpen.has(status) || seenOpen.has(key)) continue;
        seenOpen.add(key);
        openCandidates.push(candidate);
      } else {
        if (!wantedClosed.has(status) || seenClosed.has(key)) continue;
        seenClosed.add(key);
        closedCandidates.push(candidate);
      }
    }
  }

  return { openCandidates, closedCandidates };
}

/** 1つのIssueを見て、進める・通知する・見送るのいずれかを行う */
async function sweepIssue(params: {
  repositoryFullName: string;
  ownerLogin: string;
  name: string;
  issueNumber: number;
  token: string;
  now: Date;
  countSkip: (reason: keyof ProgressSweepResult["skipped"]) => void;
}): Promise<ProgressSweepAction | null> {
  const { ownerLogin, name, issueNumber, token, now, countSkip } = params;
  const branch = `issue-${issueNumber}`;

  const closed = await fetchPullRequestsForHead(ownerLogin, name, BASE_BRANCH, branch, "closed", token);
  const merged = closed
    .filter((pullRequest) => pullRequest.merged_at !== null)
    .sort((a, b) => Date.parse(a.merged_at ?? "") - Date.parse(b.merged_at ?? ""))
    .at(-1);
  if (!merged) {
    countSkip("no_merged_pr");
    return null;
  }
  const mergedPullRequest = { url: merged.html_url, headSha: merged.head.sha };

  // ブランチが消えている（404）なら追加のpushが無い証拠。それ以外の失敗は例外のまま上へ返し、
  // 次の巡回で再判定する。
  const branchHead = await fetchBranchHeadSha(ownerLogin, name, branch, token);

  let compare: ProgressSweepCompare | null = null;
  let hasOpenDevelopPullRequest = false;
  if (needsStrandedCheck(branchHead, mergedPullRequest.headSha)) {
    compare = await compareBranches(ownerLogin, name, BASE_BRANCH, branch, token);
    // developへ持ち込む変更が残っているときだけ、開いているPRの有無まで確かめる
    // （compareが読めなかった場合も含めて、判定は`decideProgressSweep`に任せる）。
    if (compare && compare.aheadBy !== 0 && compare.changedFiles !== 0) {
      const open = await fetchPullRequestsForHead(
        ownerLogin,
        name,
        BASE_BRANCH,
        branch,
        "open",
        token,
      );
      hasOpenDevelopPullRequest = open.length > 0;
    }
  }

  const decision = decideProgressSweep(
    { mergedPullRequest, branchHead, compare, hasOpenDevelopPullRequest },
    { now },
  );

  if (decision.action === "skip") {
    countSkip(decision.reason);
    return null;
  }

  // **既存コメントは、書くと決めてから読む。** 見送るだけの巡回（`develop_pr_open`・
  // `within_grace`など、同じIssueで何度も繰り返される側）でコメント一覧を引かないため。
  const commentBodies = (await fetchCommentsForIssue(ownerLogin, name, issueNumber, token)).map(
    (comment) => comment.body,
  );

  if (decision.action === "notify_stranded") {
    // 同じ先端について通知を繰り返さない。冪等でないと同じ内容が一日に何十件も積まれる。
    // **マーカーは`develop-merge-sweep`ジョブと同じ形にしてある**ので、参照タグを配り終える
    // までの間に両方が動いても二重には通知されない。
    if (hasStrandedNotice(commentBodies, issueNumber, decision.branchHead)) {
      countSkip("already_notified");
      return null;
    }
    // ユーザーがやることは「計画の承認」ではなく「続け方の指示」なので理由は`01.check-blocked`。
    await addCheckUserWithReason(ownerLogin, name, issueNumber, token, "blocked");
    await createComment(ownerLogin, name, issueNumber, token, {
      body: buildStrandedComment({
        issueNumber,
        branchHead: decision.branchHead,
        pullRequestUrl: decision.pullRequestUrl,
        pullRequestHeadSha: decision.pullRequestHeadSha,
        aheadBy: decision.aheadBy,
        ageMinutes: decision.ageMinutes,
      }),
    });
    return { repositoryFullName: params.repositoryFullName, issueNumber, kind: "stranded" };
  }

  // 進める。**確認待ちを先に解く**（人がやることは無くなったため）。
  await clearCheckUser(ownerLogin, name, issueNumber, token);
  // 通知の重複判定も`develop-merge-sweep`ジョブと同じ（PRのURLと定型文で見分ける）ため、
  // 配布前のリポジトリで両方が動いてもコメントは1件しか付かない。
  if (!hasDevelopMergedNotice(commentBodies, decision.pullRequestUrl)) {
    await createComment(ownerLogin, name, issueNumber, token, {
      body: buildDevelopMergedComment(decision.pullRequestUrl),
    });
  }
  const reported = await reportProgressStatus({
    repositoryFullName: params.repositoryFullName,
    issueNumber,
    status: ADVANCE_TO,
    onlyFrom: TARGET_STATUSES,
  });
  if (!reported.applied) {
    console.warn(
      `[progress-sweep] ${params.repositoryFullName}#${issueNumber} の進捗を進められませんでした（${reported.reason}）`,
    );
  }
  return { repositoryFullName: params.repositoryFullName, issueNumber, kind: "advanced" };
}

/**
 * closedなIssueが`Develop`・`Release`に取り残されていないか確認する（#2690）。
 *
 * `issue-<番号>`ブランチの直近マージ済みPRのheadが`main`の祖先になっていれば、既に本番へ
 * 出ているということなので`done`を報告する。Issueは既にcloseされているため`close`は行わない。
 * 判定は`decideClosedStrandedIssue`。
 */
async function sweepClosedIssue(params: {
  repositoryFullName: string;
  ownerLogin: string;
  name: string;
  issueNumber: number;
  token: string;
  countSkip: (reason: keyof ProgressSweepResult["skipped"]) => void;
}): Promise<ProgressSweepAction | null> {
  const { ownerLogin, name, issueNumber, token, countSkip } = params;
  const branch = `issue-${issueNumber}`;

  const closed = await fetchPullRequestsForHead(ownerLogin, name, BASE_BRANCH, branch, "closed", token);
  const merged = closed
    .filter((pullRequest) => pullRequest.merged_at !== null)
    .sort((a, b) => Date.parse(a.merged_at ?? "") - Date.parse(b.merged_at ?? ""))
    .at(-1);
  const mergedPullRequest = merged ? { url: merged.html_url, headSha: merged.head.sha } : null;

  const compareWithMain = mergedPullRequest
    ? await compareBranches(ownerLogin, name, MAIN_BRANCH, mergedPullRequest.headSha, token)
    : null;

  const decision = decideClosedStrandedIssue({ mergedPullRequest, compareWithMain });
  if (decision.action === "skip") {
    countSkip(decision.reason);
    return null;
  }

  const reported = await reportProgressStatus({
    repositoryFullName: params.repositoryFullName,
    issueNumber,
    status: "done",
    onlyFrom: CLOSED_TARGET_STATUSES,
  });
  if (!reported.applied) {
    console.warn(
      `[progress-sweep] ${params.repositoryFullName}#${issueNumber}（closed）の進捗をdoneへ進められませんでした（${reported.reason}）`,
    );
    countSkip("action_failed");
    return null;
  }

  // developへのマージ時に外しそこねた確認待ちが残っていれば、ここでもついでに外す
  // （`sweepIssue`の「進める」経路と同じ扱い）。
  await clearCheckUser(ownerLogin, name, issueNumber, token);
  await createComment(ownerLogin, name, issueNumber, token, {
    body: buildClosedStrandedRecoveredComment(decision.pullRequestUrl),
  });

  return { repositoryFullName: params.repositoryFullName, issueNumber, kind: "closed_advanced" };
}

/**
 * `00.check-user`と理由ラベル（`01.check-*`。旧名`00.qa-answered`を含む）を外す。
 *
 * ローカルセッション用の`removeCheckUserWithReason`と違い、**誰が付けたかを問わずに外す。**
 * developへマージされた時点で、計画の承認もマージの確認も待つ相手がいなくなるため
 * （`develop-merge-sweep`ジョブが`gh issue edit --remove-label`を並べていたのと同じ扱い）。
 *
 * 戻り値は「実際に`00.check-user`が付いていて外したか」。DBの同期が遅れて対象に挙がった
 * だけのIssueを、巡回の成果として数えないために見る（#2335）。
 */
async function clearCheckUser(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
): Promise<boolean> {
  const remaining = await removeIssueLabel(owner, repo, issueNumber, token, CHECK_USER_LABEL);
  // 404（もともと付いていない）なら理由ラベルも付いていない
  if (remaining === null) return false;
  for (const name of remaining.filter(isCheckUserReasonLabel)) {
    await removeIssueLabel(owner, repo, issueNumber, token, name);
  }
  return true;
}

/**
 * developへのマージ時に外しそこねた`00.check-user`を外す（#2335）。
 *
 * 外す役はPRのマージを受け取る`reusable-issue-labels.yml`の`develop-pr-merged`だけで、
 * そこの`gh issue edit`には再試行が無い。guchi-apps/signaly#200ではGitHubの
 * `502 Bad Gateway`に当たり、次のmainリリースまでの18分間、盤面の「確認待ち」に
 * 押せない札が残った。ワークフロー側にも再試行を足したが、恒久的な失敗と、参照タグが
 * 古いままのリポジトリは拾えないので、こちらを最後の受け皿にする。
 * 外してよいかの判定は`decideStaleCheckUser`。
 *
 * **探し先はissue-deckのDB**（`sweepManualStepLabels`と同じ）。対象を
 * **`Develop`・`Release`にいるopenなIssue**へ絞るのがGitHub APIを消費しないための要で、
 * ここには「進捗はマージ後まで進んだのに確認待ちが残っている」ものしか入らない。
 * 進捗の報告も一緒に落ちて`Develop PR`・`Implementation`に留まった場合は、上の
 * `sweepIssue`が`Develop`へ進めるときに`clearCheckUser`を呼ぶので、そちらで拾える。
 *
 * **進捗（Status）は動かさない。** 進めるのは`sweepIssue`の役目で、こちらは進み終えた
 * Issueに取り残されたラベルだけを相手にする。
 */
async function sweepStaleCheckUser(params: {
  tokenFor: (installationId: number, cacheKey: string) => Promise<string>;
  countSkip: (reason: keyof ProgressSweepResult["skipped"]) => void;
}): Promise<ProgressSweepAction[]> {
  const targets = await db.issue.findMany({
    where: {
      state: "OPEN",
      repository: { archived: false },
      labels: { some: { name: CHECK_USER_LABEL } },
      // 付与の時刻が分からないものは`decideStaleCheckUser`が見送るので、ここで落としておく。
      checkUserLabeledAt: { not: null },
      projectStatus: { in: STALE_CHECK_USER_STATUSES },
    },
    select: {
      number: true,
      checkUserLabeledAt: true,
      repository: {
        select: {
          ownerLogin: true,
          name: true,
          fullName: true,
          installation: { select: { id: true, installationId: true } },
        },
      },
    },
    orderBy: { number: "asc" },
  });
  if (targets.length === 0) return [];

  const actions: ProgressSweepAction[] = [];
  for (const target of targets) {
    const repository = target.repository;
    try {
      const token = await params.tokenFor(
        repository.installation.installationId,
        repository.installation.id,
      );
      // baseは絞らない。`develop`を持たないリポジトリでは`issue-<番号>`→`main`が唯一のPRで、
      // そちらにも`01.check-merge`が付く（`main-pr-in-progress`ジョブ）。
      const pullRequests = await fetchPullRequestsForHead(
        repository.ownerLogin,
        repository.name,
        null,
        `issue-${target.number}`,
        "all",
        token,
      );
      const decision = decideStaleCheckUser({
        pullRequests: pullRequests.map((pullRequest) => ({
          state: pullRequest.state,
          mergedAt: pullRequest.merged_at,
        })),
        checkUserLabeledAt: target.checkUserLabeledAt,
      });
      if (decision.action === "skip") {
        params.countSkip(decision.reason);
        continue;
      }
      const cleared = await clearCheckUser(
        repository.ownerLogin,
        repository.name,
        target.number,
        token,
      );
      // DBの同期が遅れて対象に挙がっただけなら、巡回の成果として数えない。
      if (!cleared) continue;
      actions.push({
        repositoryFullName: repository.fullName,
        issueNumber: target.number,
        kind: "check_user_cleared",
      });
    } catch (error) {
      // 1件の失敗で残りを止めない（次の巡回で拾い直せる）。
      console.error(
        `[progress-sweep] ${repository.fullName}#${target.number} の ${CHECK_USER_LABEL} 除去:`,
        error,
      );
      params.countSkip("action_failed");
    }
  }

  return actions;
}

/**
 * タイトルが`[手作業]`で始まるのに`71.manual-step`が付いていないopenなIssueへ、ラベルを付け直す。
 *
 * `manual-step-label`ジョブのschedule分（#2010の埋め直し）にあたる。**イベントだけでは
 * 取りこぼす**——callerの`on: issues: types:`に`opened`が無い時期に起票されたIssueは
 * 後からイベントが再発火せず、永久に埋まらない。
 *
 * **探し先はissue-deckのDB。** GitHubの検索APIを引かずに済み、対象が無い平常時は
 * GitHubへのリクエストが1回も出ない。DBはWebhookと再同期で追随しており、ワークフローの
 * 有無とは無関係に埋まる。
 */
async function sweepManualStepLabels(params: {
  tokenFor: (installationId: number, cacheKey: string) => Promise<string>;
  countSkip: (reason: keyof ProgressSweepResult["skipped"]) => void;
}): Promise<ProgressSweepAction[]> {
  const targets = await db.issue.findMany({
    where: {
      state: "OPEN",
      title: { startsWith: "[手作業]" },
      labels: { none: { name: MANUAL_STEP_LABEL } },
      repository: { archived: false },
    },
    select: {
      number: true,
      title: true,
      repository: {
        select: {
          ownerLogin: true,
          name: true,
          fullName: true,
          installation: { select: { id: true, installationId: true } },
        },
      },
    },
    orderBy: { number: "asc" },
  });
  if (targets.length === 0) return [];

  const actions: ProgressSweepAction[] = [];
  // ラベル定義の有無はリポジトリごとに1回だけ確かめる。付与エンドポイントは存在しない
  // ラベル名をその場で作ってしまうため、配布前のリポジトリへ色も説明も無いラベルを生やさない。
  const definedLabels = new Map<string, Set<string> | null>();

  for (const target of targets) {
    const repository = target.repository;
    try {
      const token = await params.tokenFor(
        repository.installation.installationId,
        repository.installation.id,
      );
      let defined = definedLabels.get(repository.fullName);
      if (defined === undefined) {
        defined = await fetchRepositoryLabelNames(repository.ownerLogin, repository.name, token);
        definedLabels.set(repository.fullName, defined);
      }
      if (!defined?.has(MANUAL_STEP_LABEL)) continue;

      await addIssueLabels(repository.ownerLogin, repository.name, target.number, token, [
        MANUAL_STEP_LABEL,
      ]);
      actions.push({
        repositoryFullName: repository.fullName,
        issueNumber: target.number,
        kind: "manual_step_labeled",
      });
    } catch (error) {
      // 1件の失敗で残りを止めない（次の巡回で拾い直せる）。
      console.error(
        `[progress-sweep] ${repository.fullName}#${target.number} への ${MANUAL_STEP_LABEL} 付与:`,
        error,
      );
      params.countSkip("action_failed");
    }
  }

  return actions;
}
