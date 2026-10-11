import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchReleaseBodyByTag, fetchUserCanWriteRepo, updateReleaseBody } from "@/lib/github/release-body-api";
import { applyReleaseBodyTaskToggle, parseReleaseBodyTasks } from "@/lib/release-body-tasks";

/**
 * リリース本文の箇条書き1行（1機能）ぶんの「確認した」のON/OFF（#2982・#4374）。
 *
 * **確認状態の正はGitHub Release本文のMarkdownタスクリスト**（`- [ ]` / `- [x]`）。ここは
 * 対応する行のチェックだけを書き換える（`lib/release-body-tasks.ts`）。DBの`ReleaseCheckLine`は
 * 旧記録として残すだけで、もう書かない（読み取りのフォールバックにのみ使う）。
 *
 * 書く直前に本文を取り直し、書いた後にもう一度取って意図した状態になっていることを確かめる。
 * GitHubのReleases APIには条件付き更新（If-Match）が無いので、取得から更新までの短い間の
 * 同時編集は防げないが、その場合は`conflict`として返し、「保存済み」と表示させない。
 */

/** GitHubのref名の上限に合わせた保険 */
const MAX_TAG_NAME_LENGTH = 255;
const MAX_LINE_KEY_LENGTH = 1000;
const MAX_LINE_TEXT_LENGTH = 1000;

type ParsedBody = {
  repoFullName: string;
  tagName: string;
  lineKey: string;
  /** 引き継ぎ項目を本文へ書き足すときの表示文言 */
  lineText?: string;
  /** 引き継ぎ元の版 */
  carriedFrom?: string;
};

async function parseBody(request: NextRequest): Promise<ParsedBody | null> {
  const payload = await request.json().catch(() => null);
  const repoFullName = payload?.repoFullName;
  const tagName = payload?.tagName;
  const lineKey = payload?.lineKey;
  const lineText = payload?.lineText;
  const carriedFrom = payload?.carriedFrom;

  if (typeof repoFullName !== "string" || !repoFullName) return null;
  if (typeof tagName !== "string" || !tagName || tagName.length > MAX_TAG_NAME_LENGTH) return null;
  if (typeof lineKey !== "string" || !lineKey || lineKey.length > MAX_LINE_KEY_LENGTH) return null;
  if (lineKey.includes("-->") || lineKey.includes("\n")) return null;
  if (lineText !== undefined && (typeof lineText !== "string" || lineText.length > MAX_LINE_TEXT_LENGTH)) {
    return null;
  }
  if (
    carriedFrom !== undefined &&
    (typeof carriedFrom !== "string" || !carriedFrom || carriedFrom.length > MAX_TAG_NAME_LENGTH)
  ) {
    return null;
  }
  return { repoFullName, tagName, lineKey, lineText, carriedFrom };
}

async function handle(request: NextRequest, checked: boolean) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = user.id;

  const body = await parseBody(request);
  if (!body) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await db.repository.findFirst({
    where: {
      fullName: body.repoFullName,
      installation: { userInstallations: { some: { userId } } },
    },
    select: { ownerLogin: true, name: true, installation: { select: { installationId: true } } },
  });
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const token = await getInstallationToken(repository.installation.installationId);
  const { ownerLogin: owner, name: repo } = repository;

  try {
    // 接続できるだけでは足りない。GitHub上でReleaseを編集できる権限（write以上）が要る（#4395）
    const permission = await fetchUserCanWriteRepo(owner, repo, user.githubLogin, token);
    if (!permission.ok) return NextResponse.json({ error: "github_error" }, { status: 502 });
    if (!permission.canWrite) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const fetched = await fetchReleaseBodyByTag(owner, repo, body.tagName, token);
    if (!fetched.ok) {
      // Releaseが無い版（失敗版など）はGitHubへ同期できない。保存済みにしない
      return NextResponse.json({ error: fetched.reason }, { status: fetched.reason === "not_found" ? 404 : 502 });
    }

    // 本文に無い行を書き足せるのは、引き継ぎ元の版に同じ行（キーと表示文言）が実在するときだけ。
    // 任意の文言・見出しを送って他人のリリース本文へ追記させない
    const alreadyInBody = parseReleaseBodyTasks(fetched.release.body).some((task) => task.key === body.lineKey);
    if (!alreadyInBody && body.lineText !== undefined && body.carriedFrom !== undefined) {
      const source = await fetchReleaseBodyByTag(owner, repo, body.carriedFrom, token);
      const sourceHasLine =
        source.ok &&
        parseReleaseBodyTasks(source.release.body).some(
          (task) => task.key === body.lineKey && task.text === body.lineText,
        );
      if (!sourceHasLine) return NextResponse.json({ error: "line_not_found" }, { status: 409 });
    }

    const toggled = applyReleaseBodyTaskToggle(fetched.release.body, {
      key: body.lineKey,
      checked,
      text: body.lineText,
      carriedFrom: body.carriedFrom,
    });
    if (!toggled.ok) {
      // 本文から行が消えた・書き換わった（別の人が編集した）。再取得して見直してもらう
      return NextResponse.json({ error: "line_not_found" }, { status: 409 });
    }

    if (toggled.changed) {
      const updated = await updateReleaseBody(owner, repo, fetched.release.id, toggled.body, token);
      if (!updated.ok) {
        return NextResponse.json(
          { error: updated.reason },
          { status: updated.reason === "not_found" ? 404 : 502 },
        );
      }

      // 書けたことを読み直して確かめる。別の編集と重なって取り消されていれば「保存済み」にしない
      const verified = await fetchReleaseBodyByTag(owner, repo, body.tagName, token);
      if (!verified.ok) {
        return NextResponse.json({ error: "verify_failed" }, { status: 502 });
      }
      const lineStates = parseReleaseBodyTasks(verified.release.body).filter((task) => task.key === body.lineKey);
      if (lineStates.length === 0 || lineStates.some((task) => task.checked !== checked)) {
        return NextResponse.json({ error: "conflict" }, { status: 409 });
      }
    }

    return NextResponse.json({ ok: true, source: "github", checkedAt: new Date().toISOString() });
  } catch (error) {
    console.error(`[release-check-lines] ${body.repoFullName}@${body.tagName}:`, error);
    return NextResponse.json({ error: "github_error" }, { status: 502 });
  }
}

export function POST(request: NextRequest) {
  return handle(request, true);
}

export function DELETE(request: NextRequest) {
  return handle(request, false);
}
