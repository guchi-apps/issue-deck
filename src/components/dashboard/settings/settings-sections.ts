import { Activity, Boxes, Eye, History, SlidersHorizontal, UserRound } from "lucide-react";

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
