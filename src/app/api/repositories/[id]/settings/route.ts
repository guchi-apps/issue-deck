import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { parseAutoRetryLimit } from "@/lib/repository-settings";

async function findRepository(userId: string, repositoryId: string) {
  return db.repository.findFirst({
    where: {
      id: repositoryId,
      installation: { userInstallations: { some: { userId } } },
    },
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const repository = await findRepository(userId, id);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const payload = await request.json().catch(() => null);
  const autoRetryLimit = parseAutoRetryLimit(payload?.autoRetryLimit);
  if (autoRetryLimit === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const updated = await db.repository.update({
    where: { id },
    data: { autoRetryLimit },
  });

  return NextResponse.json({ autoRetryLimit: updated.autoRetryLimit });
}
