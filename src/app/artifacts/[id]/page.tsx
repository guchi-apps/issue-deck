import { cache } from "react";

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ARTIFACT_IFRAME_SANDBOX } from "@/lib/artifact-document";
import { artifactWindowPath } from "@/lib/artifact-window";
import { getCurrentUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { readSessionArtifactDetail } from "@/lib/dispatch/session-artifacts";
import { formatDateTime } from "@/lib/format-date-time";

/**
 * アーティファクトを1件だけ表示する単独ページ（#2210）。**別ウィンドウの中身。**
 *
 * Issue詳細の重ね表示（`artifact-preview.tsx`）はIssueの本文・コメントを覆うため、見た目案と
 * 計画・指摘を見比べられない。Issue作成の別ウィンドウ（`/issues/new`・#1728）と同じく、
 * **URLを直接開いても成立するページ**にして、デッキを見ながら開いたままにできるようにする。
 *
 * 中身の配信は重ね表示と同じ`/api/issues/artifacts/<id>`で、`sandbox`付きのiframeで読む。
 * **`allow-same-origin`は付けない**（付けるとアーティファクトのJSからissue-deckのCookie・
 * localStorageが読める）。ここでHTMLを直に描かないのは、同じオリジンで出すとその隔離が
 * 丸ごと外れるため。
 */

/**
 * `generateMetadata`と本体の両方から引くので、リクエスト内で1回に畳む。
 * （Next.jsのfetchと違い、Prismaの呼び出しは自動では重複排除されない）
 */
const loadArtifact = cache(readSessionArtifactDetail);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const detail = await loadArtifact(id);
  // 別ウィンドウとして並ぶため、タイトルバー・タスクバーでデッキ本体と見分けが付く名前にする
  return { title: detail ? `${detail.artifact.title} | IssueDeck` : "アーティファクト | IssueDeck" };
}

export default async function ArtifactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const currentUser = await getCurrentUser();
  // 未ログインはproxy（middleware）が/loginへ送るが、Cookieが無効な場合等の保険として塞ぐ。
  // **戻り先にこのページを渡す**——URLを送られて開いた人が、ログイン後に見たいものへ着く
  if (!currentUser) redirect(`/login?callbackUrl=${encodeURIComponent(artifactWindowPath(id))}`);

  const detail = await loadArtifact(id);
  if (!detail) return <ArtifactMissing />;

  const { artifact, repositoryFullName, issueNumber } = detail;
  // デッキで該当Issueを開くための識別子。**参照できるインストール配下に限る**（見えない
  // Issueへのリンクを出しても、開いた先で選択できない）
  const issue = await db.issue.findFirst({
    where: {
      number: issueNumber,
      repository: {
        fullName: repositoryFullName,
        installation: { userInstallations: { some: { userId: currentUser.id } } },
      },
    },
    select: { githubIssueId: true },
  });
  // PC（`issue`）とスマホ（`mscreen`・`missue`）で現在地の持ち方が違うので両方載せる
  // （`useReferenceNavigation.openIssue`が組み立てるURLと同じ形）
  const issueId = issue ? String(issue.githubIssueId) : null;
  const deckHref = issueId
    ? `/dashboard?issue=${issueId}&mscreen=issue-detail&missue=${issueId}`
    : null;

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      {/* **見出しは1行だけ。** 縦はアーティファクトに明け渡す（見に来た人が読みたいのは中身） */}
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-sm font-semibold">
            {artifact.favicon ? `${artifact.favicon} ` : ""}
            {artifact.title}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {formatDateTime(artifact.publishedAt)}
            {artifact.hostName ? ` · ${artifact.hostName}` : ""}
            {` · ${repositoryFullName} #${issueNumber}`}
          </p>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* 別ウィンドウから元の話へ戻れないと、URLを送られた側が迷子になる */}
          {deckHref && (
            <Button asChild variant="outline" size="sm">
              <Link href={deckHref} target="_blank" rel="noreferrer">
                Issueを開く
              </Link>
            </Button>
          )}
          {artifact.claudeUrl && (
            <Button asChild variant="outline" size="sm">
              <a href={artifact.claudeUrl} target="_blank" rel="noreferrer">
                claude.ai
                <ExternalLink data-icon="inline-end" />
              </a>
            </Button>
          )}
        </div>
      </header>

      <iframe
        src={`/api/issues/artifacts/${artifact.id}`}
        title={artifact.title}
        sandbox={ARTIFACT_IFRAME_SANDBOX}
        className="min-h-0 flex-1 border-0 bg-white"
      />

      {/* **忠実度の断りを画面に出す**（重ね表示と同じ文言）。ここに出るのは公開時のHTMLを
          issue-deckが包み直したもので、claude.aiが足しているmermaidの描画とランタイム機能は無い */}
      <p className="shrink-0 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        claude.aiでの見え方とは細部が異なります（mermaid図・保存機能は再現されません）。
      </p>
    </main>
  );
}

/**
 * 見つからないときの表示。**Next.jsの既定の404にしない**——このページは素の別ウィンドウとして
 * 開かれるので、戻る先が無いと行き止まりになる。
 */
function ArtifactMissing() {
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground">
      <p className="text-sm">このアーティファクトは見つかりませんでした。</p>
      <p className="max-w-prose text-xs text-muted-foreground">
        保持する件数の上限（1つのIssueにつき20件）を超えて消えたか、URLが違う可能性があります。
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href="/dashboard">デッキへ戻る</Link>
      </Button>
    </main>
  );
}
