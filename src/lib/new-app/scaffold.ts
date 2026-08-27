/**
 * 立ち上げで作るリポジトリへ、作成直後にコミットする雛形一式（#2247）。
 *
 * **なぜ雛形を先にコミットするのか。** 盤面へ載る条件は`claude-issue-dispatch.yml`が
 * デフォルトブランチにあることなのに、それを作るのが初期化Issue自身だった。そのため
 * 初期化IssueだけはサブPCのローカルセッションでしか実装できず、その前提としてcloneと
 * `local-repos.conf`への追記（手作業Issue）が要った。リポジトリを作った時点でcallerを
 * 置いてしまえば、初期化Issueも最初から無人実行で回せる。
 *
 * **雛形の正はissue-deck内に置く。**`uses:`のタグ（`workflows/vN`）と`prompts-ref`を
 * 揃え続ける必要があり、タグを切るのも配るのもissue-deck側だから。ただし
 * `.github/templates/`には置けない——本番の配布物に`.github/`は入らず、実行中の
 * Next.jsサーバーからは読めない（`deploy.yml`の`tar`を参照）。
 *
 * **issue-deck自身が実物を持っているファイルは、写しを作らずそのまま配る**
 * （`.github/scripts/signaly-notify.sh`など）。写しを置くと「実物を直したのに配られるのは
 * 古い写し」という食い違いが起こる（#2240で共有スクリプトの配布に同じ方針を採った）。
 * 実物を読むのは`lib/github/scaffold-api.ts`で、ここは**どれを配るかの宣言だけ**を持つ。
 *
 * このファイルは純粋関数だけにする（`spec.ts`・`plan.ts`と同じ理由）。
 */

import {
  ciWorkflow,
  claudeIssueDispatchCaller,
  deployWorkflow,
  issueLabelsCaller,
  releaseDevelopToMainCaller,
  syncSecretsCaller,
  versionTagCheckCaller,
} from "@/lib/new-app/scaffold-workflows";
import {
  NEW_APP_ORG,
  newAppKindProfile,
  publicUrlFor,
  type NewAppSpec,
} from "@/lib/new-app/spec";

/** 雛形として作る1ファイル。 */
export type ScaffoldFile = {
  path: string;
  content: string;
  /** 実行ビット（100755）を立てるか */
  executable?: boolean;
};

/**
 * issue-deckの実物をそのまま配るファイル。
 *
 * `source`はissue-deckの`main`から読むパスで、`path`は新しいリポジトリでの置き場
 * （原則として同じパスにする）。
 */
export type ScaffoldCopy = {
  source: string;
  path: string;
  executable?: boolean;
  /**
   * そのままでは置けない箇所の書き換え。**行を丸ごと指定して差し替える形だけ**にする
   * （部分一致で置換すると、コメント中の同じ語まで書き換わる）。
   * `anchor`が見つからない場合は配布側が例外を投げ、写しが黙って壊れるのを防ぐ。
   */
  rewrite?: { anchor: string; replacement: (spec: NewAppSpec) => string };
};

/** 立ち上げが決めきれない値の暫定値。#2254 で決定項目に上がるまではこれで始める。 */
export const SCAFFOLD_THEME_COLOR = "#0f766e";
export const SCAFFOLD_BACKGROUND_COLOR = "#0b1120";

/** Next.js系（`src/`を持ち、PWA・更新履歴の雛形が意味を持つ種別）か。 */
function isNextKind(spec: NewAppSpec): boolean {
  return spec.kind === "next" || spec.kind === "next-db";
}

/**
 * issue-deckの実物をそのまま配るファイルの一覧。
 *
 * `deploy.yml`が実行時に読むもの（`update-env-file.sh`・`construct-database-url.sh`）は
 * **雛形に含めないと初回デプロイがその場で落ちる**ので、種別に応じて必ず入れる。
 */
export function scaffoldCopies(spec: NewAppSpec): ScaffoldCopy[] {
  const profile = newAppKindProfile(spec.kind);
  const copies: ScaffoldCopy[] = [
    { source: ".github/scripts/signaly-notify.sh", path: ".github/scripts/signaly-notify.sh", executable: true },
    {
      source: "scripts/generate-workflow-env-block.sh",
      path: "scripts/generate-workflow-env-block.sh",
      executable: true,
    },
    {
      source: "scripts/sync-github-secrets.sh",
      path: "scripts/sync-github-secrets.sh",
      executable: true,
      rewrite: {
        anchor: 'REPO="${REPO:-guchi-apps/issue-deck}"',
        replacement: (target) => `REPO="\${REPO:-${NEW_APP_ORG}/${target.repositoryName}}"`,
      },
    },
  ];

  if (!isNextKind(spec)) return copies;

  copies.push({ source: "scripts/update-env-file.sh", path: "scripts/update-env-file.sh", executable: true });
  copies.push({ source: "scripts/version-changelog.mjs", path: "scripts/version-changelog.mjs" });
  if (profile.usesDatabase) {
    copies.push({
      source: "scripts/construct-database-url.sh",
      path: "scripts/construct-database-url.sh",
      executable: true,
    });
  }
  return copies;
}

