import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/github-api-error";
import { githubGraphql } from "@/lib/github/graphql";
import { fetchLatestWorkflowRun } from "@/lib/github/release-api";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import {
  canStartPropagation,
  canStartRepairPropagation,
  evaluateWorkflowTags,
  findRepairWorkflowPullRequest,
  extractWorkflowTagRef,
  findWorkflowTagPullRequest,
  latestWorkflowTag,
  parseWorkflowTagVersion,
  propagationTargets,
  repairPropagationTargets,
  type PropagationRun,
  type WorkflowTagPullRequest,
  type WorkflowTagRef,
  type WorkflowTagStatus,
} from "@/lib/workflow-tags";

/**
 * 各リポジトリが参照している共有ワークフローのタグを集めて、issue-deck 側の最新タグと
 * 突き合わせる（#985）。
 *
 * **なぜ要るか。** 共有ワークフローは `uses:` のタグ固定で配っており、issue-deck 側を
 * 直しても各リポジトリの caller を上げるまで反映されない。**上げ忘れても何も起きないので
 * 気づけない。** 実際 `workflows/v10` は car-care だけに配られ、他9リポジトリは v9 のまま
 * 数時間放置されていた（#1147 の修正が届いていない状態）。
 *
 * **取得はGraphQLでまとめて行う（#1503）。** 元はRESTで「`.github/workflows/`の一覧」＋
 * 「ファイルごとの内容」を順に読んでおり、リポジトリあたり 1 + ワークフロー数、実測で
 * 141リクエスト・42秒かかっていた。画面を開くたびにこれだけ待たされるうえ、その42秒の
 * どこかで1回でも失敗すればパネル全体が「取得に失敗しました」になる（本番では 503 になった）。
 * GraphQLはTreeのentriesからBlobの`text`まで1往復で取れるため、同じ情報が
 * **クエリ数本・数秒**で揃う。RESTのレート制限も消費しない（GraphQLは別枠）。
 */

/** 共有ワークフローのタグを探す先。issue-deck 自身のリポジトリ */
const SOURCE_REPOSITORY = "guchi-apps/issue-deck";

/** 1度に取るタグ数。`workflows/v*` は多くないため1ページで足りる想定 */
const TAG_PAGE_SIZE = 100;

/**
 * 1本のGraphQLクエリに載せるリポジトリ数。
 *
 * 1本にまとめるほど往復は減るが、クエリが長くなるほどGitHub側の実行時間も伸びる。
 * 15リポジトリを1本で投げても約3秒で返ることは確認済みで、余裕を見てこの値にしている。
 */
const REPOSITORIES_PER_QUERY = 10;

export type WorkflowTagOverview = {
  /** issue-deck 側の最新タグ。取得に失敗した場合は null */
  latest: string | null;
  repositories: WorkflowTagStatus[];
  /**
   * 配布ワークフロー（`propagate-workflow-tag.yml`）の最新の実行。1度も動いていなければ null。
   *
   * **押したあとの状態を画面へ残すために取る**（#1602）。実行中は更新ボタンを無効にし、
   * 画面を開き直しても・別のタブからでも同じ判断ができるようにする。
   */
  propagation: PropagationRun | null;
  /**
   * 不足しているcallerの配布（`propagate-repair-workflows.yml`）の最新の実行（#1948・#1475）。
   *
   * タグ配布とは別のrunなので分けて持つ。**同時に走っても互いを妨げない**——タグ配布は
   * 既存callerのsed置換、こちらは新しいcallerの追加で、触るファイルが重ならない。
   */
  repairPropagation: PropagationRun | null;
};

/** GraphQLで読む対象リポジトリ（DBから引いた行のうち、問い合わせに要る項目だけ） */
type TargetRepository = {
  fullName: string;
  ownerLogin: string;
  name: string;
  defaultBranch: string;
};

/** `.github/workflows/` 直下のエントリ（Treeのentries） */
type TreeEntry = {
  name: string;
  type: string;
  object: { text?: string | null } | null;
};

