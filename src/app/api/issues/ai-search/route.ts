import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { searchIssues, type IssueSearchCandidate } from "@/lib/claude/issue-search";
import { getAppAiToken } from "@/lib/claude/request";

function isCandidate(value: unknown): value is IssueSearchCandidate {
  const candidate = value as IssueSearchCandidate | null;
  return (
    typeof candidate?.key === "string" &&
    typeof candidate.title === "string" &&
    Array.isArray(candidate.labels) &&
    candidate.labels.every((label) => typeof label === "string")
  );
}

/**
 * 検索欄の「AIで探す」（#1788）。文字列一致では拾えない言い換え・表記ゆれを、
 * 表示中のIssueのタイトルとラベルから意味で選ばせる。
 *
 * **Issue本文は受け取らない**（`lib/claude/issue-search.ts`）。候補は画面が絞り込み済みの
 * 一覧から渡すため、ここでは中身の妥当性だけを見る。
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = await getAppAiToken("issue_search");
  if (!token) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const payload = await request.json().catch(() => null);
  const query = payload?.query;
  const candidates = payload?.candidates;

  if (
    typeof query !== "string" ||
    query.trim() === "" ||
    !Array.isArray(candidates) ||
    !candidates.every(isCandidate)
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const keys = await searchIssues(token, { query: query.trim(), candidates });
    return NextResponse.json({ keys });
  } catch (error) {
    console.error("[POST /api/issues/ai-search]", error);
    return NextResponse.json(
      { error: "ai_search_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