export type ScaffoldOptions = {
  /**
   * callerが参照する共有ワークフローのタグ（`workflows/v25`）。
   *
   * **決められなかったときは`null`。** その場合はcallerを1枚も置かない——存在しない
   * タグを参照するcallerは、置いた瞬間から全イベントで失敗し続ける。
   */
  workflowTag: string | null;
};

/**
 * 雛形として新規作成するファイル。
 *
 * `multiAgent`が偽ならcallerは置かない（盤面にも載せない選択なので、置くと
 * `PROGRESS_REPORT_SECRET`未設定のまま毎回起動するだけになる）。
 */
export function buildScaffoldFiles(spec: NewAppSpec, options: ScaffoldOptions): ScaffoldFile[] {
  const profile = newAppKindProfile(spec.kind);
  const files: ScaffoldFile[] = [];
  const tag = options.workflowTag;

  if (spec.multiAgent && tag) {
    files.push({ path: ".github/workflows/issue-labels.yml", content: issueLabelsCaller(spec, tag) });
    files.push({
      path: ".github/workflows/claude-issue-dispatch.yml",
      content: claudeIssueDispatchCaller(spec, tag),
    });
  }
  // **リリース衛生の2枚はマルチエージェント運用と関係がない**（#2378）。`version-tag-check.yml`が
  // 無いと、初回の`main`マージが作った`vX.Y.Z`タグと同じバージョンのまま2回目のリリースを出した
  // ときに、main宛PRでは何も起きず`deploy.yml`のタグ作成が落ちて本番デプロイが止まる
  // （`guchi-apps/trainroute`が実際にこれに当たった）。雛形の`CLAUDE.md`も両方が存在する前提で
  // ワークフロー一覧に載せている。**Next.js系だけ`multiAgent`から外す**——fastapi・静的サイトは
  // `version-file`の既定値（`package.json`）がそのままでは合わず、別に直す必要がある。
  if (tag && (spec.multiAgent || isNextKind(spec))) {
    files.push({
      path: ".github/workflows/release-develop-to-main.yml",
      content: releaseDevelopToMainCaller(spec, tag),
    });
    files.push({
      path: ".github/workflows/version-tag-check.yml",
      content: versionTagCheckCaller(spec, tag),
    });
  }
  if (tag) {
    files.push({ path: ".github/workflows/sync-secrets.yml", content: syncSecretsCaller(spec, tag) });
  }

  if (isNextKind(spec)) {
    files.push({ path: ".github/workflows/ci.yml", content: ciWorkflow(spec) });
    files.push({ path: ".github/workflows/deploy.yml", content: deployWorkflow(spec) });
    files.push({ path: ".env.example", content: envExample(spec) });
    files.push({ path: "pnpm-workspace.yaml", content: pnpmWorkspace(spec) });
    files.push({ path: "src/lib/changelog.ts", content: changelogModule() });
    files.push({ path: "src/app/manifest.ts", content: manifestModule(spec) });
    files.push({ path: "public/icon.svg", content: placeholderIcon(spec) });
  }

  files.push({ path: ".github/secrets-manifest.tsv", content: secretsManifest(spec) });
  files.push({ path: ".gitignore", content: gitignore(spec) });
  files.push({ path: "CLAUDE.md", content: claudeMd(spec) });
  files.push({ path: "README.md", content: readme(spec) });

  // PrismaはNext.js系のスタックのもの。FastAPIはSQLAlchemyを使うため置かない
  if (profile.usesDatabase && isNextKind(spec)) {
    files.push({ path: "prisma.config.ts", content: prismaConfig() });
  }
  if (spec.port !== null && isNextKind(spec)) {
    files.push({ path: "deploy/ecosystem.config.js", content: ecosystemConfig(spec) });
  }

  return files;
}

/** 画面と初期化Issueに出す、雛形として置いたファイルの一覧（実行順ではなくパス順）。 */
export function scaffoldPathList(spec: NewAppSpec, options: ScaffoldOptions): string[] {
  return [
    ...buildScaffoldFiles(spec, options).map((file) => file.path),
    ...scaffoldCopies(spec).map((copy) => copy.path),
  ].sort();
}

/**
 * `.github/secrets-manifest.tsv`。
 *
 * **`scope`が`repo`なのに`SOURCE`が`-`の行を作らないこと。** 同期スクリプトが
 * `op read -` を実行して必ず失敗し、GitHub側に値が作られないままワークフローの
 * 参照が空で通る（`guchi-apps/aide-bot#5`）。
 */