/** GraphQLで一緒に読むopenなPull Request（更新PRが既に有るかの判定に使う） */
type OpenPullRequest = { number: number; title: string; url: string };

/** エイリアス1つぶんの応答。ディレクトリが無ければ `object` が null になる */
type RepositoryEntry = {
  object: { entries?: TreeEntry[] | null } | null;
  pullRequests?: { nodes?: (OpenPullRequest | null)[] | null } | null;
} | null;

/** 1リポジトリぶんの読み取り結果 */
type RepositoryRefs = {
  refs: WorkflowTagRef[];
  /**
   * `.github/workflows/`直下のファイル名一覧（#1948）。配布対象のcallerが置かれているかは
   * **中身ではなくファイルの実在**で決まるため、参照タグの解析と同じ応答から拾える。
   */
  files: string[];
  pullRequests: OpenPullRequest[];
};

/**
 * 1リポジトリから読むopenなPRの件数。
 *
 * 更新PRを見つけるのが目的で、タイトルで絞り込めないため一定件数を読んで突き合わせる。
 * フリートのリポジトリで同時に開いているPRはせいぜい数件のため、この数で足りる。
 */
const OPEN_PULL_REQUESTS_PER_REPOSITORY = 30;

/**
 * issue-deck のタグ一覧から最新の `workflows/vN` を取る。
 *
 * **タグ名の昇順だと `workflows/v9` が `workflows/v10` より後ろに来る**ため、
 * 100件で切れたときに新しいタグを取りこぼさないようタグの日付降順で取る
 * （どれが最新かの判定自体は `latestWorkflowTag` が版数で行う）。
 */
async function fetchLatestTag(token: string): Promise<string | null> {
  const [owner, name] = SOURCE_REPOSITORY.split("/");
  const query = `query($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) {
      refs(
        refPrefix: "refs/tags/"
        query: "workflows/"
        first: $first
        orderBy: { field: TAG_COMMIT_DATE, direction: DESC }
      ) {
        nodes { name }
      }
    }
  }`;

  type Data = { repository: { refs: { nodes: { name: string }[] } | null } | null };
  try {
    const data = await githubGraphql<Data>(
      token,
      query,
      { owner, name, first: TAG_PAGE_SIZE },
      "共有ワークフローの最新タグ取得",
    );
    return latestWorkflowTag((data.repository?.refs?.nodes ?? []).map((node) => node.name));
  } catch (error) {
    // 最新タグが分からなくても一覧自体は出す。latest が null なら「古い」判定を行わないため、
    // 誤って全リポジトリを更新対象として表示してしまうことはない
    console.warn(`[workflow-tags] 最新タグを取得できませんでした: ${String(error)}`);
    return null;
  }
}

/**
 * 複数リポジトリの caller を1本のGraphQLクエリでまとめて読む。
 *
 * リポジトリごとにエイリアス（`r0`・`r1`…）を並べ、`.github/workflows` のTreeから
 * 各Blobの`text`まで一度に取る。**共有ワークフローを参照していないファイル
 * （`ci.yml`・`deploy.yml` 等）も本文を見ないと判別できない**が、GraphQLなら
 * 追加の往復無しでまとめて返るため、RESTのようにファイル数ぶん往復せずに済む。
 *
 * **openなPRも同じクエリで読む**（#1602）。更新PRが既に有るリポジトリを配布の対象から
 * 外すため。検索API（`search`）を使わないのは、**インデックスの反映が遅れて
 * 作ったばかりのPRを取りこぼす**ため——それでは連続押下の防止にならない。
 */
