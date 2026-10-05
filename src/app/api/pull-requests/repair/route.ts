import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import {
  findRepositoryForUser,
  startPullRequestRepair,
} from "@/lib/github/pull-request-repair-service";
import { previewModeGuard } from "@/lib/preview-mode";

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("pull_request_repair", () => handlePOST(request));
}

/**
 * 詰まっているPRの自動修復ワークフローを画面のボタンから起動する（#1293）。
 * 判定と起動の本体は`pull-request-repair-service.ts`にあり、IssueDeck Chatと共用する（#3975）。
 */
async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body: { owner?: string; repo?: string; number?: number } = await request
    .json()
    .catch(() => ({}));
  const { owner, repo, number } = body;

  if (!owner || !repo || !number || Number.isNaN(Number(number))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepositoryForUser(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result = await startPullRequestRepair(repository, owner, repo, Number(number));
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.message ? { message: result.message } : {}) },
      { status: result.status },
    );
  }
  return NextResponse.json({
    ok: true,
    kinds: result.kinds,
    remainingKinds: result.remainingKinds,
    maxRounds: result.maxRounds,
  });
}
