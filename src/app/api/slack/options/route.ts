import { NextResponse, type NextRequest } from "next/server";

import { searchRepoOptions } from "@/lib/slack/intake";
import { authenticateSlackRequest } from "@/lib/slack/route-helpers";

/** external_select（候補が多いときの名称検索）の選択肢。候補は投稿者が権限を持つリポジトリだけ */
export async function POST(request: NextRequest) {
  const auth = await authenticateSlackRequest(request);
  if (!auth.ok) return auth.response;
  const raw = new URLSearchParams(auth.rawBody).get("payload");
  let payload: { value?: string; user?: { id?: string } } = {};
  try {
    payload = raw ? (JSON.parse(raw) as typeof payload) : {};
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const found = await searchRepoOptions(auth.config, payload.user?.id ?? "", payload.value ?? "");
  return NextResponse.json({
    options: found.map((c) => ({
      text: { type: "plain_text", text: `${c.name} ・ ${c.fullName}`.slice(0, 75) },
      value: c.fullName,
    })),
  });
}
