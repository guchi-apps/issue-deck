/**
 * 立ち上げで作るリポジトリへ最初にコミットするワークフローの雛形（#2247）。
 *
 * **雛形の正をissue-deck内に置く。** `uses:`のタグ（`workflows/vN`）と`prompts-ref`を
 * 揃え続ける必要があり、タグを切るのも配るのもissue-deck側だから
 * （`.github/templates/callers/`の既存の雛形と同じ理由）。
 *
 * **ただし`.github/templates/`には置けない。** 本番の配布物（`deploy.yml`の`tar`）に
 * `.github/`は入らないため、実行中のNext.jsサーバーからは読めない。ここをTypeScriptの
 * モジュールにしてあるのはそのためで、ビルド成果物へそのまま入る。
 *
 * **`${{ ... }}` はテンプレートリテラルの補間と衝突する。** YAMLへ出したいものは
 * `\${{ ... }}` と書く（`$` をエスケープする）。
 */

import { newAppKindProfile, publicUrlFor, type NewAppSpec } from "@/lib/new-app/spec";

/** callerが参照する共有ワークフローの提供元。 */
const SHARED_WORKFLOW_REPOSITORY = "guchi-apps/issue-deck";

/** Node系の雛形で使うNodeのメジャーバージョン。CIと実装ステップで同じ値を使う。 */
export const SCAFFOLD_NODE_VERSION = "24";

/** CIワークフローの`name:`。**変えないこと**（後述のcallerがこの名前で購読する）。 */
export const SCAFFOLD_CI_WORKFLOW_NAME = "CI";

function reusable(file: string, tag: string): string {
  return `${SHARED_WORKFLOW_REPOSITORY}/.github/workflows/${file}@${tag}`;
}

/** `.github/workflows/issue-labels.yml` */
export function issueLabelsCaller(spec: NewAppSpec, tag: string): string {
  return `name: Issue Labels

# Issueの進捗（Project Status）の状態遷移をイベント駆動で保証するワークフローの、
# ${spec.repositoryName}側のトリガー定義。
#
# ジョブ本体はguchi-apps/issue-deckのreusable-issue-labels.ymlにあり、ここでは\`uses:\`で参照する
# だけにしている。呼ばれる側でも\`github\`コンテキストは呼び出し元（このリポジトリ）のものになる
# ため、ジョブ定義側に${spec.repositoryName}固有の書き換えは不要。
#
# **このファイルはissue-deckの画面の「新規アプリを立ち上げる」が置いた雛形である**
# （guchi-apps/issue-deck#2247）。参照はタグ固定で、上げるときは
# claude-issue-dispatch.ymlの\`uses:\`・\`prompts-ref\`もあわせて確認する。
#
# 対象issueの番号はブランチ名 issue-<番号> から特定するため、この命名規約に従わない
# ブランチ・PRは全て対象外になる。
on:
  push:
    branches:
      - "issue-*"
  pull_request:
    types: [opened, synchronize, closed]
    branches:
      - develop
      - main
  issues:
    types: [opened, edited, closed]
  schedule:
    - cron: "*/15 * * * *"
  workflow_dispatch: {}

jobs:
  labels:
    uses: ${reusable("reusable-issue-labels.yml", tag)}
    # 呼ばれる側の権限はcallerの付与範囲を超えられない。cleanup-on-closeジョブが
    # contents: write を要求するため、あわせてここで付与する。
    permissions:
      issues: write
      pull-requests: write
      contents: write
    # 進捗をissue-deckの報告API（POST /api/progress）へ送るための共有シークレット。
    # organization secretとして解決される。secrets: inherit ではなく個別に渡し、
    # 呼ばれる側へ渡る秘密を最小限に保つ。未設定でも報告ステップがスキップされるだけ。
    secrets:
      PROGRESS_REPORT_SECRET: \${{ secrets.PROGRESS_REPORT_SECRET }}
`;
}

