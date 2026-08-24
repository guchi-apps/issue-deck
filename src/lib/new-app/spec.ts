/**
 * 新規アプリ立ち上げの「決めごと」を表す型と、そこから機械的に決まる値の導出（#2188）。
 *
 * **このファイルは純粋関数だけにする。** ウィザードのコンポーネントが直接importするため、
 * `lib/github/`（`issues-api.ts`を辿ると`node:async_hooks`へ届く）を読んではいけない
 * （docs/code-map.md「`lib/github/issues-api.ts`を辿るモジュールを、クライアント
 * コンポーネントからimportしない」）。GitHubや`guchi-apps/vps`を読む処理は
 * `lib/github/vps-inventory-api.ts`側に置く。
 *
 * 値の決め方の正は共有知識（`_docs/standards/ports.md`・`database.md`・
 * `guides/new-app-checklist.md`）で、ここはそれを写したもの。ずれたら共有知識側を正とする。
 */

/** リポジトリを作るorganization。 */
export const NEW_APP_ORG = "guchi-apps";

/** 公開URLのベースドメイン。 */
export const NEW_APP_BASE_DOMAIN = "gucchii.com";

/** 立ち上げの決めごとを1本のIssueへまとめる先。 */
export const NEW_APP_PARENT_REPOSITORY = "guchi-apps/issue-deck";

/** Apacheの設定を管理しているリポジトリ。 */
export const NEW_APP_VPS_REPOSITORY = "guchi-apps/vps";

/**
 * アプリの種別。共有ワークフローの`runtime-setup`とほぼ1対1で対応する。
 */
export type NewAppKind = "next-db" | "next" | "fastapi" | "static";

/** ログインの方式。 */
export type NewAppAuth = "none" | "supabase-google" | "fastapi-google";

/** 公開URLの取り方（`_docs/guides/apache-domain-setup.md`「ルーティングの2パターン」）。 */
export type NewAppUrlMode = "subdomain" | "path";

/**
 * アイコンとテーマカラーの決め方（#2254）。
 *
 * **既定は`provisional`（暫定で始める）。** `aide-bot`では実装エージェントが標準方針に従って
 * PWA対応まで行ったが、アイコンのデザインもテーマカラー（`#0f766e`）も人が決めていなかった。
 * 暫定で始めること自体は妥当なので、**暫定だと分かる形で残す**（親Issueの「後で決めること」）。
 */
export type NewAppIconPlan = "provisional" | "prepared";

/** テーマカラーの既定値。ニュートラルな濃紺で、決めていないことが色から分からなくならないようにする。 */
export const NEW_APP_DEFAULT_THEME_COLOR = "#0f172a";

/** 画面に出す色見本。ここから選ぶか、`#rrggbb`を直接入れる。 */
export const NEW_APP_THEME_COLOR_PRESETS = [
  NEW_APP_DEFAULT_THEME_COLOR,
  "#0f766e",
  "#1d4ed8",
  "#b45309",
  "#9d174d",
];

export type NewAppSpec = {
  /** 画面やIssueのタイトルに出る名前。日本語でよい */
  displayName: string;
  /** `guchi-apps/<これ>`。ASCIIのケバブケース */
  repositoryName: string;
  visibility: "public" | "private";
  /** 1行の概要。リポジトリのdescriptionにもなる */
  summary: string;
  kind: NewAppKind;
  urlMode: NewAppUrlMode;
  /** `urlMode`が`subdomain`のときのホスト名の先頭（`kakei-report` → `kakei-report.gucchii.com`） */
  subdomain: string;
  /** `urlMode`が`path`のときのパス（`kakei-report` → `gucchii.com/kakei-report`） */
  basePath: string;
  /** 本番ポート。常駐プロセスを持たない静的サイトでは`null` */
  port: number | null;
  /** MariaDBのDB名。DBを使わないなら`null` */
  databaseName: string | null;
  auth: NewAppAuth;
  /** マルチエージェント運用（issue-deck）に対応させるか */
  multiAgent: boolean;

  // --- 体裁と運用（#2254）。**すべて既定値を持ち、開かずに次へ進める** ---

  /**
   * ブラウザのタブとホーム画面に出る名前（`title` / `applicationName` / `appleWebApp.title`）。
   * **空ならアプリ名をそのまま使う**（`appTitleFor`）。
   */
  appTitle: string;
  /** PWA対応（`manifest`＋アイコン）するか。標準は対応する */
  pwa: boolean;
  /** オフライン対応（Service Workerでのキャッシュ）するか。標準は対応しない */
  offline: boolean;
  /** アイコンとテーマカラーを暫定で始めるか、用意してから始めるか */
  iconPlan: NewAppIconPlan;
  /** テーマカラー（`#rrggbb`） */
  themeColor: string;
  /** 更新履歴（changelog）を持つか */
  changelog: boolean;
  /**
   * CI撮影の認証バイパス（開発用ログイン＋ダミーデータ）を用意するか。
   * **認証が無いアプリでは意味を持たない**ので、読むときは`screenshotBypassEnabled`を使う。
   */
  screenshotBypass: boolean;
};

