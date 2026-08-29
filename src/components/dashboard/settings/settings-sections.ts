import {
  Activity,
  Bell,
  Boxes,
  Eye,
  History,
  Image as ImageIcon,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";

/**
 * 設定の区分（#1539）。**唯一の定義がここ**で、PCの左タブとスマホの一覧が同じ配列を読む。
 *
 * 区分は機能の「性質」で割っている。設定値（保存を押すまで効かない）と即時実行
 * （押した瞬間にGitHub Actionsが走る）が同じ画面に混ざっていたことが、
 * 「保存ボタンがどこまで効くのか分からない」という元の問題だった。
 *
 * 「表示」（#1552）はそのどちらでもない**ユーザーごとの画面の見え方**で、切り替えた時点で
 * 即座に効き、GitHub側には何も起こらない。実行設定・フリート運用のどちらへ混ぜても
 * 区分の説明と食い違うため、別区分にしている。
 *
 * 「更新履歴」（#1764）は設定値を持たない読むだけの区分。バージョン表示（`AppVersionButton`）が
 * 区分の外に常設されており、そこから入る先でもある。
 *
 * 「画像」（#2462）は保存を押すまで効かない値を持たず、押した瞬間に**このアプリが持つデータ**を
 * 消す。GitHubへ操作が飛ぶ「フリート運用」とは効く先が違うため別区分にし、その隣へ置いている。
 * **自動削除の設定（#2475）もこの性質を崩さない**——ON/OFFと保持日数は切り替えた時点で保存し、
 * 「実行設定」の保存ボタンには載せない（保存ボタンを持つのはあちらだけ、という切り分けを保つ）。
 *
 * 「通知」（#838）は**端末ごとに効く設定**で、他のどの区分とも性質が違う。保存を押すまで
 * 効かない値でも、押した瞬間に走る操作でもなく、この端末のブラウザに許可と購読を作る。
 * 見る場所は「表示」（ユーザーごとの見え方）に近いので、その隣に置く。
 */
export const SETTINGS_SECTIONS = [
  { key: "account", label: "アカウント", icon: UserRound, description: "ログイン中のアカウント" },
  {
    key: "display",
    label: "表示",
    icon: Eye,
    description: "画面に出すリポジトリ",
  },
  {
    key: "notification",
    label: "通知",
    icon: Bell,
    description: "閉じているときのPush通知",
  },
  {
    key: "execution",
    label: "実行設定",
    icon: SlidersHorizontal,
    description: "保存すると次回の実行から効く値",
  },
  {
    key: "fleet",
    label: "フリート運用",
    icon: Boxes,
    description: "押すとその場で走る操作",
  },
  {
    key: "images",
    label: "画像",
    icon: ImageIcon,
    description: "添付した画像の容量・使用状況・自動削除",
  },
  { key: "status", label: "状態", icon: Activity, description: "使用量と障害状況" },
  {
    key: "changelog",
    label: "更新履歴",
    icon: History,
    description: "これまでの更新内容",
  },
] as const;

export type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number]["key"];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionKey = "execution";