/** `.github/workflows/claude-issue-dispatch.yml` */
export function claudeIssueDispatchCaller(spec: NewAppSpec, tag: string): string {
  const profile = newAppKindProfile(spec.kind);
  const database = spec.databaseName
    ? `      database-name: ${spec.databaseName}\n`
    : "";
  const nodeVersion =
    profile.runtimeSetup === "minimal"
      ? ""
      : `      # 実装ステップのNodeをCI（.github/workflows/ci.yml）と揃え、ビルドの結果が
      # CIと食い違わないようにする。
      node-version: "${SCAFFOLD_NODE_VERSION}"\n`;

  return `name: Claude Issue Dispatch

# Issueへの\`@claude\`コメントを起点に、計画提示・実装・develop向けPR作成までをGitHub Actions上で
# 無人実行するワークフローの、${spec.repositoryName}側のトリガー定義。
#
# ジョブ本体はguchi-apps/issue-deckのreusable-issue-dispatch.ymlにあり、ここでは\`uses:\`で参照する
# だけにしている。技術スタックの差は\`with:\`のinputsで吸収する。
#
# **このファイルはissue-deckの画面の「新規アプリを立ち上げる」が置いた雛形である**
# （guchi-apps/issue-deck#2247）。**このファイルがデフォルトブランチにあることが、
# issue-deckの盤面へ載る条件**なので、消さないこと。
#
# \`uses:\`のタグと\`prompts-ref\`は必ず同じ値にする。\`uses:\`だけ上げるとプロンプト
# （.github/prompts/配下）が古いタグのまま参照され、新しいワークフローで古いプロンプトが動く。
# なお\`prompts-ref\`を空にすると呼び出し元（このリポジトリ）の.github/prompts/を読みに行き、
# ${spec.repositoryName}はそれを持たないため最初のClaudeステップで落ちる。
#
# 動作の詳細（21.plan-requiredの二段階トリガー、mode=ask/plan/split/implement/additionalの
# 判定、11.localによる二重起動防止など）は、issue-deckのdocs/multi-agent/dispatch.mdを参照する。
on:
  issues:
    types: [unlabeled]
  issue_comment:
    types: [created]
  # 計画/実装のフォールバック検証ステップ専用の自己リトライ起動経路。
  workflow_dispatch:
    inputs:
      issue_number:
        description: "対象issue番号"
        required: true
        type: string
      retry_attempt:
        description: "これまでの自動リトライ回数（0始まり。指定した回数の次の試行として実行する）"
        required: false
        type: string
        default: "0"

jobs:
  dispatch:
    uses: ${reusable("reusable-issue-dispatch.yml", tag)}
    with:
      # 種別（${profile.label}）に対応するランタイムの用意。
      runtime-setup: ${profile.runtimeSetup}
      package-manager: ${profile.packageManager}
${database}${nodeVersion}      # uses: のタグと必ず同じ値にする。
      prompts-ref: ${tag}
    # CLAUDE_CODE_OAUTH_TOKEN・WORKFLOW_PATを呼ばれる側へ渡す。
    secrets: inherit
    permissions:
      contents: write
      pull-requests: write
      issues: write
      actions: read
      id-token: write
`;
}

/** `.github/workflows/release-develop-to-main.yml` */
export function releaseDevelopToMainCaller(spec: NewAppSpec, tag: string): string {
  return `name: Release develop to main

# develop→mainのリリース（バージョンbump PR・develop→mainのPR作成）を行う。
# **本体は guchi-apps/issue-deck にあり、ここはトリガー定義だけの薄いcaller**
# （guchi-apps/issue-deck#1181）。issue-deckの画面のリリースボタンは、このファイルが
# 実在するリポジトリにだけ出る。
#
# **このファイルはissue-deckの画面の「新規アプリを立ち上げる」が置いた雛形である**
# （guchi-apps/issue-deck#2247）。
#
# バンプPRはCI通過後にdevelopへ自動マージする。バンプPRがdevelopへマージされてバージョンが
# 変わると、push(develop, paths)で本ワークフローが再度起動し、develop→mainのPRを自動作成する。
# **develop→mainの実際のマージは自動マージ不可カテゴリに該当するため人間が手動で行う。**
#
# バンプPRの作成は人間の確認なしに走るため、scheduleでの自動起動はしない。
on:
  workflow_dispatch:
    inputs:
      bump_kind:
        description: "バージョンの上げ幅（autoならコード差分から自動判定）"
        required: false
        type: choice
        default: auto
        options: [auto, patch, minor, major]
  push:
    branches: [develop]
    paths:
      - package.json

concurrency:
  group: release-develop-to-main
  cancel-in-progress: false

jobs:
  release:
    uses: ${reusable("reusable-release-develop-to-main.yml", tag)}
    # バージョンの読み書きに関する3つのinput（version-file・version-query・bump-command）は
    # すべて既定値でよい。ルートのpackage.jsonに version を持ち、\`preversion\`を持たないため。
    # **共有ワークフローはバージョンbumpのために依存関係をインストールしない**ので、
    # \`version\` lifecycleスクリプトはNode標準モジュールだけで書き、\`preversion\`に
    # テストを置かないこと（雛形の scripts/version-changelog.mjs はその条件を満たしている）。
    with:
      # pushトリガー（バンプPRのマージ）で起動したときは\`inputs\`自体が無いため空文字を渡す。
      bump-kind: \${{ github.event_name == 'workflow_dispatch' && inputs.bump_kind || '' }}
    secrets: inherit
    # **呼ばれる側の権限はcallerの付与範囲を超えられない。** issues が write なのは、
    # 呼ばれる側の notify-failure ジョブがリリース対象issueへ失敗を通知するため。
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
`;
}

