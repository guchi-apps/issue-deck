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

async function upsertDummyIssue(repository, { number, title, state, labels, projectStatus = null }) {
  const githubIssueId = BigInt(repository.githubRepositoryId) * 1000n + BigInt(number);
  const now = new Date();
  const issue = await prisma.issue.upsert({
    where: { githubIssueId },
    update: {},
    create: {
      number,
      title,
      body: "CI環境の画面確認用ダミーIssueです。",
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

  console.log(
    `開発用プロファイル: リポジトリ${updatedRepositories.count}件に実行導線のフラグを立て、Issue${issues.length}件の進捗をカンバンの全列へ散らしました。`,
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
