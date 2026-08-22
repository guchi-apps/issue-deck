import { NextResponse, type NextRequest } from "next/server";

import { parseArtifactUrlId } from "@/lib/artifact-document";
import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import {
  parseSessionArtifactDescription,
  parseSessionArtifactFavicon,
  parseSessionArtifactHtml,
  parseSessionArtifactSourcePath,
  parseSessionArtifactTitle,
} from "@/lib/dispatch/session-artifact";
import { saveSessionArtifact } from "@/lib/dispatch/session-artifacts";
import { parseSessionHostName } from "@/lib/dispatch/session-plan";

/**
 * ローカル・サブPC実行のセッションが公開したアーティファクトの受け口（#2154）。
 *
 * 送るのは`scripts/session-notify.sh`で、`Artifact`ツールの`PostToolUse`フックから叩く。
 * **claude.aiのページは`frame-ancestors 'self'`でiframeに入れられない**ため、URLだけを
 * 覚えても「アプリ上で表示する」ことにならない。ここでHTMLの原本ごと受け取り、
 * issue-deck自身のオリジンから出す（`/api/issues/artifacts/<id>`）。
 *
 * 認証は`/claim`・`/report`・`/hosts`・`/sessions`と同じ共有シークレット（`DISPATCH_SECRET`）。
 *
 * **失敗しても呼び出し側は実装を止めない。** `session-notify.sh`は何が起きても`exit 0`で返す
 * 約束なので、ここが落ちているときはアーティファクトが画面に出ないだけになる
 * （claude.aiには公開できているので、従来どおりURLから見られる）。
 */
export async function POST(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const target = parseDispatchTarget(payload?.repository, payload?.issue);
  const html = parseSessionArtifactHtml(payload?.html);
  const sourcePath = parseSessionArtifactSourcePath(payload?.sourcePath);
  if (!target || !html || !sourcePath) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // 付随情報は**形が想定外ならnullへ倒す**（リクエスト自体は拒否しない）。見た目が出ることの
  // 方が価値が高く、見出しやURLが欠けても表示できる
  const claudeUrlId = parseArtifactUrlId(payload?.claudeUrl);

  try {
    const artifact = await saveSessionArtifact({
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      hostName: parseSessionHostName(payload?.hostName),
      title: parseSessionArtifactTitle(payload?.title),
      description: parseSessionArtifactDescription(payload?.description),
      favicon: parseSessionArtifactFavicon(payload?.favicon),
      claudeUrl: claudeUrlId ? String(payload?.claudeUrl).trim() : null,
      sourcePath,
      html,
    });
    return NextResponse.json({ artifact });
  } catch (error) {
    console.error("failed to save session artifact", error);
    return NextResponse.json({ error: "save_failed" }, { status: 500 });
  }
}