/** `.github/workflows/version-tag-check.yml` */
export function versionTagCheckCaller(_spec: NewAppSpec, tag: string): string {
  return `name: Version tag check

# バージョンを上げ忘れたままdevelop→mainをマージすると、mainへ入った後に deploy.yml の
# タグ作成が失敗して本番デプロイが止まる。それをmain宛PRのCIで先に落とす
# （guchi-apps/issue-deck#1367・#2135）。
# **本体は issue-deck の reusable-version-tag-check.yml にあり、ここはトリガー定義だけの
# 薄いcaller**。
#
# **このファイルはissue-deckの画面の「新規アプリを立ち上げる」が置いた雛形である**
# （guchi-apps/issue-deck#2247）。
#
# **トリガーをdevelopへ広げないこと。** featureブランチのバージョンは直前のリリースのままで、
# 対応するタグが必ず存在するため、developへの全PRが赤くなる。
on:
  pull_request:
    branches:
      - main

concurrency:
  group: version-tag-check-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  version-tag-check:
    uses: ${reusable("reusable-version-tag-check.yml", tag)}
    # ルートの package.json に version を持ち、リリースタグは \`vX.Y.Z\` 形式のため inputs は
    # 全て既定値でよい（version-file: package.json / version-query: .version / tag-prefix: v）。

    # **呼ばれる側の権限はcallerの付与範囲を超えられない。** タグの確認しかしないため
    # contents: read だけを渡す。
    permissions:
      contents: read
`;
}

/** `.github/workflows/sync-secrets.yml` */
export function syncSecretsCaller(spec: NewAppSpec, tag: string): string {
  return `name: Sync secrets

# 1Password（正）から、このリポジトリのGitHub secret / variable へ値を同期する
# （guchi-apps/issue-deck#1309）。
# **本体は issue-deck の reusable-sync-secrets.yml にあり、ここはトリガー定義だけの薄いcaller**。
#
# **このファイルはissue-deckの画面の「新規アプリを立ち上げる」が置いた雛形である**
# （guchi-apps/issue-deck#2247）。読む対応表は .github/secrets-manifest.tsv、実行するのは
# scripts/sync-github-secrets.sh で、どちらも同じ雛形で置かれている。
#
# 起動経路は2つ。どちらも同じものが動く。
#
# - issue-deckの画面（設定 → シークレットの同期）… \`POST /api/secrets-sync\` が
#   \`workflow_dispatch\` で起動する
# - GitHubのActionsタブから手で実行
#
# **1Passwordの日次枠（アカウント全体で1,000リクエスト/日）を消費する。** 全件だと
# マニフェストの項目数ぶん。値を変えた項目だけを \`only\` で指定する。ローカルの
# \`scripts/sync-github-secrets.sh\` を直接叩く場合は個人アカウントのセッションを使うため
# 枠を消費しない。
on:
  workflow_dispatch:
    inputs:
      only:
        description: "同期するKEYをカンマ区切りで絞る（空ならマニフェスト全件）"
        required: false
        type: string
        default: ""

concurrency:
  # 同じリポジトリへの同期が重なると、同じsecretへ二重に書きにいく
  group: sync-secrets-\${{ github.repository }}
  cancel-in-progress: false

jobs:
  sync-secrets:
    uses: ${reusable("reusable-sync-secrets.yml", tag)}
    with:
      only: \${{ inputs.only }}
    # **呼ばれる側の権限はcallerの付与範囲を超えられない。** 書き込みは
    # GITHUB_TOKEN ではなく WORKFLOW_PAT が行うため、ここは contents: read だけでよい。
    permissions:
      contents: read
    secrets: inherit
`;
}

