import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { labelsAfterApproval, PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
import { createComment, updateIssue, type GithubApiIssue } from "@/lib/github/issues-api";
import {
  dispatchCommentBody,
  isOwnAppSender,
  LOCAL_LABEL_NAME,
  resolveDispatchMode,
  type DispatchMode,
} from "@/lib/github/project-status-dispatch";
import { fetchProjectItem } from "@/lib/github/projects-api";
import {
  deleteIssueByGithubId,
  syncRepositoryIssues,
  updateQaAnswerPendingState,
  upsertIssueFromWebhookPayload,
} from "@/lib/github/sync-issues";
import { fetchLocalStartScriptSupported } from "@/lib/github/local-session-support";
import { fetchClaudeWorkflowExists } from "@/lib/github/workflow-support";
import type { AccountType, IssueState } from "@prisma/client";

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
      // ローカル起動プロトコルへの適合（#1073）。Actions側の対応とは別の軸なので個別に問い合わせる。
      const hasLocalStartScript = await fetchLocalStartScriptSupported(
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
          hasLocalStartScript,
          lastSyncedAt: new Date(),
        },
        update: {
          ownerLogin,
          name: repo.name,
          fullName: repo.full_name,
          private: repo.private,
          hasClaudeWorkflow,
          hasLocalStartScript,
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
  sender?: { login?: string };
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

  const issue = await db.issue.findUnique({
    where: { repositoryId_number: { repositoryId: repository.id, number: item.issueNumber } },
    select: { projectStatus: true, state: true, labels: { select: { name: true } } },
  });
  const previousStatus = issue?.projectStatus ?? null;

  // 遷移前のStatusを条件に含めた比較更新にする（compare-and-set）。Webhookの再配信や
  // 同一イベントの同時配信があっても、実際に状態を進めた1回だけがcount > 0になるため、
  // 後続の起動が二重に走らない（#991 Phase 3）。
  const updated = await db.issue.updateMany({
    where: {
      repositoryId: repository.id,
      number: item.issueNumber,
      projectStatus: previousStatus,
    },
    data: { projectStatus: item.status, projectItemId: item.itemId },
  });
  if (updated.count === 0) return;

  await maybeDispatchFromProjectStatus({
    repository,
    installationId: installation.installationId,
    issueNumber: item.issueNumber,
    issueState: issue?.state,
    issueLabels: issue?.labels.map((label) => label.name) ?? [],
    from: previousStatus,
    to: item.status,
    senderLogin: payload.sender?.login,
  });
}

/**
 * 起動コメントを投稿する前に整えるラベル一覧。変更不要ならnull。
 *
 * **ラベル操作はissue-deckのGitHub Appトークンで行う。** そのため`issues.unlabeled`イベントの
 * senderがAppになり、ワークフローの自己ループ防止で無視される（マーカーによる操作者の復元は
 * `issue_comment`にしか効かない）。つまり**起動の引き金になるのは後続のコメントだけ**であり、
 * 「計画を承認」ボタンが付ける`<!-- issue-deck:no-trigger -->`マーカー（#566。ボタンは個人の
 * OAuthトークンでラベルを外すためラベル除去イベント側が正規の引き金になる）は、こちらでは
 * 付けてはいけない。付けるとどちらの経路でも起動しなくなる。
 */
function resolveLabelsBeforeDispatch(mode: DispatchMode, current: string[]): string[] | null {
  if (mode === "plan") {
    return current.includes(PLAN_REQUIRED_LABEL) ? null : [...current, PLAN_REQUIRED_LABEL];
  }
  if (mode === "approve-plan") {
    return labelsAfterApproval(current.map((name) => ({ name, color: "", description: null })));
  }
  return null;
}

/**
 * カンバンでStatusを動かした操作を実行の起動につなげる（#991 Phase 3）。
 *
 * 起動するかどうかの判定は`resolveDispatchMode`に集約しており、issue-deckの
 * 「実装を開始」ボタン（`POST /api/issues/progress-status`）も同じ関数を通る。
 * ここが担うのは**カンバンのドラッグ起点の経路だけ**で、ボタン経由の書き込みは
 * `isOwnAppSender`で弾かれる（ボタンは自分でコメントを投稿するため取りこぼさない）。
 *
 * 失敗してもWebhook全体は失敗させない。Statusの取り込み自体は済んでおり、
 * 起動しなかったことは画面上「起動待ち」として見えるため。
 */
async function maybeDispatchFromProjectStatus(params: {
  repository: { id: string; ownerLogin: string; name: string };
  installationId: number;
  issueNumber: number;
  issueState: IssueState | undefined;
  issueLabels: string[];
  from: string | null;
  to: string | null;
  senderLogin: string | undefined;
}) {
  // issue-deck自身の書き込み（報告APIやボタン）で自分が起動するのを防ぐ
  if (isOwnAppSender(params.senderLogin) || !params.senderLogin) return;
  // closedなIssueは全モードで再始動しない（reusable-issue-dispatch.ymlのissue_closedガードと同じ方針）
  if (params.issueState === "CLOSED") return;
  // ローカルのClaude Codeセッションで対応中のIssueは無人実行を起動しない（#919と同じ方針）。
  // ワークフロー側でもskipされるが、意味の無いコメントをIssueに残さないためここでも止める
  if (params.issueLabels.includes(LOCAL_LABEL_NAME)) return;

  const mode = resolveDispatchMode({
    from: params.from,
    to: params.to,
    labels: params.issueLabels,
  });
  if (!mode) return;

  try {
    const token = await getInstallationToken(params.installationId);

    // **ワークフローのmodeはコメント本文ではなくラベルで決まる**
    // （reusable-issue-dispatch.ymlの「実行モードを決める」ステップ）。そのため、意図した
    // 実行を通すにはコメントより先にラベルを整える必要がある。
    //
    // - `plan`: `21.plan-required`が無いと実装が始まってしまう
    // - `approve-plan`: `00.check-user`・`21.plan-required`が残っていると計画がやり直される。
    //   両方外れた状態が、ワークフローにとっての「承認済み」を意味する
    const nextLabels = resolveLabelsBeforeDispatch(mode, params.issueLabels);
    if (nextLabels) {
      await updateIssue(params.repository.ownerLogin, params.repository.name, params.issueNumber, token, {
        labels: nextLabels,
      });
    }

    await createComment(
      params.repository.ownerLogin,
      params.repository.name,
      params.issueNumber,
      token,
      {
        body: dispatchCommentBody({
          mode,
          senderLogin: params.senderLogin,
          toStatus: params.to ?? "",
        }),
      },
    );
  } catch (error) {
    console.error(
      "[webhooks/github] failed to dispatch from project status",
      params.repository.id,
      params.issueNumber,
      error,
    );
  }
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
