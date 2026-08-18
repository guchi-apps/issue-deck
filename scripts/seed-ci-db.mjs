#!/usr/bin/env node
// GitHub Actions上の無人実行環境で開発サーバーの画面に何かしら表示させるための、
// 最小限のダミーデータを投入するスクリプト。実際のGitHub App同期処理
// (src/lib/github/sync-issues.ts等)は使わず、Prisma経由で直接書き込む(#256)。
//
// 実行前に `prisma migrate deploy` でスキーマを適用しておくこと。
// 使い方: DATABASE_URL=mysql://... node scripts/seed-ci-db.mjs
//
// Issue #1473: `SEED_PROFILE=dev` を付けて呼ぶと、ローカル開発向けの後処理を追加で行う
// （scripts/seed-dev-db.sh 経由）。**未設定時の挙動は一切変えない。** CIのスクリーンショット
// 撮影が同じスクリプトを使っており、既定の投入内容が変わると撮れる画像まで変わるため。
//
// scripts/ci-seed-user.mjs（#257）が作成するCIバイパス用ユーザー（存在する場合）を
// 投入したGithubInstallationにUserInstallationとして紐付ける(#258)。この紐付けが無いと
// /dashboardのリポジトリ・Issue取得はいずれもUserInstallation経由の絞り込みで空になり、
// CIバイパスでログインしても画面に何も表示されない。

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// src/lib/ci-auth-bypass.ts の CI_BYPASS_SUPABASE_USER_ID と一致させること。
const CI_BYPASS_SUPABASE_USER_ID = "ci-screenshot-bot";

const INSTALLATION_ID = 900000001;
const REPOSITORY_GITHUB_ID_BASE = 900000001;
const REPOSITORY_COUNT = 5;
const ISSUES_PER_REPOSITORY = 10;
const COMMENT_COUNT_PER_ISSUE = 5;

// 各リポジトリ共通で使い回すIssueテンプレート（リポジトリ数 x このテンプレート数がIssue件数になる）。
// Issue #584: フィルタータブの高さ潰れ不具合はIssue件数が多いときにだけ再現するため、
// リポジトリを跨いだ合計件数（REPOSITORY_COUNT x このテンプレート数 = 50件）で
// 「すべてのIssue」ビュー（src/lib/issues-for-user.tsは全リポジトリのIssueを横断取得する）
// に十分な件数が並ぶようにしている。
const ISSUE_TEMPLATES = [
  { title: "ログイン画面のレイアウトを見直す", state: "OPEN", labels: [{ name: "bug", color: "d73a4a" }] },
  { title: "ダッシュボードの表示速度を改善する", state: "OPEN", labels: [{ name: "enhancement", color: "a2eeef" }] },
  { title: "通知メールのテンプレートを修正する", state: "CLOSED", labels: [] },
  { title: "検索機能にフィルタを追加する", state: "OPEN", labels: [{ name: "enhancement", color: "a2eeef" }] },
  { title: "モバイル版のナビゲーションを改善する", state: "OPEN", labels: [{ name: "bug", color: "d73a4a" }] },
  { title: "APIレスポンスのキャッシュを見直す", state: "CLOSED", labels: [{ name: "enhancement", color: "a2eeef" }] },
  { title: "エラーメッセージの文言を統一する", state: "OPEN", labels: [{ name: "documentation", color: "0075ca" }] },
  { title: "ダークモード対応を追加する", state: "OPEN", labels: [{ name: "enhancement", color: "a2eeef" }] },
  { title: "CSVエクスポート機能を追加する", state: "CLOSED", labels: [] },
  { title: "アクセシビリティ対応を強化する", state: "OPEN", labels: [{ name: "question", color: "d876e3" }] },
];

async function upsertDummyIssue(
  repository,
  {
    number,
    title,
    state,
    labels,
    projectStatus = null,
    body = "CI環境の画面確認用ダミーIssueです。",
  },
) {
  const githubIssueId = BigInt(repository.githubRepositoryId) * 1000n + BigInt(number);
  const now = new Date();
  const issue = await prisma.issue.upsert({
    where: { githubIssueId },
    update: {},
    create: {
      number,
      title,
      body,
      state,
      authorLogin: "ci-dummy-user",
      commentCount: COMMENT_COUNT_PER_ISSUE,
      githubIssueId,
      repositoryId: repository.id,
      htmlUrl: `${repository.htmlUrl}/issues/${number}`,
      githubCreatedAt: now,
      githubUpdatedAt: now,
      projectStatus,
    },
  });

  for (const label of labels) {
    await prisma.issueLabel.upsert({
      where: { issueId_name: { issueId: issue.id, name: label.name } },
      update: {},
      create: { issueId: issue.id, name: label.name, color: label.color },
    });
  }

  return issue;
}