/** 種別ごとに決まる値。ウィザードの既定値と、生成するIssueの本文の両方が読む。 */
export type NewAppKindProfile = {
  label: string;
  /** 共有ワークフロー`claude-issue-dispatch.yml`の`runtime-setup` */
  runtimeSetup: "node-db" | "node" | "minimal";
  packageManager: "pnpm" | "npm";
  usesDatabase: boolean;
  /** 常駐プロセスを持つか（＝ポートとプロセス管理が要るか） */
  usesPort: boolean;
  /** ポートの割り当て範囲（`_docs/standards/ports.md`） */
  portRange: { from: number; to: number } | null;
  /** vps READMEのアプリ一覧に書くプロセス管理方式 */
  processManager: string;
};

const KIND_PROFILES: Record<NewAppKind, NewAppKindProfile> = {
  "next-db": {
    label: "Next.js + DB",
    runtimeSetup: "node-db",
    packageManager: "pnpm",
    usesDatabase: true,
    usesPort: true,
    portRange: { from: 3101, to: 3199 },
    processManager: "PM2",
  },
  next: {
    label: "Next.js",
    runtimeSetup: "node",
    packageManager: "pnpm",
    usesDatabase: false,
    usesPort: true,
    portRange: { from: 3101, to: 3199 },
    processManager: "PM2",
  },
  fastapi: {
    label: "FastAPI",
    runtimeSetup: "minimal",
    packageManager: "npm",
    usesDatabase: true,
    usesPort: true,
    portRange: { from: 8003, to: 8099 },
    processManager: "PM2",
  },
  static: {
    label: "静的サイト",
    runtimeSetup: "minimal",
    packageManager: "npm",
    usesDatabase: false,
    usesPort: false,
    portRange: null,
    processManager: "Apache DocumentRoot（静的ファイル）",
  },
};

export function newAppKindProfile(kind: NewAppKind): NewAppKindProfile {
  return KIND_PROFILES[kind];
}

export const NEW_APP_KINDS: NewAppKind[] = ["next-db", "next", "fastapi", "static"];

export const NEW_APP_AUTH_LABELS: Record<NewAppAuth, string> = {
  none: "なし",
  "supabase-google": "Supabase Auth（Google）",
  "fastapi-google": "FastAPI + Google OAuth",
};

/**
 * 表示名からリポジトリ名の候補を作る。
 *
 * **ASCIIに落ちない名前（日本語だけの名前）では空文字を返す。** 無理に読みを当てると
 * 「kakeireport」のような誤った綴りが既定値として入り、直さないまま作られる。相談ステップの
 * 仕様案か、人の入力で決めてもらう。
 */
export function slugifyRepositoryName(displayName: string): string {
  const ascii = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii;
}

/** GitHubのリポジトリ名として使えるか。 */
export function isValidRepositoryName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) && name.length <= 80;
}

