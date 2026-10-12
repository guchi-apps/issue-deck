import { isAllowedRepoOwner, type SlackConfig } from "@/lib/slack/config";
import { db } from "@/lib/db";

export type RepoCandidate = { fullName: string; name: string };

/** 投稿者がIssueDeck経由で扱えるリポジトリだけ（接続済みかつ権限あり）を候補にする */
export async function listRepoCandidates(config: SlackConfig, userId: string): Promise<RepoCandidate[]> {
  const rows = await db.repository.findMany({
    where: { installation: { userInstallations: { some: { userId } } } },
    select: { fullName: true, name: true },
    orderBy: { fullName: "asc" },
  });
  return rows.filter((row) => isAllowedRepoOwner(config, row.fullName));
}

/**
 * 本文に**一意に**書かれているリポジトリ名／アプリ名があれば、事前選択の候補にする。
 * 推定は確定ではない（利用者が確認・変更でき、確定した選択だけが正本）。複数該当・該当なしはnull。
 */
export function guessRepo(text: string, candidates: RepoCandidate[]): string | null {
  const lower = text.toLowerCase();
  const hits = candidates.filter((candidate) => {
    if (lower.includes(candidate.fullName.toLowerCase())) return true;
    const name = candidate.name.toLowerCase();
    if (name.length < 3) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9_-])${escaped}($|[^a-z0-9_-])`).test(lower);
  });
  return hits.length === 1 ? hits[0].fullName : null;
}

export function filterCandidates(candidates: RepoCandidate[], query: string, limit = 100): RepoCandidate[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? candidates.filter((c) => c.fullName.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    : candidates;
  return filtered.slice(0, limit);
}
