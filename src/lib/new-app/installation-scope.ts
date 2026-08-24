import { db } from "@/lib/db";
import { fetchRepositorySelection } from "@/lib/github/installations-api";
import { NEW_APP_ORG } from "@/lib/new-app/spec";

/**
 * 立ち上げ先のorgに入っているGitHub Appが、新しいリポジトリを自動で取り込むかを確かめる（#2248）。
 *
 * `issue-deck`・`issue-deck-dev`とも`repository_selection=all`で入っているため、
 * **新しく作ったリポジトリは何もしなくてもインストール対象に入る。** 手作業Issueに
 * 「インストール対象へ追加する」を書くと、人が空振りの手順を実行することになる（#2215）。
 *
 * ただし**選び方が`selected`へ戻される可能性は残る**ので、その場合だけ手順を出す。
 * 読めなかったときも手順を出す（余分な手順が1つ増えるだけで済み、落とすと立ち上げが
 * 黙って壊れる）。
 */

export type NewAppInstallationScope = {
  /** GitHubが返した選び方。読めなければ`null` */
  repositorySelection: "all" | "selected" | null;
  /** ブラウザの手作業Issueに「インストール対象へ追加する」を出すか */
  needsRepositoryAdd: boolean;
};

export async function resolveNewAppInstallationScope(
  userId: string,
): Promise<NewAppInstallationScope> {
  const installation = await db.githubInstallation.findFirst({
    where: {
      accountLogin: NEW_APP_ORG,
      userInstallations: { some: { userId } },
    },
    select: { installationId: true },
  });
  if (!installation) {
    console.warn(
      `[new-app] ${NEW_APP_ORG} のGitHub Appのインストールが見つかりませんでした。インストール対象への追加を手順として出します。`,
    );
    return { repositorySelection: null, needsRepositoryAdd: true };
  }

  try {
    const repositorySelection = await fetchRepositorySelection(installation.installationId);
    return { repositorySelection, needsRepositoryAdd: repositorySelection !== "all" };
  } catch (error) {
    console.warn("[new-app] GitHub Appのインストール範囲を読めませんでした", error);
    return { repositorySelection: null, needsRepositoryAdd: true };
  }
}
