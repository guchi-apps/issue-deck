import {
  runInvestigation,
  type CallModel,
  type InvestigationResult,
  type ModelMessage,
} from "@/lib/chat/investigation/agent";
import { callInvestigationModel } from "@/lib/chat/investigation/model";
import {
  linkedIssueNumber,
  runTool,
  searchTerms,
  type ToolResult,
} from "@/lib/chat/investigation/tools";
import { latestFixRequest, loadFixProgress } from "@/lib/chat/fix-progress-loader";
import type {
  ChatCard,
  ChatConfirmCard,
  ChatContext,
  ChatInvestigation,
  ChatTarget,
} from "@/lib/chat/types";
import { db } from "@/lib/db";
import { findRepositoryByFullName } from "@/lib/github/issue-create-service";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";

/**
 * 調査エージェントの結果を、チャットの返信（本文・カード・次の会話コンテキスト）へ組み立てる（#4045）。
 *
 * **ここは書き込みをしない。** Issue案・修正依頼は確認カードとして返し、実行は確認APIだけが行う。
 * 調査のみの依頼は、モデルが提案を出しても`allowProposal`が偽なら捨てる。
 */

export type InvestigationDeps = {
  callModel?: CallModel;
  tool?: (
    ctx: Parameters<typeof runTool>[0],
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
};

export type InvestigationReply = {
  text: string;
  cards: ChatCard[];
  needsConfirm: boolean;
  nextContext: ChatContext;
  /** AIが使えず調査に入れなかったか（呼び出し側が従来の定型応答へ戻す判断に使う） */
  unavailable: boolean;
};

/** AIを呼べなかった理由の種別と、利用者が次にすること（機密値は含まない固定文面だけ） */
export function describeUnavailable(stopReason: string): { kind: string; label: string; next: string } {
  if (/認証情報が設定/.test(stopReason)) {
    return { kind: "auth_missing", label: "AIの認証情報が未設定です", next: "設定のAI項目で認証情報を登録してから、再試行してください。" };
  }
  if (/HTTP (401|403)/.test(stopReason)) {
    return { kind: "auth_rejected", label: "AIの認証が拒否されました", next: "設定のAI項目で認証情報の有効期限・権限を確認してから、再試行してください。" };
  }
  if (/HTTP 429/.test(stopReason)) {
    return { kind: "rate_limited", label: "AIの利用上限に達しています", next: "しばらく待ってから再試行してください。" };
  }
  if (/HTTP 5\d\d|通信に失敗|時間切れ|時間の上限/.test(stopReason)) {
    return { kind: "network", label: "AIとの通信に失敗しました（通信エラーまたは時間切れ）", next: "少し待って再試行してください。続く場合はAIサービスの状況を確認します。" };
  }
  if (/読み取れませんでした|空でした|長すぎて/.test(stopReason)) {
    return { kind: "bad_response", label: "AIの応答を読み取れませんでした", next: "もう一度試してください。続けて失敗する場合は、質問を短く分けて送ってください。" };
  }
  return { kind: "other", label: "AIの調査を始められませんでした", next: "再試行してください。続く場合は設定のAI項目を確認してください。" };
}

const ISSUE_ASK = /(issue|起案|起票)/i;
const FIX_ASK = /(直して|修正して|対応して|fix)/i;

/** 発言が書き込み系の提案を求めているか（調査だけの依頼から書き込みを始めないための関門） */
export function allowedProposals(text: string, prior: ChatInvestigation | null | undefined): {
  issue: boolean;
  fix: boolean;
} {
  const priorAgreed = (prior?.agreements.length ?? 0) > 0;
  const proceed = /(その方針|この方針|それで|お願い|進めて|続けて)/.test(text);
  return {
    issue: ISSUE_ASK.test(text),
    fix: FIX_ASK.test(text) || (proceed && priorAgreed && /(直|修正|対応)/.test(prior?.summary ?? "")),
  };
}

function mergeUnique(prior: string[], next: string[], max = 10): string[] {
  return [...new Set([...prior, ...next])].slice(-max);
}

function guessKind(result: InvestigationResult, number: number, fallback: "pr" | "issue"): "pr" | "issue" {
  for (const call of result.toolCalls) {
    if (call.args.number !== number) continue;
    if (/^get_(pull_request|pr_|ci_)/.test(call.name)) return "pr";
    if (call.name === "get_issue") return "issue";
  }
  return fallback;
}

function fallbackText(result: InvestigationResult): string {
  const lines: string[] = [];
  if (result.facts.length) lines.push(`確認できたこと:\n${result.facts.map((f) => `- ${f}`).join("\n")}`);
  const failed = result.toolCalls.filter((c) => !c.ok).length;
  lines.push(`調べた回数: ${result.toolCalls.length}回（うち取得失敗${failed}回）`);
  if (result.unconfirmed.length) lines.push(`未確認:\n${result.unconfirmed.map((f) => `- ${f}`).join("\n")}`);
  lines.push("次の行動: 範囲を絞って聞き直す（例:「#番号のレビューコメントだけ読んで」）か、権限・接続を確認してください。");
  return lines.join("\n");
}

async function findDuplicates(repositoryId: string, title: string) {
  const terms = searchTerms(title);
  if (terms.length === 0) return [];
  const rows = await db.issue.findMany({
    where: {
      repositoryId,
      state: "OPEN",
      OR: terms.flatMap((term) => [{ title: { contains: term } }]),
    },
    orderBy: { githubUpdatedAt: "desc" },
    take: 5,
    select: { number: true, title: true, htmlUrl: true, state: true },
  });
  return rows.map((r) => ({ number: r.number, title: r.title, htmlUrl: r.htmlUrl, state: String(r.state) }));
}

export async function replyWithInvestigation(params: {
  user: { id: string };
  context: ChatContext;
  text: string;
  target: { repo: string; number: number } | null;
  candidates: ChatTarget[];
  history: ModelMessage[];
  /** 既存の自動修正の対象外だったときの理由。調査の材料として渡す */
  note?: string;
  deps?: InvestigationDeps;
}): Promise<InvestigationReply> {
  const { user, context } = params;
  const defaultRepo = params.target?.repo ?? context.investigation?.target?.repo ?? context.repo;
  const known = params.target
    ? context.targets.find((t) => t.number === params.target?.number) ??
      (context.investigation?.target?.number === params.target.number ? context.investigation.target : null)
    : null;

  // 依頼済みの修正があれば、その進み具合を先に導いて材料にも使う（CI／レビュー待ちは完了にしない）
  const cards: ChatCard[] = [];
  let progressNote = "";
  if (params.target) {
    const action = latestFixRequest(context.actions, params.target.repo, params.target.number);
    if (action) {
      const progress = await loadFixProgress(user.id, action);
      if (progress) {
        cards.push(progress);
        progressNote = `\n\n[この会話で渡した修正依頼の進み具合（取得 ${progress.fetchedAt}）]\n${progress.phaseLabel}\n${progress.steps.map((s) => `${s.done ? "済" : "未"} ${s.label}${s.note ? `（${s.note}）` : ""}`).join("\n")}`;
      } else {
        progressNote = "\n\n[この会話で渡した修正依頼の進み具合は取得できませんでした。完了とは言えません（未確認）]";
      }
    }
  }

  const userText = [
    params.text,
    params.target ? `\n(対象: ${params.target.repo}#${params.target.number})` : "",
    params.candidates.length
      ? `\n(直前に見せた対象が複数: ${params.candidates.map((c) => `${c.repo}#${c.number}「${c.title}」`).join("、")}。依頼からどれか決められなければ、final の open_questions で具体的に聞き返す)`
      : "",
    params.note ? `\n(補足: ${params.note})` : "",
    progressNote,
  ].join("");

  const result = await runInvestigation({
    ctx: { user, defaultRepo, now: () => new Date() },
    callModel: params.deps?.callModel ?? callInvestigationModel,
    tool: params.deps?.tool,
    userText,
    history: params.history,
    investigation: context.investigation,
    targetHint: params.target ? `${params.target.repo}#${params.target.number}` : null,
  });

  const unavailable = result.steps === 0 && result.stopReason !== null && !result.reply;
  if (unavailable) {
    const failure = describeUnavailable(result.stopReason ?? "");
    // 相談内容は保存済み。同じ発言をそのまま送り直せる再試行を出す（操作案内で上書きしない）
    cards.push({
      type: "choice",
      question: "同じ内容でもう一度送れます。",
      options: [{ label: "同じ内容で再試行", send: params.text }],
    });
    return {
      text: `回答できませんでした：${failure.label}（${result.stopReason}）。${failure.next}\n相談内容は会話に残っています。定型の確認（「#番号どうなってる？」）は引き続き使えます。`,
      cards,
      needsConfirm: false,
      nextContext: context,
      unavailable: true,
    };
  }

  const allowed = allowedProposals(params.text, context.investigation);
  let text = result.reply || fallbackText(result);
  if (result.stopReason) {
    text = `${text}\n\n⚠️ 調査を途中で止めました: ${result.stopReason}。上の内容は、ここまでに確認できた範囲です。`;
  }

  if (result.evidence.length || result.facts.length || result.inferences.length || result.unconfirmed.length || result.stopReason) {
    cards.push({
      type: "investigation",
      evidence: result.evidence,
      facts: result.facts,
      inferences: result.inferences,
      unconfirmed: result.unconfirmed,
      stopReason: result.stopReason,
    });
  }

  // 提案 → 確認カード（書き込みは確認APIを通るまで走らない）
  let needsConfirm = false;
  const proposal = result.proposal;
  const proposalRepo = proposal.repo || defaultRepo || "";
  if (proposal.kind === "issue" && allowed.issue && proposal.title && proposal.body) {
    const repository = proposalRepo ? await findRepositoryByFullName(user.id, proposalRepo) : null;
    if (!repository) {
      text += `\n\n${proposalRepo || "リポジトリ"} へのアクセス権を確認できないため、Issue案は作りませんでした。`;
    } else {
      const duplicates = await findDuplicates(repository.id, proposal.title);
      const evidenceLines = result.evidence
        .filter((e) => e.url)
        .slice(0, 8)
        .map((e) => `- [${e.label}](${e.url})${e.ref ? `（${e.ref}、取得 ${e.fetchedAt}）` : ""}`);
      const body = [proposal.body, evidenceLines.length ? `## 根拠\n${evidenceLines.join("\n")}` : ""]
        .filter(Boolean)
        .join("\n\n");
      const card: ChatConfirmCard = {
        type: "confirm_issue",
        repo: proposalRepo,
        title: proposal.title,
        body,
        duplicates,
      };
      cards.push(card);
      needsConfirm = true;
      text += duplicates.length
        ? `\n\nIssue案を作りました。似た既存Issueが${duplicates.length}件あります。重複でないか確認してから作成してください。`
        : "\n\nIssue案を作りました。既存Issueに重複は見つかりませんでした（同期済みの範囲）。内容を確認して作成してください。";
    }
  } else if (proposal.kind === "fix_request" && allowed.fix) {
    const number = proposal.number ?? params.target?.number ?? null;
    const repoFull = proposalRepo;
    const repository = repoFull ? await findRepositoryByFullName(user.id, repoFull) : null;
    if (!number || !repository) {
      text += "\n\n修正依頼の対象PRまたはアクセス権を確認できないため、依頼カードは作りませんでした。";
    } else {
      try {
        const [owner, repo] = repoFull.split("/");
        const token = await getInstallationToken(repository.installation.installationId);
        const pr = await fetchPullRequest(owner, repo, number, token);
        const issueNumber = linkedIssueNumber(pr.head.ref);
        const investigatedHead = result.evidence
          .map((e) => /^HEAD ([0-9a-f]{7})/.exec(e.ref ?? "")?.[1])
          .find((sha) => sha);
        if (pr.state !== "open" || pr.merged) {
          text += "\n\nこのPRはクローズ・マージ済みのため、修正依頼は作りませんでした。";
        } else if (!issueNumber) {
          text += `\n\n${pr.head.ref} は issue-<番号> ブランチではなく、依頼を渡すIssueがありません。PR詳細から直接ご依頼ください。`;
        } else if (investigatedHead && !pr.head.sha.startsWith(investigatedHead)) {
          text += `\n\n調査後にHEADが進みました（調査 ${investigatedHead} → 現在 ${pr.head.sha.slice(0, 7)}）。古い前提で直さないよう、もう一度調べ直してから依頼してください。`;
        } else {
          // 過去のターンで合意した方針も依頼へ載せる（引き継いだ合意を落とさない）
          const agreed = mergeUnique(context.investigation?.agreements ?? [], result.agreements);
          const instruction = [
            proposal.body,
            agreed.length ? `## 合意済みの方針\n${agreed.map((a) => `- ${a}`).join("\n")}` : "",
            result.unconfirmed.length ? `## 確認できていない点\n${result.unconfirmed.map((a) => `- ${a}`).join("\n")}` : "",
          ]
            .filter(Boolean)
            .join("\n\n");
          cards.push({
            type: "confirm_fix_request",
            repo: repoFull,
            number,
            title: pr.title,
            headSha: pr.head.sha,
            issueNumber,
            instruction,
          });
          needsConfirm = true;
          text += `\n\nPR #${number}（HEAD ${pr.head.sha.slice(0, 7)}）の修正依頼を用意しました。依頼内容を確認して「依頼する」を押すと、Issue #${issueNumber} へ渡して同じPRのブランチで修正します。`;
        }
      } catch {
        text += "\n\nPRの最新状態を取得できなかったため、修正依頼カードは作りませんでした（未確認）。";
      }
    }
  }

  const targetNumber = params.target?.number ?? context.investigation?.target?.number ?? null;
  const targetRepo = params.target?.repo ?? context.investigation?.target?.repo ?? null;
  let target: ChatTarget | null = context.investigation?.target ?? null;
  if (targetNumber !== null && targetRepo) {
    target = {
      repo: targetRepo,
      number: targetNumber,
      kind: guessKind(result, targetNumber, known?.kind ?? "pr"),
      title: known?.title ?? context.investigation?.target?.title ?? "",
    };
  }
  const prior = context.investigation;
  const nextInvestigation: ChatInvestigation = {
    target,
    summary: [result.reply, ...result.facts].filter(Boolean).join(" / ").slice(0, 1200) || prior?.summary || "",
    evidence: result.evidence.length ? result.evidence : (prior?.evidence ?? []),
    agreements: mergeUnique(prior?.agreements ?? [], result.agreements),
    openQuestions: result.openQuestions,
    unconfirmed: result.unconfirmed,
    updatedAt: new Date().toISOString(),
  };
  return {
    text,
    cards,
    needsConfirm,
    nextContext: {
      ...context,
      repo: target?.repo ?? context.repo,
      // 番号なしの純粋な相談（候補も無い）は、以前の対象を持ち越さない
      targets: target ? [target] : params.candidates.length === 0 ? [] : context.targets,
      investigation: nextInvestigation,
    },
    unavailable: false,
  };
}
