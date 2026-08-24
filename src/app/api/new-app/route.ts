import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { GithubApiError } from "@/lib/github/github-api-error";
import { addSubIssue, createIssue } from "@/lib/github/issues-api";
import {
  openLocalPortBandPullRequest,
  planLocalPortBand,
  type LocalPortBandPlan,
} from "@/lib/github/local-port-band-api";
import {
  cloneRepositoryLabels,
  createOrgRepository,
  repositoryExists,
  setupDevelopBranch,
} from "@/lib/github/repositories-api";
import { fetchVpsUsage } from "@/lib/github/vps-inventory-api";
import { withUserGithubToken } from "@/lib/github/with-user-github-token";
import { resolveNewAppInstallationScope } from "@/lib/new-app/installation-scope";
import { parseNewAppSpec } from "@/lib/new-app/parse";
import {
  MANUAL_STEP_LABEL,
  buildBrowserManualIssueBody,
  buildBrowserManualIssueTitle,
  buildInitIssueBody,
  buildInitIssueTitle,
  buildParentIssueBody,
  buildParentIssueTitle,
  buildPortBandCommitMessage,
  buildPortBandPullRequestBody,
  buildPortBandPullRequestTitle,
  buildSubpcManualIssueBody,
  buildSubpcManualIssueTitle,
  buildVpsIssueBody,
  buildVpsIssueTitle,
  buildVpsManualIssueBody,
  buildVpsManualIssueTitle,
  portBandBranchName,
  repositoryFullName,
  type NewAppArtifactKind,
  type NewAppCreatedRef,
  type NewAppIssueRefs,
} from "@/lib/new-app/plan";
import { resyncNewRepository } from "@/lib/new-app/resync";
import {
  NEW_APP_ORG,
  NEW_APP_PARENT_REPOSITORY,
  NEW_APP_VPS_REPOSITORY,
  hostnameFor,
  validateNewAppSpec,
  type NewAppSpec,
} from "@/lib/new-app/spec";
import { isHostnameTaken } from "@/lib/new-app/vps-inventory";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 新規アプリの立ち上げを実行する（#2188）。
 *
 * **途中で失敗しても、作り終えたものは消さない。** 作成済みのリポジトリ・Issueを
 * `created`として返し、どこで止まったかを画面に出す。自動で消すと、名前だけ取られたのか
 * 何も起きていないのかが分からなくなる。**同じ内容での押し直しもしない**——リポジトリの
 * 作成で弾かれるので、続きは作られたIssueから人が進める。
 *
 * 作る順序はIssueの本文が互いを参照する都合で決まっている。
 * 親 → ポート帯のPR → サブPCの手作業 → ブラウザの手作業 → vpsのVirtualHost → VPSの手作業 → 初期化。
 *
 * **ローカルセッションのポート帯（#2225）だけは、何かを作る前に決めておく。**
 * `scripts/local-repo-ports.conf`を読めなければ`port_band_unavailable`で止める——
 * 帯を確保せずに立ち上げを終えると、汎用ランチャーの既定 `3000 + Issue番号` に落ちて
 * 未登録のリポジトリ同士でポートが衝突する（#2213で実際に漏れた）。まだ何も作っていない
 * 時点で止めるので、直してから押し直せる。**Pull Requestの作成そのものに失敗したときは
 * 止めない**——残りのIssueを作らずに終える方が損失が大きいので、`warnings`で画面へ返す。
 *
 * **最後に、作ったリポジトリとそのIssueを自分で取り込む**（#2248。`lib/new-app/resync.ts`）。
 * 設定の「リポジトリを再同期」→「Issueを再同期」を人が押す手順にしていたが、押し忘れると
 * 初期化Issueが画面に出ない（#2215で実際に押されていなかった）。ここも失敗では止めず、
 * `warnings`で「2つを手で押してください」と返す。
 */

type FailureReason =
  | "repository_taken"
  | "hostname_taken"
  | "port_band_unavailable"
  | "launch_failed";