function secretsManifest(spec: NewAppSpec): string {
  const profile = newAppKindProfile(spec.kind);
  const item = `op://apps/${spec.repositoryName}`;
  const rows: string[] = [
    "# --- VPSへの接続（organizationの共通値） ---",
    "SSH_PRIVATE_KEY\tinherit\tsecret\tSERVER_SSH_PRIVATE_KEY\t-",
    "HOST\tinherit\tsecret\tSERVER_HOST\t-",
    "USERNAME\tinherit\tsecret\tSERVER_USERNAME\t-",
    "SSH_PORT\tinherit\tsecret\tSERVER_SSH_PORT\t-",
    "#",
  ];
  if (profile.usesDatabase) {
    rows.push(
      "# --- 共有MariaDB（接続情報はorganization、DB名はアプリ固有） ---",
      "DB_HOST\tinherit\tsecret\tSHARED_DB_HOST\t-",
      "DB_PORT\tinherit\tsecret\tSHARED_DB_PORT\t-",
      "DB_USER\tinherit\tsecret\tSHARED_DB_USER\t-",
      "DB_PASSWORD\tinherit\tsecret\tSHARED_DB_PASSWORD\t-",
      "MIGRATE_DB_USER\tinherit\tsecret\tSHARED_DB_MIGRATE_USER\t-",
      "MIGRATE_DB_PASSWORD\tinherit\tsecret\tSHARED_DB_MIGRATE_PASSWORD\t-",
      "#",
    );
  }
  if (spec.auth === "supabase-google") {
    rows.push(
      "# --- Supabase（organizationの共通値。クライアントバンドルに埋め込まれる公開値のためvar） ---",
      "NEXT_PUBLIC_SUPABASE_URL\tinherit\tvar\tSUPABASE_PROJECT_URL\t-",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY\tinherit\tvar\tSUPABASE_PUBLISHABLE_KEY\t-",
      "#",
    );
  }
  rows.push(
    `# --- ${spec.repositoryName}固有 ---`,
    "# TARGET_DIRはサーバー上のパス。単体では資格情報でないがVPSへの攻撃面になるためsecret。",
    `TARGET_DIR\trepo\tsecret\tTARGET_DIR\t${item}/target-dir`,
  );
  if (profile.usesDatabase) {
    rows.push(`DB_NAME\trepo\tsecret\tDB_NAME\t${item}/db-name`);
  }
  if (spec.auth === "supabase-google") {
    rows.push(`ALLOWED_GOOGLE_EMAILS\trepo\tsecret\tALLOWED_GOOGLE_EMAILS\t${item}/allowed-google-emails`);
  }
  rows.push(
    "#",
    "# --- CI・デプロイ通知（organizationの共通値。#2255） ---",
    "# 全リポジトリのCI・デプロイ結果を1つのチャンネルへ集約するため、値はorganizationに1つだけ",
    "# ある。**repository secretを作ると同名のorganization secretを覆い隠す**ので inherit のままにする。",
    "SIGNALY_WEBHOOK_URL\tinherit\tsecret\tSIGNALY_WEBHOOK_URL\t-",
    "# リリース通知だけは別チャンネルへ分ける（guchi-apps/issue-deck#2391）。これも共通値。",
    "SIGNALY_RELEASE_WEBHOOK_URL\tinherit\tsecret\tSIGNALY_RELEASE_WEBHOOK_URL\t-",
  );

  return `# ${spec.repositoryName}のデプロイに必要な値を、GitHub側のどこから取るかを定めた対応表
# （guchi-apps/issue-deck#1307）。
#
# 背景: 以前は各ワークフローが実行のたびに1Passwordから全値を読んでいたが、1Passwordサービス
# アカウントの日次レート制限（1Passwordアカウント全体で1,000リクエスト/日。サービスアカウントを
# 分けても分割されない）を使い切り、フリート全体のデプロイが止まった
# （guchi-apps/issue-deck#1302）。
#
# GitHub側にはレート制限が無いため実行時の取得先をGitHubへ移し、1Passwordは「人が管理する
# 唯一の正」として残す。値が変わったときだけ scripts/sync-github-secrets.sh で同期する。
#
# 列: KEY <TAB> SCOPE <TAB> KIND <TAB> GH_NAME <TAB> SOURCE
#
# SCOPE   repo … このリポジトリに設定 / inherit … organizationの共通値を使う（同期しない）
# KIND    secret … ログでマスクされる（既定） / var … マスクされない
# GH_NAME GitHub側の名前。organizationの共通値は中立名のためここで読み替える
# SOURCE  1Password参照（op://…）。scopeがrepoの行はここから同期する
#
# scopeがrepoなのにSOURCEが「-」の行を作らないこと。sync-github-secrets.shが
# \`op read -\` を実行して必ずFAILし、GitHub側に値が作られないまま
# ワークフローの参照が空のまま通る（guchi-apps/aide-bot#5）。
# 1Passwordに置かない値は行ごと消し、コメントだけを残す。
#
${rows.join("\n")}
#
# PORTは1Passwordでもマニフェストでも管理しない。deploy.ymlに平文で持つ
# （guchi-apps/docs の standards/ports.md）。
`;
}

