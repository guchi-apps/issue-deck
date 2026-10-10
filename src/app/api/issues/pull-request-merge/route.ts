import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { fetchPullRequest, mergePullRequest } from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { recordDeployLaunchWatch } from "@/lib/github/deploy-launch-watch";
import { GithubApiError } from "@/lib/github/issues-api";
import { previewModeGuard } from "@/lib/preview-mode";
import {
  evaluateReleaseMergeGate,
  evaluateReleaseVerificationWait,
  isReleasePullRequest,
} from "@/lib/release-merge-gate";
import { listReleaseVerificationRecords } from "@/lib/release-verification";
import { getReleaseVerificationConfig } from "@/lib/release-verification-config";

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("pull_request_merge", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body: { owner?: string; repo?: string; number?: number; acknowledgeVerification?: boolean } = await request
    .json()
    .catch(() => ({}));
  const { owner, repo, number } = body;

  if (!owner || !repo || !number || Number.isNaN(Number(number))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);

    // リリースPR（base=main・head=release-main/v*）だけに、固定内容の検証ゲートを掛ける（#4212）。
    // **表示だけに頼らず、マージ直前にbase/headを取り直して記録のSHAと突き合わせる。**
    // develop向けPR・知見昇格PRなど他のPRは従来どおり。
    let expectedHeadSha: string | undefined;
    const pr = await fetchPullRequest(owner, repo, Number(number), token);
    if (pr.base && pr.head.ref && isReleasePullRequest({ baseRef: pr.base.ref, headRef: pr.head.ref })) {
      expectedHeadSha = pr.head.sha;
      const records = await listReleaseVerificationRecords(`${owner}/${repo}`, Number(number));
      const gate = evaluateReleaseMergeGate({
        current: { baseSha: pr.base.sha, headSha: pr.head.sha },
        records,
        enforced: getReleaseVerificationConfig(`${owner}/${repo}`).enforced,
      });
      // 統合検証・全体レビューの判定が出るまで待たせる（#4354）。結果では止めず、`enforced`にも依らない。
      // 報告が来ず待ちのまま止まった場合に備え、明示確認（acknowledgeVerification）で上書きできる
      const pending = evaluateReleaseVerificationWait({
        current: { baseSha: pr.base.sha, headSha: pr.head.sha },
        records,
      });
      if (pending.length > 0) {
        if (body.acknowledgeVerification !== true) {
          return NextResponse.json({ error: "release_verification_pending", pending }, { status: 409 });
        }
        console.warn(
          `[POST /api/issues/pull-request-merge] ${owner}/${repo}#${number} 判定待ちの検証を明示確認のうえマージ: ${pending
            .map((b) => b.reason)
            .join(" / ")}`,
        );
      }
      // 失敗・未実施・古い結果は確認済みにできない。要確認だけが明示確認（acknowledgeVerification）で通れる
      const overridable = gate.status === "needs_confirmation" && body.acknowledgeVerification === true;
      if (gate.status === "blocked" || (gate.status === "needs_confirmation" && !overridable)) {
        return NextResponse.json(
          { error: "release_verification_required", gate },
          { status: 409 },
        );
      }
      if (overridable) {
        console.warn(
          `[POST /api/issues/pull-request-merge] ${owner}/${repo}#${number} 要確認の検証を明示確認のうえマージ: ${gate.blockers
            .map((b) => b.reason)
            .join(" / ")}`,
        );
      }
    }

    const merged = await mergePullRequest(owner, repo, Number(number), token, expectedHeadSha);

    // mainへのマージなら、本番デプロイが本当に起動したかを見張る行を1つ置く（#2703）。
    // **GitHubはマージのイベントを配送し損ねることがあり**、そのときはワークフローの定義が
    // 正しくても`deploy.yml`の実行が1件も作られない（myroom#315。mainへのマージ55件中1件）。
    // 実際の見張りはpollerが叩く巡回（`/api/repositories/deploy-launch-sweep`）が行う。
    //
    // **ここで失敗してもマージは成功として返す。** 見張りが立たないだけで、マージそのものは
    // 済んでおり、押し直させると二重マージを試みることになる。
    let deployLaunchWatched = false;
    try {
      deployLaunchWatched = await recordDeployLaunchWatch({
        owner,
        repo,
        pullRequestNumber: Number(number),
        mergeCommitSha: merged.sha,
        token,
      });
    } catch (error) {
      console.error(
        `[POST /api/issues/pull-request-merge] 見張りの記録に失敗しました ${owner}/${repo}#${number}:`,
        error,
      );
    }

    return NextResponse.json({ ok: true, deployLaunchWatched });
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    console.error(`[POST /api/issues/pull-request-merge] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
