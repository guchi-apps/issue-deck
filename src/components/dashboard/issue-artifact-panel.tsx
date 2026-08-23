"use client";

import {
  ExternalLink,
  Image as ImageIcon,
  Palette,
  RotateCcw,
  SquareArrowOutUpRight,
} from "lucide-react";

import { useArtifactPreview } from "@/components/dashboard/artifact-preview";
import { ARTIFACT_IFRAME_SANDBOX } from "@/lib/artifact-document";
import { artifactWindowPath, openArtifactWindow } from "@/lib/artifact-window";
import type { SessionArtifactView } from "@/lib/dispatch/session-artifact";
import { formatRelativeDate } from "@/lib/format-relative-date";

/**
 * Issue詳細の「アーティファクト」カード（#2154・#2190）。
 *
 * セッションが`Artifact`ツールで公開した見た目案を、**claude.aiへ遷移せずにその場で開く**
 * ための入口。1件も無いIssueでは何も出さない（大半のIssueはアーティファクトを作らない）。
 *
 * **畳めるセクション（`IssueDetailSection`）ではなく独立したカードにしている**（#2190）。
 * 対応PR・子Issueと同じ「補助情報」の扱いにしていたが、`25.artifact-required`のIssueでは
 * これ自体が承認の対象で、畳まれていると開くまでどの案なのかが分からない。1件でもあれば
 * 常に開いたまま、サムネイルと開く導線を出す。
 */
export function IssueArtifactPanel({
  artifacts,
  onReload,
}: {
  artifacts: SessionArtifactView[];
  onReload: () => void;
}) {
  if (artifacts.length === 0) return null;

  return (
    <section className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Palette className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-medium">アーティファクト</h3>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
          {artifacts.length}
        </span>
        <button
          type="button"
          onClick={onReload}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <RotateCcw className="size-3" />
          更新
        </button>
      </div>

      <ul className="flex flex-col gap-2">
        {artifacts.map((artifact, index) => (
          <ArtifactCard
            key={artifact.id}
            artifact={artifact}
            // **サムネイルは新しい方から数件だけ**。1件が数百KBのHTMLをiframeで実際に開くので、
            // 上限（20件）まで並べると、Issueを開いただけでその全部を取りに行くことになる
            withThumbnail={index < THUMBNAIL_LIMIT}
          />
        ))}
      </ul>

      <p className="text-xs text-muted-foreground">
        公開時のHTMLをissue-deckが保存したものです。claude.aiでの見え方とは細部が異なります。
      </p>
    </section>
  );
}

/** サムネイルを出す件数。これを超えた古いものはアイコンだけにする。 */
const THUMBNAIL_LIMIT = 6;

function ArtifactCard({
  artifact,
  withThumbnail,
}: {
  artifact: SessionArtifactView;
  withThumbnail: boolean;
}) {
  const preview = useArtifactPreview();
  const open = () => preview?.open(artifact);

  return (
    <li className="relative rounded-md border transition-colors hover:bg-accent/50">
      {/* カード全面を選択用のボタンにし、本文はその兄弟に置く（`issue-list.tsx`と同じ作り）。
          本文ごと`<button>`で包むと、中にclaude.aiへのリンクを置けない */}
      <button
        type="button"
        onClick={open}
        aria-label={`${artifact.title} をアプリ内で開く`}
        className="absolute inset-0 z-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      <div className="pointer-events-none relative z-10 flex items-start gap-2.5 p-2">
        <ArtifactThumbnail artifact={artifact} withThumbnail={withThumbnail} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {artifact.favicon ? `${artifact.favicon} ` : ""}
            {artifact.title}
          </p>
          {artifact.description && (
            <p className="truncate text-xs text-muted-foreground">{artifact.description}</p>
          )}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatRelativeDate(artifact.publishedAt)}
            {artifact.hostName ? ` · ${artifact.hostName}` : ""}
          </p>

          {/* **押せるものを文字で出す**（#2190）。カード全面が押せることは見ただけでは
              分からず、claude.aiへ逃げる導線もアイコン1つでは何のリンクか読み取れない */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={open}
              className="pointer-events-auto inline-flex items-center rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              開く
            </button>
            {/* **別ウィンドウ**（#2210）。重ね表示はIssueの本文・コメントを覆うので、
                見た目案と計画・指摘を見比べるにはウィンドウを分ける必要がある。
                `<a>`にしてあるので中クリック・URLのコピーもでき、スマホでは別タブになる */}
            <a
              href={artifactWindowPath(artifact.id)}
              target="_blank"
              rel="noreferrer"
              aria-label={`${artifact.title} を別ウィンドウで開く`}
              onClick={(event) => {
                // 修飾キー付き・左ボタン以外は「別で開きたい」意思表示なので、ブラウザに任せる
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                if (event.button !== 0) return;
                // **開けたときだけ止める。** ポップアップを止めているブラウザでは
                // リンクのまま別タブが開く（押しても何も起きない、にはしない）
                if (openArtifactWindow(artifact.id)) event.preventDefault();
              }}
              className="pointer-events-auto inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              別ウィンドウ
              <SquareArrowOutUpRight className="size-3" />
            </a>
            {artifact.claudeUrl && (
              <a
                href={artifact.claudeUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`${artifact.title} をclaude.aiで開く`}
                className="pointer-events-auto inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                claude.ai
                <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * 保存済みのHTMLを縮小して出すサムネイル（#2190）。
 *
 * **プレビューと同じ`/api/issues/artifacts/<id>`をiframeで開き、`transform`で縮める。**
 * 画像を別に作る（スクリーンショットを撮って保存する）作りにしないのは、そのために
 * ヘッドレスブラウザを常駐させることになるため。**`sandbox`は重ね表示と同じ指定**で、
 * `allow-same-origin`は付けない（付けるとアーティファクトのJSからissue-deckのCookie・
 * localStorageが読める）。
 *
 * 幅1200pxで描かせてから縮めているのは、アーティファクトがPC幅の見た目を主に持つため
 * （狭い幅で描かせるとスマホ用の縦積みだけがサムネイルに出る）。
 */
function ArtifactThumbnail({
  artifact,
  withThumbnail,
}: {
  artifact: SessionArtifactView;
  withThumbnail: boolean;
}) {
  if (!withThumbnail) {
    return (
      <span className="grid h-[66px] w-[88px] shrink-0 place-items-center rounded border bg-muted/50 sm:h-[84px] sm:w-[112px]">
        <ImageIcon className="size-4 text-muted-foreground" aria-hidden />
      </span>
    );
  }

  return (
    <span className="relative block h-[66px] w-[88px] shrink-0 overflow-hidden rounded border bg-white [--thumb-scale:0.0733] sm:h-[84px] sm:w-[112px] sm:[--thumb-scale:0.0933]">
      <iframe
        // カードを押したときに開くのはプレビュー。**サムネイル自身は操作できない**
        // （`pointer-events-none`）ので、中のリンクを押してしまうことは無い
        src={`/api/issues/artifacts/${artifact.id}`}
        title={`${artifact.title} のサムネイル`}
        aria-hidden
        tabIndex={-1}
        loading="lazy"
        sandbox={ARTIFACT_IFRAME_SANDBOX}
        className="pointer-events-none absolute top-0 left-0 h-[900px] w-[1200px] origin-top-left border-0"
        style={{ transform: "scale(var(--thumb-scale))" }}
      />
    </span>
  );
}