/**
 * `pnpm-workspace.yaml`（依存パッケージのビルドスクリプトの承認。#2378）。
 *
 * **pnpm 10系は依存のinstall/postinstallを既定で実行せず、警告だけ出して終了コード0で
 * 素通りする。** 承認は対話的なプロンプト（`pnpm approve-builds`）でしか求められないため、
 * CIでも無人実行でも「気づかないまま実行されていない」形になる。Prismaはこの段でクエリ
 * エンジンを取りに行くので、承認が無いとエンジンが無いまま先へ進む。**このIssueが扱っている
 * 「失敗が静かに通る」類型そのもの**なので、最初から承認済みの状態で始める。
 *
 * **効くのはCIとローカルだけで、VPSへは配られない。** `deploy.yml`が作るtarの中身
 * （`scaffold-workflows.ts`の`archiveEntries`）にこのファイルは入っておらず、VPS上の
 * `pnpm install --prod` はこの承認を見ない。それで問題が出ていないのは、本番で必要な
 * `prisma generate` がアプリ自身の`postinstall`（＝依存のビルドスクリプトではないので
 * 承認の対象外）だからで、issue-deck自身も同じ構成で動いている。**要否を確かめずに
 * 配布物へ足さないこと**——本番の`pnpm install --prod`の挙動が変わる。
 *
 * `packages:`は書かない（単一パッケージのリポジトリで、ここはワークスペースルートを
 * 宣言するためだけに置いている）。
 */
function pnpmWorkspace(spec: NewAppSpec): string {
  const profile = newAppKindProfile(spec.kind);
  const entries = [
    ...(profile.usesDatabase
      ? ["'@prisma/client': true", "'@prisma/engines': true", "prisma: true"]
      : []),
    "sharp: true",
    "unrs-resolver: true",
  ];
  return `# 依存パッケージのうち、install/postinstallの実行を許可するもの（guchi-apps/issue-deck#2378）。
#
# pnpm 10系は依存のビルドスクリプトを既定で実行せず、**警告だけ出して終了コード0で
# 素通りする**。承認は対話的な \`pnpm approve-builds\` でしか求められないため、CIや無人実行
# では「実行されていないことに誰も気づかない」形になる。${profile.usesDatabase ? "Prismaはこの段でクエリエンジンを\n# 取りに行くので、承認が無いとエンジンが無いまま先へ進む。" : ""}
#
# **ビルドスクリプトを持つ依存を足したら、\`pnpm approve-builds\` を実行してこのファイルの
# 差分をコミットすること。** 承認しないままでもインストールは成功扱いになる。
#
# **効くのはCIとローカルだけ。** \`deploy.yml\` が作るtarにこのファイルは入っておらず、
# VPS上の \`pnpm install --prod\` はこの承認を見ない（本番で要る \`prisma generate\` は
# アプリ自身の \`postinstall\` なので承認の対象外）。
allowBuilds:
${entries.map((entry) => `  ${entry}`).join("\n")}
`;
}

/** `prisma.config.ts`。**`quiet: true`を落とさないこと**（理由は本文のコメント）。 */
function prismaConfig(): string {
  return `// Prisma CLI（migrate/generate/studio）はNext.jsと違い \`.env.local\` を自動で読まず、
// \`.env\` しか読まない。\`prisma migrate dev\` 等が \`next dev\` と同じDATABASE_URLを
// 見るように、ここで明示的に読み込む。
import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

// \`quiet: true\` は必須。dotenv v17は読み込み時の案内文を**stdout**へ出すが、
// Prismaはこの設定ファイルを読んだうえで \`migrate dev\` / \`migrate diff --script\` の
// SQLを同じstdoutへ書き出すため、案内文がそのままmigration.sqlの1行目に混入する。
// 実際に guchi-apps/aide-bot がそうなり、本番の \`prisma migrate deploy\` が
// MariaDBの構文エラー（1064）で落ちた（guchi-apps/aide-bot#9）。
loadEnv({ path: ".env.local", quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
});
`;
}

