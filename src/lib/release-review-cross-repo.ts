import { checkItemLabel, RELEASE_REVIEW_CHECK_ITEM_IDS } from "@/lib/release-review-checklist";

/**
 * 全体レビューが「別リポジトリのコードが無くて確認できない」とした未確認（#5378）。
 *
 * あるアプリのAPI・DBを別アプリが読む関係（AIDEがAsset ManagerのAPIを読む、など）では、項目を消す・変えるたびに
 * 全体レビューが利用側を確かめられず「指摘0件・要確認」で止まる。直すコードが無いので自動修正の対象にもならない。
 * その未確認を相手リポジトリつきで構造化し、画面が「他リポジトリの確認が必要」と原因を出し分け、利用側への
 * 確認Issueの下書きを出せるようにする。**判定・ゲートは変えない**（未確認範囲は従来どおり`unverifiedScope`が持つ）。
 */
export type ReleaseReviewCrossRepoItem = {
  /** 相手リポジトリ（`owner/repo`） */
  repository: string;
  /** 未確認にした確認項目。特定できなければnull */
  checkId: string | null;
  /** 相手が何をどう使っているか */
  usage: string;
  /** 何を確かめられなかったか */
  reason: string;
};

const REPOSITORY_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const MAX_ITEMS = 20;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function parseItem(value: unknown): ReleaseReviewCrossRepoItem | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const repository = text(raw.repository, 140);
  if (!REPOSITORY_RE.test(repository)) return null;
  const checkId = typeof raw.checkId === "string" && RELEASE_REVIEW_CHECK_ITEM_IDS.includes(raw.checkId) ? raw.checkId : null;
  return { repository, checkId, usage: text(raw.usage, 600), reason: text(raw.reason, 600) };
}

/**
 * AIの報告を正規化する。**確認項目が確認済み・非該当になっているものは落とす**（項目を確かめられたのに
 * 「他リポジトリの確認が必要」と案内しない）。`checks`がnull（旧形式）のときは項目で絞らない
 */
export function normalizeCrossRepoUnverified(
  value: unknown,
  checks: readonly { id: string; status: string }[] | null,
): ReleaseReviewCrossRepoItem[] {
  if (!Array.isArray(value)) return [];
  const settled = new Set((checks ?? []).filter((c) => c.status !== "unconfirmed").map((c) => c.id));
  const seen = new Set<string>();
  const items: ReleaseReviewCrossRepoItem[] = [];
  for (const entry of value) {
    const item = parseItem(entry);
    if (!item || (item.checkId && settled.has(item.checkId))) continue;
    const key = `${item.repository.toLowerCase()}:${item.checkId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/** 保存済みの記録から読む。旧記録には無いので空配列 */
export function readCrossRepoUnverified(value: unknown): ReleaseReviewCrossRepoItem[] {
  return normalizeCrossRepoUnverified(value, null);
}

/** 相手リポジトリごとにまとめる（下書きは相手1件につき1つ） */
export function groupCrossRepoByRepository(items: readonly ReleaseReviewCrossRepoItem[]): { repository: string; items: ReleaseReviewCrossRepoItem[] }[] {
  const groups = new Map<string, { repository: string; items: ReleaseReviewCrossRepoItem[] }>();
  for (const item of items) {
    const key = item.repository.toLowerCase();
    const group = groups.get(key) ?? { repository: item.repository, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export type CrossRepoIssueDraft = {
  repository: string;
  title: string;
  body: string;
  /** 本文・題名を埋めたGitHubの新規Issue画面。起票は人が画面で確かめてから行う */
  newIssueUrl: string;
  /** 同じ件のopenなIssueを先に探すための検索画面（同じ手順を2か所に持たない） */
  searchUrl: string;
};

/** URLの長さの上限を超えないよう、本文はこの長さで切る（GitHubの新規Issue画面はクエリで本文を受け取る） */
const MAX_DRAFT_BODY = 3500;

/**
 * 利用側リポジトリへの確認Issueの下書き。**起票はしない**——相手リポジトリに同じ件のIssueがあるかを人が確かめ、
 * GitHubの画面で内容を見てから作る（他リポジトリへの書き込みをissue-deckの操作1つで行わない）。
 */
export function buildCrossRepoIssueDraft(input: {
  repository: string;
  items: readonly ReleaseReviewCrossRepoItem[];
  /** 確認を求める側（候補のリポジトリ） */
  sourceRepository: string;
  /** 本番PR（候補）の番号 */
  pullRequestNumber: number;
}): CrossRepoIssueDraft {
  const { repository, items, sourceRepository, pullRequestNumber } = input;
  const sourceName = sourceRepository.split("/")[1] ?? sourceRepository;
  const title = `${sourceName}の変更（${sourceRepository}#${pullRequestNumber}）が利用側に影響しないか確認する`;
  const lines = [
    "## 背景",
    "",
    `${sourceRepository}#${pullRequestNumber}（本番公開の候補）の全体レビューが、このリポジトリの利用側コードを読めず「未確認」のまま止まっています。`,
    "",
    "## 確認してほしいこと",
    "",
    ...items.flatMap((item) => [
      `- ${item.checkId ? `${checkItemLabel(item.checkId)}: ` : ""}${item.reason || "利用側への影響を確認できていません"}`,
      ...(item.usage ? [`  - 利用箇所: ${item.usage}`] : []),
    ]),
    "",
    "## 完了条件",
    "",
    "- 利用側が今回の変更で壊れないか（実行時エラー・誤表示・誤った値で処理が進まないか）を実コードで確かめ、結果をこのIssueに書く",
    "- 追従が要る場合は、このIssueで対応する",
    "",
    "## 関連",
    "",
    `- ${sourceRepository}#${pullRequestNumber}`,
  ];
  const body = lines.join("\n").slice(0, MAX_DRAFT_BODY);
  const base = `https://github.com/${repository}`;
  const keyword = `${sourceName} ${pullRequestNumber}`;
  return {
    repository,
    title,
    body,
    newIssueUrl: `${base}/issues/new?${new URLSearchParams({ title, body }).toString()}`,
    searchUrl: `${base}/issues?${new URLSearchParams({ q: `is:issue is:open ${keyword}` }).toString()}`,
  };
}
