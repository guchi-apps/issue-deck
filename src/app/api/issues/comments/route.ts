import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser, requireUserId } from "@/lib/auth-user";
import { decryptSecret } from "@/lib/crypto/secret-cipher";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { mapComment } from "@/lib/github/issue-mapper";
import {
  createComment,
  deleteComment,
  fetchCommentsForIssue,
  GithubApiError,
  type GithubApiComment,
  updateComment,
} from "@/lib/github/issues-api";

// scripts/seed-ci-db.mjsが投入するCI用ダミーリポジトリのgithubRepositoryIdと一致させること。
// このリポジトリは実在しないためGitHub APIからコメントを取得できず、無人実行での
// スクリーンショット確認用に固定のダミーコメントを返す(#550)。
const CI_DUMMY_REPOSITORY_GITHUB_ID = 900000001;

// コメント単位AI要約機能（#571）の「要約を生成」ボタンはLONG_COMMENT_THRESHOLD
// （src/components/dashboard/comment-thread.tsx）を超える本文にのみ表示されるため、
// 画面確認用に2件目を長文（400文字超）にしている。
function buildCiDummyComments(): GithubApiComment[] {
  return Array.from({ length: 5 }, (_, index) => {
    const n = index + 1;
    return {
      id: -n,
      user: { login: "ci-dummy-user" },
      body: n === 2 ? CI_DUMMY_LONG_COMMENT_BODY : `CI環境の画面確認用ダミーコメントです（${n}件目）。`,
      created_at: new Date(Date.UTC(2026, 7, n)).toISOString(),
      reactions: { "+1": 0 },
    };
  });
}

const CI_DUMMY_LONG_COMMENT_BODY =
  "画面確認用の長文ダミーコメントです。このコメントはAI要約ボタンの表示確認のため、意図的に400文字を超える長さにしています。\n\n" +
  "現状整理: 既存のIssue全体AI要約機能とは別に、コメント単位で「重要な点」「変更点」「懸念点」の3観点の要約を生成・表示する機能を追加しました。コメント本体はDBに保存されず表示のたびにGitHub APIから取得する既存方針を踏襲しつつ、要約結果のみDBにキャッシュします。生成はボタン押下時のみ行い、Issue全体要約と同様に自動生成は行いません。\n\n" +
  "変更点: DBスキーマに新規モデルを追加し、コメント編集時にはキャッシュを削除して再生成をボタン操作に委ねる方式にしました。GitHub APIラッパーには単一コメント取得用の関数を追加し、全件取得APIを無駄に呼ばずに済むようにしています。\n\n" +
  "懸念点: 要約ボタンを表示する本文文字数の閾値は暫定値のため、実際の運用を見ながら調整が必要になる可能性があります。また、Claudeのプラン枠を消費するため、生成頻度についても引き続き注視が必要だと考えています。";

// src/lib/github/app-auth.tsはトップレベルでGITHUB_APP_ID等の環境変数を要求するため、
// 静的importするとGitHub App認証情報が無い環境（無人でのCIスクリーンショット撮影等）では
// このモジュール自体の読み込みで例外になり、CI用ダミーリポジトリ向けの早期returnにも
// たどり着けなくなる。実際にGitHub APIを呼ぶ経路でのみ動的importする(#550)。
async function getInstallationTokenLazy(installationId: number) {
  const { getInstallationToken } = await import("@/lib/github/app-auth");
  return getInstallationToken(installationId);
}

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

export function GET(request: NextRequest) {
  return withGithubApiFeature("issue_comments", () => handleGET(request));
}

async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const numberParam = searchParams.get("number");

  if (!owner || !repo || !numberParam) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (repository.githubRepositoryId === CI_DUMMY_REPOSITORY_GITHUB_ID) {
    return NextResponse.json({ comments: buildCiDummyComments().map(mapComment) });
  }

  try {
    const token = await getInstallationTokenLazy(repository.installation.installationId);
    const rawComments = await fetchCommentsForIssue(owner, repo, Number(numberParam), token);
    return NextResponse.json({ comments: rawComments.map(mapComment) });
  } catch (error) {
    console.error(`[GET /api/issues/comments] ${owner}/${repo}#${numberParam}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export function POST(request: NextRequest) {
  return withGithubApiFeature("comment_write", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const number = payload?.number;
  const body = payload?.body;

  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    typeof number !== "number" ||
    typeof body !== "string" ||
    !body.trim()
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(user.id, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (!user.githubAccessToken) {
    return NextResponse.json({ error: "github_reauth_required" }, { status: 409 });
  }

  try {
    const token = decryptSecret(user.githubAccessToken);
    const created = await createComment(owner, repo, number, token, { body: body.trim() });
    return NextResponse.json({ comment: mapComment(created) });
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 401) {
      await db.user.update({ where: { id: user.id }, data: { githubAccessToken: null } });
      return NextResponse.json({ error: "github_reauth_required" }, { status: 409 });
    }
    console.error(`[POST /api/issues/comments] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export function PATCH(request: NextRequest) {
  return withGithubApiFeature("comment_write", () => handlePATCH(request));
}

async function handlePATCH(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const commentId = payload?.commentId;
  const body = payload?.body;

  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    typeof commentId !== "number" ||
    typeof body !== "string" ||
    !body.trim()
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationTokenLazy(repository.installation.installationId);
    const updated = await updateComment(owner, repo, commentId, token, { body: body.trim() });
    // 編集によって内容が変わった以上、キャッシュ済みのAI要約は古くなるため削除する（再生成はボタン操作に委ねる）
    await db.issueCommentSummary.deleteMany({ where: { githubCommentId: BigInt(commentId) } });
    return NextResponse.json({ comment: mapComment(updated) });
  } catch (error) {
    console.error(`[PATCH /api/issues/comments] ${owner}/${repo} comment ${commentId}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export function DELETE(request: NextRequest) {
  return withGithubApiFeature("comment_write", () => handleDELETE(request));
}

async function handleDELETE(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const commentIdParam = searchParams.get("commentId");

  if (!owner || !repo || !commentIdParam || Number.isNaN(Number(commentIdParam))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationTokenLazy(repository.installation.installationId);
    await deleteComment(owner, repo, Number(commentIdParam), token);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(`[DELETE /api/issues/comments] ${owner}/${repo} comment ${commentIdParam}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
