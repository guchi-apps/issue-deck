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
  | "database_name_required";

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
  };
}
