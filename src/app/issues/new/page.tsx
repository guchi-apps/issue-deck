import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { CreateIssueWindow } from "@/components/dashboard/create-issue-window";
import { getCurrentUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { listDispatchRunnableRepositories } from "@/lib/dispatch/runnable-repositories";
import { getIssuesForUser } from "@/lib/issues-for-user";

/**
 * Issue作成画面を別ウィンドウで開くためのページ（#1728）。
 *
 * デッキ（`/dashboard`）を見ながらIssueを書けるようにするためのもので、開く口は作成
 * ダイアログの「別ウィンドウで開く」だけ。URLを直接開いても空のフォームとして成立する。
 *
 * リポジトリの選択肢は**サイドメニューで非表示にしたものを除く**（#367）。ダイアログが
 * `visibleRepositories`を受け取っているのと同じ範囲にしないと、こちらでだけ選べるリポジトリが
 * 現れる。Issue一覧は本文の`#123`補完（`getRepoIssueSuggestions`）にだけ使う。
 */
// 別ウィンドウとして並ぶため、タイトルバー・タスクバーでデッキ本体と見分けが付く名前にする
export const metadata: Metadata = { title: "新しいIssueを作成 | IssueDeck" };

export default async function NewIssuePage() {
  const currentUser = await getCurrentUser();
  // 未ログインはproxy（middleware）が/loginへ送るが、Cookieが無効な場合等の保険として塞ぐ
  if (!currentUser) redirect("/login?callbackUrl=/issues/new");

  const [repositories, hiddenRepositories, issues, dispatchRunnableRepositories] = await Promise.all([
    db.repository.findMany({
      where: { installation: { userInstallations: { some: { userId: currentUser.id } } } },
      orderBy: { fullName: "asc" },
    }),
    db.hiddenRepository.findMany({
      where: { userId: currentUser.id },
      select: { repositoryId: true },
    }),
    getIssuesForUser(currentUser.id),
    // 一覧の印（#1888）はデッキ本体（`/dashboard`）と同じ材料で決める
    listDispatchRunnableRepositories(),
  ]);

  const hiddenRepositoryIds = new Set(hiddenRepositories.map((row) => row.repositoryId));

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <CreateIssueWindow
        repositories={repositories
          .filter((repo) => !hiddenRepositoryIds.has(repo.id))
          .map((repo) => ({
            id: repo.id,
            name: repo.name,
            fullName: repo.fullName,
            private: repo.private,
            archived: repo.archived,
            hasClaudeWorkflow: repo.hasClaudeWorkflow,
            hasLocalStartScript: repo.hasLocalStartScript,
            dispatchRunnable: dispatchRunnableRepositories.has(repo.fullName),
            hidden: false,
            favorite: false,
          }))}
        issues={issues}
      />
    </main>
  );
}
