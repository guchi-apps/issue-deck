import { NextResponse, type NextRequest } from "next/server";

import {
  PLAN_REVIEW_AUTO_REFLECT_MAX_ROUNDS_DEFAULT,
  parsePlanReviewAutoReflectMaxRounds,
} from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";

/**
 * 計画レビューの指摘をJevが判断して自動で反映する設定（#3648）。画面の設定から読み書きする口。
 * 読む側（Webhookの自動反映）はDBを直接読むため、ワークフロー向けの口は無い。
 * 部分更新で、省略した項目は変えない。
 */
function toResponse(setting: {
  planReviewAutoReflectEnabled?: boolean;
  planReviewAutoReflectMaxRounds?: number;
} | null) {
  return {
    planReviewAutoReflectEnabled: setting?.planReviewAutoReflectEnabled ?? true,
    planReviewAutoReflectMaxRounds:
      setting?.planReviewAutoReflectMaxRounds ?? PLAN_REVIEW_AUTO_REFLECT_MAX_ROUNDS_DEFAULT,
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
  const body = payload !== null && typeof payload === "object" ? payload : {};

  const hasEnabled = "planReviewAutoReflectEnabled" in body;
  if (hasEnabled && typeof body.planReviewAutoReflectEnabled !== "boolean") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const hasMaxRounds = "planReviewAutoReflectMaxRounds" in body;
  const maxRounds = hasMaxRounds
    ? parsePlanReviewAutoReflectMaxRounds(body.planReviewAutoReflectMaxRounds)
    : undefined;
  if (hasMaxRounds && maxRounds === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!hasEnabled && !hasMaxRounds) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const data = {
    ...(hasEnabled ? { planReviewAutoReflectEnabled: body.planReviewAutoReflectEnabled as boolean } : {}),
    ...(maxRounds != null ? { planReviewAutoReflectMaxRounds: maxRounds } : {}),
  };
  const updated = await db.appSetting.upsert({
    where: { id: 1 },
    create: { id: 1, ...data },
    update: data,
  });
  return NextResponse.json(toResponse(updated));
}
