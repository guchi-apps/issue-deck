import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { parseDispatchHostName, parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import {
  resumeManualStepRun,
  startManualStepRun,
  stopManualStepRun,
} from "@/lib/manual-step-run";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 手作業アシスタントの自動実行（#1869）の開始・中断・再開（#1882）。
 *
 * **進めるのはサーバー**（`lib/manual-step-run.ts`）で、ここは人が押した1回を受けるだけ。
 * 押した後に画面を閉じても・別の端末から開いても、追っているのは同じ1本の実行になる。
 *
 * **実行そのものの入口は増やさない。** 積むのは既存の`POST /api/dispatch`と同じ
 * `enqueueManualStepJob`で、実行されるのはサーバーが手作業Issueの本文から抽出し直した
 * コマンドだけ（画面から任意のコマンドが流れる経路を作らない。docs/multi-agent/gates.md）。
 *
 * 状態を読むのはこの受け口ではなく`GET /api/dispatch`（画面のポーリングを1本に保つため）。
 */
export async function POST(request: NextRequest) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const target = parseDispatchTarget(payload?.repository, payload?.issue);
  const action = payload?.action;
  if (!target || (action !== "start" && action !== "stop" && action !== "resume")) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // **見られるリポジトリのIssueに限る**（`/api/manual-steps/fix`と同じ引き方）。
  // ジョブを積む側（`enqueueManualStepJob`）はホストの申告しか見ないため、ここで絞る
  const repository = await db.repository.findFirst({
    where: {
      fullName: target.repositoryFullName,
      installation: { userInstallations: { some: { userId } } },
    },
    select: { id: true },
  });
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (action === "start") {
    const hostName = parseDispatchHostName(payload?.host);
    if (!hostName) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    // 同意（失敗したときに出力をClaudeへ送ってよいか）は**承認した1回に含まれる**（#1869）。
    // 省略されたときは送らない側へ倒す
    const result = await startManualStepRun({
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      hostName,
      userId,
      diagnoseConsent: payload?.diagnoseConsent === true,
    });
    return toResponse(result);
  }

  const result =
    action === "stop"
      ? await stopManualStepRun({
          repositoryFullName: target.repositoryFullName,
          issueNumber: target.issueNumber,
          userId,
        })
      : await resumeManualStepRun({
          repositoryFullName: target.repositoryFullName,
          issueNumber: target.issueNumber,
        });
  return toResponse(result);
}

function toResponse(
  result: { ok: true; run: unknown } | { ok: false; message: string },
): NextResponse {
  if (!result.ok) {
    return NextResponse.json(
      { error: "not_found", message: result.message },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { ok: true, run: result.run },
    { headers: { "Cache-Control": "no-store" } },
  );
}
