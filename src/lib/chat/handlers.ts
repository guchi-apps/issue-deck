import {
  CHAT_HELP_TEXT,
  parseIntent,
  resolveIntent,
  type ResolvedRef,
} from "@/lib/chat/intent";
import { detectRepairStall } from "@/lib/chat/repair-stall";
import { fetchCommentsForIssue } from "@/lib/github/issues-api";
import { buildIssueDraft } from "@/lib/chat/issue-draft";
import { latestFixRequest, loadFixProgress } from "@/lib/chat/fix-progress-loader";
import type { ModelMessage } from "@/lib/chat/investigation/agent";
import { replyWithInvestigation, type InvestigationDeps } from "@/lib/chat/investigation/reply";
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
import { requestPullRequestFix } from "@/lib/github/pull-request-fix-request-service";
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

/** 「直して」「修正して」の依頼を調査へ渡すときの補足（#4153） */
const FIX_INVESTIGATION_NOTE =
  "修正の依頼。自動修正を再起動する前に、停止理由・直近の自動修正の結果・親Issueの要件とコメント・この会話での合意を読み、コード修正／管理情報（PR本文の役割・親Issue本文の残作業追跡）の修正／判断待ち／実行中／修正済みのどれかを説明し、必要な修正を提案すること。";

/** 番号のない改善依頼を調査へ渡すときの補足（#4281） */
const REQUEST_INVESTIGATION_NOTE =
  "番号のない改善依頼。既存のIssue/PRの状態確認ではない。選択リポジトリの現在の実装・規約・関連Issueを読み、現状、要望との差、対応案、根拠リンク、未確認の部分を説明すること。実装を読めなかった場合は現状を推測で断定せず、確認できなかったと明示すること。起案を求められたら目的・要件・対象範囲・完了条件を整理し、重複確認のうえIssue案（proposal_kind=\"issue\"）を返す。";

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