// 承認待ちカードのスクリーンショット確認用ダミーIssue（#688）。通常の承認/修正/取り下げ画面と
// PRマージ待ち画面をそれぞれ再現するため、最初のリポジトリにのみ2件追加する。ラベル名・
// Status名はsrc/lib/github/approval-labels.ts・src/lib/issue-progress.tsの値と一致させること
// （このスクリプトはPrisma経由で直接書き込むためsrc配下をimportしない）。
//
// PRマージ待ちの再現に使うのは進捗ラベルではなくProject Statusの`Develop PR`。
// 進捗ラベルは#991 Phase 5（#1010）で廃止した。
const APPROVAL_SAMPLE_ISSUES = [
  {
    number: ISSUES_PER_REPOSITORY + 1,
    title: "[CI確認用] 承認待ちサンプルIssue",
    labels: [{ name: "00.check-user", color: "d93f0b" }],
  },
  {
    number: ISSUES_PER_REPOSITORY + 2,
    title: "[CI確認用] PRマージ待ちサンプルIssue",
    // 実運用のマージ待ちと同じラベルの組にする。`01.check-merge`は理由ラベル（#1490）、
    // `22.merge-confirm-required`はマージ待ちの理由表示（#1631）が読むラベルで、
    // これが無いと画面の理由欄が「記録が見つかりません」しか再現できない
    labels: [
      { name: "00.check-user", color: "d93f0b" },
      { name: "01.check-merge", color: "d93f0b" },
      { name: "22.merge-confirm-required", color: "0e8a16" },
    ],
    projectStatus: "Develop PR",
  },
];

// ローカル開発（`SEED_PROFILE=dev`）でだけ流す後処理（#1473）。
//
// 既定の投入だけだと `projectStatus` がほぼ null で、カンバンの列が「未着手」しか埋まらない。
// 「開発環境を起動してもデータが正しく表示されない」の中身の一つがこれなので、開発用途では
// 進捗を全列に散らし、リポジトリにも実行導線が出るフラグを立てておく。
//
// **`upsert` の `update: {}` は2回目以降なにも書き換えない。** ここは投入済みの行に対して
// 明示的な更新をかける必要があるため、`updateMany` / `update` を使う。
//
// Status名は src/lib/issue-progress.ts の PROGRESS_STATUSES と一致させること
// （このスクリプトはPrisma経由で直接書き込むためsrc配下をimportしない。上の
// APPROVAL_SAMPLE_ISSUES と同じ理由）。
const DEV_PROJECT_STATUS_CYCLE = [
  "Ready",
  "Planning",
  "Implementation",
  "Develop PR",
  "Develop",
  "Release",
  "Done",
];

/**
 * 開発用の手作業Issue（`71.manual-step`）のサンプル本文（#1705）。
 *
 * 「前提条件の状況」（Issue詳細の手作業パネル）は、本文に書かれた参照の**進捗が段階ごとに
 * 違う**ときにしか読み比べられない。そのため参照先の番号は固定で書かず、進捗を散らした
 * 結果から引いて埋める（`DEV_PROJECT_STATUS_CYCLE`の並びやリポジトリの順序が変わっても
 * ずれない）。
 *
 * **前提待ちのものと、いま実行できるものを1件ずつ作る**（#1763）。左メニューの件数は
 * 実行できる手作業だけを数え、一覧の行にはどちらなのかをアイコンで出すため、片方しか
 * 無いと開発環境ではその違いを確かめられない。
 *
 * @param origin 起点Issue（実装中）の番号
 * @param developed developへ入っているIssue（本番未反映）の番号。nullなら前提待ちにしない
 * @param released mainへ反映済みのIssueの番号
 */
function manualStepSampleBody(origin, developed, released) {
  return [
    "## この作業でできるようになること",
    "",
    "- できるようになること: 本番のsample-repo-1から通知が飛ぶようになる",
    "- 実行するまでできないこと: 本番の通知が飛ばないままになる（リリース後すみやかに実施したい）",
    "",
    "## 前提条件",
    "",
    "- 実行するデバイス: VPS（`ssh vps`）",
    "- カレントディレクトリ: `/var/www/sample-repo-1`",
    "- Gitブランチ: `develop`",
    developed === null
      ? `- 先に完了している必要があるIssue・PR: #${released} の変更が本番へ出た後`
      : `- 先に完了している必要があるIssue・PR: #${developed} がmainへ反映された後、#${released} の変更が本番へ出た後`,
    "- その他の前提: なし",
    "",
    "## やること",
    "",
    "- [ ] `.env`へ`SAMPLE_TOKEN`を追記する",
    "- [ ] PM2を再起動する",
    "",
    "## 完了の確認方法",
    "",
    "`pm2 logs sample-repo-1`に`notify: ok`が出ること。",
    "",
    "## なぜエージェントが実施しないか",
    "",
    "本番サーバーの`.env`はリポジトリに無く、エージェントからは書き換えられないため。",
    "",
    "## 関連",
    "",
    `- 起点Issue: #${origin}`,
  ].join("\n");
}

