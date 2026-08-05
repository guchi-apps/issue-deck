import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";

/**
 * GitHub Actions（認証済みセッション無し）から自動リトライ回数の上限を参照するための
 * 読み取り専用API。リポジトリのfullNameをキーにし、非公開情報は一切含めない。
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const fullName = searchParams.get("fullName");

  if (!fullName) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await db.repository.findFirst({
    where: { fullName },
    select: { autoRetryLimit: true },
  });

  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json(
    { autoRetryLimit: repository.autoRetryLimit },
    { headers: { "Cache-Control": "no-store" } },
  );
}