/** PRの紐づくIssueの停止報告を読み、同じ判断待ちの繰り返しを検出する。取得に失敗したら`null`（止めない） */
async function loadRepairStall(
  repository: { installation: { installationId: number } },
  owner: string,
  repo: string,
  number: number,
) {
  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const pr = await fetchPullRequest(owner, repo, number, token);
    const issueNumber = /^issue-(\d+)$/.exec(pr.head.ref)?.[1];
    if (!issueNumber) return null;
    return detectRepairStall(await fetchCommentsForIssue(owner, repo, Number(issueNumber), token));
  } catch {
    return null;
  }
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
  /** 直近の会話（古い→新しい）。調査が「それ」「続けて」を解釈する材料（#4045） */
  history?: ModelMessage[];
  /** テスト用の差し替え */
  investigationDeps?: InvestigationDeps;
}): Promise<ChatReply> {
  const { user, context } = params;
  const resolved = resolveIntent(parseIntent(params.text), context);
  const investigate = (
    target: { repo: string; number: number } | null,
    candidates: ChatTarget[],
    note?: string,
  ) =>
    replyWithInvestigation({
      user,
      context,
      text: params.text,
      target,
      candidates,
      history: params.history ?? [],
      note,
      deps: params.investigationDeps,
    });

  switch (resolved.type) {
    case "investigate": {
      const reply = await investigate(
        resolved.target,
        resolved.candidates,
        resolved.fix ? FIX_INVESTIGATION_NOTE : resolved.request ? REQUEST_INVESTIGATION_NOTE : undefined,
      );
      return reply;
    }

    case "unknown": {
      // 定型に当たらない質問・依頼（番号のない設計相談を含む）はAIの調査へ。AIが使えないときも、
      // 理由と再試行を返し、操作案内で上書きしない（#4093）。使い方案内は短すぎる発言だけ
      if (params.text.trim().length >= 3) {
        return investigate(null, context.targets.length > 1 ? context.targets.slice(0, 4) : []);
      }
      return { text: CHAT_HELP_TEXT, cards: [], needsConfirm: false, nextContext: context };
    }

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
      const cards: ChatCard[] = loaded.flatMap((item) => (item.ok ? [item.card] : []));
      // この会話で渡した修正依頼があれば、状態カードの後ろに進み具合（依頼→push→CI→レビュー）を足す
      for (const item of loaded) {
        if (!item.ok || item.card.kind !== "pr") continue;
        const action = latestFixRequest(context.actions, item.card.repo, item.card.number);
        const progress = action ? await loadFixProgress(user.id, action) : null;
        if (progress) cards.push(progress);
      }
      const statusCards = cards.filter((c): c is ChatStatusCard => c.type === "status");
      const errors = loaded.flatMap((item) => (item.ok ? [] : [item.message]));
      const targets = statusCards.map(toTarget);
      const repo = refs[0]?.repo ?? context.repo;
      const lead =
        resolved.type === "merge_check"
          ? mergeSummary(statusCards[0])
          : statusCards.length > 1
            ? `${statusCards.length}件の現在の状態です。`
            : statusCards.length === 1
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
      // 同じ理由（方針待ち）で自動修正が繰り返し止まっているなら、4回目を起動せず停止理由の調査へ戻る（#4153）
      const stall = await loadRepairStall(repository, owner, repo, resolved.target.number);
      if (stall?.stalled) {
        const reply = await investigate(
          resolved.target,
          [],
          `直近の自動修正が同じ「判断待ち」で${stall.consecutive}回連続して止まっており、状況の変化が無い。同じ自動修正は再起動せず、止まっている理由（方針・要件の判断）を解く提案をすること。`,
        );
        if (!reply.unavailable) return reply;
        return {
          text: `直近の自動修正が判断待ちで${stall.consecutive}回続けて止まっています。状況が変わらないまま再起動しても進まないため、起動しませんでした。AIの調査が使えないので、停止理由（方針の判断）を決めてから、もう一度お試しください。`,
          cards: [],
          needsConfirm: false,
          nextContext: context,
        };
      }
      const plan = await planPullRequestRepair(repository, owner, repo, resolved.target.number);
      if (!plan.ok) {
        // 自動修正の対象外でも「終了」にしない。理由を内容から調べて説明し、明示の修正依頼なら
        // 実行系へ渡す経路（修正依頼カード）へ進める（#4045）。進行中・取得失敗は調査へ回さず理由だけ返す
        if (plan.error === "not_repairable") {
          const reply = await investigate(
            resolved.target,
            [],
            `既存の自動修正（CI失敗・コンフリクト・自動レビューの要修正）の対象外と判定された（${plan.message ?? plan.error}）。レビューやCIの中身を調べ、修正可能・方針判断待ち・情報不足・修正不要のどれかを説明すること。`,
          );
          if (!reply.unavailable) return reply;
        }
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
      // 調査・合意を目的／要件／完了条件へ整理したIssue案（重複確認つき）。AIが使えないときだけ従来の貼り付け型
      const ai = await investigate(
        context.investigation?.target
          ? { repo: context.investigation.target.repo, number: context.investigation.target.number }
          : resolved.source
            ? { repo: resolved.source.repo, number: resolved.source.number }
            : null,
        [],
        "Issue案の作成を依頼された。会話の調査・合意を目的／要件／完了条件へ整理し、proposal_kind=\"issue\" で返す。既存Issueとの重複は search_issues で確認する。",
      );
      const stopped = ai.cards.some((c) => c.type === "investigation" && c.stopReason !== null);
      if (!ai.unavailable && !stopped) return ai;
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

  if (card.type === "confirm_fix_request") {
    const [owner, repo] = card.repo.split("/");
    const repository = await findRepositoryByFullName(user.id, card.repo);
    if (!repository || !owner || !repo) {
      return failure("fix_request", card.repo, card.number, "リポジトリにアクセスできません。", at);
    }
    const result = await requestPullRequestFix(user, repository, {
      owner,
      repo,
      number: card.number,
      expectedHeadSha: card.headSha,
      instruction: card.instruction,
      scope: card.scope,
      expectedBodyHash: card.prBodyHash,
    });
    if (!result.ok) return failure("fix_request", card.repo, card.number, result.message, at);
    const message = result.duplicate
      ? `PR #${card.number} への同じ修正依頼は既に渡してあります（再送しませんでした）。「進み具合は？」で状況を確認できます。`
      : `PR #${card.number} の修正依頼をIssue #${result.issueNumber} へ渡しました。${card.scope === "metadata" ? "実行先が起動するとPR本文・Issue本文の追跡情報だけを更新します（pushはしません）。" : "実行先が起動すると同じPRのブランチへpushされます。"}CI・レビューを待ち、検証できたら結果をお知らせします（「進み具合は？」で確認できます）。`;
    return {
      ok: true,
      text: message,
      card: { type: "result", ok: true, title: "修正依頼を渡しました（まだ完了ではありません）", detail: message, htmlUrl: result.commentUrl },
      action: {
        type: "fix_request",
        status: "started",
        repo: card.repo,
        number: card.number,
        at,
        message,
        fixRequest: {
          headSha: result.headSha,
          commentUrl: result.commentUrl,
          issueNumber: result.issueNumber,
          scope: card.scope ?? "code",
          reviewKindBefore: card.reviewKindBefore ?? null,
        },
      },
    };
  }

  const repository = await findRepositoryByFullName(user.id, card.repo);
  const title = (overrides.title ?? card.title).trim();
  if (!repository) return failure("create_issue", card.repo, null, "リポジトリにアクセスできません。", at);
  if (!title) return failure("create_issue", card.repo, null, "タイトルが空です。", at);
  // 再送・再接続で同じIssueを2件作らない: 直近に同じタイトルのIssueがあれば、それを返す
  const recent = await db.issue.findFirst({
    where: {
      repositoryId: repository.id,
      title,
      githubCreatedAt: { gte: new Date(Date.now() - 10 * 60_000) },
    },
    select: { number: true, title: true, htmlUrl: true },
  });
  if (recent) {
    const message = `同じタイトルのIssue #${recent.number} が直前に作成済みのため、新しくは作りませんでした。`;
    return {
      ok: true,
      text: message,
      card: { type: "result", ok: true, title: message, detail: recent.title, htmlUrl: recent.htmlUrl },
      action: { type: "create_issue", status: "created", repo: card.repo, number: recent.number, at, message },
    };
  }
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
