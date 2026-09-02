import type { MobileBottomNavTab } from "@/components/dashboard/mobile-bottom-nav";
import type { MobileScreen } from "@/hooks/use-mobile-screen";

// ドリルダウン先の画面（リポジトリ別Issue一覧・Issue詳細）でも、どのタブから辿ってきたかを
// ボトムナビでハイライトする。以前は一律で「ホーム」を点灯させており、リポジトリタブから
// 開いたのにホームが選択中に見える不整合があった（#414）。**#2724でそのリポジトリタブ自体を
// 外したため、Issue・PR系の画面は再び「ホーム」の枝に戻っている**（辿り方が変わったのであって、
// #414の「開いたタブと点灯が食い違う」状態に戻したわけではない）。
//
// **`null`はどのタブも点灯させない**（#1638）。フッターに対応するタブが無い画面（設定）がある。
export function resolveBottomNavTab(screen: MobileScreen): MobileBottomNavTab | null {
  switch (screen.kind) {
    case "home":
      return screen.kind;
    // Issue・Pull Requestに関わる画面は、#2724でフッターのタブ（「Issue」＝リポジトリ一覧・
    // 「PR」）を外したため、どれもホームのメニューからのドリルダウンになった。全リポジトリ
    // 横断のIssue一覧が#1436からそう扱われているのと同じで、辿ってきた導線に合わせて
    // 「ホーム」を点灯させる。**`null`（どのタブも点灯させない）にはしない**——設定・確認環境と
    // 揃うが、いま自分がどの枝にいるのかが画面から消える。
    case "repos":
    case "repo-detail":
    case "pull-requests":
    case "issues":
      return "home";
    // 「ブランチ」画面は#1455ではホームからのドリルダウンだったが、#1638でタブになった
    case "flow":
      return "flow";
    // AI使用量は#2504ではホームのメニューからのドリルダウンだったが、#2631でフッターの
    // 5枠目を持つようになった
    case "usage":
      return "usage";
    // 設定はフッターから外し、ホームのヘッダー右上から開く画面になった（#1638）。
    // 確認環境（#2444）も同じくホームのメニューからのドリルダウンで、タブを持たない。
    // どちらも対応するタブが無いので点灯させない。リリース履歴（#2726）も同じくホームの
    // メニューからのドリルダウンだけで開き、タブを持たない。
    case "settings":
    case "preview":
    case "release-history":
      return null;
    case "issue-detail":
      return resolveBottomNavTab(screen.back);
  }
}
