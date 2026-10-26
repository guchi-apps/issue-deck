import { headers } from "next/headers";

import { db } from "@/lib/db";
import {
  isValidIssueId,
  isValidNumber,
  isValidRepositorySegment,
  type ShareCardInfo,
} from "@/lib/share-card";

/**
 * Issue IDから、カードに載せる項目（リポジトリ名・番号・タイトル・GitHub上の作成日時）だけを引く。
 * 未存在・不正は`null`（呼び出し側は存在の有無が分からない汎用カードを返す）。
 * **公開リポジトリに限る（非公開は`null`）。selectはこの項目と公開判定のみで、本文は読まない。**
 */
export async function loadIssueShareCard(id: string): Promise<ShareCardInfo | null> {
  if (!isValidIssueId(id)) return null;
  const issue = await db.issue
    .findUnique({
      where: { githubIssueId: BigInt(id) },
      select: {
        number: true,
        title: true,
        githubCreatedAt: true,
        repository: { select: { fullName: true, private: true } },
      },
    })
    .catch(() => null);
  // 匿名で届くので、非公開リポジトリは存在しないものとして扱う（名称・番号を開示しない）
  if (!issue || issue.repository.private) return null;
  return {
    kind: "issue",
    repositoryFullName: issue.repository.fullName,
    number: issue.number,
    title: issue.title,
    createdAt: issue.githubCreatedAt,
  };
}

/** PRはDBに無いので、登録済みの公開リポジトリに限って受け付ける（GitHub APIは呼ばない） */
export async function loadPullRequestShareCard(
  owner: string,
  repo: string,
  number: string,
): Promise<ShareCardInfo | null> {
  if (!isValidRepositorySegment(owner) || !isValidRepositorySegment(repo) || !isValidNumber(number)) {
    return null;
  }
  const repository = await db.repository
    .findFirst({ where: { fullName: `${owner}/${repo}`, private: false }, select: { fullName: true } })
    .catch(() => null);
  if (!repository) return null;
  return { kind: "pr", repositoryFullName: repository.fullName, number: Number(number) };
}

/** 実際にリクエストされたホストからoriginを作る（`og:image`は絶対URLが要る） */
export async function getShareOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "issuedeck.gucchii.com";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
