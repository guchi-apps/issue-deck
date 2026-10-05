import {
  CHAT_HELP_TEXT,
  parseIntent,
  resolveIntent,
  type ResolvedRef,
} from "@/lib/chat/intent";
import { buildIssueDraft } from "@/lib/chat/issue-draft";
import {
  buildIssueStatusCard,
  buildPullRequestStatusCard,
  repairKindLabel,
} from "@/lib/chat/status-card";
import type {
  ChatActionRecord,
  ChatCard,
  ChatConfirmCard,
  ChatContext,
  ChatStatusCard,
  ChatTarget,
} from "@/lib/chat/types";
import { db } from "@/lib/db";
import { findDispatchSessionForIssue } from "@/lib/dispatch/sessions";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/github-api-error";
import {
  createIssueForUser,
  findRepositoryByFullName,
} from "@/lib/github/issue-create-service";
import { repairKindsFor } from "@/lib/github/pull-request-repair";
import {
  planPullRequestRepair,
  startPullRequestRepair,
} from "@/lib/github/pull-request-repair-service";
import { fetchActivePullRequestRepairRun } from "@/lib/github/pull-request-repair-run";
import { parsePullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { fetchPullRequestCiState } from "@/lib/github/release-api";

/**
 * IssueDeck Chatの1発言の処理（#3975）。
 *
 * **状態の取得・修復・Issue作成は既存の関数を呼ぶだけで、判定の複製は持たない。**
 * 読み取り（状態確認）は発言からそのまま実行し、副作用のある操作（修復・Issue作成）は
 * 確認カードを返すまでで止める。実行は`executeConfirmedCard`だけが行い、呼び出し側（確認API）が
 * 「確認カードが`pending`だった1回だけ」を保証する。

 */

export type ChatUser = {
  id: string;
  githubAccessToken: string | null;
  githubRefreshToken: string | null;
};

export type ChatReply = {
  text: string;
  cards: ChatCard[];
  /** 確認カードを含む返信か（含むときだけ`confirmState`を`pending`で保存する） */
  needsConfirm: boolean;
  nextContext: ChatContext;
};

const MAX_ACTIONS = 20;

type StatusLoad =
  | { ok: true; card: ChatStatusCard }
  | { ok: false; message: string };

export async function loadStatus(user: ChatUser, ref: ResolvedRef): Promise<StatusLoad> {
  const [owner, repo] = ref.repo.split("/");
  const repository = await findRepositoryByFullName(user.id, ref.repo);
  if (!repository || !owner || !repo) {
    return { ok: false, message: `${ref.repo} は見つからないか、アクセス権がありません。` };
  }
  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const pullRequest = await fetchPullRequest(owner, repo, ref.number, token);
    const [ci, activeRepair] = await Promise.all([
      fetchPullRequestCiState(owner, repo, ref.number, token),
      fetchActivePullRequestRepairRun(ref.repo, ref.number),
    ]);
    const state = pullRequest.state === "closed" ? "closed" : "open";
    const verdict = parsePullRequestReviewVerdict(pullRequest.body);
    const repairKinds =
      state === "open" && !pullRequest.merged
        ? repairKindsFor(
            {
              state,
              draft: pullRequest.draft,
              ciState: ci.ciState,
              baseRef: pullRequest.base.ref,
              headRef: pullRequest.head.ref,
              reviewVerdict: verdict,
            },
            ci.mergeable,
          )
        : [];
    return {
      ok: true,
      card: buildPullRequestStatusCard({
        repo: ref.repo,
        number: ref.number,
        title: pullRequest.title,
        htmlUrl: pullRequest.html_url,
        state,
        merged: pullRequest.merged,
        draft: pullRequest.draft,
        headRef: pullRequest.head.ref,
        ciState: ci.ciState,
        mergeable: ci.mergeable,
        reviewVerdict: verdict,
        activeRepair,
        repairKinds,
      }),
    };
  } catch (error) {
    // PRではない番号はIssueとして読む（Issueは同期済みのDBから）
    if (!(error instanceof GithubApiError) || error.status !== 404) {
      return {
        ok: false,
        message: `#${ref.number} の取得に失敗しました。${error instanceof Error ? error.message : ""}`.trim(),
      };
    }
  }

  const issue = await db.issue.findFirst({
    where: { repositoryId: repository.id, number: ref.number },
    include: { labels: true },
  });
  if (!issue) return { ok: false, message: `${ref.repo}#${ref.number} は見つかりませんでした。` };
  const session = await findDispatchSessionForIssue({
    repositoryFullName: ref.repo,
    issueNumber: ref.number,
  });
  return {
    ok: true,
    card: buildIssueStatusCard({
      repo: ref.repo,
      number: ref.number,
      title: issue.title,
      htmlUrl: issue.htmlUrl,
      state: issue.state,
      assigneeLogin: issue.assigneeLogin,
      labels: issue.labels.map((label) => label.name),
      session: session ? { label: session.tmuxSessionName, state: session.state } : null,
    }),
  };
}

