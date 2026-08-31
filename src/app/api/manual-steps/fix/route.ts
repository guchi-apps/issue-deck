import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import {
  diagnoseManualStepFailure,
  type ManualStepFixInput,
} from "@/lib/claude/manual-step-fix";
import { getAppAiToken } from "@/lib/claude/request";
import { db } from "@/lib/db";
import { MANUAL_STEP_LABEL } from "@/lib/github/approval-labels";
import {
  findManualStepCommand,
  findManualStepInstruction,
  type ManualStepCommandKind,
} from "@/lib/manual-step-command";
import { parseManualStepGuide, type ManualStepGuide } from "@/lib/manual-step-guide";
import {
  MANUAL_STEP_TROUBLE_CATEGORIES,
  MANUAL_STEP_TROUBLE_DETAIL_MAX_LENGTH,
  MANUAL_STEP_TROUBLE_PASTED_MAX_LENGTH,
  type ManualStepTroubleCategory,
  type ManualStepTroubleReport,
} from "@/lib/manual-step-trouble";

/**
 * 手作業アシスタントで想定外だったことについて、原因と直し案を返す（#1869・#2299）。
 *
 * 入口は2つあり、**どちらもコマンドと出力を画面から受け取らない**。
 *
 * 1. **失敗した代行実行**（#1828・#1869）。画面が送るのはジョブのidだけで、コマンドも出力も
 *    サーバーが`DispatchJob`とIssueキャッシュから読み直す。画面が送った文字列をそのまま
 *    Claudeへ渡すと、実行していない内容について診断させられる（そして提案がそのまま本文へ入る）
 * 2. **人が書いたつまずき**（#2299）。代行できない手順（ブラウザでの操作・別デバイスでの作業）は
 *    出力が画面に届かないため、分類と自由記述を受け取る。**貼り付けた出力は同意があるときだけ
 *    載る**（画面のチェック。既定オフ）
 *
 * **返すのは提案まで。** 本文の書き換えも実行も、画面で差分を見た人が押したときにだけ行う
 * （書き換えは`PATCH /api/issues`、実行は既存の`POST /api/dispatch`）。
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = await getAppAiToken("manual_step_fix");
  if (!token) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const payload = await request.json().catch(() => null);
  if (payload === null || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const report = pickReport(payload);
  const jobId = (payload as { jobId?: unknown }).jobId;

  // 失敗した代行実行から呼ばれた場合（#1869）。コマンド・終了コード・出力はジョブから読む
  if (typeof jobId === "string" && jobId !== "") {
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

    const issue = await findManualStepIssue(userId, job.repositoryFullName, job.issueNumber);
    if (issue === null) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const guide = parseManualStepGuide(issue.body);
    const entry = findManualStepCommand(issue.body, job.manualStepLine);
    // 本文が書き換わって、実行した手順がもう無い場合。**古い本文を材料に直し案を出さない**
    if (!entry) return NextResponse.json({ error: "body_changed" }, { status: 409 });

    return await diagnose(token, {
      issueTitle: issue.title,
      kind: entry.kind,
      where: guide.where,
      markdown: pickMarkdown(guide, entry.kind, job.manualStepLine),
      // **実行したのはジョブに載っているコマンド**（本文は後から変わりうる）
      command: job.command,
      exitCode: job.exitCode,
      output: job.commandOutput ?? "",
      instruction:
        entry.kind === "step"
          ? (findManualStepInstruction(issue.body, job.manualStepLine) ?? "")
          : "",
      report,
    });
  }

  // 人が「うまくいかない」から書いた場合（#2299）
  const repositoryFullName = (payload as { repositoryFullName?: unknown }).repositoryFullName;
  const number = (payload as { number?: unknown }).number;
  const kind = (payload as { kind?: unknown }).kind;
  const rawLine = (payload as { line?: unknown }).line;
  const line = typeof rawLine === "number" && Number.isInteger(rawLine) ? rawLine : null;

  if (
    typeof repositoryFullName !== "string" ||
    !repositoryFullName.includes("/") ||
    typeof number !== "number" ||
    (kind !== "step" && kind !== "verification") ||
    report === null ||
    report.detail === ""
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const issue = await findManualStepIssue(userId, repositoryFullName, number);
  if (issue === null) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const guide = parseManualStepGuide(issue.body);
  if (kind === "step" && !guide.steps.some((step) => step.line === line)) {
    return NextResponse.json({ error: "body_changed" }, { status: 409 });
  }

  const command = line === null ? null : (findManualStepCommand(issue.body, line)?.command ?? null);
  return await diagnose(token, {
    issueTitle: issue.title,
    kind,
    where: guide.where,
    markdown: pickMarkdown(guide, kind, line),
    // 人が自分で実行したので、issue-deckには終了コードも出力も無い
    command,
    exitCode: null,
    output: "",
    instruction:
      kind === "step" && line !== null ? (findManualStepInstruction(issue.body, line) ?? "") : "",
    report,
  });
}

/** Issueは**このユーザーが見られるリポジトリの手作業Issue**に限る（`/api/issues`と同じ引き方） */
async function findManualStepIssue(
  userId: string,
  repositoryFullName: string,
  number: number,
): Promise<{ title: string; body: string | null } | null> {
  const repository = await db.repository.findFirst({
    where: {
      fullName: repositoryFullName,
      installation: { userInstallations: { some: { userId } } },
    },
    select: { id: true },
  });
  if (!repository) return null;

  const issue = await db.issue.findFirst({
    where: { repositoryId: repository.id, number },
    select: { title: true, body: true, labels: { select: { name: true } } },
  });
  if (!issue || !issue.labels.some((label) => label.name === MANUAL_STEP_LABEL)) return null;
  return { title: issue.title, body: issue.body };
}

/** 診断の材料にする、本文のその部分（手順のMarkdown、または確認節） */
function pickMarkdown(
  guide: ManualStepGuide,
  kind: ManualStepCommandKind,
  line: number | null,
): string {
  if (kind !== "step") return guide.verification ?? "";
  return guide.steps.find((step) => step.line === line)?.markdown ?? "";
}

/**
 * 画面が書いて送ったつまずき（#2299）。
 *
 * **長さで切るのではなく、超えていたら受け取らない**——切った文章を材料に診断すると、
 * 途中で切れた文の続きを推測させることになる。分類は知らない値なら`null`へ倒す。
 */
function pickReport(payload: object): ManualStepTroubleReport | null {
  const raw = (payload as { report?: unknown }).report;
  if (raw === null || typeof raw !== "object") return null;

  const { category, detail, pasted } = raw as {
    category?: unknown;
    detail?: unknown;
    pasted?: unknown;
  };
  const text = typeof detail === "string" ? detail.trim() : "";
  const paste = typeof pasted === "string" ? pasted.trim() : "";
  if (
    text.length > MANUAL_STEP_TROUBLE_DETAIL_MAX_LENGTH ||
    paste.length > MANUAL_STEP_TROUBLE_PASTED_MAX_LENGTH
  ) {
    return null;
  }

  return {
    category: MANUAL_STEP_TROUBLE_CATEGORIES.some((entry) => entry.value === category)
      ? (category as ManualStepTroubleCategory)
      : null,
    detail: text,
    pasted: paste,
  };
}

async function diagnose(token: string, input: ManualStepFixInput) {
  try {
    const result = await diagnoseManualStepFailure(token, input);
    return NextResponse.json(
      {
        fix: result,
        currentCommand: input.command,
        currentInstruction: input.instruction,
      },
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
