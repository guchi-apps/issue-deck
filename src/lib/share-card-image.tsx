import { ImageResponse } from "next/og";

import { AppIconGlyph } from "@/lib/app-icon-glyph";
import {
  formatShareCreatedAt,
  formatShareLabel,
  normalizeShareTitle,
  SHARE_TITLE_IMAGE_MAX,
  type ShareCardInfo,
  type ShareKind,
} from "@/lib/share-card";
import { loadShareCardFonts } from "@/lib/share-card-font";

export const shareCardSize = { width: 1200, height: 630 };

// アプリのリポジトリ別配色（globals.cssの--pie-3 / --pie-6）に合わせる
const KIND_COLOR: Record<ShareKind, string> = { issue: "#1baf7a", pr: "#7a5bd6" };

/**
 * カードの画像。公開Issue（タイトルあり）はタイトルと作成日まで描く。それ以外は
 * リポジトリ名と種別・番号だけを描き、info=nullなら存在を示さない汎用カードにする。
 */
export async function renderShareCard(kind: ShareKind, info: ShareCardInfo | null) {
  const title = info?.title ? normalizeShareTitle(info.title, SHARE_TITLE_IMAGE_MAX) : "";
  if (info && kind === "issue" && title) return renderIssueCard(info, title);
  const [owner, repo] = info ? info.repositoryFullName.split("/") : ["", ""];
  const label = info ? formatShareLabel(kind, info.number) : kind === "issue" ? "Issue" : "PR";
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#171717",
          color: "#fafafa",
          padding: "72px 80px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", fontSize: 40, fontWeight: 700 }}>
          <AppIconGlyph size={64} />
          <span style={{ marginLeft: 22 }}>IssueDeck</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          {info ? (
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", fontSize: 44, color: "#a3a3a3" }}>{`${owner} /`}</div>
              <div style={{ display: "flex", fontSize: repo.length > 18 ? 64 : 84, fontWeight: 700, marginTop: 16 }}>
                {repo}
              </div>
            </div>
          ) : null}
        </div>
        <div
          style={{
            display: "flex",
            alignSelf: "flex-start",
            fontSize: 64,
            fontWeight: 700,
            color: "#ffffff",
            background: KIND_COLOR[kind],
            padding: "14px 40px",
            borderRadius: 999,
          }}
        >
          {label}
        </div>
      </div>
    ),
    shareCardSize,
  );
}

/** 公開Issueのカード（#5090）。上段にIssueDeckとリポジトリ名、中央にタイトル（3行で省略）、下段に番号と作成日 */
async function renderIssueCard(info: ShareCardInfo, title: string) {
  const [owner, repo] = info.repositoryFullName.split("/");
  const label = formatShareLabel("issue", info.number);
  const created = info.createdAt ? formatShareCreatedAt(info.createdAt) : "";
  const { fonts, fontFamily } = await loadShareCardFonts(`IssueDeck${owner} / ${repo}${title}${label}${created}…`);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#171717",
          color: "#fafafa",
          padding: "64px 80px",
          fontFamily,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", fontSize: 34, fontWeight: 700, flexShrink: 0 }}>
            <AppIconGlyph size={52} />
            <span style={{ marginLeft: 18 }}>IssueDeck</span>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 32,
              color: "#a3a3a3",
              marginLeft: 40,
              overflow: "hidden",
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
            }}
          >
            {`${owner} /`}
            <span style={{ marginLeft: 10, color: "#e5e5e5" }}>{repo}</span>
          </div>
        </div>
        {/* 3行で「…」にする。overflow:hiddenを併用すると、分割フォントの幅の測り違いで「…」が1点に切れる */}
        <div
          style={{
            display: "block",
            fontSize: 60,
            fontWeight: 700,
            lineHeight: 1.32,
            lineClamp: 3,
            wordBreak: "break-all",
          }}
        >
          {title}
        </div>
        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              fontSize: 40,
              fontWeight: 700,
              color: "#ffffff",
              background: KIND_COLOR.issue,
              padding: "8px 32px",
              borderRadius: 999,
            }}
          >
            {label}
          </div>
          {created ? <div style={{ display: "flex", marginLeft: 28, fontSize: 34, color: "#a3a3a3" }}>{created}</div> : null}
        </div>
      </div>
    ),
    { ...shareCardSize, fonts },
  );
}