function toTarget(card: ChatStatusCard): ChatTarget {
  return { repo: card.repo, number: card.number, kind: card.kind, title: card.title };
}

function withAction(context: ChatContext, action: ChatActionRecord): ChatContext {
  return { ...context, actions: [...context.actions, action].slice(-MAX_ACTIONS) };
}

export async function handleChatMessage(params: {
  user: ChatUser;
  context: ChatContext;
  text: string;
  recentUserTexts: string[];
}): Promise<ChatReply> {
  const { user, context } = params;
  const resolved = resolveIntent(parseIntent(params.text), context);

  switch (resolved.type) {
    case "unknown":
      return { text: CHAT_HELP_TEXT, cards: [], needsConfirm: false, nextContext: context };

    case "ask":
      return {
        text: resolved.question,
        cards: resolved.options.length
          ? [{ type: "choice", question: resolved.question, options: resolved.options }]
          : [],
        needsConfirm: false,
        nextContext: context,
      };

    case "status":
    case "merge_check": {
      const refs = resolved.type === "status" ? resolved.targets : [resolved.target];
      const loaded = await Promise.all(refs.map((ref) => loadStatus(user, ref)));
      const cards = loaded.flatMap((item) => (item.ok ? [item.card] : []));
      const errors = loaded.flatMap((item) => (item.ok ? [] : [item.message]));
      const targets = cards.map(toTarget);
      const repo = refs[0]?.repo ?? context.repo;
      const lead =
        resolved.type === "merge_check"
          ? mergeSummary(cards[0])
          : cards.length > 1
            ? `${cards.length}件の現在の状態です。`
            : cards.length === 1
              ? "現在の状態です。"
              : "";
      return {
        text: [lead, ...errors].filter(Boolean).join("\n"),
        cards,
        needsConfirm: false,
        nextContext: { ...context, repo, targets: targets.length > 0 ? targets : context.targets },
      };
    }

    case "repair": {
      const [owner, repo] = resolved.target.repo.split("/");
      const repository = await findRepositoryByFullName(user.id, resolved.target.repo);
      if (!repository || !owner || !repo) {
        return {
          text: `${resolved.target.repo} は見つからないか、アクセス権がありません。`,
          cards: [],
          needsConfirm: false,
          nextContext: context,
        };
      }
      const plan = await planPullRequestRepair(repository, owner, repo, resolved.target.number);
      if (!plan.ok) {
        return {
          text: plan.message ?? `#${resolved.target.number} は自動修正を起動できません（${plan.error}）。`,
          cards: [],
          needsConfirm: false,
          nextContext: context,
        };
      }
      const known = context.targets.find((t) => t.number === resolved.target.number);
      const card: ChatConfirmCard = {
        type: "confirm_repair",
        repo: resolved.target.repo,
        number: resolved.target.number,
        title: known?.title ?? "",
        kinds: plan.kinds,
      };
      return {
        text: `PR #${resolved.target.number} を自動修正します。内容を確認して「実行する」を押してください。`,
        cards: [card],
        needsConfirm: true,
        nextContext: context,
      };
    }

    case "create_issue": {
      const draft = buildIssueDraft({
        title: resolved.title,
        source: resolved.source,
        recentUserTexts: params.recentUserTexts,
      });
      const card: ChatConfirmCard = {
        type: "confirm_issue",
        repo: resolved.repo,
        title: draft.title,
        body: draft.body,
      };
      return {
        text: "この会話を材料にIssue案を作りました。タイトルと本文を確認して「Issueを作成」を押してください。",
        cards: [card],
        needsConfirm: true,
        nextContext: context,
      };
    }
  }
}