/** サブドメインの先頭（ラベル）として使えるか。ドットを含む多段（`klondike.game`）も許す。 */
export function isValidSubdomain(value: string): boolean {
  if (!value || value.length > 60) return false;
  return value
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

/**
 * DB名（`_docs/standards/database.md`。`app_{PJ名}`）。
 *
 * MySQLの識別子にハイフンは使えないため、リポジトリ名の`-`は`_`にする。
 */
export function databaseNameFor(repositoryName: string): string {
  return `app_${repositoryName.replace(/-/g, "_")}`;
}

/** 公開するホスト名（`urlMode`が`path`のときはベースドメインそのもの）。 */
export function hostnameFor(spec: Pick<NewAppSpec, "urlMode" | "subdomain">): string {
  if (spec.urlMode === "path") return NEW_APP_BASE_DOMAIN;
  return `${spec.subdomain}.${NEW_APP_BASE_DOMAIN}`;
}

/** 画面とIssue本文に出す公開URL。 */
export function publicUrlFor(spec: Pick<NewAppSpec, "urlMode" | "subdomain" | "basePath">): string {
  if (spec.urlMode === "path") return `https://${NEW_APP_BASE_DOMAIN}/${spec.basePath}`;
  return `https://${hostnameFor(spec)}/`;
}

/** vps READMEのアプリ一覧に書く「ドメイン / ポート」欄の値。 */
export function vpsAppListLocation(
  spec: Pick<NewAppSpec, "urlMode" | "subdomain" | "basePath" | "port">,
): string {
  const place =
    spec.urlMode === "path"
      ? `${NEW_APP_BASE_DOMAIN}/${spec.basePath}`
      : hostnameFor(spec);
  return spec.port === null ? place : `${place} / ${spec.port}`;
}

/** テーマカラーとして使えるか（`#rrggbb`）。3桁の短縮形は`manifest`で扱いが揺れるので許さない。 */
export function isValidThemeColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

/** 実際に`title`へ入る表示名。**空欄はアプリ名で埋める**（入力を必須にしない）。 */
export function appTitleFor(spec: Pick<NewAppSpec, "appTitle" | "displayName">): string {
  return spec.appTitle.trim() || spec.displayName.trim();
}

/**
 * オフライン対応を実施するか。**PWA対応しないアプリでは成立しない**（Service Workerだけ
 * 置いても、ホーム画面へ追加する導線が無い）。
 */
export function offlineEnabled(spec: Pick<NewAppSpec, "pwa" | "offline">): boolean {
  return spec.pwa && spec.offline;
}

/**
 * CI撮影の認証バイパスを用意するか。**認証が無いアプリでは迂回するものが無い**ため、
 * チェックの値によらず不要とする。
 */
export function screenshotBypassEnabled(
  spec: Pick<NewAppSpec, "auth" | "screenshotBypass">,
): boolean {
  return spec.auth !== "none" && spec.screenshotBypass;
}

/**
 * 無人実行のスクリーンショット（`24.screenshot-required`）が成立する種別か。
 *
 * **`runtime-setup: minimal`（FastAPI・静的サイト）ではPlaywrightがインストールされない**ため、
 * バイパスを用意しても無人では撮れない（`docs/cross-repo-setup-guide.md`「なお`minimal`では
 * Playwrightがインストールされないため、`24.screenshot-required`は無人実行では成立しない」）。
 * バイパス自体はローカルでの画面確認に効くので、**用意しないのではなく用途を断って書く**。
 */
export function supportsUnattendedScreenshot(kind: NewAppKind): boolean {
  return newAppKindProfile(kind).runtimeSetup !== "minimal";
}

/**
 * 体裁と運用が標準どおりか。畳んだパネルの「標準どおり」バッジの出し分けに使う。
 * **表示名は標準の判定に含めない**——アプリ名と同じかどうかは体裁の逸脱ではない。
 */
export function isAppearanceDefault(spec: NewAppSpec): boolean {
  const base = emptyNewAppSpec();
  return (
    spec.pwa === base.pwa &&
    spec.offline === base.offline &&
    spec.iconPlan === base.iconPlan &&
    spec.themeColor.toLowerCase() === base.themeColor.toLowerCase() &&
    spec.changelog === base.changelog &&
    spec.screenshotBypass === base.screenshotBypass
  );
}

/**
 * 決めた体裁を1行にまとめた文。畳んだパネルと確認ステップの両方が同じ文を出す
 * （**開かずに通した人も、押す前に決まった値を読める**ようにするため）。
 */
export function appearanceSummary(spec: NewAppSpec): string {
  const parts = [
    `表示名「${appTitleFor(spec) || "（アプリ名）"}」`,
    spec.pwa
      ? `アイコンとテーマカラーは${spec.iconPlan === "provisional" ? "暫定" : "用意する"}（${spec.themeColor}）`
      : "アイコンは用意しない",
    spec.pwa ? `PWA対応・オフライン${offlineEnabled(spec) ? "あり" : "なし"}` : "PWA対応しない",
    `更新履歴${spec.changelog ? "あり" : "なし"}`,
    spec.auth === "none"
      ? "CI撮影の認証バイパスは不要（認証なし）"
      : screenshotBypassEnabled(spec)
        ? `CI撮影の認証バイパスあり${supportsUnattendedScreenshot(spec.kind) ? "" : "（ローカル実行専用）"}`
        : "CI撮影の認証バイパスなし",
  ];
  return parts.join("／");
}

/**
 * 種別を選び直したときの既定値。**人が触った値は上書きしない**ため、呼び出し側で
 * 差し替えるのは「その種別では意味を持たなくなる値」だけにする。
 */
export function defaultsForKind(
  kind: NewAppKind,
  repositoryName: string,
): Pick<NewAppSpec, "databaseName" | "port"> {
  const profile = newAppKindProfile(kind);
  return {
    databaseName: profile.usesDatabase && repositoryName ? databaseNameFor(repositoryName) : null,
    port: null,
  };
}

export type NewAppSpecError =
  | "display_name_required"
  | "repository_name_required"
  | "repository_name_invalid"
  | "subdomain_required"
  | "subdomain_invalid"
  | "base_path_required"
  | "port_required"
  | "port_out_of_range"
  | "database_name_required"
  | "theme_color_invalid";

export const NEW_APP_SPEC_ERROR_MESSAGES: Record<NewAppSpecError, string> = {
  display_name_required: "アプリ名を入力してください。",
  repository_name_required: "リポジトリ名を入力してください。",
  repository_name_invalid:
    "リポジトリ名は英小文字・数字・ハイフンで、先頭と末尾はハイフン以外にしてください。",
  subdomain_required: "サブドメインを入力してください。",
  subdomain_invalid:
    "サブドメインは英小文字・数字・ハイフンで、先頭と末尾はハイフン以外にしてください。",
  base_path_required: "配置するパスを入力してください。",
  port_required: "本番ポートを決めてください。",
  port_out_of_range: "本番ポートが種別ごとの割り当て範囲から外れています。",
  database_name_required: "データベース名を入力してください。",
  theme_color_invalid: "テーマカラーは `#rrggbb` の形式で入力してください。",
};

/**
 * 立ち上げを始められる状態かを見る。**GitHubやvpsを見ないと分からないこと
 * （リポジトリ名の空き・ポートの重複）はここでは判定しない**——あちらは
 * `preflight`が実物を読んで返す。ここは形式だけを見る。
 */
export function validateNewAppSpec(spec: NewAppSpec): NewAppSpecError[] {
  const errors: NewAppSpecError[] = [];
  const profile = newAppKindProfile(spec.kind);

  if (!spec.displayName.trim()) errors.push("display_name_required");

  if (!spec.repositoryName) errors.push("repository_name_required");
  else if (!isValidRepositoryName(spec.repositoryName)) errors.push("repository_name_invalid");

  if (spec.urlMode === "subdomain") {
    if (!spec.subdomain) errors.push("subdomain_required");
    else if (!isValidSubdomain(spec.subdomain)) errors.push("subdomain_invalid");
  } else if (!spec.basePath.trim()) {
    errors.push("base_path_required");
  }

  if (profile.usesPort) {
    if (spec.port === null) errors.push("port_required");
    else if (
      profile.portRange &&
      (spec.port < profile.portRange.from || spec.port > profile.portRange.to)
    ) {
      errors.push("port_out_of_range");
    }
  }

  if (profile.usesDatabase && !spec.databaseName) errors.push("database_name_required");

  // テーマカラーは`manifest`へそのまま入るので、PWA対応するときだけ形式を見る
  if (spec.pwa && !isValidThemeColor(spec.themeColor)) errors.push("theme_color_invalid");

  return errors;
}

/** 空のウィザードの初期値。 */
export function emptyNewAppSpec(): NewAppSpec {
  return {
    displayName: "",
    repositoryName: "",
    visibility: "private",
    summary: "",
    kind: "next-db",
    urlMode: "subdomain",
    subdomain: "",
    basePath: "",
    port: null,
    databaseName: null,
    auth: "none",
    multiAgent: true,
    appTitle: "",
    pwa: true,
    offline: false,
    iconPlan: "provisional",
    themeColor: NEW_APP_DEFAULT_THEME_COLOR,
    changelog: true,
    screenshotBypass: true,
  };
}
