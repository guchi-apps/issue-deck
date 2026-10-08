import { NextResponse, type NextRequest } from "next/server";

import { BackupCiError, getBackupCiReadiness, startBackupCiRun } from "@/lib/backup-ci/service";
import { toBackupCiRunView, toCiGateStateView } from "@/lib/backup-ci/view";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { GithubApiError } from "@/lib/github/github-api-error";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * PRのバックアップCI（#4065）。GETで設定の準備状況と直近の実行を、POSTで実行の開始を行う。
 * **起動は利用者の明示的な操作だけ**（Actionsの障害を自動判定して切り替えない）。
 */

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    select: { fullName: true },
  });
}

function parseTarget(owner: unknown, repo: unknown, number: unknown) {
  const prNumber = Number(number);
  if (typeof owner !== "string" || typeof repo !== "string" || !owner || !repo) return null;
  if (!Number.isInteger(prNumber) || prNumber <= 0) return null;
  return { owner, repo, prNumber };
}

export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = request.nextUrl.searchParams;
  const target = parseTarget(params.get("owner"), params.get("repo"), params.get("number"));
  if (!target) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const repository = await findRepository(userId, target.owner, target.repo);
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [readiness, runs, gate] = await Promise.all([
    getBackupCiReadiness(repository.fullName),
    db.backupCiRun.findMany({
      where: { repositoryFullName: repository.fullName, prNumber: target.prNumber },
      orderBy: { attempt: "desc" },
      take: 5,
    }),
    db.ciGateState.findUnique({
      where: { repositoryFullName_prNumber: { repositoryFullName: repository.fullName, prNumber: target.prNumber } },
    }),
  ]);
  return NextResponse.json(
    {
      readiness: {
        enabled: readiness.setting?.enabled ?? false,
        circleciProjectSlug: readiness.setting?.circleciProjectSlug ?? null,
        circleciDefinitionId: readiness.setting?.circleciDefinitionId ?? null,
        mirrorActionsToCiGate: readiness.setting?.mirrorActionsToCiGate ?? false,
        tokenConfigured: readiness.tokenConfigured,
        webhookConfigured: readiness.webhookConfigured,
        problems: readiness.problems,
      },
      runs: runs.map(toBackupCiRunView),
      gate: gate ? toCiGateStateView(gate) : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("backup_ci", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body: { owner?: unknown; repo?: unknown; number?: unknown } = await request.json().catch(() => ({}));
  const target = parseTarget(body.owner, body.repo, body.number);
  if (!target) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const repository = await findRepository(userId, target.owner, target.repo);
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const { run, reused } = await startBackupCiRun({
      repositoryFullName: repository.fullName,
      prNumber: target.prNumber,
      userId,
    });
    return NextResponse.json({ ok: true, reused, run: toBackupCiRunView(run) });
  } catch (error) {
    if (error instanceof BackupCiError) {
      const status = error.code === "not_found" ? 404 : 409;
      return NextResponse.json({ error: error.code, message: error.message }, { status });
    }
    if (error instanceof GithubApiError && error.status === 404) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    console.error(`[POST /api/pull-requests/backup-ci] ${repository.fullName}#${target.prNumber}:`, error);
    return NextResponse.json(
      { error: "backup_ci_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
