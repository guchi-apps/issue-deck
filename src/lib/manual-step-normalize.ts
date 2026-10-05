import { db } from "@/lib/db";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import {
  generateManualStepNormalization,
  MANUAL_STEP_NORMALIZE_BODY_MAX_LENGTH,
} from "@/lib/claude/manual-step-normalize";
import { getAppAiToken } from "@/lib/claude/request";
import { MANUAL_STEP_LABEL } from "@/lib/github/approval-labels";
import { createComment, fetchIssueBody, updateIssue } from "@/lib/github/issues-api";
import { upsertIssueAndGetDisplay } from "@/lib/github/sync-issues";
import { buildManualStepRunPlan } from "@/lib/manual-step-autorun";
import { checkManualStepBody } from "@/lib/manual-step-body-check";
import { collectShellBlocks } from "@/lib/manual-step-command";
import { parseManualStepGuide } from "@/lib/manual-step-guide";

/**
 * 手作業Issueの自動実行を始める直前に、本文を雛形へ自動で整える（#4039）。
 *
 * **人の承認は挟まない**（Issueの要望）。そのかわり、**実行内容が変わる整形は書き戻さない**。
 * 実行されるのは本文から抽出されたコマンド・端末・前提条件なので、整形の前後で次を検証する
 * （`isSafeNormalization`）。1つでも崩れたら元の本文のまま続行する。
 *
 * - コードブロック（シェル）の中身の集合が一致する（追加・削除・書き換えがない）
 * - 整形前から読み取れていた手順は、コマンド・端末が変わらない（端末の付け替えで
 *   別の端末へ代行実行されるのを防ぐ）
 * - 整形前から読み取れていたディレクトリ・ブランチ・既定の端末が変わらない
 *
 * 整形前に読み取れなかった項目（端末の表記が無かった等）が読めるようになるのは、整形の目的
 * そのものなので許す。**失敗はすべて「元の本文で続行」**（Claude未設定・API失敗・競合を含む）。
 * 整形を理由に自動実行を止めない。
 */

export type ManualStepNormalizeOutcome =
  | { status: "skipped"; reason: "not_manual_step" | "conforming" | "too_long" | "not_configured" }
  | { status: "unchanged"; reason: "generation_failed" | "unsafe" | "still_invalid" | "body_changed" | "write_failed" }
  | { status: "normalized" };

/** 実行内容の比較に使う、ホストの申告に左右されない固定のホスト */
const CAPABLE_HOST = {
  online: true,
  manualStepCapable: true,
  manualStepValuesCapable: true,
  manualStepVpsCapable: true,
} as const;

/** 画面の機能が落ちる指摘（`error`）が1件でもあるか */
export function hasBlockingFindings(
  body: string | null,
  repositoryFullName: string,
): boolean {
  return checkManualStepBody(body, { repositoryFullName }).some(
    (finding) => finding.severity === "error",
  );
}

function shellBlocks(body: string): string[] {
  return collectShellBlocks(body).sort();
}

function planEntries(body: string) {
  return buildManualStepRunPlan(body, parseManualStepGuide(body), {
    host: CAPABLE_HOST,
    isManualStepIssue: true,
  }).entries;
}

/** 整形が実行内容を変えていないか。純粋関数 */
export function isSafeNormalization(before: string, after: string): boolean {
  const beforeBlocks = shellBlocks(before);
  const afterBlocks = shellBlocks(after);
  if (
    beforeBlocks.length !== afterBlocks.length ||
    beforeBlocks.some((block, index) => block !== afterBlocks[index])
  ) {
    return false;
  }

  const beforeGuide = parseManualStepGuide(before);
  const afterGuide = parseManualStepGuide(after);
  const sameWhenKnown = (a: string | null, b: string | null) => a === null || a === b;
  if (
    !sameWhenKnown(beforeGuide.where.defaultDevice, afterGuide.where.defaultDevice) ||
    !sameWhenKnown(beforeGuide.where.directory, afterGuide.where.directory) ||
    !sameWhenKnown(beforeGuide.where.branch, afterGuide.where.branch)
  ) {
    return false;
  }

  // 整形前から読めていた手順（端末が確定しているもの）は、同じコマンドが同じ端末のまま残る
  const afterEntries = planEntries(after);
  for (const entry of planEntries(before)) {
    if (entry.command === null || entry.device === null) continue;
    const same = afterEntries.some(
      (candidate) =>
        candidate.kind === entry.kind &&
        candidate.command === entry.command &&
        candidate.device === entry.device,
    );
    if (!same) return false;
  }
  return true;
}

