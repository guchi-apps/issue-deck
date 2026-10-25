import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchReleaseBodyByTag, fetchUserCanWriteRepo, updateReleaseBody } from "@/lib/github/release-body-api";
import { previewModeGuard } from "@/lib/preview-mode";
import { convertBulletsToTasks, parseReleaseBodyTasks } from "@/lib/release-body-tasks";

/**
 * 旧確認記録（ユーザーごとの`ReleaseCheckLine`）をGitHub Release本文のタスクリストへ移す（#4374）。
 *
 * 規則（`docs/release-check-github-sync.md`）:
 * - 対象は、ログインユーザーが見られるリポジトリの旧記録があるリリース（複数ユーザーぶんは和集合）
 * - **GitHub上でwrite以上の権限があるリポジトリだけ**を扱う（通常更新APIと同じ`fetchUserCanWriteRepo`。#4404）。
 *   権限が無いリポジトリは`forbidden`として本文を読まず・書かない。対象がすべて権限不足なら403を返す
 * - 本文が通常の箇条書きの行だけを`- [x]`（旧記録あり）/`- [ ]`（なし）へ変換する。
 *   **すでにタスクリストの行は触らない**（GitHubのチェックを旧記録で上書きしない）
 * - 旧記録の行が本文に無い（引き継ぎ項目）ものは移せないので件数だけ返し、DBに残す
 * - **旧記録は削除しない**。移行の検証が済んでから別途消す
 *
 * `{ "dryRun": true }`（既定）は本文を書かず、書き換え件数だけ返す。実際に書くときは`dryRun: false`。
 * 1回の呼び出しで`MAX_RELEASES_PER_CALL`件まで。残りがあれば`remaining`が0より大きいので、`nextOffset`を`offset`に渡して再実行する。
 */
const MAX_RELEASES_PER_CALL = 30;

export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = user.id;
  const payload = await request.json().catch(() => ({}));
  const dryRun = payload?.dryRun !== false;
  const offset = Number.isInteger(payload?.offset) && payload.offset > 0 ? payload.offset : 0;

  const rows = await db.releaseCheckLine.findMany({
    where: { repository: { installation: { userInstallations: { some: { userId } } } } },
    select: {
      tagName: true,
      lineKey: true,
      repository: {
        select: {
          fullName: true,
          ownerLogin: true,
          name: true,
          installation: { select: { installationId: true } },
        },
      },
    },
  });

  type Group = { repo: (typeof rows)[number]["repository"]; tagName: string; keys: Set<string> };
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const id = `${row.repository.fullName} ${row.tagName}`;
    const group = groups.get(id) ?? { repo: row.repository, tagName: row.tagName, keys: new Set<string>() };
    group.keys.add(row.lineKey);
    groups.set(id, group);
  }

  const targets = [...groups.values()].sort((a, b) =>
    `${a.repo.fullName} ${a.tagName}`.localeCompare(`${b.repo.fullName} ${b.tagName}`),
  );
  const batch = targets.slice(offset, offset + MAX_RELEASES_PER_CALL);
  const results: { repoFullName: string; tagName: string; status: string; converted: number; unmigratable: number }[] = [];

  // リポジトリごとの書込権限（同じリポジトリの複数リリースで1回だけ確認する）
  const writeChecks = new Map<string, "write" | "forbidden" | "error">();

  for (const group of batch) {
    const { repo, tagName, keys } = group;
    try {
      const token = await getInstallationToken(repo.installation.installationId);
      let access = writeChecks.get(repo.fullName);
      if (!access) {
        const permission = await fetchUserCanWriteRepo(repo.ownerLogin, repo.name, user.githubLogin, token);
        access = !permission.ok ? "error" : permission.canWrite ? "write" : "forbidden";
        writeChecks.set(repo.fullName, access);
      }
      if (access !== "write") {
        results.push({
          repoFullName: repo.fullName,
          tagName,
          status: access === "forbidden" ? "forbidden" : "github_error",
          converted: 0,
          unmigratable: 0,
        });
        continue;
      }
      const fetched = await fetchReleaseBodyByTag(repo.ownerLogin, repo.name, tagName, token);
      if (!fetched.ok) {
        results.push({ repoFullName: repo.fullName, tagName, status: fetched.reason, converted: 0, unmigratable: keys.size });
        continue;
      }
      const converted = convertBulletsToTasks(fetched.release.body, keys);
      // 本文に行が無い旧記録（引き継ぎ項目）は移せない。DBに残して件数だけ返す
      const bodyKeys = new Set(parseReleaseBodyTasks(fetched.release.body).map((task) => task.key));
      const unmigratable = [...keys].filter((key) => !bodyKeys.has(key)).length;
      if (converted.convertedCount > 0 && !dryRun) {
        const updated = await updateReleaseBody(repo.ownerLogin, repo.name, fetched.release.id, converted.body, token);
        if (!updated.ok) {
          results.push({ repoFullName: repo.fullName, tagName, status: updated.reason, converted: 0, unmigratable });
          continue;
        }
      }
      results.push({
        repoFullName: repo.fullName,
        tagName,
        status: dryRun ? "dry_run" : "migrated",
        converted: converted.convertedCount,
        unmigratable,
      });
    } catch (error) {
      console.error(`[release-check-lines/migrate] ${repo.fullName}@${tagName}:`, error);
      results.push({ repoFullName: repo.fullName, tagName, status: "github_error", converted: 0, unmigratable: 0 });
    }
  }

  if (results.length > 0 && results.every((result) => result.status === "forbidden")) {
    return NextResponse.json({ error: "forbidden", results }, { status: 403 });
  }

  return NextResponse.json({
    dryRun,
    processed: batch.length,
    remaining: Math.max(0, targets.length - offset - batch.length),
    nextOffset: offset + batch.length,
    results,
  });
}
