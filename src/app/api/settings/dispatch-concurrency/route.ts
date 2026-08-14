import { NextResponse, type NextRequest } from "next/server";

import { DISPATCH_CONCURRENCY_DEFAULT, parseDispatchConcurrency } from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";

/**
 * サブPCで同時に走らせるジョブの本数の上限（#1179）。
 *
 * **定数で埋め込まず設定値として持つ**という決めごと（#1176）に対応する口。
 * CPUを載せ替えると適正値が変わるため、コードを直さずに変えられるようにしている。
 */
export async function PATCH(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const dispatchConcurrency = parseDispatchConcurrency(payload?.dispatchConcurrency);
  if (dispatchConcurrency === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const updated = await db.appSetting.upsert({
    where: { id: 1 },
    create: { id: 1, dispatchConcurrency },
    update: { dispatchConcurrency },
  });

  return NextResponse.json({
    dispatchConcurrency: updated.dispatchConcurrency ?? DISPATCH_CONCURRENCY_DEFAULT,
  });
}
