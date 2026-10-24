import { db } from "@/lib/db";
import {
  resolveParentRunChildKind,
  type ParentRunChildMark,
} from "@/lib/parent-run/child-state";
import type { ChildDisplay } from "@/lib/parent-run/decide";

/**
 * 稼働中の親の自動実行（#4536）の子を、`owner/repo#番号`ごとの印として返す（#4953）。
 *
 * **`run.ts`ではなく独立したモジュールに置く。** `run.ts`はジョブ投入（`dispatch/jobs.ts`）経由で
 * GitHub Appの認証を読み込み、Issue一覧にその資格情報を要求してしまう（`pending-dispatch.ts`と同じ理由）。
 * 親の実行が1件も無ければ`ParentRunChild`は引かない。
 *
 * 子が複数の稼働中の実行に載ることは想定しない。載っている場合は先に見つけた方を使う。
 *
 * **閲覧者（`userId`）が見えるリポジトリを親に持つ実行の印だけを返す**（#4969）。印には親のリポジトリ名・
 * 親Issue番号・待機理由が入るので、子のリポジトリだけを共有された別の利用者へ、見えない親の情報が
 * 漏れてしまう。権限の基準はIssue一覧と同じ「ユーザーが見えるインストールのリポジトリ」。
 */
export type ParentRunChildMarkEntry = ParentRunChildMark & {
  /** 起動済み（`running`）の子を「実行中」へ振り分けるときの日時（ISO8601） */
  at: string;
};

export async function getParentRunChildMarksByIssue(userId: string): Promise<Map<string, ParentRunChildMarkEntry>> {
  const allRuns = await db.parentRun.findMany({
    where: { activeKey: { not: null } },
    select: {
      parentRepository: true,
      parentIssue: true,
      children: {
        select: { repository: true, number: true, display: true, launchedAt: true, updatedAt: true },
      },
    },
  });

  const map = new Map<string, ParentRunChildMarkEntry>();
  if (allRuns.length === 0) return map;

  // 親のリポジトリが閲覧者に見えるものだけを残す。実行が1件も無ければリポジトリは引かない
  const visibleParents = new Set(
    (
      await db.repository.findMany({
        where: {
          fullName: { in: [...new Set(allRuns.map((run) => run.parentRepository))] },
          installation: { userInstallations: { some: { userId } } },
        },
        select: { fullName: true },
      })
    ).map((repository) => repository.fullName),
  );
  const runs = allRuns.filter((run) => visibleParents.has(run.parentRepository));

  for (const run of runs) {
    for (const child of run.children) {
      const display = child.display as ChildDisplay | null;
      if (!display) continue;
      const kind = resolveParentRunChildKind(display.phase);
      if (!kind) continue;
      const key = `${child.repository}#${child.number}`;
      if (map.has(key)) continue;
      map.set(key, {
        kind,
        parentRepository: run.parentRepository,
        parentNumber: run.parentIssue,
        reason: display.reason,
        at: (child.launchedAt ?? child.updatedAt).toISOString(),
      });
    }
  }
  return map;
}

/** 印の部分だけ取り出す（Issueに載せる形） */
export function toParentRunChildMark(entry: ParentRunChildMarkEntry | undefined): ParentRunChildMark | null {
  if (!entry) return null;
  const { at: _at, ...mark } = entry;
  return mark;
}
