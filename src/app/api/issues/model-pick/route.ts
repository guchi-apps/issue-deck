import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { pickModelByRule, pickModelForIssue } from "@/lib/claude/model-pick";
import { getAppAiToken } from "@/lib/claude/request";
import { db } from "@/lib/db";

/**
 * 「実装を開始」ダイアログの「おまかせ」が押されたときだけ呼ぶ、モデルの自動選択（#2723）。
 *
 * **材料はDBのIssue（タイトル・本文・ラベル・コメント数）だけ**で、GitHubへは取りに行かない。
 * 押すたびにGitHub APIを1本増やすほどの材料ではなく、キャッシュ済みの内容で十分に選べる。
 * 承認済みの計画は画面が既に持っていることがあるので、あれば`planComment`として受け取る。
 *
 * **AIのトークンが無くても200で返す。** その場合はラベルと分量からのルールで選び、
 * `source: "rule"`として返す——起動の入口なので、選べないからといって塞がない。
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const number = payload?.number;
  const planComment = typeof payload?.planComment === "string" ? payload.planComment : undefined;

  if (typeof owner !== "string" || typeof repo !== "string" || typeof number !== "number") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
  });
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const issue = await db.issue.findFirst({
    where: { repositoryId: repository.id, number },
    include: { labels: true },
  });
  if (!issue) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const input = {
    title: issue.title,
    body: issue.body ?? "",
    labels: issue.labels.map((label) => label.name),
    commentCount: issue.commentCount,
    planComment,
  };

  const token = await getAppAiToken("model_pick");
  if (!token) {
    return NextResponse.json({ ...pickModelByRule(input), source: "rule" });
  }

  return NextResponse.json(await pickModelForIssue(token, input));
}
