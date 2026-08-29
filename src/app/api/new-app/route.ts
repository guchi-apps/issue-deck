import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { GithubApiError } from "@/lib/github/github-api-error";
import { addSubIssue, createComment, createIssue } from "@/lib/github/issues-api";
import {
  openLocalPortBandPullRequest,
  planLocalPortBand,
  type LocalPortBandPlan,
} from "@/lib/github/local-port-band-api";
import { findExistingVpsLaunchIssue } from "@/lib/github/new-app-existing-issue";
import {
  cloneRepositoryLabels,
  createOrgRepository,
  repositoryExists,
  setupDevelopBranch,
} from "@/lib/github/repositories-api";
import { commitScaffoldFiles, resolveScaffoldCopies } from "@/lib/github/scaffold-api";
import { fetchVpsUsage } from "@/lib/github/vps-inventory-api";
import { withUserGithubToken } from "@/lib/github/with-user-github-token";
import { fetchLatestWorkflowTag } from "@/lib/github/workflow-tags";
import { resolveNewAppInstallationScope } from "@/lib/new-app/installation-scope";
import { decideLaunchError, type NewAppLaunchFailure } from "@/lib/new-app/launch-failure";
import { buildExistingLaunchIssueComment, withNewAppMarker } from "@/lib/new-app/launch-marker";
import { parseNewAppSpec } from "@/lib/new-app/parse";
import { buildScaffoldFiles, scaffoldCopies } from "@/lib/new-app/scaffold";
import {
  MANUAL_STEP_LABEL,
  buildBrowserManualIssueBody,
  buildBrowserManualIssueTitle,
  buildDeployCheckIssueBody,
  buildDeployCheckIssueTitle,
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
  type ScaffoldOutcome,
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
 * **この処理は非冪等なので、途中からやり直せない**（#2442）。`withUserGithubToken`は401を
 * 受けるとトークンを延長して`fn`を先頭から呼び直すため、1つでも作った後に401を投げ直すと
 * 立ち上げが丸ごと再実行され、先頭の`repositoryExists`が自分で作ったリポジトリを見つけて
 * 原因と食い違う`repository_taken`で終わる。**投げ直すのは`created`が空のときだけ**とし、
 * それ以外は`launch_failed`として`created`と一緒に返す（`lib/new-app/launch-failure.ts`）。
 *
 * 作る順序はIssueの本文が互いを参照する都合で決まっている。
 * リポジトリ → 雛形のコミット → 親 → ポート帯のPR → サブPCの手作業 →
 * （ブラウザの手作業） → vpsのVirtualHost → VPS受け入れの手作業 → 初期化
 *
 * **ブラウザの手作業は、GitHub Appのインストール対象への追加が要るときだけ作る**（#2246）。
 * DNSのAレコードとActions secretsの登録を外した結果、通常は中身が空になるため。
 *
 * **雛形のコミット（#2247）はリポジトリを作った直後、`develop`を切る前に行う。**
 * `claude-issue-dispatch.yml`がデフォルトブランチにあることが盤面へ載る条件で、それを
 * 初期化Issue自身が作っていたために、以前は初期化IssueだけがサブPCのローカルセッション
 * 専用になっていた。**ここの失敗では止めない**——雛形が無くても初期化Issueは実装できる
 * ので、`warnings`で画面へ返し、初期化Issueの本文を従来の（ローカルセッション前提の）
 * 書き方に切り替える
 * → 初回デプロイ前チェック（#2252。前提条件として初期化Issueの番号を指すので最後に置く）。
 *
 * **ローカルセッションのポート帯（#2225）だけは、何かを作る前に決めておく。**
 * `scripts/local-repo-ports.conf`を読めなければ`port_band_unavailable`で止める——
 * 帯を確保せずに立ち上げを終えると、汎用ランチャーの既定 `3000 + Issue番号` に落ちて
 * 未登録のリポジトリ同士でポートが衝突する（#2213で実際に漏れた）。まだ何も作っていない
 * 時点で止めるので、直してから押し直せる。**Pull Requestの作成そのものに失敗したときは
 * 止めない**——残りのIssueを作らずに終える方が損失が大きいので、`warnings`で画面へ返す。
 *
 * **`guchi-apps/vps`には、同じ対象のopenなIssueがあれば起票しない**（#2250）。`aide-bot`の
 * 立ち上げでは同じ作業のIssueが4件並んだ。見つかったときは新しく作らず、そのIssueへ
 * コメントを書き足して`refs.vps`をそちらへ向ける（`lib/new-app/launch-marker.ts`）。
 * 作るIssueの本文には、後から来たエージェントが判別できるよう不可視のマーカーを埋める。
 *
 * **最後に、作ったリポジトリとそのIssueを自分で取り込む**（#2248。`lib/new-app/resync.ts`）。
 * 設定の「リポジトリを再同期」→「Issueを再同期」を人が押す手順にしていたが、押し忘れると
 * 初期化Issueが画面に出ない（#2215で実際に押されていなかった）。ここも失敗では止めず、
 * `warnings`で「2つを手で押してください」と返す。
 */

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
      // **投げ直してよいのは、まだ何も作っていないときの401だけ**（#2442）。
      // `withUserGithubToken`は401を受けるとトークンを延長して`fn`を先頭から呼び直すが、
      // 立ち上げは非冪等なので、1つでも作った後に呼び直すと`repositoryExists`が自分で
      // 作ったリポジトリを見つけて`repository_taken`で終わる（判断は`decideLaunchError`）
      const decision = decideLaunchError(error, created);
      if (decision.rethrow) throw error;
      console.error("[POST /api/new-app]", error);
      return decision.failure;
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

/**
 * 成功したら`null`、続けられない理由が分かっていれば`NewAppLaunchFailure`を返す。
 *
 * **401はここでは判断せず、呼び出し元（`handlePOST`）へ投げ上げる。** 投げ直すか
 * `launch_failed`にするかは`created`が空かどうかで決まり、それを知っているのは呼び出し元
 * だけだから（#2442）。
 */
async function launchNewApp(
  token: string,
  userId: string,
  spec: NewAppSpec,
  created: NewAppCreatedRef[],
  warnings: string[],
): Promise<NewAppLaunchFailure | null> {
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
    // 401は`handlePOST`が「投げ直すか失敗として返すか」を決める（#2442）
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

  // **`develop`を切る前に置く。** ここで置いておけば、`main`と`develop`の両方が
  // 最初から雛形を持つ（`develop`はこのコミットから枝分かれする）
  const scaffold = await commitScaffold(token, spec, repository.defaultBranch, warnings);

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
    vpsManual: null,
    init: null,
    localPortBase: portBand.base,
    portBandPullRequest: null,
    githubAppNeedsRepositoryAdd: installationScope.needsRepositoryAdd,
  };

  // 立ち上げが作ったIssueだと後から機械的に分かるよう、本文の先頭へ印を埋める（#2250）
  const marked = (kind: NewAppArtifactKind, body: string, parent: string) =>
    withNewAppMarker(body, {
      app: spec.repositoryName,
      repo,
      host: spec.urlMode === "subdomain" ? hostnameFor(spec) : "",
      kind,
      parent,
    });

  const createIn = async (
    owner: string,
    name: string,
    kind: NewAppArtifactKind,
    title: string,
    body: string,
    labels?: string[],
  ) => {
    const issue = await createIssue(owner, name, token, {
      title,
      body: marked(kind, body, refs.parent),
      labels,
    });
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
      // 401は`handlePOST`が判断する（この時点ではリポジトリを作り終えているので、
      // 投げ直されず`launch_failed`になる。#2442）
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

  // 5. ブラウザの手作業。**残る手順があるときだけ作る**（#2246）。DNSのAレコードは
  //    `*.gucchii.com`のワイルドカードで済み（`guchi-apps/vps#131`）、Actions secretsは
  //    organizationに`visibility=all`で登録済み（#2255）。両方を外すと、`repository_selection`が
  //    `all`のときは中身が空になるので、空のIssueで人の着手を待たせない
  if (installationScope.needsRepositoryAdd) {
    const browser = await createIn(
      parentOwner,
      parentRepo,
      "manual-browser",
      buildBrowserManualIssueTitle(spec),
      buildBrowserManualIssueBody(spec, refs),
      [MANUAL_STEP_LABEL],
    );
    children.push(browser.id);
  }

  // 6. vpsのVirtualHost（VPSの手作業Issueがこれを指す）。**同じ対象のopenなIssueが
  //    あれば起票せず、そちらへコメントする**（#2250）
  const existingVps = await findExistingVpsLaunchIssue(token, {
    appName: spec.repositoryName,
    hostname: spec.urlMode === "subdomain" ? hostnameFor(spec) : null,
  });
  if (existingVps) {
    refs.vps = existingVps.reference;
    try {
      await createComment(vpsOwner, vpsRepo, existingVps.number, token, {
        body: buildExistingLaunchIssueComment({
          displayName: spec.displayName,
          repositoryFullName: repo,
          hostname: hostnameFor(spec),
          parent: refs.parent,
          reason: existingVps.reason,
        }),
      });
    } catch (error) {
      // 401は`handlePOST`が判断する（#2442）
      if (error instanceof GithubApiError && error.status === 401) throw error;
      console.warn("[POST /api/new-app] 既存Issueへコメントできませんでした", error);
    }
    // **サブIssueとしては紐付けない。** 既存Issueには別の親が付いていることがあり、
    // 付け替えると元の追跡が外れる。つながりはコメントのリンクで残す
    created.push({
      kind: "vps-issue",
      title: existingVps.title,
      reference: existingVps.reference,
      url: existingVps.url,
      existing: true,
    });
    warnings.push(
      `${NEW_APP_VPS_REPOSITORY} には同じ対象のIssue（${existingVps.reference}）が開いていたため、新しく作らずコメントを書き足しました。`,
    );
  } else {
    const vps = await createIn(
      vpsOwner,
      vpsRepo,
      "vps-issue",
      buildVpsIssueTitle(spec),
      buildVpsIssueBody(spec, refs),
    );
    refs.vps = vps.reference;
    children.push(vps.id);
  }

  // 7. VPSの手作業
  const vpsManual = await createIn(
    parentOwner,
    parentRepo,
    "manual-vps",
    buildVpsManualIssueTitle(spec),
    buildVpsManualIssueBody(spec, refs),
    [MANUAL_STEP_LABEL],
  );
  refs.vpsManual = vpsManual.reference;
  children.push(vpsManual.id);

  // 8. 新しいリポジトリの初期化
  const init = await createIn(
    NEW_APP_ORG,
    spec.repositoryName,
    "init-issue",
    buildInitIssueTitle(spec),
    buildInitIssueBody(spec, refs, scaffold),
  );
  refs.init = init.reference;
  children.push(init.id);

  // 9. 初回デプロイ前チェックと公開確認（#2252）。**初期化Issueの後に置く**——前提条件として
  //    その番号を指すため。deployジョブの成功では公開できたことを確かめられないので、
  //    公開URLの疎通まで見届ける担当をここで作る
  const deployCheck = await createIn(
    NEW_APP_ORG,
    spec.repositoryName,
    "deploy-check-issue",
    buildDeployCheckIssueTitle(spec),
    buildDeployCheckIssueBody(spec, refs),
  );
  children.push(deployCheck.id);

  // 10. サブIssueとして紐付ける。**ここの失敗では止めない**——紐付きが欠けても
  //    各Issueは独立して読め、作り直しの必要が無い
  for (const childId of children) {
    try {
      await addSubIssue(parentOwner, parentRepo, parent.number, token, childId);
    } catch (error) {
      console.warn("[POST /api/new-app] サブIssueの紐付けに失敗しました", error);
    }
  }

  // 11. 作ったリポジトリとそのIssueを盤面へ取り込む（#2248）。**初期化Issueを作ったあとに
  //     置く**——先に回すとIssueがまだ無く、取り込むものが無い
  const resync = await resyncNewRepository(userId, NEW_APP_ORG, spec.repositoryName);
  if (!resync.ok) {
    warnings.push(
      `${repo} を画面へ取り込めませんでした（${resync.message}）。設定で「リポジトリを再同期」→「Issueを再同期」の順に押してください。`,
    );
  }

  return null;
}

/**
 * 雛形一式を`main`へ1コミットで置く（#2247）。
 *
 * **参照タグを決められなければcallerを置かない。** 存在しないタグを指すcallerは、置いた
 * 瞬間から全イベントで失敗し続ける（`buildScaffoldFiles`が`workflowTag: null`で判断する）。
 *
 * **失敗しても立ち上げは止めない。** 戻り値が`null`なら、初期化Issueは従来どおり
 * 「サブPCのローカルセッションで実装する」形の本文になる。
 */
async function commitScaffold(
  token: string,
  spec: NewAppSpec,
  branch: string,
  warnings: string[],
): Promise<ScaffoldOutcome | null> {
  let workflowTag: string | null = null;
  try {
    workflowTag = await fetchLatestWorkflowTag(token);
  } catch (error) {
    // 401は`handlePOST`が判断する（#2442）
    if (error instanceof GithubApiError && error.status === 401) throw error;
    console.warn("[POST /api/new-app] 共有ワークフローの最新タグを読めませんでした", error);
  }
  if (!workflowTag) {
    warnings.push(
      "共有ワークフローの最新タグ（workflows/vN）を読めなかったため、caller（issue-labels.yml・claude-issue-dispatch.yml など）は置いていません。初期化Issueで手動配置するか、issue-deckの画面（設定＞フリート運用）から配ってください。",
    );
  }

  const generated = buildScaffoldFiles(spec, { workflowTag });
  const copies = await resolveScaffoldCopies(token, spec, scaffoldCopies(spec));
  for (const problem of copies.problems) {
    warnings.push(`雛形の ${problem}。初期化Issueで置いてください。`);
  }

  const files = [...generated, ...copies.files];
  if (files.length === 0) return null;

  try {
    await commitScaffoldFiles(NEW_APP_ORG, spec.repositoryName, token, {
      branch,
      message: `${spec.displayName}の雛形一式を追加する。`,
      files,
    });
    return { paths: files.map((file) => file.path).sort(), workflowTag };
  } catch (error) {
    // 401は`handlePOST`が判断する（#2442）
    if (error instanceof GithubApiError && error.status === 401) throw error;
    console.error("[POST /api/new-app] 雛形をコミットできませんでした", error);
    warnings.push(
      `雛形一式をコミットできませんでした（${error instanceof Error ? error.message : String(error)}）。初期化IssueはサブPCのローカルセッションで実装してください。`,
    );
    return null;
  }
}