async function fetchRefsBatch(
  targets: TargetRepository[],
  token: string,
): Promise<Map<string, RepositoryRefs>> {
  const declarations = targets
    .map(
      (_, index) =>
        `$owner${index}: String!, $name${index}: String!, $expression${index}: String!`,
    )
    .join(", ");
  const selections = targets
    .map(
      (_, index) => `  r${index}: repository(owner: $owner${index}, name: $name${index}) {
    object(expression: $expression${index}) {
      ... on Tree { entries { name type object { ... on Blob { text } } } }
    }
    pullRequests(states: OPEN, first: ${OPEN_PULL_REQUESTS_PER_REPOSITORY}, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { number title url }
    }
  }`,
    )
    .join("\n");

  const variables: Record<string, unknown> = {};
  targets.forEach((target, index) => {
    variables[`owner${index}`] = target.ownerLogin;
    variables[`name${index}`] = target.name;
    variables[`expression${index}`] = `${target.defaultBranch}:.github/workflows`;
  });

  const data = await githubGraphql<Record<string, RepositoryEntry>>(
    token,
    `query(${declarations}) {\n${selections}\n}`,
    variables,
    "共有ワークフローの参照タグ取得",
    // 1リポジトリが読めなくても（DBに残っている削除済みリポジトリなど）残りは表示する
    { allowPartialData: true },
  );

  const refsByRepository = new Map<string, RepositoryRefs>();
  targets.forEach((target, index) => {
    const repository = data[`r${index}`];
    const entries = repository?.object?.entries ?? [];
    const refs: WorkflowTagRef[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.type !== "blob" || !entry.name.endsWith(".yml")) continue;
      files.push(entry.name);
      // バイナリや巨大ファイルでは text が null になる。ワークフローYAMLでは起こらない想定
      if (typeof entry.object?.text !== "string") continue;

      const ref = extractWorkflowTagRef(entry.name, entry.object.text);
      if (ref) refs.push(ref);
    }

    const pullRequests = (repository?.pullRequests?.nodes ?? []).filter(
      (node): node is OpenPullRequest => node !== null,
    );
    refsByRepository.set(target.fullName, { refs, files, pullRequests });
  });
  return refsByRepository;
}

/**
 * 対象リポジトリすべての参照状況を集める。
 *
 * 対象は**マルチエージェント対応かつアーカイブ済みでない**リポジトリ（既存の再同期と同じ条件）。
 * issue-deck 自身はローカルパス参照（`uses: ./.github/workflows/...`）でタグを持たないため、
 * 参照が見つからず結果に現れない。
 */
export async function collectWorkflowTags(userId: string): Promise<WorkflowTagOverview> {
  const repositories = await db.repository.findMany({
    where: {
      hasClaudeWorkflow: true,
      archived: false,
      installation: { userInstallations: { some: { userId } } },
    },
    select: {
      fullName: true,
      ownerLogin: true,
      name: true,
      defaultBranch: true,
      installation: { select: { installationId: true } },
    },
    orderBy: { fullName: "asc" },
  });

  if (repositories.length === 0) {
    return { latest: null, repositories: [], propagation: null, repairPropagation: null };
  }

  // インストールごとにトークンを取り直す。1ユーザーが複数インストールを持つことがある
  const tokens = new Map<number, string>();
  const tokenFor = async (installationId: number): Promise<string> => {
    const cached = tokens.get(installationId);
    if (cached) return cached;
    const token = await getInstallationToken(installationId);
    tokens.set(installationId, token);
    return token;
  };

  const firstToken = await tokenFor(repositories[0]!.installation.installationId);
  const latest = await fetchLatestTag(firstToken);

  // トークンはインストール単位なので、1本のクエリに混ぜられるのは同じインストールのぶんだけ
  const byInstallation = new Map<number, TargetRepository[]>();
  for (const repository of repositories) {
    const installationId = repository.installation.installationId;
    const targets = byInstallation.get(installationId) ?? [];
    targets.push(repository);
    byInstallation.set(installationId, targets);
  }

  const refsByRepository = new Map<string, RepositoryRefs>();
  for (const [installationId, targets] of byInstallation) {
    const token = await tokenFor(installationId);
    for (let start = 0; start < targets.length; start += REPOSITORIES_PER_QUERY) {
      const chunk = targets.slice(start, start + REPOSITORIES_PER_QUERY);
      const refs = await fetchRefsBatch(chunk, token);
      for (const [fullName, value] of refs) refsByRepository.set(fullName, value);
    }
  }

  const statuses: WorkflowTagStatus[] = [];
  for (const repository of repositories) {
    const result = refsByRepository.get(repository.fullName);
    // 共有ワークフローを参照していないリポジトリは表示しても意味がないため落とす
    if (!result || result.refs.length === 0) continue;

    const updatePullRequest: WorkflowTagPullRequest | null = findWorkflowTagPullRequest(
      result.pullRequests,
      latest,
    );
    statuses.push(
      evaluateWorkflowTags(repository.fullName, result.refs, latest, updatePullRequest, {
        files: result.files,
        pullRequest: findRepairWorkflowPullRequest(result.pullRequests),
      }),
    );
  }

  const [propagation, repairPropagation] = await Promise.all([
    fetchPropagationRun(firstToken, PROPAGATE_WORKFLOW_FILE),
    fetchPropagationRun(firstToken, PROPAGATE_REPAIR_WORKFLOW_FILE),
  ]);

  return { latest, repositories: statuses, propagation, repairPropagation };
}

