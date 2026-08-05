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
const REPOSITORY_GITHUB_ID = 900000001;

// Issue #584: フィルタータブの高さ潰れ不具合はIssue件数が多いときにだけ再現するため、
// 画面確認用に十分な件数（15件）を投入する。デフォルトビュー（「すべてのIssue」）の
// 既定状態フィルターはopen（src/lib/nav-views.tsのgetNavViewDefaultState）のため、
// 追加分もOPENにして無条件で一覧に表示されるようにしている。
const ISSUES = [
  {
    number: 1,
    title: "ログイン画面のレイアウトを見直す",
    body: "CI環境の画面確認用ダミーIssueです。",
    state: "OPEN",
    authorLogin: "ci-dummy-user",
    commentCount: 2,
    labels: [{ name: "bug", color: "d73a4a" }],
  },
  {
    number: 2,
    title: "ダッシュボードの表示速度を改善する",
    body: "CI環境の画面確認用ダミーIssueです。",
    state: "OPEN",
    authorLogin: "ci-dummy-user",
    commentCount: 0,
    labels: [{ name: "enhancement", color: "a2eeef" }],
  },
  {
    number: 3,
    title: "通知メールのテンプレートを修正する",
    body: "CI環境の画面確認用ダミーIssueです。",
    state: "OPEN",
    authorLogin: "ci-dummy-user",
    commentCount: 1,
    labels: [],
  },
  {
    number: 4,
    title: "検索フォームのプレースホルダーを修正する",
    body: "CI環境の画面確認用ダミーIssueです。",
    state: "OPEN",
    authorLogin: "ci-dummy-user",
    commentCount: 0,
    labels: [{ name: "bug", color: "d73a4a" }],
  },
  {
    number: 5,
    title: "リポジトリ一覧のソート順を保持する",
    body: "CI環境の画面確認用ダミーIssueです。",
    state: "OPEN",
    authorLogin: "ci-dummy-user",
    commentCount: 3,
    labels: [{ name: "enhancement", color: "a2eeef" }],
  },
  {
    number: 6,
    title: "ラベル絞り込みの選択状態が消える不具合を修正する",
    body: "CI環境の画面確認用ダミーIssueです。",
    state: "OPEN",
    authorLogin: "ci-dummy-user",
    commentCount: 5,
    labels: [{ name: "bug", color: "d73a4a" }],
  },
  {
    number: 7,
    title: "モバイル版のフッターナビゲーションを改善する",
    body: "CI環境の画面確認用ダミーIssueです。",
    state: "OPEN",
    authorLogin: "ci-dummy-user",
    commentCount: 1,
    labels: [{ name: "enhancement", color: "a2eeef" }],
  },
  {
    number: 8,
    title: "Issue詳細のコメント投稿でエラーが出る",
    body: "CI環境の画面確認用ダミーIssueです。",
    state: "OPEN",
    authorLogin: "ci-dummy-user",
    commentCount: 0,
    labels: [{ name: "bug", color: "d73a4a" }],
  },
  {
    number: 9,
    title: "お気に入りリポジトリのピン留め機能を追加する",
    body: "CI環境の画面確認用ダミーIssueです。",
    state: "OPEN",
    authorLogin: "ci-dummy-user",
    commentCount: 2,
    labels: [{ name: "enhancement", color: "a2eeef" }],
  },
  {
    number: 10,
    title: "ダークモードでコントラストが低い箇所を修正する",
    body: "CI環境の画面確認用ダミーIssueです。",
    state: "OPEN",
    authorLogin: "ci-dummy-user",
    commentCount: 4,
    labels: [{ name: "bug", color: "d73a4a" }],
  },
  {
    number: 11,
    title: "担当者フィルターに複数選択を対応させる",
    body: "CI環境の画面確認用ダミーIssueです。",
    state: "OPEN",
    authorLogin: "ci-dummy-user",
    commentCount: 0,
    labels: [{ name: "enhancement", color: "a2eeef" }],
  },
  {
    number: 12,
    title: "同期処理のリトライ回数を設定可能にする",
    body: "CI環境の画面確認用ダミーIssueです。",
    state: "OPEN",
    authorLogin: "ci-dummy-user",
    commentCount: 1,
    labels: [],
  },
  {
    number: 13,
    title: "PWAインストール導線を追加する",
    body: "CI環境の画面確認用ダミーIssueです。",
    state: "OPEN",
    authorLogin: "ci-dummy-user",
    commentCount: 0,
    labels: [{ name: "enhancement", color: "a2eeef" }],
  },
  {
    number: 14,
    title: "Issue一覧の無限スクロールで重複が発生する",
    body: "CI環境の画面確認用ダミーIssueです。",
    state: "OPEN",
    authorLogin: "ci-dummy-user",
    commentCount: 6,
    labels: [{ name: "bug", color: "d73a4a" }],
  },
  {
    number: 15,
    title: "設定画面に通知のON/OFF切り替えを追加する",
    body: "CI環境の画面確認用ダミーIssueです。",
    state: "OPEN",
    authorLogin: "ci-dummy-user",
    commentCount: 2,
    labels: [{ name: "enhancement", color: "a2eeef" }],
  },
  {
    number: 16,
    title: "古いAPIエンドポイントを削除する",
    body: "CI環境の画面確認用ダミーIssueです。",
    state: "CLOSED",
    authorLogin: "ci-dummy-user",
    commentCount: 1,
    labels: [],
  },
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

  const repository = await prisma.repository.upsert({
    where: { githubRepositoryId: REPOSITORY_GITHUB_ID },
    update: {},
    create: {
      githubRepositoryId: REPOSITORY_GITHUB_ID,
      installationId: installation.id,
      ownerLogin: "ci-dummy-org",
      name: "sample-repo",
      fullName: "ci-dummy-org/sample-repo",
      private: false,
      htmlUrl: "https://github.com/ci-dummy-org/sample-repo",
      defaultBranch: "main",
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

  for (const { labels, ...issueData } of ISSUES) {
    const githubIssueId = BigInt(REPOSITORY_GITHUB_ID) * 1000n + BigInt(issueData.number);
    const now = new Date();
    const issue = await prisma.issue.upsert({
      where: { githubIssueId },
      update: { ...issueData, githubUpdatedAt: now },
      create: {
        ...issueData,
        githubIssueId,
        repositoryId: repository.id,
        htmlUrl: `${repository.htmlUrl}/issues/${issueData.number}`,
        githubCreatedAt: now,
        githubUpdatedAt: now,
      },
    });

    for (const label of labels) {
      await prisma.issueLabel.upsert({
        where: { issueId_name: { issueId: issue.id, name: label.name } },
        update: {},
        create: { issueId: issue.id, name: label.name, color: label.color },
      });
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