/** `deploy/ecosystem.config.js`。 */
function ecosystemConfig(spec: NewAppSpec): string {
  return `const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "${spec.repositoryName}",
      script: "node_modules/next/dist/bin/next",
      args: "start",
      cwd: path.resolve(__dirname, ".."),
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      // メモリ2GBのVPS上でNext.jsが複数常駐しており、Nodeの既定ヒープ上限
      // （1プロセスあたり約1006MB）ではGCが働かず各プロセスが数百MBを抱え込む。
      // 上限を明示して早めにGCさせる。max_memory_restart は暴走時の保険。
      node_args: "--max-old-space-size=128",
      max_memory_restart: "320M",
      // PM2 は max_memory_restart による再起動やサーバー再起動後の resurrect で
      // プロセスを起動し直す際、pm2 start 時に指定した --env production を失って
      // 既定の env にフォールバックすることがある。development/3000 で起動されると
      // Apache のプロキシ先（127.0.0.1:${spec.port}）と食い違って 503 になるため、
      // 既定の env も本番と同じ値にしておく（guchi-apps/issue-deck#2259）。
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || ${spec.port},
      },
      env_production: {
        NODE_ENV: "production",
        PORT: process.env.PORT || ${spec.port},
      },
    },
  ],
};
`;
}

/** `.env.example`（変数名だけ。実値は置かない）。 */
function envExample(spec: NewAppSpec): string {
  const profile = newAppKindProfile(spec.kind);
  const blocks: string[] = [
    "# アプリ実行時に参照する環境変数（値は空。ローカル開発の記入例は .env.local.example を参照）",
  ];
  if (profile.usesDatabase) {
    blocks.push(
      "",
      "# MariaDB接続。本番は DB_* から scripts/construct-database-url.sh が組み立てる",
      "DATABASE_URL=",
    );
  }
  if (spec.auth === "supabase-google") {
    blocks.push(
      "",
      "# Supabase Auth（他アプリと共有のSupabaseプロジェクト）",
      "NEXT_PUBLIC_SUPABASE_URL=",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=",
      "",
      "# 利用を許可するGoogleアカウント（カンマ区切り）。未設定の場合は全員ログイン不可",
      "ALLOWED_GOOGLE_EMAILS=",
    );
  }
  if (profile.usesDatabase) {
    blocks.push(
      "",
      "# デプロイ時のみ使用（DATABASE_URL の組み立て元。scripts/construct-database-url.sh）",
      "DB_USER=",
      "DB_PASSWORD=",
      "DB_HOST=",
      "DB_PORT=",
      "DB_NAME=",
    );
  }
  blocks.push(
    "",
    "# CI/デプロイ通知",
    "SIGNALY_WEBHOOK_URL=",
    "",
    "# リリース通知（別チャンネル。未設定ならCI/デプロイと同じチャンネルへ送る）",
    "SIGNALY_RELEASE_WEBHOOK_URL=",
  );
  return `${blocks.join("\n")}\n`;
}

/** `.gitignore`。 */
function gitignore(spec: NewAppSpec): string {
  const next = isNextKind(spec)
    ? `
# next.js
/.next/
/out/

# production
/build
`
    : "";
  const typescript = isNextKind(spec)
    ? `
# typescript
*.tsbuildinfo
next-env.d.ts
`
    : "";
  return `# See https://help.github.com/articles/ignoring-files/ for more about ignoring files.

# dependencies
/node_modules
/.pnp
.pnp.*
${next}
# misc
.DS_Store
*.pem

# debug
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.pnpm-debug.log*

# env files（実シークレットはコミットしない。テンプレートのみ管理対象）
.env*
!.env.example
!.env.local.example

# 共有知識リポジトリ（GitHub Actions実行時にcheckoutされる。読み取り専用）
/.shared-context/

# issue-deck側の実装プロンプトのcheckout先（prompts-ref指定時）。同じくリポジトリ管理外。
/.shared-prompts/
${typescript}`;
}

/** `src/lib/changelog.ts`（更新履歴の受け皿。中身は空で始める）。 */
function changelogModule(): string {
  return `export type ChangelogEntry = {
  version: string;
  /** ISO 8601 (YYYY-MM-DD) */
  date: string;
  /** 何が変わったか。1項目1行 */
  changes: string[];
  /** どう使うか（どこを開く / 何を押す / どうなれば成功か）。無い版もある */
  usage?: string[];
};

/**
 * 利用者向けの更新履歴。
 *
 * **手で書き足す必要は無い。** develop→mainのリリースフロー
 * （\`.github/workflows/release-develop-to-main.yml\`）が差分から利用者向けの文面を生成し、
 * バージョンbump時の \`version\` lifecycleスクリプト（\`scripts/version-changelog.mjs\`）が
 * この配列の先頭へ新しいエントリを挿入する。生成された文面はバンプPRの本文にも載るため、
 * 内容の確認はそこで行う。**package.json の scripts に
 * \`"version": "node scripts/version-changelog.mjs"\` を足すこと**（無いと追記されない）。
 *
 * ## 記載ルール（手で直すときに守ること）
 *
 * - 利用者が画面を見て体感できる変更だけを書く
 * - 内部実装・リファクタリング・CI/CD・依存関係の更新は書かない
 * - 開発者向けの用語は利用者向けの言い方に言い換える
 * - 過去バージョンのエントリは変更しない
 *
 * 新しい順に並べる。
 */
export const APP_CHANGELOG: ChangelogEntry[] = [];
`;
}

