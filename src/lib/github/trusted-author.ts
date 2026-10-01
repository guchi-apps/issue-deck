import { isBotLogin } from "@/lib/github/is-bot-login";

/** 投稿者がリポジトリに対して持つ関係。判定に使うのはこの2つだけ（#3365・#3716） */
export type GithubAuthor = {
  /** GitHub上の実際の投稿者。`issue-deck:posted-by`マーカーで表示用に差し替える前の値を渡す */
  login: string;
  /** GitHubの`author_association`。同期していないIssue・古いレコード・取得できないときは`null` */
  association: string | null;
};

const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * 投稿者を信頼して、その本文を自動処理の入口にしてよいか（#3365・#3716）。
 *
 * issue-deckはPUBLICで、Issue・コメントは外部の誰でも書ける。本文のマーカーだけで動く処理
 * （手作業の確認コマンドの定期巡回・計画レビューの記録と自動反映）は、ここで投稿者を絞る。
 *
 * **人はOWNER/MEMBER/COLLABORATORだけを通す。** `CONTRIBUTOR`・`NONE`などは、GitHubアカウントさえ
 * あれば誰でも該当しうるため通さない。**`[bot]`名義はissue-deck自身の自動化とみなして通す**——
 * このリポジトリにインストールされたGitHub Appの権限はリポジトリのオーナーが管理しており、
 * 外部の人が任意の`[bot]`アカウントとしてこのリポジトリへ投稿することはできない（コメントの
 * 投稿者解決`resolveCommentAuthorLogin`と同じ判断）。
 */
export function isTrustedGithubAuthor(author: GithubAuthor): boolean {
  if (isBotLogin(author.login)) return true;
  return author.association !== null && TRUSTED_AUTHOR_ASSOCIATIONS.has(author.association);
}
