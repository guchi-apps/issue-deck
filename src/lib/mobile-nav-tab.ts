import type { MobileBottomNavTab } from "@/components/dashboard/mobile-bottom-nav";
import type { MobileScreen } from "@/hooks/use-mobile-screen";

// ドリルダウン先の画面（リポジトリ別Issue一覧・Issue詳細）でも、どのタブから辿ってきたかを
// ボトムナビでハイライトする。以前は一律で「ホーム」を点灯させており、リポジトリタブから
// 開いたのにホームが選択中に見える不整合があった（#414）。
//
// **`null`はどのタブも点灯させない**（#1638）。フッターに対応するタブが無い画面（設定）がある。
export function resolveBottomNavTab(screen: MobileScreen): MobileBottomNavTab | null {
  switch (screen.kind) {
    case "home":
      return screen.kind;
    // 「Issue」タブが開くのはリポジトリ一覧で、リポジトリ別Issue一覧はその先（#1436）
    case "repos":
    case "repo-detail":
      return "repos";
    // PR一覧は#1058ではホームからのドリルダウンだったが、#1436でタブを持つようになった
    case "pull-requests":
      return "pull-requests";
    // 全リポジトリ横断のIssue一覧はフッターから外し、ホームの「よくつかうフィルター」
    // 「保存したフィルター」「概要」からのドリルダウンだけにした（#1436）。
    // 辿ってきた導線に合わせてホームを点灯させる。#1951で「Issue」タブのリポジトリ一覧
    // からも開けるようになったため、そこから来た場合だけ「Issue」タブを点灯させる。
    case "issues":
      return screen.origin === "repos" ? "repos" : "home";
    // 「ブランチ」画面は#1455ではホームからのドリルダウンだったが、#1638でタブになった
    case "flow":
      return "flow";
    // AI使用量は#2504ではホームのメニューからのドリルダウンだったが、#2631でフッターの
    // 5枠目を持つようになった
    case "usage":
      return "usage";
    // 設定はフッターから外し、ホームのヘッダー右上から開く画面になった（#1638）。
    // 確認環境（#2444）も同じくホームのメニューからのドリルダウンで、タブを持たない。
    // どちらも対応するタブが無いので点灯させない。
    case "settings":
    case "preview":
      return null;
    case "issue-detail":
      return resolveBottomNavTab(screen.back);
  }
}