/** `src/app/manifest.ts`（PWA対応は標準方針。`guchi-apps/docs`の`standards/tech-stack.md`）。 */
function manifestModule(spec: NewAppSpec): string {
  const description = spec.summary.trim() || spec.displayName;
  return `import type { MetadataRoute } from "next";

/**
 * PWAのmanifest。新規Webアプリは基本的にPWA対応とする（\`guchi-apps/docs\` の
 * \`standards/tech-stack.md\`）。
 *
 * **アイコンとテーマカラーは暫定値**（guchi-apps/issue-deck#2254）。\`public/icon.svg\` は
 * 差し替え前提のプレースホルダで、192/512のPNGと \`apple-icon.png\` はまだ無い。デザインを
 * 決めたらPNGを足し、\`icons\` と \`theme_color\` を更新する。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "${spec.displayName}",
    short_name: "${spec.displayName}",
    description: "${description.replace(/"/g, '\\"')}",
    start_url: "/",
    display: "standalone",
    background_color: "${SCAFFOLD_BACKGROUND_COLOR}",
    theme_color: "${SCAFFOLD_THEME_COLOR}",
    lang: "ja",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
`;
}

/** `public/icon.svg`（差し替え前提のプレースホルダ）。 */
function placeholderIcon(spec: NewAppSpec): string {
  const initial = (spec.repositoryName[0] ?? "a").toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="${spec.displayName}">
  <!-- guchi-apps/issue-deck#2247 が置いたプレースホルダ。デザインが決まったら差し替える。 -->
  <rect width="512" height="512" rx="96" fill="${SCAFFOLD_THEME_COLOR}" />
  <text x="256" y="256" fill="#ffffff" font-family="system-ui, sans-serif" font-size="256"
        font-weight="700" text-anchor="middle" dominant-baseline="central">${initial}</text>
</svg>
`;
}

/** `README.md`（`auto_init`が入れた空のREADMEを上書きする）。 */
function readme(spec: NewAppSpec): string {
  const profile = newAppKindProfile(spec.kind);
  return `# ${spec.displayName}

${spec.summary.trim() || spec.displayName}

- 公開URL: ${publicUrlFor(spec)}
- 種別: ${profile.label}${spec.port === null ? "" : `（本番ポート \`${spec.port}\`・${profile.processManager}）`}
${spec.databaseName ? `- データベース: \`${spec.databaseName}\`（共有MariaDB）\n` : ""}
このリポジトリは issue-deck の「新規アプリを立ち上げる」が作成し、CI・デプロイ・
マルチエージェント運用の雛形をコミットした状態で始まっています。中身の実装は
「プロジェクトを初期化する」Issueから進めます。

## 開発

\`\`\`bash
${profile.packageManager} install
${profile.packageManager} dev
\`\`\`

## 運用

- 日常の開発ブランチは \`develop\`。\`main\` は本番と一致するリリース用ブランチ
- \`main\` へのpushで \`.github/workflows/deploy.yml\` がVPSへ配る
- エージェント運用のルールは [CLAUDE.md](CLAUDE.md)
`;
}

/**
 * `CLAUDE.md`。
 *
 * **GitHub Actions上の無人実行は、個人環境のグローバル設定（`~/.claude/CLAUDE.md`）も
 * スキルも読まない。** 無人実行でも守らせたいルールは、このファイルか各ワークフローの
 * プロンプトに書いてある必要がある。ここに置くのは横断的な判断基準だけで、手順の正は
 * 共有知識（`.shared-context/`）とissue-deckの`docs/`にある。
 */