/** CI・デプロイのビルド時に渡す環境変数（種別と認証で決まる）。 */
function buildEnvLines(spec: NewAppSpec, mode: "ci" | "deploy"): string[] {
  const profile = newAppKindProfile(spec.kind);
  const lines: string[] = [];
  if (profile.usesDatabase) {
    lines.push(
      mode === "ci"
        ? `          DATABASE_URL: mysql://placeholder:placeholder@127.0.0.1:3306/${spec.databaseName}`
        : "          DATABASE_URL: ${{ env.DATABASE_URL }}",
    );
  }
  if (spec.auth === "supabase-google") {
    if (mode === "ci") {
      lines.push("          NEXT_PUBLIC_SUPABASE_URL: https://ci-placeholder.supabase.co");
      lines.push("          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ci-placeholder");
    } else {
      lines.push("          # NEXT_PUBLIC_* はビルド時にバンドルへ埋め込まれるため、ここにも渡す。");
      lines.push("          NEXT_PUBLIC_SUPABASE_URL: ${{ env.NEXT_PUBLIC_SUPABASE_URL }}");
      lines.push(
        "          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ${{ env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY }}",
      );
    }
  }
  return lines;
}

/** `.github/workflows/ci.yml`（Next.js系のみ） */
export function ciWorkflow(spec: NewAppSpec): string {
  const buildEnv = buildEnvLines(spec, "ci");
  const buildEnvBlock =
    buildEnv.length === 0
      ? ""
      : `\n          # ビルドは外部サービスへ接続しないため、いずれもCI専用のプレースホルダーでよい。\n${buildEnv.join("\n")}`;

  return `name: ${SCAFFOLD_CI_WORKFLOW_NAME}

# 注意: claude-conflict-resolve.ymlが、このワークフローの\`workflow_run\`（CI / requested /
# develop）を「developへのpush」の代理通知として購読している（guchi-apps/issue-deck#1330。
# claude-code-actionがpushイベントに対応していないため直接pushで受けられない）。したがって
# - ワークフロー名（\`${SCAFFOLD_CI_WORKFLOW_NAME}\`）
# - \`push: branches: [develop]\`トリガー
# を変更・削除すると、コンフリクト自動解消の最速検知経路が無言で止まる（scheduleの15分
# おきの安全網だけが残る）。変更する場合はclaude-conflict-resolve.ymlも合わせて直す。
#
# **このファイルはissue-deckの画面の「新規アプリを立ち上げる」が置いた雛形である**
# （guchi-apps/issue-deck#2247）。検証コマンドを増やしたら、このジョブにも足すこと。

on:
  pull_request:
    branches:
      - main
      - develop
  push:
    branches:
      - develop

concurrency:
  group: ci-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint-and-build:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "${SCAFFOLD_NODE_VERSION}"
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Lint
        run: pnpm lint

      - name: Typecheck
        run: pnpm typecheck

      - name: Build
        run: pnpm build:ci
        env:
          NODE_ENV: production${buildEnvBlock}

  notify:
    needs: [lint-and-build]
    if: always()
    runs-on: ubuntu-latest

    # GitHub側の値をここで明示的に渡す。以前は実行のたびに1Passwordから読んで
    # いたが、サービスアカウントの日次レート制限を使い切ってフリート全体の
    # デプロイが止まった（guchi-apps/issue-deck#1302）。
    #
    # このブロックは scripts/generate-workflow-env-block.sh で生成する（guchi-apps/issue-deck#1307）。
    env:
      SIGNALY_WEBHOOK_URL: \${{ secrets.SIGNALY_WEBHOOK_URL }}

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Determine workflow status
        id: status
        run: |
          lint_and_build="\${{ needs.lint-and-build.result }}"
          if [ "$lint_and_build" = "success" ]; then
            result=success
          elif [ "$lint_and_build" = "cancelled" ]; then
            result=cancelled
          else
            result=failure
          fi
          echo "result=$result" >> "$GITHUB_OUTPUT"
          if [ "$lint_and_build" = "success" ]; then
            echo "jobs=lint-and-build" >> "$GITHUB_OUTPUT"
          else
            echo "jobs=lint-and-build: $lint_and_build" >> "$GITHUB_OUTPUT"
          fi
          # develop push: 失敗のみ通知。main宛PR: success・failure・cancelledを通知。
          if [ "$result" = "failure" ]; then
            echo "should_notify=true" >> "$GITHUB_OUTPUT"
          elif [ "\${{ github.event_name }}" = "pull_request" ] && [ "\${{ github.base_ref }}" = "main" ]; then
            echo "should_notify=true" >> "$GITHUB_OUTPUT"
          else
            echo "should_notify=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Signaly に通知
        if: steps.status.outputs.should_notify == 'true'
        # 通知はCIやデプロイの合否そのものではない。ここが失敗してもrun全体を
        # 落とさない（guchi-apps/issue-deck#1302）。
        continue-on-error: true
        env:
          SIGNALY_WEBHOOK_URL: \${{ env.SIGNALY_WEBHOOK_URL }}
          NOTIFY_APP: ${spec.repositoryName}
          NOTIFY_KIND: CI
          NOTIFY_STATUS: \${{ steps.status.outputs.result }}
          NOTIFY_JOB: \${{ steps.status.outputs.jobs }}
        run: bash .github/scripts/signaly-notify.sh
`;
}

