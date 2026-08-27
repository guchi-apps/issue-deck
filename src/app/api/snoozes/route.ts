import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import type { SnoozeEntry, SnoozeTargetKind } from "@/lib/snooze";

/**
 * 「いまは実施しない」として伏せた要対応の項目（#2398）。
 *
 * **IssueとPull Requestを1つの受け口で扱う。** マージ待ちPRはDBに行を持たない
 * （GitHubから都度取得する）ため、対象は`repositoryFullName` + 種別 + 番号で指す。
 * 期限切れの行はここでは落とさず、そのまま返す——効いているかどうかの判定は
 * `src/lib/snooze.ts`の純粋関数が持ち、件数・一覧・通知が同じ関数を通る。
 */

const KIND_TO_DB = {
  issue: "ISSUE",
  "pull-request": "PULL_REQUEST",
} as const satisfies Record<SnoozeTargetKind, "ISSUE" | "PULL_REQUEST">;

const KIND_FROM_DB = {
  ISSUE: "issue",
  PULL_REQUEST: "pull-request",
} as const satisfies Record<"ISSUE" | "PULL_REQUEST", SnoozeTargetKind>;

type SnoozeRequest = {
  kind: SnoozeTargetKind;
  repositoryFullName: string;
  number: number;
};

/** 受け取った本文から対象を取り出す。形が違えばnull（400で返す） */
function parseTarget(payload: unknown): SnoozeRequest | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const kind = record.kind;
  const repositoryFullName = record.repositoryFullName;
  const number = record.number;
  if (kind !== "issue" && kind !== "pull-request") return null;
  if (typeof repositoryFullName !== "string" || repositoryFullName === "") return null;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
  return { kind, repositoryFullName, number };
}

/**
 * `until`（保留が解ける時刻）を取り出す。**未指定・nullは「手動で解除するまで」**。
 * 読めない文字列だけをエラーにするので、`undefined`と`null`は区別しない。
 */
function parseUntil(payload: unknown): { ok: true; until: Date | null } | { ok: false } {
  const value = (payload as Record<string, unknown> | null)?.until;
  if (value === undefined || value === null) return { ok: true, until: null };
  if (typeof value !== "string") return { ok: false };
  const until = new Date(value);
  return Number.isNaN(until.getTime()) ? { ok: false } : { ok: true, until };
}

/** そのユーザーが見られるリポジトリだけを引く（他人のリポジトリを伏せられないようにする） */
async function findRepository(userId: string, fullName: string) {
  return db.repository.findFirst({
    where: { fullName, installation: { userInstallations: { some: { userId } } } },
    select: { id: true },
  });
}

export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await db.snoozedItem.findMany({
    where: { userId },
    include: { repository: { select: { fullName: true } } },
  });

  const snoozes: SnoozeEntry[] = rows.map((row) => ({
    kind: KIND_FROM_DB[row.kind],
    repositoryFullName: row.repository.fullName,
    number: row.number,
    until: row.until?.toISOString() ?? null,
  }));

  return NextResponse.json({ snoozes });
}

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const target = parseTarget(payload);
  const parsedUntil = parseUntil(payload);
  if (!target || !parsedUntil.ok) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, target.repositoryFullName);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const kind = KIND_TO_DB[target.kind];
  await db.snoozedItem.upsert({
    where: {
      userId_repositoryId_kind_number: {
        userId,
        repositoryId: repository.id,
        kind,
        number: target.number,
      },
    },
    create: {
      userId,
      repositoryId: repository.id,
      kind,
      number: target.number,
      until: parsedUntil.until,
    },
    // 期限の付け替え（「日時を変える」）も同じ口を通る
    update: { until: parsedUntil.until },
  });

  return NextResponse.json({
    ok: true,
    snooze: {
      kind: target.kind,
      repositoryFullName: target.repositoryFullName,
      number: target.number,
      until: parsedUntil.until?.toISOString() ?? null,
    } satisfies SnoozeEntry,
  });
}

export async function DELETE(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const target = parseTarget(payload);
  if (!target) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, target.repositoryFullName);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await db.snoozedItem.deleteMany({
    where: {
      userId,
      repositoryId: repository.id,
      kind: KIND_TO_DB[target.kind],
      number: target.number,
    },
  });

  return NextResponse.json({ ok: true });
}
