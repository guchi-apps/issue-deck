import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { listSessionTimeline } from "@/lib/dispatch/session-timeline";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const session = await db.dispatchSession.findUnique({ where: { id }, select: { repositoryFullName: true } });
  if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const repository = await db.repository.findFirst({
    where: { fullName: session.repositoryFullName, installation: { userInstallations: { some: { userId } } } },
    select: { id: true },
  });
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ events: await listSessionTimeline(id) }, { headers: { "Cache-Control": "no-store" } });
}
