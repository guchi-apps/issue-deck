import type { MobileBottomNavTab } from "@/components/dashboard/mobile-bottom-nav";
import type { MobileScreen } from "@/hooks/use-mobile-screen";

// ドリルダウン先の画面（リポジトリ別Issue一覧・Issue詳細）でも、どのタブから辿ってきたかを
// ボトムナビでハイライトする。以前は一律で「ホーム」を点灯させており、リポジトリタブから
// 開いたのにホームが選択中に見える不整合があった（#414）。
export function resolveBottomNavTab(screen: MobileScreen): MobileBottomNavTab {
  switch (screen.kind) {
    case "home":
    case "settings":
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
    // 辿ってきた導線に合わせてホームを点灯させる。
    case "issues":
      return "home";
    // 「ブランチ」画面もホームからのドリルダウン（#1455）。PRタブを点灯させると
    // タブが開く画面（PR一覧）と表示中の画面が食い違うため、辿ってきたホームを点灯させる。
    case "flow":
      return "home";
    case "issue-detail":
      return resolveBottomNavTab(screen.back);
  }
}