type LaunchFailure = {
  step: NewAppArtifactKind;
  reason: FailureReason;
  message?: string;
};

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("new_app_launch", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const spec = parseNewAppSpec(payload?.spec);
  if (!spec) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const specErrors = validateNewAppSpec(spec);
  if (specErrors.length > 0) {
    return NextResponse.json({ error: "invalid_spec", details: specErrors }, { status: 400 });
  }

  const created: NewAppCreatedRef[] = [];
  const warnings: string[] = [];

  const result = await withUserGithubToken(user, "POST /api/new-app", async (token) => {
    try {
      return await launchNewApp(token, user.id, spec, created, warnings);
    } catch (error) {
      // 401だけは`withUserGithubToken`へトークンの更新を任せるため投げ直す
      if (error instanceof GithubApiError && error.status === 401) throw error;
      console.error("[POST /api/new-app]", error);
      const failure: LaunchFailure = {
        step: created.length > 0 ? created[created.length - 1].kind : "repository",
        reason: "launch_failed",
        message: error instanceof Error ? error.message : String(error),
      };
      return failure;
    }
  });

  if ("errorResponse" in result) {
    return result.errorResponse;
  }
  if (result.value) {
    return NextResponse.json(
      {
        error: result.value.reason,
        step: result.value.step,
        message: result.value.message,
        created,
        warnings,
      },
      { status: 409 },
    );
  }
  return NextResponse.json({ created, warnings });
}

