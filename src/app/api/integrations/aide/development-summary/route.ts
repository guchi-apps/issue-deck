import { NextResponse, type NextRequest } from "next/server";

import { authorizeAideSummary, resolveAideSummaryUser } from "@/lib/aide-summary-auth";
import { loadDevelopmentSummary } from "@/lib/aide-development-summary-load";
import { buildSummaryResponse, parseSummaryQuery } from "@/lib/aide-development-summary-response";

/**
 * AIDE向けの開発状況サマリ（#3999）。進捗・要対応・予約・PR・本番反映・最近の完了を、
 * 全体合計とリポジトリ別内訳で1回に返す**読み取り専用**API。契約・集計定義は
 * `docs/aide-development-summary-api.md`。
 *
 * 読み取りでジョブ起動・予約変更・既読化・AI推論・5時間枠の取得を起こさない
 * （材料の集め方は`aide-development-summary-load.ts`）。
 */
export async function GET(request: NextRequest) {
  const auth = await authorizeAideSummary(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth !== "ok") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const parsed = parseSummaryQuery(new URL(request.url).searchParams, now);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const user = await resolveAideSummaryUser();
  if (!user) {
    return NextResponse.json({ error: "user_not_configured" }, { status: 503 });
  }

  const { query } = parsed;
  try {
    const { summary, source } = await loadDevelopmentSummary({
      userId: user.id,
      userLogin: user.githubLogin,
      now,
      period: { from: query.from, to: query.to },
      includePullRequests: query.includePullRequests,
      includeDeployEvidence: query.includeDeployEvidence,
    });
    const body = buildSummaryResponse(summary, source, query, user.githubLogin);
    if (body === null) {
      // 認可された母集団（アーカイブ・非表示を除く）に無いリポジトリ
      return NextResponse.json({ error: "repository_not_found" }, { status: 404 });
    }
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[GET /api/integrations/aide/development-summary]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