/**
 * 配布ワークフローの最新の実行を取る。**取れなくても一覧は出す**（実行状態が分からない
 * だけで、参照タグの状況は独立して読めるため）。
 */
async function fetchPropagationRun(
  token: string,
  workflowFile: string,
): Promise<PropagationRun | null> {
  const [owner, repo] = SOURCE_REPOSITORY.split("/");
  try {
    const run = await fetchLatestWorkflowRun(owner!, repo!, workflowFile, token);
    if (!run) return null;
    return {
      status: run.status,
      conclusion: run.conclusion,
      htmlUrl: run.htmlUrl,
      createdAt: run.createdAt,
    };
  } catch (error) {
    console.warn(`[workflow-tags] 配布ワークフローの実行を取得できませんでした: ${String(error)}`);
    return null;
  }
}

/** タグ更新PRを一括作成するワークフロー（issue-deck 側） */
const PROPAGATE_WORKFLOW_FILE = "propagate-workflow-tag.yml";

/** 不足している自動修復callerを配るワークフロー（issue-deck 側。#1948） */
const PROPAGATE_REPAIR_WORKFLOW_FILE = "propagate-repair-workflows.yml";

export type CreateWorkflowTagResult = {
  created: boolean;
  /** 切ったタグ。既に存在した場合もそのタグ名を返す */
  tag: string | null;
  /** タグが指すコミット（短縮なし） */
  sha: string | null;
  reason?: "no_latest" | "already_exists" | "not_synced";
  message?: string;
};

/**
 * 次の版数のタグを `main` に切る（#1876）。
 *
 * **配布はここまで自動化されていて、残っていたのはこの1操作だけだった。** タグを切るためだけに
 * `71.manual-step` のIssueが v20・v21・v22 と毎回起票されていた（#1739・#1795・#1870）。
 *
 * **`main` に対して切る。** `develop` の内容を配ると、まだ本番へ出ていないワークフローが
 * 全リポジトリで走り出す。参照するのは `main` の先端で、`develop` は見ない。
 *
 * **人の確認点は残す。** 「配るタグは人の確認を通してから切る」という運用
 * （`.github/workflows/propagate-workflow-tag.yml` のコメント）は、画面のボタンを押す行為で
 * 満たされる。自動では切らない。
 */
