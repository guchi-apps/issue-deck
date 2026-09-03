import { NextResponse, type NextRequest } from "next/server";

import { parseClaudeLocalModel } from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import {
  DEFAULT_DISPATCH_AGENT,
  parseDispatchAgent,
  parseDispatchHostName,
  parseDispatchHostRepositories,
  resolveDispatchAgentRejection,
  type DispatchHostView,
} from "@/lib/dispatch/dispatch-job";
import { resolveNightlyRunLabelRejection } from "@/lib/nightly-run";
import { nightlyRunIssueKey } from "@/lib/nightly-run-db";
import { listNightlyRunState } from "@/lib/nightly-run-state";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 夜間実行（#2772）の予定と結果。
 *
 * - `GET`: 「夜間実行」画面に出す状態（設定・窓・今夜の予定・直近の夜の結果）
 * - `POST`: Issueを「今夜の夜間実行」に積む。**いまは起動しない。** 起動先のホストは積む時点で
 *   決め、時刻が来たらそのホストのclaimで`enqueueDispatchJob`へ変換する（`nightly-run-launch.ts`）
 *
 * 積めない組み合わせはここで弾いて理由を返す（`POST /api/dispatch`と同じ考え方）。
 * オプションのラベル（`21.plan-required`等）は**呼び出し側（ダイアログ）が積む前に付ける**
 * （「実装を開始」と同じ順）。ここでは付いている実ラベルを見て、人が居ないと進まないもの
 * （`23.preview-required`・`25.artifact-required`）が付いていれば積ませない（G1の指摘1）。
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const state = await listNightlyRunState();
  return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
}

function parseIssueTarget(
  repository: unknown,
  issue: unknown,
): { repositoryFullName: string; issueNumber: number } | null {
  if (typeof repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repository)) return null;
  if (typeof issue !== "number" || !Number.isInteger(issue) || issue <= 0) return null;
  return { repositoryFullName: repository, issueNumber: issue };
}

export async function POST(request: NextRequest) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const target = parseIssueTarget(payload?.repository, payload?.issue);
  const hostName = parseDispatchHostName(payload?.host);
  if (!target || !hostName) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  // `agent`・`model`は`POST /api/dispatch`と同じく、未知の値は黙って既定へ落とさず400で断る
  const agent =
    payload?.agent === undefined ? DEFAULT_DISPATCH_AGENT : parseDispatchAgent(payload.agent);
  if (!agent) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const claudeModel = payload?.model === undefined ? null : parseClaudeLocalModel(payload.model);
  if (payload?.model !== undefined && !claudeModel) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const optionLabels = Array.isArray(payload?.optionLabels)
    ? payload.optionLabels.filter((item: unknown): item is string => typeof item === "string")
    : [];

  // 起動先は**登録されているホストで、そのリポジトリを実行できる**こと。いまオンラインかどうかは
  // 見ない（積むのは日中、起動は夜なので、いま応答していなくても積めてよい）
  const host = await db.dispatchHost.findUnique({ where: { name: hostName } });
  if (!host) {
    return NextResponse.json(
      { error: "host_unknown", message: `${hostName}は起動先として登録されていません` },
      { status: 409 },
    );
  }
  if (!parseDispatchHostRepositories(host.repositories).includes(target.repositoryFullName)) {
    return NextResponse.json(
      {
        error: "repository_not_runnable",
        message: `${hostName}では${target.repositoryFullName}を実行できません（cloneされていません）`,
      },
      { status: 409 },
    );
  }
  const agentRejection = resolveDispatchAgentRejection(
    { name: host.name, codexCapable: host.codexCapable } as DispatchHostView,
    agent,
  );
  if (agentRejection) {
    return NextResponse.json({ error: "agent_not_capable", message: agentRejection }, { status: 409 });
  }

  // 付いている実ラベルで判定する（同期済みのIssueから引く。無ければラベル不明として通す）
  const issue = await db.issue.findFirst({
    where: { number: target.issueNumber, repository: { fullName: target.repositoryFullName } },
    select: { labels: { select: { name: true } } },
  });
  const labelRejection = resolveNightlyRunLabelRejection(issue?.labels ?? []);
  if (labelRejection) {
    return NextResponse.json({ error: "label_blocked", message: labelRejection }, { status: 409 });
  }

  try {
    const entry = await db.nightlyRunEntry.create({
      data: {
        repositoryFullName: target.repositoryFullName,
        issueNumber: target.issueNumber,
        targetHost: hostName,
        agent,
        claudeModel,
        optionLabels,
        activeKey: nightlyRunIssueKey(target.repositoryFullName, target.issueNumber),
        requestedByUserId: userId,
      },
    });
    return NextResponse.json({ entry: { id: entry.id } }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "already_queued", message: "このIssueはすでに今夜の夜間実行に積んであります" },
      { status: 409 },
    );
  }
}
