import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "IssueDeck",
    short_name: "IssueDeck",
    description: "複数のGitHubリポジトリのIssueを横断して確認・整理できるWebアプリ",
    // ホーム画面のアイコンから開く先。"/"はリダイレクトを1回挟むぶん起動が遅く、
    // その間は白い画面になるため直接ダッシュボードを開く（#1978）。未ログインなら
    // middlewareがログイン画面へ送る。
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#171717",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
