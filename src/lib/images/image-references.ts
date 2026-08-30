import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchRepositoryComments } from "@/lib/github/issues-api";
import {
  IMAGE_COMMENT_SCAN_MAX_PAGES,
  nextCommentScanCursor,
} from "@/lib/images/image-cleanup";
import { extractUploadedImageFilenames, UPLOADED_IMAGE_URL_PATH } from "@/lib/uploaded-images";
import type { UploadedImageReferenceSummary } from "@/types/uploaded-image";

/**
 * 添付画像がどこに貼られているかを集める（#2475）。
 *
 * ## どこを見て、どこを見ていないか
 *
 * 見ているのは2つだけ。
 *
 * - **Issueの本文** … issue-deckのDB（`Issue.body`）。GitHubのキャッシュなのでAPIを使わない
 * - **Issue／PRのコメント本文** … `GET /repos/{owner}/{repo}/issues/comments`を`since`で差分取得
 *
 * 見ていないもの（＝ここに貼った画像は「未使用」に見える）。
 *
 * - **Pull Requestの本文**（`Issue`テーブルはPRを除外している）
 * - **PRの差分コメント・レビュー本文**（別の受け口）
 * - **リポジトリの中のファイル・issue-deck以外への貼り付け**（配信は未認証なので原理的に不可能）
 * - **投稿前の下書き**（ブラウザのlocalStorageにしか無い）
 *
 * だから「未使用」は**参照が見つからなかった**という意味でしかなく、自動削除は
 * 保持期間とゴミ箱で二重に受ける（[`image-cleanup.ts`](./image-cleanup.ts)）。
 */

/** 参照元1件ぶんの鍵と、そこから見つかったファイル名 */
type SourceReferences = {
  sourceKey: string;
  repositoryFullName: string;
  issueNumber: number;
  isPullRequest: boolean;
  filenames: string[];
};

export function issueSourceKey(githubIssueId: bigint): string {
  return `issue:${githubIssueId}`;
}

export function commentSourceKey(githubCommentId: number): string {
  return `comment:${githubCommentId}`;
}

/**
 * 参照元ごとに、いまそこに写っている画像の集合へ置き換える。
 *
 * **「今回見つかったものを足す」だけでは足りない。** コメントの編集で画像記法が外れたときに
 * 古い参照が残り続け、その画像が永久に「使用中」になる。逆に、**読まなかった参照元の行は
 * 触らない**——リポジトリの連携が外れてIssue行が消えたとき、参照まで道連れにすると
 * 使っている画像が一斉に「未使用」へ変わるため（`UploadedImageReference`のコメントを参照）。
 */
async function replaceReferencesForSources(sources: SourceReferences[]): Promise<void> {
  if (sources.length === 0) return;

  // **画像を1枚も含まない参照元はまとめて片付ける。** 初回のバックログでは1回の巡回に
  // 1,000件のコメントが載り、その大半は画像を含まない。1件ずつ`deleteMany`を投げると
  // 巡回のほとんどが空振りのクエリになる。
  const emptyKeys = sources.filter((s) => s.filenames.length === 0).map((s) => s.sourceKey);
  for (let i = 0; i < emptyKeys.length; i += 500) {
    await db.uploadedImageReference.deleteMany({
      where: { sourceKey: { in: emptyKeys.slice(i, i + 500) } },
    });
  }

  for (const source of sources) {
    if (source.filenames.length === 0) continue;

    await db.uploadedImageReference.createMany({
      data: source.filenames.map((filename) => ({
        filename,
        sourceKey: source.sourceKey,
        repositoryFullName: source.repositoryFullName,
        issueNumber: source.issueNumber,
        isPullRequest: source.isPullRequest,
      })),
      skipDuplicates: true,
    });
    // 番号やPRかどうかは後から変わりうる（Issueの移動など）ので、既存行にも書き戻す
    await db.uploadedImageReference.updateMany({
      where: { sourceKey: source.sourceKey, filename: { in: source.filenames } },
      data: {
        repositoryFullName: source.repositoryFullName,
        issueNumber: source.issueNumber,
        isPullRequest: source.isPullRequest,
        foundAt: new Date(),
      },
    });
    // 編集で外れた画像の参照を落とす
    await db.uploadedImageReference.deleteMany({
      where: { sourceKey: source.sourceKey, filename: { notIn: source.filenames } },
    });
  }
}

/**
 * Issue本文の参照を集め直す（GitHub APIを使わない）。
 *
 * **増分にしない。** `Issue.body`はDBの現在値なので、毎回全部を読み直しても正しさが揺れない。
 * 増分のために「どこまで読んだか」を列に持つと、本文を読んだ後・書く前にWebhookが
 * `githubUpdatedAt`を進めた場合にその版を二度と読み直さなくなる（そのぶんの複雑さに見合わない）。
 *
 * 画像を貼っていない本文は`LIKE`で先に落とすので、実際に読むのは数十件のオーダーになる。
 */
export async function collectIssueBodyReferences(): Promise<number> {
  const issues = await db.issue.findMany({
    where: { body: { contains: UPLOADED_IMAGE_URL_PATH } },
    select: {
      githubIssueId: true,
      number: true,
      body: true,
      repository: { select: { fullName: true } },
    },
  });

  const sources: SourceReferences[] = issues.map((issue) => ({
    sourceKey: issueSourceKey(issue.githubIssueId),
    repositoryFullName: issue.repository.fullName,
    issueNumber: issue.number,
    isPullRequest: false,
    filenames: extractUploadedImageFilenames(issue.body),
  }));

  await replaceReferencesForSources(sources);
  return sources.length;
}