/**
 * サブPCで実行する手作業のサンプル本文（#1828）。
 *
 * 手作業アシスタントの**代行実行（「承認して実行」）は、実行するデバイスがサブPCで、かつ
 * 手順の中にシェルのコードブロックがちょうど1つある手順にしか出ない。** 上の2件（VPS・
 * 1Password）はどちらも条件を満たさないため、これが無いと開発環境では「代行できません」の
 * 側しか確かめられない。
 *
 * **2つ目の手順にはコマンドを置いていない**（代行できない手順の見え方も同じ本文で確かめられる）。
 *
 * **`## 完了の確認方法`はコードブロックで書く**（#1869）。確認のコマンドも代行の対象になったので、
 * インラインコードのままだと開発環境で自動実行の最後の1件を確かめられない。
 *
 * @param origin 起点Issue（mainへ反映済み）の番号
 */
function manualStepSubpcSampleBody(origin) {
  return [
    "## この作業でできるようになること",
    "",
    "- できるようになること: サブPCのチェックアウトが最新になり、新しいpollerが動く",
    "- 実行するまでできないこと: developへ入れた変更がサブPC側に反映されない",
    "",
    "## 前提条件",
    "",
    "- 実行するデバイス: **サブPC**（メインPCからなら `ssh subpc`）",
    "- カレントディレクトリ: `~/apps/issue-deck`",
    "- Gitブランチ: `develop`（本体チェックアウトがdevelopのため）",
    `- 先に完了している必要があるIssue・PR: #${origin} の変更が本番へ出た後`,
    "- その他の前提: なし",
    "",
    "## やること",
    "",
    "- [ ] 本体チェックアウトを最新のdevelopへ更新する",
    "",
    "    ```bash",
    "    cd ~/apps/issue-deck",
    "    git pull --ff-only",
    "    ```",
    "",
    "- [ ] 画面のホストの行で、チェックアウトの遅れが消えていることを確かめる",
    "",
    "## 完了の確認方法",
    "",
    "次のコマンドが `0` を返すこと。",
    "",
    "```bash",
    "git -C ~/apps/issue-deck rev-list --count HEAD..origin/develop",
    "```",
    "",
    "## なぜエージェントが実施しないか",
    "",
    "`~/apps/issue-deck`は本体チェックアウトで、実装エージェントが触れるのは自分のworktreeだけのため。",
    "",
    "## 関連",
    "",
    `- 起点Issue: #${origin}`,
  ].join("\n");
}

