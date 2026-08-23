import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { GithubApiError } from "@/lib/github/github-api-error";
import { addSubIssue, createIssue } from "@/lib/github/issues-api";
import {
  cloneRepositoryLabels,
  createOrgRepository,
  repositoryExists,
  setupDevelopBranch,
} from "@/lib/github/repositories-api";
import { fetchVpsUsage } from "@/lib/github/vps-inventory-api";
import { withUserGithubToken } from "@/lib/github/with-user-github-token";
import { parseNewAppSpec } from "@/lib/new-app/parse";
import {
  MANUAL_STEP_LABEL,
  buildBrowserManualIssueBody,
  buildBrowserManualIssueTitle,
  buildInitIssueBody,
  buildInitIssueTitle,
  buildParentIssueBody,
  buildParentIssueTitle,
  buildSubpcManualIssueBody,
  buildSubpcManualIssueTitle,
  buildVpsIssueBody,
  buildVpsIssueTitle,
  buildVpsManualIssueBody,
  buildVpsManualIssueTitle,
  repositoryFullName,
  type NewAppArtifactKind,
  type NewAppCreatedRef,
  type NewAppIssueRefs,
} from "@/lib/new-app/plan";
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
 * 親 → サブPCの手作業 → ブラウザの手作業 → vpsのVirtualHost → VPSの手作業 → 初期化。
 */

type FailureReason = "repository_taken" | "hostname_taken" | "launch_failed";

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

  const result = await withUserGithubToken(user, "POST /api/new-app", async (token) => {
    try {
      return await launchNewApp(token, spec, created);
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
      },
      { status: 409 },
    );
  }
  return NextResponse.json({ created });
}

/** 成功したら`null`、続けられない理由が分かっていれば`LaunchFailure`を返す。 */
async function launchNewApp(
  token: string,
  spec: NewAppSpec,
  created: NewAppCreatedRef[],
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

  const refs: NewAppIssueRefs = { parent: "", vps: null, subpc: null };

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
    buildParentIssueBody(spec),
  );
  refs.parent = parent.reference;

  const children: number[] = [];

  // 3. サブPCの手作業（初期化Issueがこれを前提条件に指す）
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

  // 4. ブラウザの手作業
  const browser = await createIn(
    parentOwner,
    parentRepo,
    "manual-browser",
    buildBrowserManualIssueTitle(spec),
    buildBrowserManualIssueBody(spec, refs),
    [MANUAL_STEP_LABEL],
  );
  children.push(browser.id);

  // 5. vpsのVirtualHost（VPSの手作業Issueがこれを指す）
  const vps = await createIn(
    vpsOwner,
    vpsRepo,
    "vps-issue",
    buildVpsIssueTitle(spec),
    buildVpsIssueBody(spec, refs),
  );
  refs.vps = vps.reference;
  children.push(vps.id);

  // 6. VPSの手作業
  const vpsManual = await createIn(
    parentOwner,
    parentRepo,
    "manual-vps",
    buildVpsManualIssueTitle(spec),
    buildVpsManualIssueBody(spec, refs),
    [MANUAL_STEP_LABEL],
  );
  children.push(vpsManual.id);

  // 7. 新しいリポジトリの初期化
  const init = await createIn(
    NEW_APP_ORG,
    spec.repositoryName,
    "init-issue",
    buildInitIssueTitle(spec),
    buildInitIssueBody(spec, refs),
  );
  children.push(init.id);

  // 8. サブIssueとして紐付ける。**ここの失敗では止めない**——紐付きが欠けても
  //    各Issueは独立して読め、作り直しの必要が無い
  for (const childId of children) {
    try {
      await addSubIssue(parentOwner, parentRepo, parent.number, token, childId);
    } catch (error) {
      console.warn("[POST /api/new-app] サブIssueの紐付けに失敗しました", error);
    }
  }

  return null;
}
