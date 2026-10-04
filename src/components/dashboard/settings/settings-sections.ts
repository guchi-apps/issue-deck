import {
  Activity,
  Bell,
  BookOpen,
  Boxes,
  Bot,
  Eye,
  History,
  Image as ImageIcon,
  Play,
  Repeat2,
  Database,
  UserRound,
} from "lucide-react";

/**
 * 設定の区分（#1539）。**唯一の定義がここ**で、PCの左タブとスマホの一覧が同じ配列を読む。
 *
 * 区分は保存方式ではなく、利用者が設定したい目的で分ける。PCの左タブとスマホの
 * 一覧は、この定義とグループ定義を共通で読む。
 *
 * 「表示」（#1552）は**ユーザーごとの画面の見え方**に限定し、切り替えた時点で
 * 即座に効く設定を扱う。AI・実行や管理系の設定とは責務を分ける。
 *
 * 「更新履歴」（#1764）は設定値を持たない読むだけの区分。バージョン表示（`AppVersionButton`）が
 * 区分の外に常設されており、そこから入る先でもある。
 *
 * 「ストレージ」（#2462）はIssueDeckが保持する画像の容量・保持・削除を扱う。
 * 自動削除（#2475）のON/OFFと保持日数は従来どおりその場で保存する。
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
    description: "Issueを作った後に開く画面",
  },
  {
    key: "notification",
    label: "通知",
    icon: Bell,
    description: "閉じているときのPush通知",
  },
  {
    key: "ai-models",
    label: "AI・モデル",
    icon: Bot,
    description: "処理ごとの担当エージェントとモデル",
  },
  {
    key: "execution",
    label: "実行",
    icon: Play,
    description: "同時実行、フェイルオーバー、エラー処理",
  },
  {
    key: "automation",
    label: "自動化",
    icon: Repeat2,
    description: "計画、レビュー、リリースの自動処理",
  },
  {
    key: "repositories",
    label: "リポジトリ",
    icon: Database,
    description: "表示するリポジトリとIssue作成対象の管理",
  },
  {
    key: "fleet",
    label: "フリート",
    icon: Boxes,
    description: "GitHubへの再取得・配布・同期と、認証情報の管理",
  },
  {
    key: "images",
    label: "ストレージ",
    icon: ImageIcon,
    description: "添付した画像の容量・使用状況・自動削除",
  },
  {
    key: "status",
    label: "システム状態",
    icon: Activity,
    description: "GitHubの障害情報",
  },
  {
    key: "knowledge",
    label: "共通知識",
    icon: BookOpen,
    description: "フリートの知見メモと、共有知識にたまった知見（反映PRは自動でマージされます）",
  },
  {
    key: "changelog",
    label: "更新履歴",
    icon: History,
    description: "これまでの更新内容",
  },
] as const;

export type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number]["key"];

export const SETTINGS_SECTION_GROUPS = [
  { label: "一般", keys: ["display", "notification"] },
  { label: "AI・実行", keys: ["ai-models", "execution", "automation"] },
  { label: "管理", keys: ["repositories", "fleet", "images", "knowledge"] },
  { label: "情報", keys: ["status", "changelog"] },
] as const satisfies ReadonlyArray<{ label: string; keys: readonly SettingsSectionKey[] }>;

/**
 * 区分の一覧（PCの左タブ・スマホの一覧）に並べるもの（#3744）。「アカウント」は一覧に並べず、
 * アカウント名の行を押して開く。定義（`SETTINGS_SECTIONS`）には残してあるので、見出し・説明文・
 * 戻る先の判定は全区分から引ける。
 */
export const SETTINGS_LIST_SECTIONS = SETTINGS_SECTIONS.filter((item) => item.key !== "account");

export const DEFAULT_SETTINGS_SECTION: SettingsSectionKey = "ai-models";
