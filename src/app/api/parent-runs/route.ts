import { NextResponse, type NextRequest } from "next/server";

import { parseClaudeModel, parseCodexLocalModel } from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import { parseDispatchAgent, parseDispatchHostName } from "@/lib/dispatch/dispatch-job";
import { parseRepositoryFullName } from "@/lib/local-session";
import { getPlanView } from "@/lib/execution-plan/register";
import { applyRunAction, getParentRunView, startParentRun, type RunAction } from "@/lib/parent-run/run";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 親Issueの自動実行（#4536。仕様は docs/parent-run.md）。画面（ログイン中の本人）からだけ操作する。
 * 開始は計画内の子の実装実行をまとめて許可する入口で、本番リリースや既存の必須承認は自動許可しない。
 */
function parseRef(repository: unknown, number: unknown) {
  if (typeof repository !== "string" || !parseRepositoryFullName(repository)) return null;
  const n = typeof number === "string" ? Number(number) : number;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return null;
  return { repository, number: n };
}

export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = request.nextUrl.searchParams;
  const parent = parseRef(params.get("repository"), params.get("issue"));
  if (!parent) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const [run, plan] = await Promise.all([getParentRunView(parent), getPlanView(parent)]);
  // 計画があれば開始確認に使う（対象・順序・並行範囲）。計画が無い親は`plan: null`で、自動実行の対象にならない
  return NextResponse.json(
    { run, plan: plan ? { currentVersion: plan.currentVersion, objective: plan.plan.objective, children: plan.plan.children, stages: plan.stages } : null }, { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const parent = parseRef(body?.repository, body?.issue);
  if (!parent) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const type = body?.action;
  if (type === "start") {
    const hostName = parseDispatchHostName(body?.host);
    const agent = parseDispatchAgent(body?.agent) ?? "claude";
    if (!hostName) return NextResponse.json({ error: "invalid_request", message: "実行先のホストを指定してください" }, { status: 400 });
    const result = await startParentRun({
      parent,
      userId,
      hostName,
      agent,
      claudeModel: parseClaudeModel(body?.claudeModel),
      codexModel: parseCodexLocalModel(body?.codexModel),
      maxParallel: typeof body?.maxParallel === "number" ? body.maxParallel : undefined,
    });
    if (!result.ok) return NextResponse.json({ error: result.error, message: result.message }, { status: result.status });
    return NextResponse.json({ run: result.run }, { status: 201 });
  }

  let action: RunAction | null = null;
  const child = body?.child ? parseRef(body.child.repository, body.child.number) : null;
  if (type === "pause" || type === "resume" || type === "stop") action = { type };
  else if (type === "retry" && child) action = { type: "retry", child };
  else if (type === "verify") action = { type: "verify", ...(child ? { child } : {}) };
  if (!action) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const result = await applyRunAction(parent, action);
  if (!result.ok) return NextResponse.json({ error: result.error, message: result.message }, { status: result.status });
  return NextResponse.json({ run: result.run });
}
