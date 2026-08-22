import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { listSessionArtifacts } from "@/lib/dispatch/session-artifacts";

/**
 * 選択中のIssueが持つアーティファクトの一覧（#2154）。
 *
 * 中身（HTML）は返さない。カードに出すぶんだけを返し、実物は
 * `/api/issues/artifacts/<id>`がiframeへ直接配る。
 *
 * **参照できるインストール配下のリポジトリに限る。** アーティファクトはIssueに紐づく
 * 成果物なので、Issue本体と同じ範囲でしか見せない。
 */
export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const number = Number(searchParams.get("number"));
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repositoryFullName = `${owner}/${repo}`;
  const repository = await db.repository.findFirst({
    where: {
      fullName: repositoryFullName,
      installation: { userInstallations: { some: { userId } } },
    },
    select: { id: true },
  });
  // **404にはしない。** 見えないリポジトリと「1件も無い」を画面で区別する意味が無く、
  // どちらもセクションを出さないだけで済む
  if (!repository) return NextResponse.json({ artifacts: [] });

  const artifacts = await listSessionArtifacts(repositoryFullName, number);
  return NextResponse.json({ artifacts });
}
