import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { db } from "@/lib/db";
import { parseArtifactUrlId } from "@/lib/artifact-document";
import {
  resolveSessionArtifactTitle,
  SESSION_ARTIFACT_PER_ISSUE_LIMIT,
  type SessionArtifactView,
} from "@/lib/dispatch/session-artifact";

/**
 * セッションが公開したアーティファクト（#2154）の保存と取り出し。
 *
 * **HTMLの原本はDBではなくディスクに置く**（`uploads/artifacts/`）。Issueの画像
 * （`api/issues/images`）と同じ置き場で、1件が数百KBになるものをDBの行に載せると、
 * 一覧を引くたびに読む羽目になる。DBが持つのは在り処と、カードに出す見出しだけ。
 */

const UPLOAD_DIR = path.join(process.cwd(), "uploads", "artifacts");

/** 保存ファイル名の形。**ここを通ったものしか読まない**（パストラバーサル対策）。 */
const STORED_FILENAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.html$/;

/**
 * 再公開の同一判定に使うキー。**`sourcePath`のハッシュ**にするのは、MySQLのunique indexを
 * `TEXT`へ直接張れないため（パスは長さが読めない）。
 */
function sourceKeyOf(sourcePath: string): string {
  return createHash("sha256").update(sourcePath).digest("hex").slice(0, 32);
}

async function removeStoredFile(filename: string): Promise<void> {
  if (!STORED_FILENAME_PATTERN.test(filename)) return;
  // **消せなくても止めない。** 残ったファイルは誰からも参照されないだけで害が無く、
  // ここで失敗して保存そのものを落とす方が損失が大きい
  await rm(path.join(UPLOAD_DIR, filename), { force: true }).catch(() => undefined);
}

/**
 * 1件保存する。**同じIssueの同じファイルパスへの再公開は上書き**（claude.aiでも同じURLになる）。
 *
 * 戻すのは画面へ渡す形。保存できなければ例外がそのまま出るので、呼び出し側（Route Handler）が
 * 握って「送れなかった」ことにする——アーティファクトが1件残らないことより、セッションを
 * 止めないことが優先（`scripts/session-notify.sh`と同じ約束）。
 */
export async function saveSessionArtifact(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string | null;
  title: string | null;
  description: string | null;
  favicon: string | null;
  claudeUrl: string | null;
  sourcePath: string;
  html: string;
  now?: Date;
}): Promise<SessionArtifactView> {
  const now = params.now ?? new Date();
  const sourceKey = sourceKeyOf(params.sourcePath);
  const title = resolveSessionArtifactTitle({
    title: params.title,
    html: params.html,
    sourcePath: params.sourcePath,
  });

  const storedFilename = `${randomUUID()}.html`;
  const buffer = Buffer.from(params.html, "utf8");
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(path.join(UPLOAD_DIR, storedFilename), buffer);

  const existing = await db.sessionArtifact.findUnique({
    where: {
      repositoryFullName_issueNumber_sourceKey: {
        repositoryFullName: params.repositoryFullName,
        issueNumber: params.issueNumber,
        sourceKey,
      },
    },
    select: { id: true, storedFilename: true },
  });

  const data = {
    hostName: params.hostName,
    title,
    description: params.description,
    favicon: params.favicon,
    // **URLが取れなかったときに、覚えてあるURLを消さない。** フックはツールの応答から
    // 拾っているだけなので、形が変われば取れなくなる。取れた回だけ更新する
    ...(params.claudeUrl ? { claudeUrl: params.claudeUrl } : {}),
    sourcePath: params.sourcePath,
    storedFilename,
    byteSize: buffer.byteLength,
    publishedAt: now,
  };

  const row = existing
    ? await db.sessionArtifact.update({ where: { id: existing.id }, data })
    : await db.sessionArtifact.create({
        data: {
          repositoryFullName: params.repositoryFullName,
          issueNumber: params.issueNumber,
          sourceKey,
          claudeUrl: params.claudeUrl,
          ...data,
        },
      });

  if (existing) await removeStoredFile(existing.storedFilename);
  await pruneSessionArtifacts(params.repositoryFullName, params.issueNumber);

  return toSessionArtifactView(row);
}

/** 上限を超えた分を古いものから消す。ファイルも一緒に消す（残すと誰も辿れないゴミになる）。 */
async function pruneSessionArtifacts(
  repositoryFullName: string,
  issueNumber: number,
): Promise<void> {
  const rows = await db.sessionArtifact.findMany({
    where: { repositoryFullName, issueNumber },
    orderBy: { publishedAt: "desc" },
    select: { id: true, storedFilename: true },
    skip: SESSION_ARTIFACT_PER_ISSUE_LIMIT,
  });
  if (rows.length === 0) return;

  await db.sessionArtifact.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  for (const row of rows) await removeStoredFile(row.storedFilename);
}

/** Issue1件ぶんの一覧。新しい順。 */
export async function listSessionArtifacts(
  repositoryFullName: string,
  issueNumber: number,
): Promise<SessionArtifactView[]> {
  const rows = await db.sessionArtifact.findMany({
    where: { repositoryFullName, issueNumber },
    orderBy: { publishedAt: "desc" },
    take: SESSION_ARTIFACT_PER_ISSUE_LIMIT,
  });
  return rows.map(toSessionArtifactView);
}

/**
 * 配信用に1件読む。**IDだけで引く**（表示は認証済みの画面からしか呼ばれず、
 * リポジトリ・Issueを引数に足しても隔離が強くなるわけではない）。
 */
export async function readSessionArtifactHtml(
  id: string,
): Promise<{ html: string; title: string } | null> {
  const row = await db.sessionArtifact.findUnique({
    where: { id },
    select: { title: true, storedFilename: true },
  });
  if (!row || !STORED_FILENAME_PATTERN.test(row.storedFilename)) return null;

  try {
    const html = await readFile(path.join(UPLOAD_DIR, row.storedFilename), "utf8");
    return { html, title: row.title };
  } catch {
    return null;
  }
}

type SessionArtifactRow = {
  id: string;
  title: string;
  description: string | null;
  favicon: string | null;
  claudeUrl: string | null;
  hostName: string | null;
  byteSize: number;
  publishedAt: Date;
};

export function toSessionArtifactView(row: SessionArtifactRow): SessionArtifactView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    favicon: row.favicon,
    claudeUrl: row.claudeUrl,
    claudeArtifactId: parseArtifactUrlId(row.claudeUrl),
    hostName: row.hostName,
    byteSize: row.byteSize,
    publishedAt: row.publishedAt.toISOString(),
  };
}