/** 成功したら`null`、続けられない理由が分かっていれば`LaunchFailure`を返す。 */
async function launchNewApp(
  token: string,
  userId: string,
  spec: NewAppSpec,
  created: NewAppCreatedRef[],
  warnings: string[],
): Promise<LaunchFailure | null> {
  const [parentOwner, parentRepo] = NEW_APP_PARENT_REPOSITORY.split("/");
  const [vpsOwner, vpsRepo] = NEW_APP_VPS_REPOSITORY.split("/");

  // 押す前に見た状態から変わっていることがあるので、作る直前にもう一度確かめる
  if (await repositoryExists(NEW_APP_ORG, spec.repositoryName, token)) {
    return { step: "repository", reason: "repository_taken" };
  }
  const usage = await fetchVpsUsage(token);
  if (usage && spec.urlMode === "subdomain" && isHostnameTaken(hostnameFor(spec), usage.hostnames)) {
    return { step: "vps-issue", reason: "hostname_taken" };
  }

  const repo = repositoryFullName(spec);

  // ローカルセッションのポート帯は**何かを作る前に**決める。読めない・上限に達したなら
  // ここで止める（まだ何も作っていないので、直して押し直せる）
  let portBand: LocalPortBandPlan;
  try {
    portBand = await planLocalPortBand(token, repo);
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 401) throw error;
    console.error("[POST /api/new-app] ポート帯を決められませんでした", error);
    return {
      step: "port-band",
      reason: "port_band_unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // 1. リポジトリ
  const repository = await createOrgRepository(NEW_APP_ORG, token, {
    name: spec.repositoryName,
    description: spec.summary,
    private: spec.visibility === "private",
  });
  created.push({ kind: "repository", title: repo, reference: repo, url: repository.htmlUrl });
  await setupDevelopBranch(NEW_APP_ORG, spec.repositoryName, token, repository.defaultBranch);
  await cloneRepositoryLabels(
    { owner: parentOwner, repo: parentRepo },
    { owner: NEW_APP_ORG, repo: spec.repositoryName },
    token,
  );

  // GitHub Appのインストール対象への追加が要るかは、**Issueの本文を作る前に**決める（#2248）
  const installationScope = await resolveNewAppInstallationScope(userId);

  const refs: NewAppIssueRefs = {
    parent: "",
    vps: null,
    subpc: null,
    localPortBase: portBand.base,
    portBandPullRequest: null,
    githubAppNeedsRepositoryAdd: installationScope.needsRepositoryAdd,
  };

  const createIn = async (
    owner: string,
    name: string,
    kind: NewAppArtifactKind,
    title: string,
    body: string,
    labels?: string[],
  ) => {
    const issue = await createIssue(owner, name, token, { title, body, labels });
    const reference = `${owner}/${name}#${issue.number}`;
    created.push({ kind, title, reference, url: issue.html_url });
    return { id: issue.id, number: issue.number, reference };
  };

  // 2. 親Issue
  const parent = await createIn(
    parentOwner,
    parentRepo,
    "parent-issue",
    buildParentIssueTitle(spec),
    buildParentIssueBody(spec, {
      localPortBase: portBand.base,
      githubAppNeedsRepositoryAdd: installationScope.needsRepositoryAdd,
    }),
  );
  refs.parent = parent.reference;

  const children: number[] = [];

  // 3. ポート帯のPull Request。**ここの失敗では止めない**——残りのIssueを作らずに
  //    終える方が損失が大きい。帯の値は親Issueの本文に残るので手でも足せる
  if (portBand.alreadyListed) {
    warnings.push(
      `${repo} はすでに scripts/local-repo-ports.conf に載っていました（ベース値 ${portBand.base}）。Pull Requestは作っていません。`,
    );
  } else {
    try {
      const pull = await openLocalPortBandPullRequest(token, {
        branch: portBandBranchName(spec),
        repositoryFullName: repo,
        base: portBand.base,
        comment: `${spec.displayName}（${parent.reference}）。画面の「新規アプリを立ち上げる」が確保した帯。`,
        commitMessage: buildPortBandCommitMessage(spec, portBand.base),
        title: buildPortBandPullRequestTitle(spec, portBand.base),
        body: buildPortBandPullRequestBody(spec, portBand.base, refs),
        conf: portBand.conf,
      });
      refs.portBandPullRequest = pull.reference;
      created.push({
        kind: "port-band",
        title: buildPortBandPullRequestTitle(spec, portBand.base),
        reference: pull.reference,
        url: pull.htmlUrl,
      });
    } catch (error) {
      if (error instanceof GithubApiError && error.status === 401) throw error;
      console.error("[POST /api/new-app] ポート帯のPull Requestを作れませんでした", error);
      warnings.push(
        `ローカルセッションのポート帯（ベース値 ${portBand.base}）のPull Requestを作れませんでした。scripts/local-repo-ports.conf へ手で追記してください。`,
      );
    }
  }

  // 4. サブPCの手作業（初期化Issueがこれを前提条件に指す）
  const subpc = await createIn(
    parentOwner,
    parentRepo,
    "manual-subpc",
    buildSubpcManualIssueTitle(spec),
    buildSubpcManualIssueBody(spec, refs),
    [MANUAL_STEP_LABEL],
  );
  refs.subpc = subpc.reference;
  children.push(subpc.id);

  // 5. ブラウザの手作業
  const browser = await createIn(
    parentOwner,
    parentRepo,
    "manual-browser",
    buildBrowserManualIssueTitle(spec),
    buildBrowserManualIssueBody(spec, refs),
    [MANUAL_STEP_LABEL],
  );
  children.push(browser.id);

  // 6. vpsのVirtualHost（VPSの手作業Issueがこれを指す）
  const vps = await createIn(
    vpsOwner,
    vpsRepo,
    "vps-issue",
    buildVpsIssueTitle(spec),
    buildVpsIssueBody(spec, refs),
  );
  refs.vps = vps.reference;
  children.push(vps.id);

  // 7. VPSの手作業
  const vpsManual = await createIn(
    parentOwner,
    parentRepo,
    "manual-vps",
    buildVpsManualIssueTitle(spec),
    buildVpsManualIssueBody(spec, refs),
    [MANUAL_STEP_LABEL],
  );
  children.push(vpsManual.id);

  // 8. 新しいリポジトリの初期化
  const init = await createIn(
    NEW_APP_ORG,
    spec.repositoryName,
    "init-issue",
    buildInitIssueTitle(spec),
    buildInitIssueBody(spec, refs),
  );
  children.push(init.id);

  // 9. サブIssueとして紐付ける。**ここの失敗では止めない**——紐付きが欠けても
  //    各Issueは独立して読め、作り直しの必要が無い
  for (const childId of children) {
    try {
      await addSubIssue(parentOwner, parentRepo, parent.number, token, childId);
    } catch (error) {
      console.warn("[POST /api/new-app] サブIssueの紐付けに失敗しました", error);
    }
  }

  // 10. 作ったリポジトリとそのIssueを盤面へ取り込む（#2248）。**初期化Issueを作ったあとに
  //     置く**——先に回すとIssueがまだ無く、取り込むものが無い
  const resync = await resyncNewRepository(userId, NEW_APP_ORG, spec.repositoryName);
  if (!resync.ok) {
    warnings.push(
      `${repo} を画面へ取り込めませんでした（${resync.message}）。設定で「リポジトリを再同期」→「Issueを再同期」の順に押してください。`,
    );
  }

  return null;
}
