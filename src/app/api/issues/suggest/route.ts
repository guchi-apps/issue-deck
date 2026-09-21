import { NextResponse, type NextRequest } from "next/server";

import { MODEL_PICK_ENGINE_DEFAULT, parseModelPickEngine } from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import {
  generateIssueSuggestion,
  suggestLabelsByJev,
  type IssueSuggestLabelInput,
} from "@/lib/claude/issue-suggest";
import { getAppAiToken } from "@/lib/claude/request";
import { db } from "@/lib/db";

/**
 * 本文からタイトル・種別・ラベルを提案する。
 *
 * **タイトルと種別はアプリ内AI、ラベルは設定（`AppSetting.modelPickEngine`）でJevを選んでいれば
 * Jev**が判定する（#3245。判定に使うAIの設定は「おまかせ」と共用）。Jevで判定できなかった
 * （キー未設定・呼び出し失敗・答えが読めない）ときは、従来どおりアプリ内AIにラベルも選ばせる。
 */

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = await getAppAiToken("issue_suggest");
  if (!token) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const payload = await request.json().catch(() => null);
  const body = payload?.body;
  const labels = payload?.labels;

  if (
    typeof body !== "string" ||
    !Array.isArray(labels) ||
    !labels.every(
      (label): label is IssueSuggestLabelInput =>
        typeof label?.name === "string" && (label.description === null || typeof label.description === "string"),
    )
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const input = { body, availableLabels: labels };
    const setting = await db.appSetting
      .findUnique({ where: { id: 1 }, select: { modelPickEngine: true } })
      .catch(() => null);
    const engine = parseModelPickEngine(setting?.modelPickEngine) ?? MODEL_PICK_ENGINE_DEFAULT;

    const jevLabels = engine === "jev" ? await suggestLabelsByJev(input) : null;
    const result = await generateIssueSuggestion(token, input, {
      includeLabels: jevLabels === null,
    });
    return NextResponse.json(jevLabels === null ? result : { ...result, labels: jevLabels });
  } catch (error) {
    console.error("[POST /api/issues/suggest]", error);
    return NextResponse.json(
      { error: "suggestion_generation_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