async function applyDevProfile(installation) {
  // 「実装を開始」「ローカルで開始」の導線は、この2つのフラグが立っているリポジトリにしか出ない。
  const updatedRepositories = await prisma.repository.updateMany({
    where: { installationId: installation.id },
    data: { hasClaudeWorkflow: true, hasLocalStartScript: true },
  });

  // 承認待ちサンプル（APPROVAL_SAMPLE_ISSUES）は意図した進捗を持たせてあるので触らない。
  const issues = await prisma.issue.findMany({
    where: {
      repository: { installationId: installation.id },
      number: { lte: ISSUES_PER_REPOSITORY },
    },
    orderBy: [{ repositoryId: "asc" }, { number: "asc" }],
    select: { id: true },
  });

  for (const [index, issue] of issues.entries()) {
    await prisma.issue.update({
      where: { id: issue.id },
      data: { projectStatus: DEV_PROJECT_STATUS_CYCLE[index % DEV_PROJECT_STATUS_CYCLE.length] },
    });
  }

  // 手作業Issueのサンプル（#1705）。進捗を散らした**後**に、実際に散った結果から参照先を
  // 選んで作る（このIssue自身の進捗はReadyのまま）
  const firstRepository = await prisma.repository.findFirst({
    where: { installationId: installation.id },
    orderBy: { githubRepositoryId: "asc" },
  });
  const referenceFor = async (projectStatus) =>
    firstRepository
      ? await prisma.issue.findFirst({
          where: {
            repositoryId: firstRepository.id,
            number: { lte: ISSUES_PER_REPOSITORY },
            projectStatus,
          },
          orderBy: { number: "asc" },
          select: { number: true },
        })
      : null;
  const [origin, developed, released] = await Promise.all([
    referenceFor("Develop PR"),
    referenceFor("Develop"),
    referenceFor("Done"),
  ]);
  const hasManualStepSample = Boolean(firstRepository && origin && developed && released);
  if (hasManualStepSample) {
    // 前提待ち（#developedがdevelopまでしか来ていない）
    await upsertDummyIssue(firstRepository, {
      number: ISSUES_PER_REPOSITORY + 3,
      title: "[手作業] VPS: sample-repo-1の.envにSAMPLE_TOKENを追加する",
      state: "OPEN",
      labels: [{ name: "71.manual-step", color: "d876e3" }],
      body: manualStepSampleBody(origin.number, developed.number, released.number),
    });
    // いま実行できる（待つ相手が本番へ出ているものだけ。起点も反映済みにする）
    await upsertDummyIssue(firstRepository, {
      number: ISSUES_PER_REPOSITORY + 4,
      title: "[手作業] 1Password: sample-repo-1のSAMPLE_TOKENを発行する",
      state: "OPEN",
      labels: [{ name: "71.manual-step", color: "d876e3" }],
      body: manualStepSampleBody(released.number, null, released.number),
    });
    // サブPCで実行するもの（#1828。代行実行の「承認して実行」が出る唯一のサンプル）
    await upsertDummyIssue(firstRepository, {
      number: ISSUES_PER_REPOSITORY + 5,
      title: "[手作業] サブPC: issue-deckのチェックアウトを更新する",
      state: "OPEN",
      labels: [{ name: "71.manual-step", color: "d876e3" }],
      body: manualStepSubpcSampleBody(released.number),
    });
  }

  console.log(
    `開発用プロファイル: リポジトリ${updatedRepositories.count}件に実行導線のフラグを立て、Issue${issues.length}件の進捗をカンバンの全列へ散らし、手作業Issueのサンプルを${hasManualStepSample ? 3 : 0}件（前提待ち・いま実行できる・サブPCで代行できる各1件）追加しました。`,
  );
}

async function main() {
  const installation = await prisma.githubInstallation.upsert({
    where: { installationId: INSTALLATION_ID },
    update: {},
    create: {
      installationId: INSTALLATION_ID,
      accountId: INSTALLATION_ID,
      accountLogin: "ci-dummy-org",
      accountType: "ORGANIZATION",
      repositorySelection: "ALL",
    },
  });

  const ciUser = await prisma.user.findUnique({
    where: { supabaseUserId: CI_BYPASS_SUPABASE_USER_ID },
  });
  if (ciUser) {
    await prisma.userInstallation.upsert({
      where: { userId_installationId: { userId: ciUser.id, installationId: installation.id } },
      update: {},
      create: { userId: ciUser.id, installationId: installation.id },
    });
  } else {
    console.warn(
      `CIバイパス用ユーザー（supabaseUserId=${CI_BYPASS_SUPABASE_USER_ID}）が見つからないため、UserInstallationの紐付けをスキップしました。先にscripts/ci-seed-user.mjsを実行してください。`,
    );
  }

  for (let repoIndex = 0; repoIndex < REPOSITORY_COUNT; repoIndex++) {
    const repoNumber = repoIndex + 1;
    const repositoryGithubId = REPOSITORY_GITHUB_ID_BASE + repoIndex;
    const repoName = `sample-repo-${repoNumber}`;

    const repository = await prisma.repository.upsert({
      where: { githubRepositoryId: repositoryGithubId },
      update: {},
      create: {
        githubRepositoryId: repositoryGithubId,
        installationId: installation.id,
        ownerLogin: "ci-dummy-org",
        name: repoName,
        fullName: `ci-dummy-org/${repoName}`,
        private: false,
        htmlUrl: `https://github.com/ci-dummy-org/${repoName}`,
        defaultBranch: "main",
      },
    });

    for (let issueIndex = 0; issueIndex < ISSUES_PER_REPOSITORY; issueIndex++) {
      const template = ISSUE_TEMPLATES[issueIndex % ISSUE_TEMPLATES.length];
      const number = issueIndex + 1;
      await upsertDummyIssue(repository, {
        number,
        title: template.title,
        state: template.state,
        labels: template.labels,
      });
    }

    if (repoIndex === 0) {
      for (const sample of APPROVAL_SAMPLE_ISSUES) {
        await upsertDummyIssue(repository, { ...sample, state: "OPEN" });
      }
    }
  }

  if (process.env.SEED_PROFILE === "dev") {
    await applyDevProfile(installation);
  }

  console.log("CI用ダミーデータのシードが完了しました。");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
