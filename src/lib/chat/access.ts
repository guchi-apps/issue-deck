import { findRepositoryByFullName } from "@/lib/github/issue-create-service";

/**
 * 会話の対象リポジトリへの権限を、いまのユーザーで確かめる（#4047）。
 * 権限を失った後は、古い会話を使った新規の取得・操作を許さない（履歴の閲覧だけは本人のものなので残す）。
 */
export async function hasConversationRepoAccess(userId: string, repo: string | null): Promise<boolean> {
  if (!repo) return true;
  return (await findRepositoryByFullName(userId, repo)) !== null;
}
