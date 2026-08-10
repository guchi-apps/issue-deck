import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import type { GithubApiIssue } from "@/lib/github/issues-api";
import { fetchProjectItem } from "@/lib/github/projects-api";
import {
  deleteIssueByGithubId,
  syncRepositoryIssues,
  updateQaAnswerPendingState,
  upsertIssueFromWebhookPayload,
} from "@/lib/github/sync-issues";
import { fetchClaudeWorkflowExists } from "@/lib/github/workflow-support";
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
  changes?: { new_repository?: { id: number } };
}) {
  if (payload.action === "deleted") {
    await deleteIssueByGithubId(payload.issue.id);
    return;
  }

  if (payload.action === "transferred") {
    // issue-deck経由ではなくGitHub上で直接Issueが移動された場合も、DBの整合性を保つために対応する。
    // Webhookは移動元リポジトリ（payload.repository）宛に配信されるが、移動先はchanges.new_repositoryに入る。
    const newRepositoryId = payload.changes?.new_repository?.id;
    if (typeof newRepositoryId !== "number") {
      // 移動先が特定できないため移動先への反映はできないが、移動元に古いリポジトリ・番号のまま
      // 行を残し続けると重複表示の原因になるため、最低限のフォールバックとして削除しておく
      // （移動先での再表示は、移動先リポジトリの次回同期・Webhookで改めて行われる）
      console.error(
        "[webhooks/github] issues.transferred event is missing changes.new_repository.id",
        payload,
      );
      await deleteIssueByGithubId(payload.issue.id);
      return;
    }

    const destinationRepository = await db.repository.findUnique({
      where: { githubRepositoryId: newRepositoryId },
    });
    if (!destinationRepository) {
      // 移動先がissue-deckに未接続のリポジトリの場合、移動元のレコードを削除して整合性を保つ
      await deleteIssueByGithubId(payload.issue.id);
      return;
    }

    await upsertIssueFromWebhookPayload(destinationRepository.id, payload.issue);
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
  comment: { body: string; created_at: string };
  repository: { id: number };
}) {
  // issue_commentイベントはPRへのコメントでも発火する（GitHub内部ではPRもissueの一種のため）。
  // PRはissue一覧の対象外なので、pull_requestキーを持つペイロードは無視する。
  if (payload.issue.pull_request) return;

  const repository = await db.repository.findUnique({
    where: { githubRepositoryId: payload.repository.id },
  });
  if (!repository) return;

  // lastCommentAt（確認待ちフィルターのソート基準）は新規コメントの実際の投稿日時を
  // 反映したいため、action=createdの場合のみ渡す。edited/deletedではcomment.created_at自体が
  // 新規投稿を意味しないため対象外とする
  const commentCreatedAt =
    payload.action === "created" ? new Date(payload.comment.created_at) : undefined;
  await upsertIssueFromWebhookPayload(repository.id, payload.issue, commentCreatedAt);

  // 編集・削除は対象外とし、新規投稿のみを回答待ち状態の判定に使う
  if (payload.action === "created") {
    await updateQaAnswerPendingState(payload.issue.id, payload.comment.body);
  }
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
    const installationToken = await getInstallationToken(installation.installationId);
    for (const repo of payload.repositories_added) {
      const ownerLogin = repo.full_name.split("/")[0];
      const hasClaudeWorkflow = await fetchClaudeWorkflowExists(
        ownerLogin,
        repo.name,
        installationToken,
      ).catch(() => false);
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
          hasClaudeWorkflow,
          lastSyncedAt: new Date(),
        },
        update: {
          ownerLogin,
          name: repo.name,
          fullName: repo.full_name,
          private: repo.private,
          hasClaudeWorkflow,
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

/**
 * GitHub Projects v2 のカンバン操作を受けて、対応するIssueのStatusをDBへ反映する（#991）。
 *
 * ペイロードは`content_node_id`（GraphQLのnode ID）しか持たず、DBが持つ`githubIssueId`
 * （RESTの数値ID）と直接突き合わせられない。そのため`fetchProjectItem`でnodeを解決し、
 * ついでに現在のStatusも取得する。`changes`を見ない設計にしているのは、`created`・`restored`
 * のように`changes`を持たないactionでも同じ経路で扱えるようにするため。
 */
async function handleProjectsV2ItemEvent(payload: {
  action: string;
  projects_v2_item: { node_id: string };
  installation?: { id: number };
  organization?: { login: string };
}) {
  const installation = payload.installation?.id
    ? await db.githubInstallation.findUnique({
        where: { installationId: payload.installation.id },
      })
    : payload.organization
      ? await db.githubInstallation.findFirst({
          where: { accountLogin: payload.organization.login },
        })
      : null;
  if (!installation) return;

  // Projectから外れた場合はStatusを消し、進捗ラベル起点の判定へ戻す（フォールバック）
  if (payload.action === "deleted" || payload.action === "archived") {
    await db.issue.updateMany({
      where: { projectItemId: payload.projects_v2_item.node_id },
      data: { projectStatus: null, projectItemId: null },
    });
    return;
  }

  const token = await getInstallationToken(installation.installationId);
  const item = await fetchProjectItem(payload.projects_v2_item.node_id, token);
  // Issue以外（PR等）が追加された場合はnullになる。運用対象外なので何もしない
  if (!item) return;

  const repository = await db.repository.findUnique({
    where: { githubRepositoryId: item.repositoryDatabaseId },
  });
  // issue-deckが接続していないリポジトリのIssueは無視する（handleIssuesEventと同じ方針）
  if (!repository) return;

  await db.issue.updateMany({
    where: { repositoryId: repository.id, number: item.issueNumber },
    data: { projectStatus: item.status, projectItemId: item.itemId },
  });
}

export function POST(request: NextRequest) {
  return withGithubApiFeature("setup", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
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
    } else if (event === "projects_v2_item") {
      await handleProjectsV2ItemEvent(payload);
    }
  } catch (error) {
    // 非2xxを返すとGitHubが自動再送・手動redeliveryの対象にしてくれるため、
    // 握りつぶさずエラーとして返す。
    console.error("[webhooks/github] failed to process event", event, error);
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
