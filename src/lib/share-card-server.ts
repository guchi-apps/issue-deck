import { headers } from "next/headers";

import { db } from "@/lib/db";
import {
  isValidIssueId,
  isValidNumber,
  isValidRepositorySegment,
  type ShareCardInfo,
} from "@/lib/share-card";

/**
 * Issue IDから、カードに載せる3項目だけを引く。未存在・不正は`null`（呼び出し側は
 * 存在の有無が分からない汎用カードを返す）。**selectでこの3項目以外は読まない。**
 */
export async function loadIssueShareCard(id: string): Promise<ShareCardInfo | null> {
  if (!isValidIssueId(id)) return null;
  const issue = await db.issue
    .findUnique({
      where: { githubIssueId: BigInt(id) },
      select: { number: true, repository: { select: { fullName: true } } },
    })
    .catch(() => null);
  if (!issue) return null;
  return { kind: "issue", repositoryFullName: issue.repository.fullName, number: issue.number };
}

/** PRはDBに無いので、登録済みリポジトリに限って受け付ける（GitHub APIは呼ばない） */
export async function loadPullRequestShareCard(
  owner: string,
  repo: string,
  number: string,
): Promise<ShareCardInfo | null> {
  if (!isValidRepositorySegment(owner) || !isValidRepositorySegment(repo) || !isValidNumber(number)) {
    return null;
  }
  const repository = await db.repository
    .findFirst({ where: { fullName: `${owner}/${repo}` }, select: { fullName: true } })
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
