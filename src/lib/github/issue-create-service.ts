import { MODEL_PICK_ENGINE_DEFAULT, parseModelPickEngine } from "@/lib/app-settings";
import { db } from "@/lib/db";
import { getAppAiToken } from "@/lib/claude/request";
import {
  generateIssueSuggestion,
  suggestLabelsByJev,
  type IssueSuggestResult,
} from "@/lib/claude/issue-suggest";
import { addIssueLabels, createIssue, fetchRepoLabels, updateIssue } from "@/lib/github/issues-api";
import { upsertIssueAndGetDisplay } from "@/lib/github/sync-issues";
import {
  withUserGithubToken,
  type WithUserGithubTokenResult,
} from "@/lib/github/with-user-github-token";
import { consumeShareImageUploads, loadOwnedShareImages } from "@/lib/images/share-image-ownership";

/**
 * Issue作成の本体（#3975）。画面の起案（`POST /api/issues`）とIssueDeck Chatの確認カードが
 * 同じ関数を呼ぶ。ユーザー本人のトークン取得・GitHubへの作成・DBへの反映までを持つ。
 */

export type IssueCreateRequest = {
  repositoryFullName: string;
  title: string;
  body?: string;
  labels?: string[];
  assignee?: string;
};

type CreateIssueUser = {
  id: string;
  githubAccessToken: string | null;
  githubRefreshToken: string | null;
};

export async function findRepositoryByFullName(userId: string, repositoryFullName: string) {
  return db.repository.findFirst({
    where: {
      fullName: repositoryFullName,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

type Repository = NonNullable<Awaited<ReturnType<typeof findRepositoryByFullName>>>;

export type CreatedIssueDisplay = Awaited<ReturnType<typeof upsertIssueAndGetDisplay>>;

export async function createIssueForUser(
  user: CreateIssueUser,
  repository: Repository,
  request: IssueCreateRequest,
): Promise<WithUserGithubTokenResult<CreatedIssueDisplay>> {
  const [owner, repo] = request.repositoryFullName.split("/");
  return withUserGithubToken(user, `POST /api/issues ${request.repositoryFullName}`, async (token) => {
    const created = await createIssue(owner, repo, token, {
      title: request.title.trim(),
      body: request.body?.trim() ? request.body : undefined,
      labels: request.labels,
      assignees: request.assignee ? [request.assignee] : undefined,
    });
    return upsertIssueAndGetDisplay(repository, created);
  });
}

/**
 * 共有画面から作ったIssueへ、AIが判定したラベルと（空欄で作ったときは）タイトルを書き込む
 * （#4298・#5673）。**ベストエフォート**: AI未設定・失敗・GitHubへの更新失敗では何も変えず、
 * 仮タイトル・ラベル無しのまま残す（作成そのものは成功している）。呼び出し元は応答を返したあとに走らせる。
 *
 * 画像があるときはアプリ内AIに画像ごと見せる（Jevは画像を読めない）。無いときのラベルは
 * 起案画面（`POST /api/issues/suggest`）と同じく、設定がJevならJev、駄目ならアプリ内AI。
 */
export async function fillSharedIssueByAi(
  user: CreateIssueUser,
  repository: Repository,
  issue: { number: number },
  content: { title: string; body: string },
): Promise<void> {
  try {
    const images = await loadOwnedShareImages(user.id, content.body);
    // 画像のURLは判断材料にならないので落とす
    const text = [content.title, content.body.replace(/!\[[^\]]*\]\([^)]*\)/g, "")]
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n");
    if (!text && images.length === 0) return;

    const [owner, repo] = repository.fullName.split("/");
    const logContext = `POST /api/share/issues ${repository.fullName}#${issue.number}`;
    const fetched = await withUserGithubToken(user, logContext, (token) =>
      fetchRepoLabels(owner, repo, token),
    );
    const availableLabels = "errorResponse" in fetched ? [] : fetched.value;
    const input = { body: text, availableLabels };

    const setting = await db.appSetting
      .findUnique({ where: { id: 1 }, select: { modelPickEngine: true } })
      .catch(() => null);
    const engine = parseModelPickEngine(setting?.modelPickEngine) ?? MODEL_PICK_ENGINE_DEFAULT;
    const jevLabels =
      engine === "jev" && images.length === 0 ? await suggestLabelsByJev(input) : null;

    const fillTitle = !content.title;
    let suggestion: IssueSuggestResult | null = null;
    const aiToken = fillTitle || jevLabels === null ? await getAppAiToken("issue_suggest") : null;
    if (aiToken) {
      suggestion = await generateIssueSuggestion(aiToken, input, {
        includeLabels: jevLabels === null,
        images,
      });
    }

    const labels = jevLabels ?? suggestion?.labels ?? [];
    const title = fillTitle ? (suggestion?.title ?? "") : "";
    if (labels.length === 0 && !title) return;

    const updated = await withUserGithubToken(user, logContext, async (token) => {
      // ラベルは追加だけにする（作成後に人が付けたラベルを消さない）
      if (labels.length > 0) await addIssueLabels(owner, repo, issue.number, token, labels);
      // 変更が無くても、画面へ反映するため付与後のIssueを受け取る
      return updateIssue(owner, repo, issue.number, token, title ? { title } : {});
    });
    if ("errorResponse" in updated) return;
    await upsertIssueAndGetDisplay(repository, updated.value);
  } catch (error) {
    console.error("[share] タイトル・ラベルの自動記入に失敗しました", error);
  } finally {
    await consumeShareImageUploads(user.id, content.body).catch(() => undefined);
  }
}
