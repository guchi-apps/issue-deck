import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { decideIssueOrder, type IssueOrderCandidate } from "@/lib/claude/issue-order";

function isCandidate(value: unknown): value is IssueOrderCandidate {
  const candidate = value as IssueOrderCandidate | null;
  return (
    typeof candidate?.key === "string" &&
    typeof candidate.title === "string" &&
    Array.isArray(candidate.labels) &&
    candidate.labels.every((label) => typeof label === "string") &&
    typeof candidate.ageDays === "number" &&
    Number.isFinite(candidate.ageDays) &&
    typeof candidate.bodyHead === "string"
  );
}

/**
 * 未着手のIssueの着手順を決める「次にやること」（#1853）。
 * 着手順と、実施しない方がよいと判断されたIssueを1回の問い合わせでまとめて返す。
 *
 * 候補は画面が絞り込み済みの一覧（未着手ビュー）から渡すため、ここでは中身の妥当性だけを見る。
 * **本文は先頭200文字だけ**が`bodyHead`として渡る（`lib/claude/issue-order.ts`）。
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
  const candidates = payload?.candidates;

  if (!Array.isArray(candidates) || candidates.length === 0 || !candidates.every(isCandidate)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const result = await decideIssueOrder(token, { candidates });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[POST /api/issues/order]", error);
    return NextResponse.json(
      {
        error: "issue_order_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
