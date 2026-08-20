import { NextResponse, type NextRequest } from "next/server";

import { authorizeProgressReport } from "@/lib/progress-report-auth";
import { normalizeOnlyKeys } from "@/lib/secrets-sync";
import { recordSecretsSyncReport } from "@/lib/secrets-sync-runs";

/**
 * シークレット同期の結果を、対象リポジトリのActionsから受け取る（#1309）。
 *
 * 認証はログインセッションではなく共有シークレット（`PROGRESS_REPORT_SECRET`）。呼ぶのは
 * `.github/workflows/reusable-sync-secrets.yml`で、セッションを持たないため
 * （`POST /api/progress`と同じ理由・同じ値を使う）。
 *
 * **受け取るのは件数と、項目の名前だけ**（失敗・同期・スキップ。#2022で同期とスキップを足した）。
 * 値そのものも値の長さも受け取らない（長さも手がかりになる）。数値以外で受けるのは
 * リポジトリ名・実行URL・KEY名・補足文（`message`。同期処理が始まる前に落ちた場合など、
 * 件数だけでは何も伝わらないときの理由）に限り、KEY名は`normalizeOnlyKeys`と同じ字種検証を通す。
 *
 * **呼び出し側はこのAPIの失敗でワークフローを止めない**取り決め（`POST /api/progress`と同じ）。
 * 届かなかった実行は`expireStaleSecretSyncRuns`が時間切れとして倒す。
 */
export async function POST(request: NextRequest) {
  const auth = authorizeProgressReport(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);

  const repositoryFullName =
    typeof payload?.repository === "string" && payload.repository.includes("/")
      ? payload.repository
      : null;
  if (!repositoryFullName) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const failedKeys = toKeyNames(payload?.failedKeys);
  const syncedKeys = toKeyNames(payload?.syncedKeys);
  const skippedKeys = toKeyNames(payload?.skippedKeys);

  await recordSecretsSyncReport({
    repositoryFullName,
    runUrl: typeof payload?.runUrl === "string" ? payload.runUrl : null,
    only: normalizeOnlyKeys(payload?.only) ?? "",
    succeeded: payload?.succeeded === true,
    synced: toCount(payload?.synced),
    skipped: toCount(payload?.skipped),
    failed: toCount(payload?.failed),
    failedKeys,
    syncedKeys,
    skippedKeys,
    message: toMessage(payload?.message),
  });

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * KEY名として妥当なものだけを残す。ここが画面へそのまま出るため、報告された文字列を
 * 素通ししない。**妥当でない要素があっても報告全体は捨てない**——件数（特に失敗の件数）は
 * それ自体が価値のある情報で、名前が1つ崩れたせいで実行が時間切れ扱いになるほうが損。
 *
 * 件数の上限を置くのは、マニフェストが30件程度に対して長さの決まっていない配列を
 * そのままTEXT列へ入れないため（#2022）。
 */
function toKeyNames(value: unknown): string[] {
  const reported: unknown[] = Array.isArray(value) ? value : [];
  return reported
    .map((key) => normalizeOnlyKeys(key))
    .filter((key): key is string => key !== null && key !== "")
    .slice(0, MAX_REPORTED_KEYS);
}

/** 1グループぶんの項目名の上限。マニフェスト全件でも30件程度 */
const MAX_REPORTED_KEYS = 100;

function toCount(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

// 画面にそのまま出るため、長さの上限だけ設ける（値そのものは元々ここに乗らない）
function toMessage(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value.slice(0, 500);
}