export async function createNextWorkflowTag(userId: string): Promise<CreateWorkflowTagResult> {
  const overview = await collectWorkflowTags(userId);
  if (!overview.latest) {
    return {
      created: false,
      tag: null,
      sha: null,
      reason: "no_latest",
      message: "issue-deck側の最新タグを取得できませんでした。",
    };
  }

  const current = parseWorkflowTagVersion(overview.latest);
  if (current === null) {
    return {
      created: false,
      tag: overview.latest,
      sha: null,
      reason: "no_latest",
      message: `最新タグの版数を読めません（${overview.latest}）。`,
    };
  }
  const next = `workflows/v${current + 1}`;

  const [owner, repo] = SOURCE_REPOSITORY.split("/");
  const source = await db.repository.findFirst({
    where: { fullName: SOURCE_REPOSITORY },
    select: { installation: { select: { installationId: true } } },
  });
  if (!source) {
    return {
      created: false,
      tag: next,
      sha: null,
      reason: "not_synced",
      message: `${SOURCE_REPOSITORY} が同期されていません。`,
    };
  }

  const token = await getInstallationToken(source.installation.installationId);

  // **`main` の先端を取る。** ここを `develop` にすると、本番へ出ていない内容が配られる
  const headRes = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/commits/main`, token);
  if (!headRes.ok) {
    const detail = await headRes.text().catch(() => "");
    throw new GithubApiError(
      headRes.status,
      `GitHub API request failed: ${headRes.status} commits/main ${detail}`,
    );
  }
  const head = (await headRes.json()) as { sha?: string };
  if (!head.sha) {
    return {
      created: false,
      tag: next,
      sha: null,
      reason: "not_synced",
      message: "mainの先端を取得できませんでした。",
    };
  }

  const res = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs`, token, {
    method: "POST",
    body: { ref: `refs/tags/${next}`, sha: head.sha },
  });

  // 既に同じタグがある（二重クリック・別タブからの操作）。**エラーにはしない**——
  // 呼び出し側はこのあと配布へ進むので、狙った版数が存在していれば目的は果たせている
  if (res.status === 422) {
    return {
      created: false,
      tag: next,
      sha: head.sha,
      reason: "already_exists",
      message: `${next} は既に存在します。`,
    };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(
      res.status,
      `GitHub API request failed: ${res.status} git/refs ${detail}`,
    );
  }

  return { created: true, tag: next, sha: head.sha };
}

export type DispatchPropagationResult = {
  dispatched: boolean;
  tag: string | null;
  repositories: string[];
  /** 起動しなかった理由。`running`のときだけ呼び出し側が409にする */
  reason?: "running" | "no_targets" | "no_tag";
  message?: string;
};

/**
 * 更新が必要なリポジトリへ、タグを上げるPRを作るワークフローを起動する（#1173）。
 *
 * **対象はここ（DBを持つissue-deck側）で決めて渡す。** ワークフロー側で再検知すると、
 * 画面に出ている一覧と実際の対象がずれる。
 *
 * 起動するだけで、PRの作成自体はActions側が行う。ローカルのチェックアウトに依存せず、
 * 同じ処理を手動起動でも使えるようにするため。
 *
 * **二重起動はここで止める**（#1602）。画面のボタンを無効にするだけでは、リロード後や
 * 別のタブからは押せてしまう。実行中かどうかの正はGitHub側のrunなので、それを見て断る。
 * 更新PRが既にopenのリポジトリを対象から外すのも同じ理由で、仮に起動が重なっても
 * 同じリポジトリへ2本目のPRは作られない。
 *
 * `autoMerge`が真のとき、配布先ではIssueを作らずPRだけを作り、CI通過後に自動マージする
 * （`.github/scripts/propagate-workflow-tag.sh`）。
 */