export type CommentScanResult = {
  /** 読んだコメントの件数 */
  scannedComments: number;
  /** まだ読み残しがあるリポジトリの数（次の巡回で続きを読む） */
  pendingRepositories: number;
  /** 取得に失敗したリポジトリの数 */
  failedRepositories: number;
};

/**
 * Issue／PRのコメントの参照を集める。
 *
 * リポジトリ単位に`since`で差分を取り、**読み終えた最後のコメントの`updated_at`**を
 * カーソルとして`Repository.imageCommentScanAt`へ書く。1回のページ数に上限があるので、
 * 初回のバックログは何回かの巡回に分かれて進む。
 *
 * `full: true`で全リポジトリのカーソルを捨てて最初から読み直す（削除されたコメントの参照が
 * 溜まったときの作り直し用）。
 */
export async function collectCommentReferences(
  options: { full?: boolean } = {},
): Promise<CommentScanResult> {
  if (options.full) {
    await db.repository.updateMany({ data: { imageCommentScanAt: null } });
  }

  const repositories = await db.repository.findMany({
    where: { archived: false },
    select: {
      id: true,
      ownerLogin: true,
      name: true,
      fullName: true,
      imageCommentScanAt: true,
      installation: { select: { id: true, installationId: true } },
    },
    // 一度も読んでいないリポジトリを先に片付ける（自動削除が始まる条件がそこだけで決まるため）
    orderBy: [{ imageCommentScanAt: { sort: "asc", nulls: "first" } }, { fullName: "asc" }],
  });

  const result: CommentScanResult = {
    scannedComments: 0,
    pendingRepositories: 0,
    failedRepositories: 0,
  };

  const tokenCache = new Map<string, string | null>();

  for (const repository of repositories) {
    // 同一installationのリポジトリ間でトークン取得を使い回す（既存の巡回3本と同じ）
    let token = tokenCache.get(repository.installation.id);
    if (token === undefined) {
      token = await getInstallationToken(repository.installation.installationId).catch(() => null);
      tokenCache.set(repository.installation.id, token);
    }
    if (!token) {
      result.failedRepositories += 1;
      continue;
    }

    try {
      const { comments, hasMore } = await fetchRepositoryComments(
        repository.ownerLogin,
        repository.name,
        token,
        { since: repository.imageCommentScanAt, maxPages: IMAGE_COMMENT_SCAN_MAX_PAGES },
      );

      const sources: SourceReferences[] = [];
      let lastUpdatedAt: Date | null = null;
      for (const comment of comments) {
        const updatedAt = new Date(comment.updated_at);
        if (!Number.isNaN(updatedAt.getTime())) {
          if (lastUpdatedAt === null || updatedAt > lastUpdatedAt) lastUpdatedAt = updatedAt;
        }
        const filenames = extractUploadedImageFilenames(comment.body);
        const issueNumber = parseIssueNumberFromUrl(comment.issue_url);
        if (issueNumber === null) continue;
        // 画像が1枚も無いコメントも「置き換え」の対象にする（編集で外れた参照を消すため）
        sources.push({
          sourceKey: commentSourceKey(comment.id),
          repositoryFullName: repository.fullName,
          issueNumber,
          isPullRequest: comment.html_url.includes("/pull/"),
          filenames,
        });
      }

      await replaceReferencesForSources(sources);
      result.scannedComments += comments.length;
      if (hasMore) result.pendingRepositories += 1;

      const cursor = nextCommentScanCursor(lastUpdatedAt, repository.imageCommentScanAt);
      // 1件も返らなかった初回でも、カーソルを立てて「読み終えた」ことを記録する
      await db.repository.update({
        where: { id: repository.id },
        data: { imageCommentScanAt: cursor ?? new Date() },
      });
    } catch (error) {
      console.error("[collectCommentReferences]", repository.fullName, error);
      result.failedRepositories += 1;
    }
  }

  return result;
}

/** `https://api.github.com/repos/<owner>/<repo>/issues/<number>` から番号を取る */
function parseIssueNumberFromUrl(issueUrl: string): number | null {
  const matched = issueUrl.match(/\/issues\/(\d+)$/);
  if (!matched) return null;
  const value = Number(matched[1]);
  return Number.isInteger(value) ? value : null;
}

/** ファイル名 → その画像を貼っている参照元。画面の一覧と削除の判定が読む */
export async function getReferencesByFilename(): Promise<
  Map<string, UploadedImageReferenceSummary[]>
> {
  const rows = await db.uploadedImageReference.findMany({
    select: {
      filename: true,
      repositoryFullName: true,
      issueNumber: true,
      isPullRequest: true,
    },
    orderBy: [{ repositoryFullName: "asc" }, { issueNumber: "desc" }],
  });

  const map = new Map<string, UploadedImageReferenceSummary[]>();
  for (const row of rows) {
    const list = map.get(row.filename) ?? [];
    // 同じIssueの本文とコメントの両方に貼られていることがあるので、Issue単位でまとめる
    const already = list.some(
      (item) =>
        item.repositoryFullName === row.repositoryFullName && item.issueNumber === row.issueNumber,
    );
    if (!already) {
      list.push({
        repositoryFullName: row.repositoryFullName,
        issueNumber: row.issueNumber,
        isPullRequest: row.isPullRequest,
      });
    }
    map.set(row.filename, list);
  }
  return map;
}