/**
 * `.github/workflows/deploy.yml`（Next.js系のみ）。
 *
 * **待受ポートは`${{ vars.PORT }}`ではなく平文で持つ**（`guchi-apps/docs`の
 * `standards/ports.md`「ポート番号は1Passwordで管理しない」）。`aide-bot`はこの形に
 * なっていない古い雛形から始まり、`vars.PORT`が空のまま起動して直すことになった
 * （`guchi-apps/aide-bot#5`）。
 */
export function deployWorkflow(spec: NewAppSpec): string {
  const profile = newAppKindProfile(spec.kind);
  const usesDb = profile.usesDatabase;
  const supabase = spec.auth === "supabase-google";
  const port = spec.port ?? 3000;
  const publicUrl = publicUrlFor(spec);

  const secretsEnv = [
    "      SSH_PRIVATE_KEY: ${{ secrets.SERVER_SSH_PRIVATE_KEY }}",
    "      HOST: ${{ secrets.SERVER_HOST }}",
    "      USERNAME: ${{ secrets.SERVER_USERNAME }}",
    "      SSH_PORT: ${{ secrets.SERVER_SSH_PORT }}",
    ...(usesDb
      ? [
          "      DB_HOST: ${{ secrets.SHARED_DB_HOST }}",
          "      DB_PORT: ${{ secrets.SHARED_DB_PORT }}",
          "      DB_USER: ${{ secrets.SHARED_DB_USER }}",
          "      DB_PASSWORD: ${{ secrets.SHARED_DB_PASSWORD }}",
          "      MIGRATE_DB_USER: ${{ secrets.SHARED_DB_MIGRATE_USER }}",
          "      MIGRATE_DB_PASSWORD: ${{ secrets.SHARED_DB_MIGRATE_PASSWORD }}",
          "      DB_NAME: ${{ secrets.DB_NAME }}",
        ]
      : []),
    ...(supabase
      ? [
          "      NEXT_PUBLIC_SUPABASE_URL: ${{ vars.SUPABASE_PROJECT_URL }}",
          "      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ${{ vars.SUPABASE_PUBLISHABLE_KEY }}",
          "      ALLOWED_GOOGLE_EMAILS: ${{ secrets.ALLOWED_GOOGLE_EMAILS }}",
        ]
      : []),
    "      TARGET_DIR: ${{ secrets.TARGET_DIR }}",
    "      SIGNALY_WEBHOOK_URL: ${{ secrets.SIGNALY_WEBHOOK_URL }}",
  ].join("\n");

  const secretsEnvComment = `    # GitHub側の値をここで明示的に渡す。以前は実行のたびに1Passwordから読んで
    # いたが、サービスアカウントの日次レート制限を使い切ってフリート全体の
    # デプロイが止まった（guchi-apps/issue-deck#1302）。SERVER_*${usesDb ? "・SHARED_DB_*" : ""}${supabase ? "・SUPABASE_*" : ""}
    # はorganizationの共通値。
    #
    # このブロックは scripts/generate-workflow-env-block.sh で生成する（guchi-apps/issue-deck#1307）。`;

  const constructDbStep = usesDb
    ? `
      - name: Construct DATABASE_URL
        run: bash scripts/construct-database-url.sh
`
    : "";

  const buildEnv = buildEnvLines(spec, "deploy");
  const buildEnvBlock = buildEnv.length === 0 ? "" : `\n${buildEnv.join("\n")}`;

  const archiveEntries = [
    "package.json",
    "pnpm-lock.yaml",
    "public",
    ".next",
    ...(usesDb ? ["prisma"] : []),
    "deploy",
    ...(usesDb ? ["scripts/construct-database-url.sh"] : []),
    "scripts/update-env-file.sh",
    "next.config.ts",
  ];
  const archive = archiveEntries.map((entry) => `            ${entry} \\`).join("\n").replace(/ \\$/, "");
  const cleanup = archiveEntries
    .filter((entry) => !entry.startsWith("scripts/"))
    .join(" ");

  const sshEnv = [
    ...(usesDb
      ? ["          DATABASE_URL: ${{ env.DATABASE_URL }}", "          MIGRATE_DATABASE_URL: ${{ env.MIGRATE_DATABASE_URL }}"]
      : []),
    ...(supabase
      ? [
          "          NEXT_PUBLIC_SUPABASE_URL: ${{ env.NEXT_PUBLIC_SUPABASE_URL }}",
          "          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ${{ env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY }}",
          "          ALLOWED_GOOGLE_EMAILS: ${{ env.ALLOWED_GOOGLE_EMAILS }}",
        ]
      : []),
    "          TARGET_DIR: ${{ env.TARGET_DIR }}",
  ].join("\n");
  const sshEnvNames = [
    ...(usesDb ? ["DATABASE_URL", "MIGRATE_DATABASE_URL"] : []),
    ...(supabase
      ? ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "ALLOWED_GOOGLE_EMAILS"]
      : []),
    "TARGET_DIR",
  ].join(",");

  const updateEnv = [
    "            update_env NODE_ENV production",
    '            update_env PORT "$PORT"',
    ...(usesDb ? ['            update_env DATABASE_URL "$DATABASE_URL"'] : []),
    ...(supabase
      ? [
          '            update_env NEXT_PUBLIC_SUPABASE_URL "$NEXT_PUBLIC_SUPABASE_URL"',
          '            update_env NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY "$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"',
          '            update_env ALLOWED_GOOGLE_EMAILS "$ALLOWED_GOOGLE_EMAILS"',
        ]
      : []),
  ].join("\n");

  const migrate = usesDb
    ? `
            echo "Applying database migrations..."
            DATABASE_URL="$MIGRATE_DATABASE_URL" pnpm exec prisma migrate deploy
`
    : "";

  return `name: Deploy to Production

# mainへのpushでVPSへ配る。**このファイルはissue-deckの画面の「新規アプリを立ち上げる」が
# 置いた雛形である**（guchi-apps/issue-deck#2247）。
on:
  push:
    branches:
      - main
  workflow_dispatch:

concurrency:
  group: deploy-${spec.repositoryName}-production
  cancel-in-progress: true

jobs:
  tag:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    outputs:
      version: \${{ steps.version.outputs.version }}
      tag: \${{ steps.version.outputs.tag }}

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Resolve release version
        id: version
        run: |
          VERSION=$(node -p "require('./package.json').version")
          echo "version=\${VERSION}" >> "$GITHUB_OUTPUT"
          echo "tag=v\${VERSION}" >> "$GITHUB_OUTPUT"

      - name: Create Git tag
        run: |
          TAG="\${{ steps.version.outputs.tag }}"
          HEAD_SHA=$(git rev-parse HEAD)

          if git rev-parse "$TAG" >/dev/null 2>&1; then
            TAG_SHA=$(git rev-parse "$TAG")
            if [ "$TAG_SHA" = "$HEAD_SHA" ]; then
              echo "Tag \${TAG} already points to HEAD"
              exit 0
            fi
            echo "::error::Tag \${TAG} already exists on \${TAG_SHA}, but HEAD is \${HEAD_SHA}. Bump package.json version before merging."
            exit 1
          fi

          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git tag "$TAG"
          git push origin "$TAG"

  release:
    runs-on: ubuntu-latest
    needs: [tag, deploy]
    permissions:
      contents: write

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Detect prerelease
        id: meta
        run: |
          TAG="\${{ needs.tag.outputs.tag }}"
          if [[ "$TAG" == *-* ]]; then
            echo "prerelease=true" >> "$GITHUB_OUTPUT"
          else
            echo "prerelease=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: \${{ needs.tag.outputs.tag }}
          generate_release_notes: true
          prerelease: \${{ steps.meta.outputs.prerelease == 'true' }}
          skip_if_release_exists: true

  build:
    runs-on: ubuntu-latest
    needs: tag

${secretsEnvComment}
    env:
${secretsEnv}

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
${constructDbStep}
      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "${SCAFFOLD_NODE_VERSION}"
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build:ci
        env:
          NODE_ENV: production${buildEnvBlock}

      - name: Create archive
        run: |
          tar -czf deploy.tar.gz \\
${archive}

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: build-artifact
          path: deploy.tar.gz
          if-no-files-found: error

  deploy:
    runs-on: ubuntu-latest
    needs: build

${secretsEnvComment}
    env:
${secretsEnv}

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Download artifact
        uses: actions/download-artifact@v4
        with:
          name: build-artifact
          path: ./
${constructDbStep}
      - name: Install SSH key
        uses: shimataro/ssh-key-action@v2
        with:
          key: \${{ env.SSH_PRIVATE_KEY }}
          known_hosts: placeholder
          if_key_exists: replace

      - name: Add known hosts
        run: ssh-keyscan -p "\${SSH_PORT}" -H "\${HOST}" >> ~/.ssh/known_hosts
        env:
          HOST: \${{ env.HOST }}
          SSH_PORT: \${{ env.SSH_PORT }}

      - name: Upload archive
        run: scp -P "\${SSH_PORT}" deploy.tar.gz "\${USERNAME}@\${HOST}:\${TARGET_DIR}/deploy.tar.gz"
        env:
          HOST: \${{ env.HOST }}
          USERNAME: \${{ env.USERNAME }}
          SSH_PORT: \${{ env.SSH_PORT }}
          TARGET_DIR: \${{ env.TARGET_DIR }}

      - name: Deploy and restart
        uses: appleboy/ssh-action@v1
        env:
${sshEnv}
        with:
          host: \${{ env.HOST }}
          username: \${{ env.USERNAME }}
          key: \${{ env.SSH_PRIVATE_KEY }}
          port: \${{ env.SSH_PORT }}
          # ここに無い変数はSSH先に存在しない。env: と同じ名前を必ず並べる。
          envs: ${sshEnvNames}
          script: |
            set -euo pipefail
            cd "\${TARGET_DIR}"

            # 待受ポートはシークレットではなく設定値として平文で持つ
            # （guchi-apps/docs の standards/ports.md「ポート番号は 1Password で管理しない」）。
            PORT=${port}

            echo "Cleaning up old release files..."
            # 配布物を増やしたらこの行にも足す。永続させたいディレクトリは絶対に入れない。
            rm -rf ${cleanup}

            echo "Extracting archive..."
            tar -xzf deploy.tar.gz
            rm deploy.tar.gz

            update_env() {
              bash scripts/update-env-file.sh .env "$1" "$2"
            }

            echo "Updating .env..."
${updateEnv}

            echo "Installing production dependencies..."
            corepack enable pnpm >/dev/null 2>&1 || true
            pnpm install --prod --frozen-lockfile
${migrate}
            echo "Restarting PM2..."
            if command -v pm2 >/dev/null 2>&1; then
              pm2 delete ${spec.repositoryName} 2>/dev/null || true
              PORT="$PORT" pm2 start deploy/ecosystem.config.js --env production
              pm2 save
            else
              echo "pm2 is required on the server. Install: npm install -g pm2"
              exit 1
            fi

            echo "Health check..."
            # Next.js は起動完了までに数秒かかる。1回だけのcurlでは起動が間に合わずに
            # 失敗するため、一定時間リトライする。
            for i in $(seq 1 30); do
              if curl -fsS -o /dev/null "http://127.0.0.1:\${PORT}/"; then
                echo "Deployment successful."
                exit 0
              fi
              sleep 2
            done

            echo "Health check failed after 60s."
            pm2 describe ${spec.repositoryName} || true
            pm2 logs ${spec.repositoryName} --lines 50 --nostream || true
            exit 1

      # **deployジョブの成功は公開できたことを保証しない**（guchi-apps/issue-deck#2252）。
      # 上のヘルスチェックが叩くのはVPS内の127.0.0.1で、ApacheのVirtualHostが無くても通る。
      # ここで公開URLを外から引き、DNS・Apache・TLSまで通っているかを確かめる。
      #
      # **失敗させない。** certbot前・DNS未反映の初回デプロイは必ず落ちるため、
      # 警告として出すだけにする（初回だけの分岐も持たない。2回目以降もApacheの設定や
      # プロセスが壊れていれば拾えるほうがよい）。
      - name: 公開URLの疎通を確認する（警告のみ）
        continue-on-error: true
        run: |
          URL="${publicUrl}"
          # 失敗時もcurl自身が %{http_code} に 000 を出す。パイプで 000 を足すと
          # 2行になって数値比較が壊れるので、終了コードだけを握りつぶす
          CODE=$(curl -sS -o /dev/null -w '%{http_code}' -I --max-time 20 "$URL") || true
          [ -n "$CODE" ] || CODE=000
          if [ "$CODE" -ge 200 ] && [ "$CODE" -lt 400 ]; then
            echo "$URL -> $CODE"
          else
            echo "::warning::$URL が開けませんでした（HTTP $CODE）。デプロイ自体は成功しています。DNSのAレコード・ApacheのVirtualHost・TLS証明書を確認してください。"
          fi

  notify:
    runs-on: ubuntu-latest
    needs: [tag, build, deploy]
    if: always()

    env:
      SIGNALY_WEBHOOK_URL: \${{ secrets.SIGNALY_WEBHOOK_URL }}

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Determine workflow status
        id: status
        run: |
          tag="\${{ needs.tag.result }}"
          build="\${{ needs.build.result }}"
          deploy="\${{ needs.deploy.result }}"
          if [ "$tag" = "success" ] && [ "$build" = "success" ] && [ "$deploy" = "success" ]; then
            result=success
          elif [ "$tag" = "cancelled" ] || [ "$build" = "cancelled" ] || [ "$deploy" = "cancelled" ]; then
            result=cancelled
          else
            result=failure
          fi
          echo "result=$result" >> "$GITHUB_OUTPUT"

      - name: Signaly に通知
        # 通知はCIやデプロイの合否そのものではない。ここが失敗してもrun全体を
        # 落とさない（guchi-apps/issue-deck#1302）。
        continue-on-error: true
        env:
          SIGNALY_WEBHOOK_URL: \${{ env.SIGNALY_WEBHOOK_URL }}
          NOTIFY_APP: ${spec.repositoryName}
          NOTIFY_KIND: デプロイ
          NOTIFY_STATUS: \${{ steps.status.outputs.result }}
        run: bash .github/scripts/signaly-notify.sh

  notify-release:
    runs-on: ubuntu-latest
    needs: [tag, deploy, release]
    if: always() && needs.release.result != 'skipped'

    env:
      SIGNALY_WEBHOOK_URL: \${{ secrets.SIGNALY_WEBHOOK_URL }}

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Signaly に通知
        continue-on-error: true
        env:
          SIGNALY_WEBHOOK_URL: \${{ env.SIGNALY_WEBHOOK_URL }}
          # リリースだけはCI・デプロイと別のチャンネルへ送る（guchi-apps/issue-deck#2391）。
          # 未登録なら空が渡り、スクリプトが従来のチャンネルへフォールバックする。
          SIGNALY_RELEASE_WEBHOOK_URL: \${{ secrets.SIGNALY_RELEASE_WEBHOOK_URL }}
          NOTIFY_STATUS: \${{ needs.release.result }}
          NOTIFY_APP: ${spec.repositoryName}
          NOTIFY_KIND: リリース
          NOTIFY_VERSION: \${{ needs.tag.outputs.tag }}
        run: bash .github/scripts/signaly-notify.sh
`;
}
