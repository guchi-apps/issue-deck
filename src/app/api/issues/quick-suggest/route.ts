import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { generateIssueSuggestion } from "@/lib/claude/issue-suggest";
import {
  RECENT_TITLE_LIMIT,
  suggestRepository,
  type RepositorySuggestCandidate,
} from "@/lib/claude/repository-suggest";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchRepoLabels } from "@/lib/github/issues-api";
import type { QuickSuggestKind, QuickSuggestResult } from "@/lib/quick-issue";

/** 候補リポジトリの判断材料として読み込むIssueの上限（全リポジトリ合算） */
const CANDIDATE_ISSUE_SCAN_LIMIT = 300;

/**
 * クイック起票（#1605）の一括推定。本文だけから「リポジトリ・タイトル・ラベル」を決める。
 *
 * 画面（`create-issue-dialog.tsx`）の入力ステップで「次へ」を押したときだけ呼ばれる。
 * **決めた値は必ず確認ステップに出してから作成する**ので、ここは推測に徹してよい。
 *
 * 手順は次の3段。リポジトリが決まらないとラベル候補が引けない（ラベルはリポジトリごと）ため、
 * 1回のClaude呼び出しにまとめられない。
 *
 * 1. Claudeでリポジトリを推定（`repositoryFullName`が渡されていれば省略）
 * 2. そのリポジトリのラベル一覧をGitHubから取得
 * 3. 既存の`generateIssueSuggestion`でタイトル・ラベルを生成
 *
 * **途中で失敗しても、取れたところまでを返す。** 起票そのものを止めないための作りで、
 * 呼び出し側は欠けた項目を空欄のフォームとして扱う。
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const payload = await request.json().catch(() => null);
  const body = payload?.body;
  const kind: QuickSuggestKind = payload?.kind === "question" ? "question" : "issue";
  const givenRepositoryFullName =
    typeof payload?.repositoryFullName === "string" && payload.repositoryFullName
      ? payload.repositoryFullName
      : null;

  if (typeof body !== "string" || !body.trim()) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const repositoryFullName =
      givenRepositoryFullName ?? (await inferRepository(userId, body, kind));

    if (!repositoryFullName) {
      const result: QuickSuggestResult = { repositoryFullName: null, title: null, labels: [] };
      return NextResponse.json(result);
    }

    // 質問のタイトルは質問文から機械的に作る決まり（`buildAskRepoQuestionTitle`）なので、
    // Claudeには作らせない。ラベルも質問Issueでは使わないため、ここで打ち切る
    if (kind === "question") {
      const result: QuickSuggestResult = { repositoryFullName, title: null, labels: [] };
      return NextResponse.json(result);
    }

    const suggestion = await suggestTitleAndLabels(userId, repositoryFullName, body);
    const result: QuickSuggestResult = {
      repositoryFullName,
      title: suggestion?.title ?? null,
      labels: suggestion?.labels ?? [],
    };
    return NextResponse.json(result);
  } catch (error) {
    console.error("[POST /api/issues/quick-suggest]", error);
    return NextResponse.json(
      {
        error: "suggestion_generation_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}

/**
 * 候補リポジトリを集めてClaudeに選ばせる。
 *
 * 母集団はPR一覧（`/api/pull-requests`）と同じ「連携済みからアーカイブ済みと非表示を除いたもの」。
 * 質問はGitHub Actions（mode=ask）が答えるため`hasClaudeWorkflow`のものだけに絞る
 * （画面側の`resolveKindRepository`と同じ条件）。
 */
async function inferRepository(
  userId: string,
  body: string,
  kind: QuickSuggestKind,
): Promise<string | null> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return null;

  const hiddenRepositoryIds = (
    await db.hiddenRepository.findMany({ where: { userId }, select: { repositoryId: true } })
  ).map((row) => row.repositoryId);

  const repositories = await db.repository.findMany({
    where: {
      archived: false,
      id: { notIn: hiddenRepositoryIds },
      installation: { userInstallations: { some: { userId } } },
      ...(kind === "question" ? { hasClaudeWorkflow: true } : {}),
    },
    orderBy: { fullName: "asc" },
    select: { id: true, fullName: true },
  });

  if (repositories.length === 0) return null;

  // 何を扱っているリポジトリなのかを伝えるための材料。1リポジトリずつ引くとリポジトリ数だけ
  // クエリが増えるので、更新が新しい順にまとめて読んでからリポジトリごとに割り振る
  const recentIssues = await db.issue.findMany({
    where: { repositoryId: { in: repositories.map((repo) => repo.id) }, state: "OPEN" },
    orderBy: { githubUpdatedAt: "desc" },
    take: CANDIDATE_ISSUE_SCAN_LIMIT,
    select: { repositoryId: true, title: true },
  });

  const titlesByRepositoryId = new Map<string, string[]>();
  for (const issue of recentIssues) {
    const titles = titlesByRepositoryId.get(issue.repositoryId) ?? [];
    if (titles.length >= RECENT_TITLE_LIMIT) continue;
    titles.push(issue.title);
    titlesByRepositoryId.set(issue.repositoryId, titles);
  }

  const candidates: RepositorySuggestCandidate[] = repositories.map((repo) => ({
    fullName: repo.fullName,
    recentIssueTitles: titlesByRepositoryId.get(repo.id) ?? [],
  }));

  return suggestRepository(token, { body, candidates });
}

/**
 * 決まったリポジトリのラベル一覧を取り、既存の提案生成でタイトル・ラベルを作る。
 *
 * **ここでの失敗は握りつぶしてnullを返す。** リポジトリまでは決まっているので、
 * タイトルが空のまま確認ステップへ進めた方が、エラーで作成をやり直させるより手数が少ない。
 */
async function suggestTitleAndLabels(
  userId: string,
  repositoryFullName: string,
  body: string,
): Promise<{ title: string; labels: string[] } | null> {
  const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!claudeToken) return null;

  try {
    const repository = await db.repository.findFirst({
      where: {
        fullName: repositoryFullName,
        installation: { userInstallations: { some: { userId } } },
      },
      include: { installation: true },
    });
    if (!repository) return null;

    const [owner, repo] = repositoryFullName.split("/");
    const labels = await withGithubApiFeature("repo_meta", async () => {
      const installationToken = await getInstallationToken(repository.installation.installationId);
      return fetchRepoLabels(owner, repo, installationToken);
    });

    return await generateIssueSuggestion(claudeToken, {
      body,
      availableLabels: labels.map((label) => ({
        name: label.name,
        description: label.description,
      })),
    });
  } catch (error) {
    console.error(`[POST /api/issues/quick-suggest] ${repositoryFullName}:`, error);
    return null;
  }
}
