#!/usr/bin/env node
// Fly.io Machinesプレビュー環境（#826）向け。本番DBダンプをロードしたMariaDBサービス
// コンテナ（.github/workflows/deploy-preview.yml、#831）に対して、開発App
// （issue-deck-dev, App ID 4445268）向けのinstallation ID書き換えと、ユーザートークンの
// サニタイズを行う。GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_BASE64 には、このプロセスに
// 限り開発Appの値を渡すこと（本番Appの値ではinstallation一覧を解決できない）。
//
// GithubInstallation.installationId（prisma/schema.prisma:53）はGitHub App固有のため、
// 本番AppのインストールIDのままでは開発Appとして認証した際にGitHubから404が返る
// （src/lib/github/app-auth.ts の getInstallationToken 参照）。
//
// 本番に複数installationが存在する可能性は未確認のため、GithubInstallationの行数が
// 1件でない場合・開発App側のinstallation一覧が1件でない場合は、事故防止のため
// 書き換えを行わずエラー終了する（installationIdは@uniqueのため、複数行を同一IDに
// 書き換えると一意制約違反になる）。
//
// 使い方: DATABASE_URL=mysql://... GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY_BASE64=... \
//   node scripts/preview-sanitize-dump.mjs

import { createAppAuth } from "@octokit/auth-app";
import { PrismaClient } from "@prisma/client";

const GITHUB_API = "https://api.github.com";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

async function resolveDevInstallationId() {
  const appId = requireEnv("GITHUB_APP_ID");
  const privateKeyBase64 = requireEnv("GITHUB_APP_PRIVATE_KEY_BASE64");
  const privateKey = Buffer.from(privateKeyBase64, "base64").toString("utf-8");

  const auth = createAppAuth({ appId, privateKey });
  const { token: jwt } = await auth({ type: "app" });

  const res = await fetch(`${GITHUB_API}/app/installations`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to list installations: ${res.status} ${await res.text()}`);
  }
  const installations = await res.json();
  if (installations.length !== 1) {
    throw new Error(
      `Expected exactly 1 installation for the dev app, but got ${installations.length}. ` +
        "Aborting to avoid an ambiguous rewrite.",
    );
  }
  return installations[0].id;
}

async function main() {
  const devInstallationId = await resolveDevInstallationId();
  console.log(`開発Appのinstallation IDを解決しました: ${devInstallationId}`);

  const db = new PrismaClient();
  try {
    const installations = await db.githubInstallation.findMany({ select: { id: true, installationId: true } });
    if (installations.length !== 1) {
      throw new Error(
        `Expected exactly 1 GithubInstallation row in the dump, but got ${installations.length}. ` +
          "Aborting to avoid an ambiguous rewrite.",
      );
    }

    const [{ id, installationId: previousInstallationId }] = installations;
    await db.githubInstallation.update({
      where: { id },
      data: { installationId: devInstallationId },
    });
    console.log(`GithubInstallation.installationId を書き換えました: ${previousInstallationId} -> ${devInstallationId}`);

    const { count } = await db.user.updateMany({
      data: { githubAccessToken: null, githubRefreshToken: null },
    });
    console.log(`User.githubAccessToken / githubRefreshToken をNULL化しました: ${count}件`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
