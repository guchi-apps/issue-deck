import type { MobileBottomNavTab } from "@/components/dashboard/mobile-bottom-nav";
import type { MobileScreen } from "@/hooks/use-mobile-screen";

// ドリルダウン先の画面（リポジトリ別Issue一覧・Issue詳細）でも、どのタブから辿ってきたかを
// ボトムナビでハイライトする。以前は一律で「ホーム」を点灯させており、リポジトリタブから
// 開いたのにホームが選択中に見える不整合があった（#414）。
export function resolveBottomNavTab(screen: MobileScreen): MobileBottomNavTab {
  switch (screen.kind) {
    case "repo-detail":
      return "repos";
    case "issue-detail":
      return resolveBottomNavTab(screen.back);
    default:
      return screen.kind;
  }
}
