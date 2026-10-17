import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchReleaseCallerText } from "@/lib/github/release-api";
import { decideDevelopSync } from "@/lib/release-develop-sync";
import { observeDevelopSync } from "@/lib/release-develop-sync-run";
import { reconcileActiveRcPublication } from "@/lib/release-rc-reconcile";
import type { RcBlockSummary } from "@/lib/release-rc";
import { readProductionTargetKind } from "@/lib/release-production-stop-run";
import { loadRcBlock } from "@/lib/release-rc-run";
import { decideReleaseStartMode, type ReleaseStartMode } from "@/lib/release-start-mode";

/**
 * リポジトリごとのリリース開始方式（#4604）。ブランチ画面・スマホ・一括の開始操作が、
 * 新方式（候補を作成して検証）か旧方式か、起動できないかを**同じ判定**で決めるための状態照合を含む取得。
 *
 * `?repos=owner/a,owner/b`。権限の無いリポジトリ・取得に失敗したリポジトリは`unknown`にする
 * （応答全体を失敗にせず、旧方式を黙って起動させない）。**何も起動しない。**
 */
export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const repos = [
    ...new Set((request.nextUrl.searchParams.get("repos") ?? "").split(",").filter((name) => /^[\w.-]+\/[\w.-]+$/.test(name))),
  ].slice(0, 100);
  if (repos.length === 0) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const rows = await db.repository.findMany({
    where: { fullName: { in: repos }, installation: { userInstallations: { some: { userId } } } },
    include: { installation: true },
  });
  const byName = new Map(rows.map((row) => [row.fullName, row]));
  const unreadable: ReleaseStartMode = { mode: "unknown", label: "リポジトリへアクセスできず、新方式に対応しているか判定できません" };

  const entries = await Promise.all(
    repos.map(async (fullName): Promise<[string, ReleaseStartMode]> => {
      const row = byName.get(fullName);
      if (!row) return [fullName, unreadable];
      const [owner, repo] = fullName.split("/");
      try {
        const token = await getInstallationToken(row.installation.installationId);
        const mode: ReleaseStartMode = decideReleaseStartMode(await fetchReleaseCallerText(owner, repo, token));
        if (mode.mode !== "candidate") return [fullName, mode];
        let successorOf: RcBlockSummary | undefined;
        // 新規開始を妨げる既存候補を起動前に返す（#4628）。確認できなければ「候補なし」とは扱わない
        try {
          await reconcileActiveRcPublication({ owner, repo, token });
          const block = await loadRcBlock({ owner, repo, token });
          // 証拠未設定で止まった候補は、照合を持つ次の候補で確かめる（#4712）。開始は止めず、何が起きるかを添える
          if (block?.successorStart?.allowed) successorOf = block;
          else if (block) return [fullName, { mode: "blocked", label: `${block.label}: ${block.reason}`, block }];
        } catch (error) {
          console.error(`[GET /api/repositories/release/start-mode] candidate lookup ${fullName}:`, error);
          return [fullName, { mode: "unknown", label: "既存のリリース候補の有無を確認できませんでした。再取得してください" }];
        }
        // 前回の公開がdevelopへ戻っているかを、候補作成と同じ判定で起動前に返す（#4641。読むだけで同期PRは作らない）
        const sync = decideDevelopSync(await observeDevelopSync({ owner, repo, token }));
        if (sync.state !== "synced") return [fullName, { mode: "develop_sync", label: `${sync.label}: ${sync.reason}`, sync }];
        // 公開後の稼働確認で証拠を取れるか（#4712）。開始は止めず、照合が無い場合は開始前に知らせる
        const productionKind = await readProductionTargetKind({ owner, repo, token }, "develop");
        return [fullName, { mode: "candidate", productionKind, ...(successorOf ? { successorOf } : {}) }];
      } catch (error) {
        console.error(`[GET /api/repositories/release/start-mode] ${fullName}:`, error);
        return [fullName, unreadable];
      }
    }),
  );
  return NextResponse.json({ modes: Object.fromEntries(entries) }, { headers: { "Cache-Control": "no-store" } });
}
