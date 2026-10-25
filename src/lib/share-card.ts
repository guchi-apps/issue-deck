/**
 * DiscordなどのリンクプレビューにIssue・PRのカードを出すための純関数（#5036）。
 *
 * Discordに貼るURLは従来の`/dashboard?issue=…`・`?pr=…`のまま（#5035のUniversal Linkも
 * `/dashboard`だけを対象にする）。リンクプレビューのクローラーが取りに来たときだけ、
 * `src/proxy.ts`が`/share/...`（ログイン不要のOGメタ・カード画像）へrewriteする。
 *
 * **カードに載せてよいのはリポジトリ名・種別・番号の3つだけ**。タイトル・本文・状態・担当者は
 * ここで扱う型にそもそも持たせない。
 */
import { parsePullRequestId } from "@/lib/github-reference";

export type ShareKind = "issue" | "pr";

/** カードに載せる情報。ここに無い項目は画像にもメタタグにも出さない */
export type ShareCardInfo = {
  kind: ShareKind;
  repositoryFullName: string;
  number: number;
};

// リンクプレビューを取りに来る代表的なクローラー。人のブラウザは含めない
const LINK_PREVIEW_BOT_PATTERN =
  /Discordbot|Twitterbot|Slackbot|facebookexternalhit|LinkedInBot|TelegramBot|WhatsApp/i;

export function isLinkPreviewBot(userAgent: string | null | undefined): boolean {
  return !!userAgent && LINK_PREVIEW_BOT_PATTERN.test(userAgent);
}

// GitHubのIssue IDは符号付き64bit。桁数で粗く弾き、BigIntへ渡せる形だけ通す
const ISSUE_ID_PATTERN = /^\d{1,19}$/;
const OWNER_PATTERN = /^[A-Za-z0-9-_.]{1,100}$/;
const NUMBER_PATTERN = /^\d{1,9}$/;

export function isValidIssueId(id: string): boolean {
  return ISSUE_ID_PATTERN.test(id);
}

export function isValidRepositorySegment(value: string): boolean {
  return OWNER_PATTERN.test(value);
}

export function isValidNumber(value: string): boolean {
  return NUMBER_PATTERN.test(value) && Number(value) > 0;
}

/**
 * `/dashboard`のクエリから、対応する`/share/...`のパスを求める。
 * `issue=`・`pr=`のどちらも無い、または形が不正なら`null`（rewriteしない）。
 */
export function resolveSharePath(searchParams: URLSearchParams): string | null {
  const issue = searchParams.get("issue");
  if (issue && isValidIssueId(issue)) return `/share/issue/${issue}`;

  const pr = searchParams.get("pr");
  if (pr) {
    const parsed = parsePullRequestId(pr);
    if (parsed) {
      const [owner, repo] = parsed.repositoryFullName.split("/");
      if (
        isValidRepositorySegment(owner) &&
        isValidRepositorySegment(repo) &&
        isValidNumber(String(parsed.number))
      ) {
        return `/share/pr/${owner}/${repo}/${parsed.number}`;
      }
    }
  }
  return null;
}

/** 人が`/share/...`を直接開いたときの行き先（従来の`/dashboard`のURL） */
export function buildDashboardPath(kind: ShareKind, id: string): string {
  const q = new URLSearchParams();
  if (kind === "issue") {
    q.set("issue", id);
    q.set("mscreen", "issue-detail");
    q.set("missue", id);
  } else {
    q.set("pane", "pull-requests");
    q.set("pr", id);
    q.set("mscreen", "pull-requests");
  }
  return `/dashboard?${q.toString()}`;
}

/** 種別と番号の表示（`Issue #1366`・`PR #5036`） */
export function formatShareLabel(kind: ShareKind, number: number): string {
  return `${kind === "issue" ? "Issue" : "PR"} #${number}`;
}

/** メタタグ用の文言。カードと同じ3項目だけで組み立てる */
export function buildShareMeta(info: ShareCardInfo | null, kind: ShareKind) {
  if (!info) {
    return { title: "IssueDeck", description: kind === "issue" ? "IssueDeck の Issue" : "IssueDeck の PR" };
  }
  const label = formatShareLabel(info.kind, info.number);
  return {
    title: `${info.repositoryFullName} ${label}`,
    description: `IssueDeck で ${label} を開く`,
  };
}
