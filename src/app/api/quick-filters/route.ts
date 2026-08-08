import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { parseQuickFilterInput, toQuickFilter } from "@/lib/quick-filters";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await db.quickFilter.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ quickFilters: rows.map(toQuickFilter) });
}

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const input = parseQuickFilterInput(payload);
  if (!input) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const row = await db.quickFilter.create({
      data: {
        userId,
        name: input.name,
        view: input.view,
        q: input.q,
        repo: input.repos.join(",") || null,
        state: input.state,
        labels: input.labels.join(","),
        assignee: input.assignee,
        sort: input.sort,
      },
    });
    return NextResponse.json({ quickFilter: toQuickFilter(row) });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json({ error: "duplicate_name" }, { status: 409 });
    }
    throw error;
  }
}
