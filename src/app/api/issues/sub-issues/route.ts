import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import {
  fetchSubIssueRelations,
  type GithubSubIssueRef,
} from "@/lib/github/sub-issues-api";
import type { SubIssue, SubIssueRelations } from "@/types/issue";

/**
 * 選択中のIssueの親子関係（GitHubネイティブのサブIssue）を返す。
 *
 * **キャッシュしない。** コメント（`/api/issues/comments`）・PR詳細と同じ流儀で、
 * Issue詳細を開いたときだけGitHubへ問い合わせる。DBへ持たせるとGitHub Appの`sub_issues`
 * Webhookイベント購読の追加（GitHub App設定の手作業変更）とスキーマ変更が要るのに対し、
 * 得られるのは1クエリぶんの節約でしかないため。
 */

// 静的importするとGitHub App認証情報が無い環境（無人でのCIスクリーンショット撮影等）では
// このモジュール自体の読み込みで例外になるため、実際にGitHub APIを呼ぶ経路でのみ動的importする（#550）
async function getInstallationTokenLazy(installationId: number) {
  const { getInstallationToken } = await import("@/lib/github/app-auth");
  return getInstallationToken(installationId);
}

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

const EMPTY: SubIssueRelations = { parent: null, children: [], childCount: 0 };

/** DBの引き当てキー。**番号だけでは足りない**（別リポジトリの同番号と混ざる・#1722） */
function statusKey(repositoryFullName: string, number: number) {
  return `${repositoryFullName}#${number}`;
}

/**
 * GitHubから取った親子に、ローカルDBのキャッシュから`projectStatus`だけを合流させる。
 * タイトル・stateはGitHub側を正とするため、**DBに無い相手でもリンクは欠けない**。
 *
 * **リポジトリごとに引く**（#1722）。以前は開いているIssueの`repositoryId`だけで引いていたため、
 * 別リポジトリの子には**番号が一致する親リポジトリ側の無関係なIssueの進捗**が付いていた。
 * サブIssueはリポジトリをまたげるので、番号だけの突き合わせは成立しない。
 *
 * 引く範囲は`findRepository`と同じく、そのユーザーが参照できるインストール配下に限定する。
 */
async function attachProjectStatus(
  userId: string,
  refs: GithubSubIssueRef[],
): Promise<SubIssue[]> {
  if (refs.length === 0) return [];

  const numbersByRepository = new Map<string, number[]>();
  for (const ref of refs) {
    const numbers = numbersByRepository.get(ref.repositoryFullName);
    if (numbers) numbers.push(ref.number);
    else numbersByRepository.set(ref.repositoryFullName, [ref.number]);
  }

  const rows = await db.issue.findMany({
    where: {
      repository: { installation: { userInstallations: { some: { userId } } } },
      OR: [...numbersByRepository].map(([fullName, numbers]) => ({
        repository: { fullName },
        number: { in: numbers },
      })),
    },
    select: { number: true, projectStatus: true, repository: { select: { fullName: true } } },
  });
  const statusByKey = new Map(
    rows.map((row) => [statusKey(row.repository.fullName, row.number), row.projectStatus]),
  );

  return refs.map((ref) => ({
    ...ref,
    projectStatus: statusByKey.get(statusKey(ref.repositoryFullName, ref.number)) ?? null,
  }));
}

export function GET(request: NextRequest) {
  return withGithubApiFeature("sub_issues", () => handleGET(request));
}

async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const numberParam = searchParams.get("number");
  const number = Number(numberParam);

  if (!owner || !repo || !numberParam || !Number.isInteger(number) || number <= 0) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationTokenLazy(repository.installation.installationId);
    const relations = await fetchSubIssueRelations(token, owner, repo, number);

    // 親と子はまとめて1クエリで引く（リポジトリごとの`OR`になるため、分けても得が無い）
    const withStatus = await attachProjectStatus(userId, [
      ...(relations.parent ? [relations.parent] : []),
      ...relations.children,
    ]);

    const payload: SubIssueRelations = {
      parent: relations.parent ? (withStatus[0] ?? null) : null,
      children: relations.parent ? withStatus.slice(1) : withStatus,
      childCount: relations.childCount,
    };
    return NextResponse.json({ relations: payload });
  } catch (error) {
    // 親子関係の表示は本文・コメントの補助であり、ここで失敗しても詳細画面の他の情報は
    // 読める。エラーを画面へ出すと「関係が無いIssue（大多数）」との区別が付かない見た目に
    // なるため、サーバーログにだけ残して関係なしとして返す。
    // GitHub App認証が無いCI環境（実在しないダミーリポジトリ）もこの経路を通る。
    console.error(`[GET /api/issues/sub-issues] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json({ relations: EMPTY });
  }
}
