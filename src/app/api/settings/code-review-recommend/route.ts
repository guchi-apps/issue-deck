import { NextResponse, type NextRequest } from "next/server";

import {
  CODE_REVIEW_RECOMMEND_DAYS_DEFAULT,
  CODE_REVIEW_RECOMMEND_PR_COUNT_DEFAULT,
  parseCodeReviewRecommendDays,
  parseCodeReviewRecommendPrCount,
} from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";

/**
 * コードレビューの提案条件（経過日数・PR数。#3685）。設定画面の読み書きと、
 * 「コードレビュー」ビューが提案の基準を読む口を兼ねる。
 */
function toResponse(setting: {
  codeReviewRecommendDays: number | null;
  codeReviewRecommendPrCount: number | null;
} | null) {
  return {
    days: setting?.codeReviewRecommendDays ?? CODE_REVIEW_RECOMMEND_DAYS_DEFAULT,
    prCount: setting?.codeReviewRecommendPrCount ?? CODE_REVIEW_RECOMMEND_PR_COUNT_DEFAULT,
  };
}

export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const setting = await db.appSetting.findUnique({ where: { id: 1 } });
  return NextResponse.json(toResponse(setting));
}

export async function PATCH(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const days = parseCodeReviewRecommendDays(payload?.days);
  const prCount = parseCodeReviewRecommendPrCount(payload?.prCount);
  if (days === null || prCount === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const updated = await db.appSetting.upsert({
    where: { id: 1 },
    create: { id: 1, codeReviewRecommendDays: days, codeReviewRecommendPrCount: prCount },
    update: { codeReviewRecommendDays: days, codeReviewRecommendPrCount: prCount },
  });
  return NextResponse.json(toResponse(updated));
}
