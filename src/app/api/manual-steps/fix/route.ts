import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { diagnoseManualStepFailure } from "@/lib/claude/manual-step-fix";
import { db } from "@/lib/db";
import { MANUAL_STEP_LABEL } from "@/lib/github/approval-labels";
import { findManualStepCommand } from "@/lib/manual-step-command";
import { parseManualStepGuide } from "@/lib/manual-step-guide";

/**
 * 失敗した手作業の代行実行（#1828）について、原因と修正コマンド案を返す（#1869）。
 *
 * **画面からはどのジョブかしか受け取らない。** コマンドも出力も、サーバーが`DispatchJob`と
 * Issueキャッシュから読み直す。画面が送った文字列をそのままClaudeへ渡すと、
 * 実行していない内容について診断させられる（そして提案がそのまま本文へ入る）。
 *
 * **返すのは提案まで。** 本文の書き換えも実行も、画面で差分を見た人が押したときにだけ行う
 * （書き換えは`PATCH /api/issues`、実行は既存の`POST /api/dispatch`）。
 *
 * 呼ばれるのは失敗したジョブに対してだけ。**出力にはシークレットが混ざりうる**ので、
 * 画面は同意（承認パネルのチェック）がある場合にしか呼ばない。
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const payload = await request.json().catch(() => null);
  const jobId = payload?.jobId;
  if (typeof jobId !== "string" || jobId === "") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const job = await db.dispatchJob.findUnique({ where: { id: jobId } });
  // 成功したジョブ・別の種別・コマンドや行番号を持たない行は診断の対象にしない
  if (
    !job ||
    job.kind !== "MANUAL_STEP" ||
    job.command === null ||
    job.manualStepLine === null ||
    job.exitCode === 0
  ) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Issueは**このユーザーが見られるリポジトリのもの**に限る（`/api/issues`と同じ引き方）
  const repository = await db.repository.findFirst({
    where: {
      fullName: job.repositoryFullName,
      installation: { userInstallations: { some: { userId } } },
    },
    select: { id: true },
  });
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const issue = await db.issue.findFirst({
    where: { repositoryId: repository.id, number: job.issueNumber },
    select: { title: true, body: true, labels: { select: { name: true } } },
  });
  if (!issue || !issue.labels.some((label) => label.name === MANUAL_STEP_LABEL)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const guide = parseManualStepGuide(issue.body);
  const entry = findManualStepCommand(issue.body, job.manualStepLine);
  // 本文が書き換わって、実行した手順がもう無い場合。**古い本文を材料に修正案を出さない**
  if (!entry) {
    return NextResponse.json({ error: "body_changed" }, { status: 409 });
  }

  const markdown =
    entry.kind === "step"
      ? (guide.steps.find((step) => step.line === job.manualStepLine)?.markdown ?? "")
      : (guide.verification ?? "");

  try {
    const result = await diagnoseManualStepFailure(token, {
      issueTitle: issue.title,
      kind: entry.kind,
      where: guide.where,
      markdown,
      // **実行したのはジョブに載っているコマンド**（本文は後から変わりうる）
      command: job.command,
      exitCode: job.exitCode,
      output: job.commandOutput ?? "",
    });
    return NextResponse.json(
      { fix: result, currentCommand: entry.command },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[POST /api/manual-steps/fix]", error);
    return NextResponse.json(
      {
        error: "manual_step_fix_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
