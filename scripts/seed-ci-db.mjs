#!/usr/bin/env node
// GitHub Actions上の無人実行環境で開発サーバーの画面に何かしら表示させるための、
// 最小限のダミーデータを投入するスクリプト。実際のGitHub App同期処理
// (src/lib/github/sync-issues.ts等)は使わず、Prisma経由で直接書き込む(#256)。
//
// 実行前に `prisma migrate deploy` でスキーマを適用しておくこと。
// 使い方: DATABASE_URL=mysql://... node scripts/seed-ci-db.mjs
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
      const githubIssueId = BigInt(repositoryGithubId) * 1000n + BigInt(number);
      const now = new Date();
      const issue = await prisma.issue.upsert({
        where: { githubIssueId },
        update: {},
        create: {
          number,
          title: template.title,
          body: "CI環境の画面確認用ダミーIssueです。",
          state: template.state,
          authorLogin: "ci-dummy-user",
          commentCount: COMMENT_COUNT_PER_ISSUE,
          githubIssueId,
          repositoryId: repository.id,
          htmlUrl: `${repository.htmlUrl}/issues/${number}`,
          githubCreatedAt: now,
          githubUpdatedAt: now,
        },
      });

      for (const label of template.labels) {
        await prisma.issueLabel.upsert({
          where: { issueId_name: { issueId: issue.id, name: label.name } },
          update: {},
          create: { issueId: issue.id, name: label.name, color: label.color },
        });
      }
    }
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
