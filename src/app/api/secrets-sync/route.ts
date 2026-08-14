import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { GithubApiError } from "@/lib/github/github-api-error";
import { dispatchWorkflow } from "@/lib/github/workflow-dispatch";
import { previewModeGuard } from "@/lib/preview-mode";
import {
  canStartSecretsSync,
  normalizeOnlyKeys,
  SECRETS_SYNC_WORKFLOW_FILE,
  type SecretSyncRunView,
} from "@/lib/secrets-sync";
import {
  createQueuedSecretSyncRun,
  expireStaleSecretSyncRuns,
  failSecretSyncRun,
  findLatestSecretSyncRun,
  findLatestSecretSyncRuns,
} from "@/lib/secrets-sync-runs";

/**
 * 1Password → GitHub のシークレット同期を画面のボタンから起こす（#1309）。
 *
 * **issue-deckはsecretを書かない。** ここがするのは対象リポジトリの`sync-secrets.yml`を
 * `workflow_dispatch`で起動することだけで、1Passwordの読み取りもGitHubへの書き込みも
 * 対象リポジトリのActionsの中で完結する。issue-deckに要る権限は既にあるワークフロー起動の
 * ぶんだけで、Secrets書き込み権限は持たない（設計の理由は
 * docs/cross-repo-automation.md・.github/workflows/reusable-sync-secrets.yml）。
 */
export function GET() {
  return withGithubApiFeature("secrets_sync", () => handleGET());
}

type RepositoryStatus = {
  fullName: string;
  latestRun: SecretSyncRunView | null;
};

async function handleGET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 報告が来ないまま固まった実行をここで倒す。定期実行を持たない遅延評価
  await expireStaleSecretSyncRuns();

  const repositories = await db.repository.findMany({
    where: {
      hasClaudeWorkflow: true,
      archived: false,
      installation: { userInstallations: { some: { userId } } },
    },
    select: { fullName: true },
    orderBy: { fullName: "asc" },
  });

  const latest = await findLatestSecretSyncRuns(repositories.map((r) => r.fullName));
  const result: RepositoryStatus[] = repositories.map((repository) => ({
    fullName: repository.fullName,
    latestRun: latest[repository.fullName] ?? null,
  }));

  return NextResponse.json(
    { repositories: result },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("secrets_sync", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body: { owner?: string; repo?: string; only?: string } = await request
    .json()
    .catch(() => ({}));
  const { owner, repo } = body;

  if (!owner || !repo) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // 不正な指定は起動前に弾く。起動してから落ちると、押した側には理由が見えない
  const only = normalizeOnlyKeys(body.only);
  if (only === null) {
    return NextResponse.json(
      {
        error: "invalid_only",
        message:
          "対象キーの指定が不正です（英大文字・数字・アンダースコアをカンマ区切りで指定してください）。",
      },
      { status: 400 },
    );
  }

  const fullName = `${owner}/${repo}`;
  const repository = await db.repository.findFirst({
    where: {
      fullName,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await expireStaleSecretSyncRuns();

  // 二重起動とクールダウンの判定。**1Passwordの日次枠を守るための入口はここ**
  const latest = await findLatestSecretSyncRun(fullName);
  const decision = canStartSecretsSync(latest, new Date());
  if (!decision.allowed) {
    return NextResponse.json(
      { error: decision.reason, message: decision.message },
      { status: 409 },
    );
  }

  const run = await createQueuedSecretSyncRun({
    repositoryFullName: fullName,
    only,
    requestedByUserId: userId,
  });

  try {
    // **GitHub Appの認証はPOSTのときだけ読み込む。** `lib/github/app-auth.ts`は読み込み時点で
    // `GITHUB_APP_PRIVATE_KEY_BASE64`を要求するため、静的にimportすると同じファイルにある
    // GETまで資格情報を要求することになる（DBを読むだけの一覧に、起動用の資格情報は要らない）。
    // `lib/dispatch/pending-dispatch.ts`をIssue一覧から分けているのと同じ理由。
    const { getInstallationToken } = await import("@/lib/github/app-auth");
    const token = await getInstallationToken(repository.installation.installationId);
    await dispatchWorkflow(
      owner,
      repo,
      SECRETS_SYNC_WORKFLOW_FILE,
      repository.defaultBranch,
      { only },
      token,
    );
    return NextResponse.json({ ok: true, run });
  } catch (error) {
    // ワークフローがそのリポジトリのデフォルトブランチに載っていなければ404が返る。
    // 「押しても何も起きない」を避けるため、汎用のAPIエラーと区別した文言を返す
    if (error instanceof GithubApiError && error.status === 404) {
      const message = `${SECRETS_SYNC_WORKFLOW_FILE} がこのリポジトリで見つかりませんでした（デフォルトブランチへ未反映の可能性があります）。`;
      await failSecretSyncRun(run.id, message);
      return NextResponse.json({ error: "workflow_not_found", message }, { status: 404 });
    }

    console.error(`[POST /api/secrets-sync] ${fullName}:`, error);
    const message = error instanceof Error ? error.message : String(error);
    await failSecretSyncRun(run.id, message);
    return NextResponse.json({ error: "github_api_error", message }, { status: 502 });
  }
}
