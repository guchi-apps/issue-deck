import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { generateIssueSuggestion } from "@/lib/claude/issue-suggest";
import {
  RECENT_TITLE_LIMIT,
  suggestRepositories,
  type RepositorySuggestCandidate,
} from "@/lib/claude/repository-suggest";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchRepoLabels } from "@/lib/github/issues-api";
import type { QuickSuggestKind, QuickSuggestResult } from "@/lib/quick-issue";

/** 候補リポジトリの判断材料として読み込むIssueの上限（1リポジトリあたり） */
const CANDIDATE_ISSUE_SCAN_LIMIT = RECENT_TITLE_LIMIT;

/**
 * クイック起票（#1605）の一括推定。本文だけから「リポジトリ・タイトル・ラベル」を決める。
 *
 * 画面（`create-issue-dialog.tsx`）の入力ステップで「次へ」を押したときだけ呼ばれる。
 * **決めた値は必ず確認ステップに出してから作成する**ので、ここは推測に徹してよい。
 *
 * 手順は次の3段。リポジトリが決まらないとラベル候補が引けない（ラベルはリポジトリごと）ため、
 * 1回のClaude呼び出しにまとめられない。
 *
 * 1. Claudeでリポジトリ候補を推定（確からしい順に最大3件）
 * 2. 選ばれたリポジトリのラベル一覧をGitHubから取得
 * 3. 既存の`generateIssueSuggestion`でタイトル・ラベルを生成
 *
 * **`repositoryFullName`が渡されていても推定は行う**（#1710）。画面がリポジトリを渡すのは
 * 「リポジトリ別の画面から開いた」というだけの理由で、書いた内容が別のリポジトリの話である
 * ことは普通に起きる。渡された方を選択状態にしたまま、推定した候補も返して画面に並べる。
 *
 * **例外は`repositoryPinned`が付いているとき**（＝人が入力ステップで選んだ・#1733）。本人が
 * 決めた値を推し量る意味は無いので、リポジトリの推定（Claude 1回＋リポジトリごとのIssue取得）を
 * まるごと省いてタイトル・ラベルの生成へ進む。候補も返さない——押しても何も変わらない候補を
 * 並べると、選んだはずの指定が疑われているように見える。
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
  // 人が選んだリポジトリのときだけ推定を省く（#1733）。渡されただけの場合は推定を続ける（#1710）
  const isRepositoryPinned = payload?.repositoryPinned === true && givenRepositoryFullName !== null;

  if (typeof body !== "string" || !body.trim()) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const repositoryCandidates = isRepositoryPinned
      ? []
      : await inferRepositories(userId, body, kind);
    const repositoryFullName = givenRepositoryFullName ?? repositoryCandidates[0] ?? null;

    if (!repositoryFullName) {
      const result: QuickSuggestResult = {
        repositoryFullName: null,
        repositoryCandidates,
        title: null,
        labels: [],
      };
      return NextResponse.json(result);
    }

    // 質問のタイトルは質問文から機械的に作る決まり（`buildAskRepoQuestionTitle`）なので、
    // Claudeには作らせない。ラベルも質問Issueでは使わないため、ここで打ち切る
    if (kind === "question") {
      const result: QuickSuggestResult = {
        repositoryFullName,
        repositoryCandidates,
        title: null,
        labels: [],
      };
      return NextResponse.json(result);
    }

    const suggestion = await suggestTitleAndLabels(userId, repositoryFullName, body);
    const result: QuickSuggestResult = {
      repositoryFullName,
      repositoryCandidates,
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
 * 候補リポジトリを集めてClaudeに順位付けさせる。確からしい順に最大3件を返す。
 *
 * 母集団はPR一覧（`/api/pull-requests`）と同じ「連携済みからアーカイブ済みと非表示を除いたもの」。
 * 質問はGitHub Actions（mode=ask）が答えるため`hasClaudeWorkflow`のものだけに絞る
 * （画面側の`resolveKindRepository`と同じ条件）。
 */
async function inferRepositories(
  userId: string,
  body: string,
  kind: QuickSuggestKind,
): Promise<string[]> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return [];

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

  if (repositories.length === 0) return [];

  // 何を扱っているリポジトリなのかを伝えるための材料。
  // **リポジトリごとに引く**（#1710）。以前は全リポジトリ合算で更新の新しい順に300件読んで
  // 割り振っていたが、それだとIssueの多いリポジトリが枠を占め、動きの少ないリポジトリは
  // 名前しか材料が無い状態になっていた。判断材料の量が偏ると推定もそちらへ偏る
  const recentTitles = await Promise.all(
    repositories.map((repo) =>
      db.issue.findMany({
        where: { repositoryId: repo.id, state: "OPEN" },
        orderBy: { githubUpdatedAt: "desc" },
        take: CANDIDATE_ISSUE_SCAN_LIMIT,
        select: { title: true },
      }),
    ),
  );

  const candidates: RepositorySuggestCandidate[] = repositories.map((repo, index) => ({
    fullName: repo.fullName,
    recentIssueTitles: recentTitles[index].map((issue) => issue.title),
  }));

  return suggestRepositories(token, { body, candidates });
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