function mergeSummary(card: ChatStatusCard | undefined): string {
  if (!card) return "";
  if (card.kind !== "pr") return `#${card.number} はPRではないため、マージ可否は確認できません。`;
  const value = (label: string) => card.rows.find((row) => row.label === label)?.value ?? "不明";
  const blockers = card.rows.filter(
    (row) => ["CI", "レビュー", "コンフリクト"].includes(row.label) && row.tone !== "ok",
  );
  if (value("状態") !== "オープン") return `#${card.number} は${value("状態")}です。`;
  if (blockers.length === 0) return `#${card.number} はCI・レビュー・コンフリクトとも問題ありません。マージは自動レビューの判定に従って進みます。`;
  return `#${card.number} はまだ確認が必要です（${blockers.map((row) => `${row.label}: ${row.value}`).join("、")}）。`;
}

export type ConfirmOverrides = { title?: string; body?: string };

export type ConfirmOutcome = {
  ok: boolean;
  text: string;
  card: ChatCard;
  action: ChatActionRecord;
};

/**
 * 確認カードの実行。**呼び出し側が`pending`→`done`の更新に成功した1回だけ**呼ぶこと。
 * 起動の本体は画面のボタンと共用のサービス関数で、ここに判定は持たない。
 */
export async function executeConfirmedCard(
  user: ChatUser,
  card: ChatConfirmCard,
  overrides: ConfirmOverrides = {},
): Promise<ConfirmOutcome> {
  const at = new Date().toISOString();
  if (card.type === "confirm_repair") {
    const [owner, repo] = card.repo.split("/");
    const repository = await findRepositoryByFullName(user.id, card.repo);
    if (!repository || !owner || !repo) {
      return failure("repair", card.repo, card.number, "リポジトリにアクセスできません。", at);
    }
    const result = await startPullRequestRepair(repository, owner, repo, card.number);
    if (!result.ok) {
      return failure("repair", card.repo, card.number, result.message ?? result.error, at);
    }
    const kinds = result.kinds.map(repairKindLabel).join("・");
    const rest = result.remainingKinds.length
      ? `（残り: ${result.remainingKinds.map(repairKindLabel).join("・")}。完了後にもう一度「直して」で続けられます）`
      : "";
    const message = `PR #${card.number} の自動修正（${kinds}）を起動しました。${rest}`;
    return {
      ok: true,
      text: message,
      card: { type: "result", ok: true, title: "PRの自動修正を起動しました", detail: message, htmlUrl: null },
      action: { type: "repair", status: "started", repo: card.repo, number: card.number, at, message },
    };
  }

  const repository = await findRepositoryByFullName(user.id, card.repo);
  const title = (overrides.title ?? card.title).trim();
  if (!repository) return failure("create_issue", card.repo, null, "リポジトリにアクセスできません。", at);
  if (!title) return failure("create_issue", card.repo, null, "タイトルが空です。", at);
  const result = await createIssueForUser(user, repository, {
    repositoryFullName: card.repo,
    title,
    body: overrides.body ?? card.body,
  });
  if ("errorResponse" in result) {
    const body = await result.errorResponse.json().catch(() => ({}));
    return failure(
      "create_issue",
      card.repo,
      null,
      typeof body?.message === "string" ? body.message : `Issueを作成できませんでした（${body?.error ?? result.errorResponse.status}）。`,
      at,
    );
  }
  const issue = result.value;
  const message = `Issue #${issue.number} を作成しました。`;
  return {
    ok: true,
    text: message,
    card: { type: "result", ok: true, title: message, detail: issue.title, htmlUrl: issue.htmlUrl ?? null },
    action: { type: "create_issue", status: "created", repo: card.repo, number: issue.number, at, message },
  };
}

function failure(
  type: ChatActionRecord["type"],
  repo: string,
  number: number | null,
  message: string,
  at: string,
): ConfirmOutcome {
  return {
    ok: false,
    text: message,
    card: { type: "result", ok: false, title: "実行できませんでした", detail: message, htmlUrl: null },
    action: { type, status: "failed", repo, number, at, message },
  };
}

export { withAction };
