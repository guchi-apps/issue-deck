import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { fetchUserCanMaintainRepo } from "@/lib/github/release-body-api";
import { previewModeGuard } from "@/lib/preview-mode";
import { reconcileRcFinalization } from "@/lib/release-finalize-run";
import { parseAttestationNote, parseVersionEndpointUrl } from "@/lib/release-production-verification";
import { attestProduction, saveVersionEndpoint } from "@/lib/release-production-verification-run";

/**
 * 新方式の候補の稼働版の確認（#4713）。公開済みで「稼働確認中」に止まった候補へ、後から証拠を付ける正規の経路。
 *
 * - POST `action=attest`: 何で確かめたかを書いて、人の確認として記録する。**記録しただけでは完了にしない。**
 *   対象コミットのdeploy成功が前提で、公開URLが別の版を返している間は完了にならない（判定は`decideProductionEvidence`）
 * - POST `action=set_endpoint`: このrepoの稼働版を返す公開URLを登録する（`url`が空なら削除）。以後の巡回が外から照合する
 *
 * どちらも本番の完了判定を左右するため、対象repoのadmin/maintain権限を持つ利用者だけが行える。
 * 受け付けた後に本番反映の進行を1巡回し、証拠が揃っていればその場で候補を完了にする
 */

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const STATUS_BY_ERROR: Record<string, number> = { not_found: 404, not_attestable: 409, stale_target: 409, already_attested: 409 };

export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const owner = readString(payload?.owner);
  const repo = readString(payload?.repo);
  const action = readString(payload?.action);
  const candidateId = readString(payload?.candidateId);
  if (!owner || !repo || !candidateId || (action !== "attest" && action !== "set_endpoint")) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const repository = await db.repository.findFirst({
    where: { fullName: `${owner}/${repo}`, installation: { userInstallations: { some: { userId: user.id } } } },
    include: { installation: true },
  });
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const candidate = await db.releaseCandidate.findUnique({ where: { id: candidateId }, select: { repositoryFullName: true } });
  if (!candidate || candidate.repositoryFullName !== repository.fullName) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const permission = await fetchUserCanMaintainRepo(owner, repo, user.githubLogin, token);
    if (!permission.ok) return NextResponse.json({ error: "github_error" }, { status: 502 });
    if (!permission.canMaintain) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    if (action === "attest") {
      const note = parseAttestationNote(payload?.note);
      const expectedMergeSha = readString(payload?.expectedMergeSha);
      if (!note || !expectedMergeSha) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
      const result = await attestProduction({ candidateId, expectedMergeSha, userId: user.id, note });
      if (!result.ok) return NextResponse.json(result, { status: STATUS_BY_ERROR[result.error] ?? 409 });
    } else {
      const raw = payload?.url;
      const url = raw === null || raw === "" ? null : parseVersionEndpointUrl(raw);
      if (url === null && raw !== null && raw !== "") return NextResponse.json({ error: "invalid_url" }, { status: 400 });
      await saveVersionEndpoint(repository.fullName, url, user.id);
    }
    await reconcileRcFinalization({ owner, repo, token }, candidateId).catch((error: unknown) =>
      console.error("[release-production] reconcile failed", repository.fullName, error),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(`[POST /api/repositories/release/production-verification] ${owner}/${repo}:`, error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
  }
}