export async function dispatchPropagation(
  userId: string,
  autoMerge: boolean,
): Promise<DispatchPropagationResult> {
  const overview = await collectWorkflowTags(userId);
  if (!overview.latest) {
    return {
      dispatched: false,
      tag: null,
      repositories: [],
      reason: "no_tag",
      message: "issue-deck側の最新タグを取得できませんでした。",
    };
  }

  const decision = canStartPropagation(overview.propagation);
  if (!decision.allowed) {
    return {
      dispatched: false,
      tag: overview.latest,
      repositories: [],
      reason: decision.reason,
      message: decision.message,
    };
  }

  const targets = propagationTargets(overview.repositories).map((status) => status.fullName);

  // 対象が無いのに起動すると、何もしないrunが履歴に残って紛らわしい
  if (targets.length === 0) {
    return { dispatched: false, tag: overview.latest, repositories: [], reason: "no_targets" };
  }

  const [owner, repo] = SOURCE_REPOSITORY.split("/");
  const source = await db.repository.findFirst({
    where: { fullName: SOURCE_REPOSITORY },
    select: { installation: { select: { installationId: true } } },
  });
  if (!source) {
    throw new Error(`${SOURCE_REPOSITORY} が同期されていません`);
  }

  const token = await getInstallationToken(source.installation.installationId);
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${PROPAGATE_WORKFLOW_FILE}/dispatches`;
  const res = await githubFetch(url, token, {
    method: "POST",
    body: {
      ref: "main",
      inputs: {
        tag: overview.latest,
        repositories: JSON.stringify(targets),
        // workflow_dispatchのinputsは文字列で渡す（booleanのinputでも"true"/"false"）
        auto_merge: autoMerge ? "true" : "false",
      },
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }

  return { dispatched: true, tag: overview.latest, repositories: targets };
}

export type DispatchRepairPropagationResult = {
  dispatched: boolean;
  /** 配布先とファイルの組。画面の件数表示にそのまま使う */
  targets: { repository: string; workflows: string[] }[];
  /** 起動しなかった理由。`running`のときだけ呼び出し側が409にする */
  reason?: "running" | "no_targets";
  message?: string;
};

/**
 * 置かれていないcallerが有るリポジトリへ、それを追加するPRを作るワークフローを起動する（#1948・#1475）。
 *
 * **なぜ要るか。** 画面の「コンフリクトを自動解消」「CI失敗を自動修正」は
 * `workflow_dispatch`でcallerを起動するため、callerが無いリポジトリでは押しても
 * 404で何も起きない。実測ではフリートのうち3リポジトリしか持っていなかった。
 *
 * **対象はここ（DBを持つissue-deck側）で決めて渡す。** ワークフロー側で再検知すると、
 * 画面に出ている一覧と実際の対象がずれる（タグ配布と同じ方針）。
 *
 * **自動マージはしない。** 配るのは新しいワークフローファイルそのもので、
 * `@workflows/vN`の機械的な置換（#1602で自動マージの例外にしたもの）とは別物のため、
 * 各リポジトリのPRは人が確認してマージする。
 */
export async function dispatchRepairPropagation(
  userId: string,
): Promise<DispatchRepairPropagationResult> {
  const overview = await collectWorkflowTags(userId);

  const decision = canStartRepairPropagation(overview.repairPropagation);
  if (!decision.allowed) {
    return { dispatched: false, targets: [], reason: decision.reason, message: decision.message };
  }

  const targets = repairPropagationTargets(overview.repositories).map((status) => ({
    repository: status.fullName,
    workflows: status.missingRepairWorkflows,
  }));

  // 対象が無いのに起動すると、何もしないrunが履歴に残って紛らわしい
  if (targets.length === 0) {
    return { dispatched: false, targets: [], reason: "no_targets" };
  }

  const [owner, repo] = SOURCE_REPOSITORY.split("/");
  const source = await db.repository.findFirst({
    where: { fullName: SOURCE_REPOSITORY },
    select: { installation: { select: { installationId: true } } },
  });
  if (!source) {
    throw new Error(`${SOURCE_REPOSITORY} が同期されていません`);
  }

  const token = await getInstallationToken(source.installation.installationId);
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${PROPAGATE_REPAIR_WORKFLOW_FILE}/dispatches`;
  const res = await githubFetch(url, token, {
    method: "POST",
    // 配布処理・雛形は`main`のものを使う（配るワークフローはタグ配布と揃えて本番の内容にする）
    body: { ref: "main", inputs: { targets: JSON.stringify(targets) } },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(
      res.status,
      `GitHub API request failed: ${res.status} ${url} ${detail}`,
    );
  }

  return { dispatched: true, targets };
}
