"use client";

import { ExternalLink, Image as ImageIcon, RotateCcw } from "lucide-react";

import { useArtifactPreview } from "@/components/dashboard/artifact-preview";
import { IssueDetailSection } from "@/components/dashboard/issue-detail-section";
import type { SessionArtifactView } from "@/lib/dispatch/session-artifact";
import { formatRelativeDate } from "@/lib/format-relative-date";

/**
 * Issue詳細の「アーティファクト」セクション（#2154）。
 *
 * セッションが`Artifact`ツールで公開した見た目案を、**claude.aiへ遷移せずにその場で開く**
 * ための入口。1件も無いIssueでは何も出さない（大半のIssueはアーティファクトを作らない）。
 *
 * 畳めるセクションにしているのは、対応PR・子Issueと同じ「補助情報」だからで、
 * 主役の説明・コメントより前に場所を取らせない（#1577の作り）。
 */
export function IssueArtifactSection({
  artifacts,
  onReload,
  idPrefix,
}: {
  artifacts: SessionArtifactView[];
  onReload: () => void;
  /** PC版とスマホ版が同時にDOMへ乗るので、開閉の保存キーを分ける */
  idPrefix: string;
}) {
  if (artifacts.length === 0) return null;

  return (
    <IssueDetailSection
      id={`${idPrefix}-artifacts`}
      title="アーティファクト"
      count={artifacts.length}
      summary={<span className="truncate text-xs text-muted-foreground">{artifacts[0].title}</span>}
    >
      <ul className="space-y-2">
        {artifacts.map((artifact) => (
          <ArtifactCard key={artifact.id} artifact={artifact} />
        ))}
      </ul>

      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>公開時のHTMLをissue-deckが保存したものです。</span>
        <button
          type="button"
          onClick={onReload}
          className="inline-flex shrink-0 items-center gap-1 underline underline-offset-4 hover:text-foreground"
        >
          <RotateCcw className="size-3" />
          更新
        </button>
      </div>
    </IssueDetailSection>
  );
}

function ArtifactCard({ artifact }: { artifact: SessionArtifactView }) {
  const preview = useArtifactPreview();

  return (
    <li className="relative rounded-md border transition-colors hover:bg-accent/50">
      {/* カード全面を選択用のボタンにし、本文はその兄弟に置く（`issue-list.tsx`と同じ作り）。
          本文ごと`<button>`で包むと、中にclaude.aiへのリンクを置けない */}
      <button
        type="button"
        onClick={() => preview?.open(artifact)}
        aria-label={`${artifact.title} をアプリ内で開く`}
        className="absolute inset-0 z-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      <div className="pointer-events-none relative z-10 flex items-start gap-2 p-3">
        <span aria-hidden className="mt-0.5 shrink-0 text-base leading-none">
          {artifact.favicon ?? <ImageIcon className="size-4 text-muted-foreground" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{artifact.title}</p>
          {artifact.description && (
            <p className="truncate text-xs text-muted-foreground">{artifact.description}</p>
          )}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatRelativeDate(artifact.publishedAt)}
            {artifact.hostName ? ` · ${artifact.hostName}` : ""}
          </p>
        </div>
        {artifact.claudeUrl && (
          <a
            href={artifact.claudeUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            aria-label={`${artifact.title} をclaude.aiで開く`}
            className="pointer-events-auto shrink-0 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
    </li>
  );
}
