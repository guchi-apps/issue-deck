import { ImageResponse } from "next/og";

import { AppIconGlyph } from "@/lib/app-icon-glyph";
import { formatShareLabel, type ShareCardInfo, type ShareKind } from "@/lib/share-card";

export const shareCardSize = { width: 1200, height: 630 };

// アプリのリポジトリ別配色（globals.cssの--pie-3 / --pie-6）に合わせる
const KIND_COLOR: Record<ShareKind, string> = { issue: "#1baf7a", pr: "#7a5bd6" };

/** カードの画像。リポジトリ名と種別・番号だけを描く。info=nullなら存在を示さない汎用カード */
export function renderShareCard(kind: ShareKind, info: ShareCardInfo | null) {
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