function claudeMd(spec: NewAppSpec): string {
  const profile = newAppKindProfile(spec.kind);
  const repo = `${NEW_APP_ORG}/${spec.repositoryName}`;
  const verify = isNextKind(spec)
    ? `\`\`\`bash
${profile.packageManager} lint
${profile.packageManager} typecheck
${profile.packageManager} build:ci
\`\`\`

**\`typecheck\` は \`next typegen && tsc --noEmit\` にしておくこと**（guchi-apps/issue-deck#2378）。
Next.js 16の \`PageProps\` / \`LayoutProps\` / \`RouteContext\` は \`.next/types\` へ生成される
グローバル型で、生成前は \`Cannot find name 'LayoutProps'\` になる。\`next build\` は内部で
型生成するため、**ビルドは通るのに \`typecheck\` だけが落ちる**という分かりにくい形になる。

**依存を足したら \`${profile.packageManager} approve-builds\` を実行し、\`pnpm-workspace.yaml\` の差分をコミットする。**
pnpm 10系は依存のビルドスクリプトを既定で実行せず、警告だけ出して終了コード0で素通りする。

**型チェック・Lintが通ることと、実際の動作が正しいことは別。** 振る舞いが変わる変更では
両方を確かめる。`
    : "検証コマンドは初期化時に決めてここへ書く（何も書かないと、エージェントは毎回推測する）。";

  // **実際に置いたcallerだけを並べる。** 置いていないファイルを載せると、エージェントが
  // 「あるはずのものが消された」と判断して作り直す（判定は`buildScaffoldFiles`と同じ条件）。
  const workflowList = [
    ...(spec.multiAgent
      ? [
          "- `issue-labels.yml` … 進捗の状態遷移をイベント駆動で報告する",
          `- \`claude-issue-dispatch.yml\` … Issue起点の無人実行。**このファイルがデフォルトブランチに
  あることがissue-deckの盤面へ載る条件**なので消さない`,
        ]
      : []),
    ...(spec.multiAgent || isNextKind(spec)
      ? [
          "- `release-develop-to-main.yml` … バージョンbump PRと develop→main のPR作成",
          `- \`version-tag-check.yml\` … バージョンの上げ忘れをmain宛PRで落とす。**消さないこと**——
  初回の\`main\`マージが作った\`vX.Y.Z\`タグと同じバージョンのまま2回目のリリースを出すと、
  \`deploy.yml\`のタグ作成が落ちて本番デプロイが止まる（${NEW_APP_ORG}/issue-deck#2378）`,
        ]
      : []),
    "- `sync-secrets.yml` … 1Passwordから`.github/secrets-manifest.tsv`のとおりに同期する",
  ].join("\n");

  return `# ${spec.repositoryName} 固有ルール

このリポジトリで作業するClaude Codeエージェント向けのルール。

**このファイルはissue-deckの画面の「新規アプリを立ち上げる」が置いた雛形である**
（\`${NEW_APP_ORG}/issue-deck#2247\`）。アプリ固有の前提（構成・認証・検証コマンド・
デプロイの注意点）は、初期化を進めながらここへ書き足していく。

ローカル実行ではユーザー個人環境のグローバルルール（\`~/.claude/CLAUDE.md\`）も読み込まれるが、
**GitHub Actions上での無人実行はリポジトリをチェックアウトしたワークツリーしか参照できない**
ため、それらは読み込まれない。無人実行でも守られる必要があるルールは、このファイルに
明文化しておく必要がある。

## アプリ概要

| 項目 | 値 |
|---|---|
| 公開URL | ${publicUrlFor(spec)} |
| 種別 | ${profile.label} |
| 本番ポート | ${spec.port === null ? "なし（常駐プロセスを持たない）" : `\`${spec.port}\``} |
| プロセス管理 | ${profile.processManager} |
| データベース | ${spec.databaseName ? `\`${spec.databaseName}\`（共有MariaDB）` : "使わない"} |

${spec.summary.trim() ? `${spec.summary.trim()}\n\n` : ""}## 出力言語

エージェントの出力は日本語で書く。対象は成果物（コミットメッセージ・PR・Issueコメント）
だけでなく、**応答本文・作業の要約・TODO・提示する計画・ツール実行時の説明といった画面に
出る文章も含む**。コード・識別子・ファイルパス・コマンド・設定値・ログやエラーメッセージの
引用は原文（英語）のままでよい。

## 検証コマンド

${verify}

## 依存関係の追加

新しい依存関係（パッケージ・ライブラリ・ツール）を追加する前には、必ずユーザーに確認を取る。