/**
 * 本文が雛形から崩れていれば、整形して書き戻す。**例外は投げない**（呼び出し側の自動実行を止めない）。
 */
export async function normalizeManualStepIssueBody(params: {
  repositoryFullName: string;
  issueNumber: number;
}): Promise<ManualStepNormalizeOutcome> {
  try {
    return await normalize(params);
  } catch (error) {
    console.error(
      `[manual-step-normalize] 整形に失敗しました ${params.repositoryFullName}#${params.issueNumber}:`,
      error,
    );
    return { status: "unchanged", reason: "write_failed" };
  }
}

async function normalize(params: {
  repositoryFullName: string;
  issueNumber: number;
}): Promise<ManualStepNormalizeOutcome> {
  const { repositoryFullName, issueNumber } = params;
  const repository = await db.repository.findFirst({
    where: { fullName: repositoryFullName },
    include: { installation: true },
  });
  if (!repository) return { status: "skipped", reason: "not_manual_step" };

  const issue = await db.issue.findFirst({
    where: { repositoryId: repository.id, number: issueNumber },
    select: { title: true, body: true, labels: { select: { name: true } } },
  });
  if (!issue || !issue.labels.some((label) => label.name === MANUAL_STEP_LABEL)) {
    return { status: "skipped", reason: "not_manual_step" };
  }

  const body = issue.body ?? "";
  const findings = checkManualStepBody(body, { repositoryFullName }).filter(
    (finding) => finding.severity === "error",
  );
  if (findings.length === 0) return { status: "skipped", reason: "conforming" };
  if (body.length > MANUAL_STEP_NORMALIZE_BODY_MAX_LENGTH) {
    return { status: "skipped", reason: "too_long" };
  }

  const aiToken = await getAppAiToken("manual_step_normalize");
  const githubToken = await resolveInstallationToken(repositoryFullName);
  if (!aiToken || githubToken === null) return { status: "skipped", reason: "not_configured" };

  const normalized = await generateManualStepNormalization(aiToken, {
    title: issue.title,
    body,
    findings: findings.map((finding) => finding.message),
  });
  if (normalized === null) return { status: "unchanged", reason: "generation_failed" };

  if (!isSafeNormalization(body, normalized)) return { status: "unchanged", reason: "unsafe" };
  const after = checkManualStepBody(normalized, { repositoryFullName }).filter(
    (finding) => finding.severity === "error",
  );
  if (after.length >= findings.length) return { status: "unchanged", reason: "still_invalid" };

  // 書き戻す直前にGitHub上の現在の本文を読み直し、整形に使った本文のままかを確かめる
  const [owner, repo] = repositoryFullName.split("/");
  const current = await fetchIssueBody(owner, repo, issueNumber, githubToken);
  if (current === null || current !== body) return { status: "unchanged", reason: "body_changed" };

  const updated = await updateIssue(owner, repo, issueNumber, githubToken, { body: normalized });
  await upsertIssueAndGetDisplay(repository, updated);

  await createComment(owner, repo, issueNumber, githubToken, {
    body: `手作業の自動実行を始める前に、本文を雛形（\`docs/multi-agent/manual-step-body-template.md\`）の書式へ自動で整えました。コマンドと実行する端末は変えていません（検証済み）。元の本文はIssueの編集履歴から戻せます。\n\n<!-- issue-deck-agent:implementer -->`,
  }).catch((error) => {
    console.error("[manual-step-normalize] 通知コメントを投稿できませんでした:", error);
  });

  return { status: "normalized" };
}
