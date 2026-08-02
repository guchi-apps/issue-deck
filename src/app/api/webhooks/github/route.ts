import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import type { GithubApiIssue } from "@/lib/github/issues-api";
import {
  deleteIssueByGithubId,
  syncRepositoryIssues,
  upsertIssueFromWebhookPayload,
} from "@/lib/github/sync-issues";
import type { AccountType } from "@prisma/client";

type InstallationRepoPayload = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
};

type InstallationPayload = {
  id: number;
  account: { id: number; login: string; type: string } | null;
  repository_selection: "all" | "selected";
};

function verifySignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signatureHeader);
  if (expectedBuffer.length !== actualBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function toAccountType(githubType: string): AccountType {
  return githubType === "Organization" ? "ORGANIZATION" : "USER";
}

async function handleIssuesEvent(payload: {
  action: string;
  issue: GithubApiIssue;
  repository: { id: number };
}) {
  if (payload.action === "deleted") {
    await deleteIssueByGithubId(payload.issue.id);
    return;
  }

  const repository = await db.repository.findUnique({
    where: { githubRepositoryId: payload.repository.id },
  });
  if (!repository) return;

  await upsertIssueFromWebhookPayload(repository.id, payload.issue);
}

async function handleIssueCommentEvent(payload: {
  action: string;
  issue: GithubApiIssue;
  repository: { id: number };
}) {
  // issue_commentイベントはPRへのコメントでも発火する（GitHub内部ではPRもissueの一種のため）。
  // PRはissue一覧の対象外なので、pull_requestキーを持つペイロードは無視する。
  if (payload.issue.pull_request) return;

  const repository = await db.repository.findUnique({
    where: { githubRepositoryId: payload.repository.id },
  });
  if (!repository) return;

  await upsertIssueFromWebhookPayload(repository.id, payload.issue);
}

async function handleLabelEvent(payload: {
  action: string;
  label: { id: number; name: string; color: string; description: string | null };
  repository: { id: number };
}) {
  const repository = await db.repository.findUnique({
    where: { githubRepositoryId: payload.repository.id },
  });
  if (!repository) return;

  const githubLabelId = BigInt(payload.label.id);

  if (payload.action === "deleted") {
    await db.issueLabel.deleteMany({
      where: { githubLabelId, issue: { repositoryId: repository.id } },
    });
    return;
  }

  if (payload.action === "edited") {
    await db.issueLabel.updateMany({
      where: { githubLabelId, issue: { repositoryId: repository.id } },
      data: {
        name: payload.label.name,
        color: payload.label.color,
        description: payload.label.description,
      },
    });
  }
}

async function handleInstallationRepositoriesEvent(payload: {
  action: "added" | "removed";
  installation: InstallationPayload;
  repositories_added?: InstallationRepoPayload[];
  repositories_removed?: InstallationRepoPayload[];
}) {
  const installation = await db.githubInstallation.findUnique({
    where: { installationId: payload.installation.id },
  });
  if (!installation) return;

  if (payload.action === "removed" && payload.repositories_removed) {
    await db.repository.deleteMany({
      where: {
        installationId: installation.id,
        githubRepositoryId: { in: payload.repositories_removed.map((repo) => repo.id) },
      },
    });
  }

  if (payload.action === "added" && payload.repositories_added) {
    for (const repo of payload.repositories_added) {
      const ownerLogin = repo.full_name.split("/")[0];
      const created = await db.repository.upsert({
        where: { githubRepositoryId: repo.id },
        create: {
          githubRepositoryId: repo.id,
          installationId: installation.id,
          ownerLogin,
          name: repo.name,
          fullName: repo.full_name,
          private: repo.private,
          htmlUrl: `https://github.com/${repo.full_name}`,
          archived: false,
          defaultBranch: "main",
          lastSyncedAt: new Date(),
        },
        update: {
          ownerLogin,
          name: repo.name,
          fullName: repo.full_name,
          private: repo.private,
        },
      });
      await syncRepositoryIssues({
        id: created.id,
        ownerLogin,
        name: created.name,
        installation: { installationId: installation.installationId },
      });
    }
  }
}

async function handleInstallationEvent(payload: {
  action: string;
  installation: InstallationPayload;
}) {
  if (payload.action === "deleted") {
    await db.githubInstallation.deleteMany({
      where: { installationId: payload.installation.id },
    });
    return;
  }

  if (payload.action === "suspend" || payload.action === "unsuspend") {
    await db.githubInstallation.updateMany({
      where: { installationId: payload.installation.id },
      data: { suspendedAt: payload.action === "suspend" ? new Date() : null },
    });
    return;
  }

  if (payload.installation.account) {
    await db.githubInstallation.updateMany({
      where: { installationId: payload.installation.id },
      data: {
        accountLogin: payload.installation.account.login,
        accountType: toAccountType(payload.installation.account.type),
        repositorySelection: payload.installation.repository_selection === "all" ? "ALL" : "SELECTED",
      },
    });
  }
}

export async function POST(request: NextRequest) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "webhook_not_configured" }, { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifySignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  const payload = JSON.parse(rawBody);

  try {
    if (event === "issues") {
      await handleIssuesEvent(payload);
    } else if (event === "issue_comment") {
      await handleIssueCommentEvent(payload);
    } else if (event === "label") {
      await handleLabelEvent(payload);
    } else if (event === "installation_repositories") {
      await handleInstallationRepositoriesEvent(payload);
    } else if (event === "installation") {
      await handleInstallationEvent(payload);
    }
  } catch (error) {
    // 非2xxを返すとGitHubが自動再送・手動redeliveryの対象にしてくれるため、
    // 握りつぶさずエラーとして返す。
    console.error("[webhooks/github] failed to process event", event, error);
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