GitHub Actions上の無人実行では、その場で確認を取る相手がいない。追加が必要だと判断した場合は
追加せずに作業を止め、\`00.check-user\`ラベル（と理由を表す\`01.check-blocked\`）を付与した
うえで、なぜ必要かをIssueコメントで相談する。

## シークレットの扱い

- APIキー・トークン・パスワード等の実シークレットをコミットしない。コミットしてよいのは、
  値を空にしたサンプル（\`.env.example\`）と、1Passwordの\`op://vault/item/field\`形式の
  参照だけを書いた対応表（\`.github/secrets-manifest.tsv\`）に限る
- **1Passwordは「人が管理する唯一の正」だが、GitHub Actionsの実行時の取得先ではない。**
  1Passwordサービスアカウントには日次レート制限（アカウント全体で1,000リクエスト/日）が
  あり、実行のたびに読むとフリート全体のデプロイが止まる。\`ci.yml\`・\`deploy.yml\`は
  GitHubのsecret/variableから取得する。対応表は\`.github/secrets-manifest.tsv\`、同期は
  \`scripts/sync-github-secrets.sh\`（値を変更したときだけ実行する）
- \`.github/secrets-manifest.tsv\`で**\`scope\`が\`repo\`の行に\`SOURCE\`が\`-\`のものを
  作らない。** 同期スクリプトが\`op read -\`を実行して必ず失敗し、GitHub側に値が
  作られないままワークフローの参照が空で通る（\`${NEW_APP_ORG}/aide-bot#5\`）
- **待受ポートは1Passwordでもマニフェストでも管理しない。** \`deploy.yml\`に平文で持つ
  （\`guchi-apps/docs\`の\`standards/ports.md\`）

## 全アプリ共通の共有知識（shared context）

複数アプリで再利用できる知識は共有知識リポジトリ（\`guchi-apps/docs\`）で管理する。
GitHub Actions実行では\`.shared-context/\`へcheckoutされ、ローカル実行では\`~/apps/_docs\`を
参照できる。**\`.shared-context/\`配下は読み取り専用として扱い、編集・\`git add\`・
コミットを行わない。**

読む順序は、\`CLAUDE.md\`（索引）→ 自分の役割の\`agent-rules/\` → 必要に応じて
\`knowledge/\` → 設計判断が要るときだけ\`standards/\` → 手作業の設定手順が要るときだけ
\`guides/\`。内容が矛盾する場合はこのファイルを優先する。

実装中に得た知見は、このリポジトリの\`docs/\`か\`CLAUDE.md\`へ書くのと、同じ内容を
「知見メモ」コメント（\`<!-- knowledge-candidate -->\`）としてIssueへ投稿するのを**両方**行う。
共有知識へ格上げすべきかどうかは判定しない。

# Issueごとの複数Claude Codeエージェント運用

## ブランチ運用

- \`main\`は本番環境と一致するリリース用ブランチで、直接コミット・pushしない。\`develop\`が
  日常の開発ブランチで、本番へ反映する変更は\`develop\`→\`main\`のPull RequestをCI通過後に
  マージする
- Issue単位の作業ブランチは\`develop\`から作成し、**ブランチ名は\`issue-<Issue番号>\`とする**
  （例: \`issue-123\`）。進捗の遷移とcloseはこの命名だけを見ているため、違う命名では
  進捗が一切動かない

## Issueの進捗

**進捗はGitHub ProjectsのStatusで管理する。唯一の正はStatusで、進捗ラベルは存在しない。**
Statusを進めるのはissue-deckだけで、各ワークフローは進捗報告API（\`POST /api/progress\`）へ
報告する。\`gh issue edit\`で進捗を付け替えることはできない。

\`Ready\` → \`Planning\`（\`21.plan-required\`のときだけ）→ \`Implementation\` →
\`Develop PR\` → \`Develop\` → \`Release\` → \`Done\`（mainへマージ完了。この時点でclose）。

\`00.check-user\`（ユーザーのチェックが必要）はどの段階でも併用でき、**付けるときは理由を
表す\`01.check-*\`ラベルも1枚あわせて付ける**（そのリポジトリに定義が無ければ付けなくてよい）。
\`11.local\`が付いている間は無人実行がそのIssueに対して何も行わない。

## 実装エージェントの禁止事項

- \`main\` / \`develop\` への直接コミット・push
- 他Issueのブランチ・worktreeの編集
- **担当Issue以外の実装。** 作業中に別件を新規Issueとして起票するのはよいが、そのIssueを
  このセッション・このブランチで実装しない
- 不要なforce push
- 自分が作成したPull Requestの自己マージ

## 自動マージ不可カテゴリ（\`00.check-user\`付与対象）

認証・認可／DBスキーマ変更・マイグレーション／本番環境の設定／GitHub Actionsやデプロイ設定／
Secretsや環境変数／課金・決済／大規模な依存関係の更新／\`develop\`→\`main\`のマージ。

## PR本文テンプレート

\`develop\`宛のPRには次を記載する。対応Issueは\`closes #番号\`を使わず\`#番号\`のみ
（developマージ時点ではissueをcloseしない運用のため）。

- 対応Issue
- 実装内容
- テスト内容
- 確認方法
- 注意点

## ワークフローの構成

\`.github/workflows/\`のうち\`uses:\`で\`${NEW_APP_ORG}/issue-deck\`を参照しているものは
**トリガー定義だけを持つ薄いcaller**で、ジョブ本体はissue-deck側にある。参照は
\`@workflows/vN\`のタグ固定で、**\`uses:\`のタグと\`prompts-ref\`は必ず同じ値にする。**
タグを上げるPull Requestはissue-deckの画面（設定＞フリート運用）から配られる。

${workflowList}

自動修復系（\`claude-ci-fix.yml\`・\`claude-conflict-resolve.yml\`・\`claude-pr-repair.yml\`・
\`claude-review-develop.yml\`・\`deploy-retry.yml\`）はまだ置かれていない。issue-deckの画面
（設定＞フリート運用）から\`${repo}\`へ配れる。

**callerに書ける\`with:\`は、参照しているタグ時点の再利用ワークフローが持つ入力だけ。**
宣言されていない入力を渡すとワークフローの読み込み自体が失敗する。
`;
}
