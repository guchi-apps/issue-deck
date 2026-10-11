import { db } from "@/lib/db";
import { describeIntegrationSetupGap, getReleaseVerificationConfig } from "@/lib/release-verification-config";
import { parseReleaseProgress } from "@/lib/release-verification-progress";
import {
  isReleasePullRequest,
  parseReleaseVerificationKind,
  parseReleaseVerificationState,
  viewReleaseVerifications,
  type ReleaseVerificationView,
} from "@/lib/release-merge-gate";
import type { PullRequestReleaseCheckState, PullRequestReleaseChecks } from "@/types/pull-request";

/**
 * PR一覧のリリースPRに出す、統合検証・全体レビューの状態（#4349）。
 *
 * **判定は`release-merge-gate.ts`の`viewReleaseVerifications`に委ねる**（リリース画面・マージAPIと
 * 食い違わせない）。ここは一覧向けに状態を畳み、DBを1クエリ引くだけで、GitHub APIは使わない。
 */
function toListState(view: ReleaseVerificationView): PullRequestReleaseCheckState {
  switch (view.state) {
    case "waiting":
    case "running":
      return "running";
    default:
      return view.state;
  }
}

export function summarizeReleaseChecks(
  current: { baseSha: string; headSha: string },
  records: Parameters<typeof viewReleaseVerifications>[1],
): PullRequestReleaseChecks {
  const views = viewReleaseVerifications(current, records);
  const stateOf = (kind: "integration" | "ai_review") => {
    const view = views.find((v) => v.kind === kind);
    return view ? toListState(view) : "not_run";
  };
  return { aiReview: stateOf("ai_review"), integration: stateOf("integration") };
}

type Target = {
  repositoryFullName: string;
  number: number;
  baseRef: string;
  headRef: string;
  headSha: string;
  baseSha: string | null;
};

/** リリースPRのキー。`<repo>#<number>` */
export function releaseChecksKey(repositoryFullName: string, number: number): string {
  return `${repositoryFullName}#${number}`;
}

const UNAVAILABLE: PullRequestReleaseChecks = {
  aiReview: "not_run",
  integration: "not_run",
  unavailable: true,
};

/**
 * リリースPR（base=main・head=`release-main/v*`）の検証状態を、全リポジトリぶんまとめて引く。
 *
 * **強制していないリポジトリのリリースPRにも返す**（#4390）。#4354の完了待ちは強制の有無に依らず効くため、
 * 「mainへマージ待ち」の判定（`release-candidate-status.ts`）が検証中を知る必要がある。PR一覧の2枠は
 * `enforced`を見て従来どおり強制しているリポジトリだけに出す。
 *
 * 基準SHAが取れない・DBを読めないときは`unavailable`を返す（成功と推測せず、マージ待ちにもしない）。
 * 実行中と待機中を分けるため、現在の対象の実行中ジョブを1クエリ足して引く（GitHub APIは使わない）。
 */
export async function fetchReleaseChecks(
  targets: Target[],
): Promise<Map<string, PullRequestReleaseChecks>> {
  const result = new Map<string, PullRequestReleaseChecks>();
  const releases: (Target & { baseSha: string })[] = [];
  for (const target of targets) {
    if (!isReleasePullRequest(target)) continue;
    if (target.baseSha === null) {
      result.set(releaseChecksKey(target.repositoryFullName, target.number), UNAVAILABLE);
      continue;
    }
    releases.push({ ...target, baseSha: target.baseSha });
  }
  if (releases.length === 0) return result;
  try {
    const where = { OR: releases.map((t) => ({ repoFullName: t.repositoryFullName, prNumber: t.number })) };
    const [rows, runningJobs] = await Promise.all([
      db.releaseVerification.findMany({ where, orderBy: { updatedAt: "desc" } }),
      db.dispatchJob.findMany({
        where: {
          kind: { in: ["RELEASE_VERIFY", "RELEASE_REVIEW"] },
          status: "RUNNING",
          OR: releases.map((t) => ({ repositoryFullName: t.repositoryFullName, prNumber: t.number })),
        },
        select: { kind: true, repositoryFullName: true, prNumber: true, baseSha: true, headSha: true, progress: true },
      }),
    ]);
    for (const target of releases) {
      const current = { baseSha: target.baseSha, headSha: target.headSha };
      const records = rows
        .filter((row) => row.repoFullName === target.repositoryFullName && row.prNumber === target.number)
        .flatMap((row) => {
          const kind = parseReleaseVerificationKind(row.kind);
          const state = parseReleaseVerificationState(row.state);
          if (!kind || !state) return [];
          return [{ kind, state, baseSha: row.baseSha, headSha: row.headSha, unverifiedScope: row.unverifiedScope }];
        });
      // 候補のSHAが変わったら古い対象のジョブは見ない（旧候補の進行を現在の候補へ流用しない）
      const jobs = runningJobs.filter(
        (job) =>
          job.repositoryFullName === target.repositoryFullName &&
          job.prNumber === target.number &&
          job.baseSha === current.baseSha &&
          job.headSha === current.headSha,
      );
      const integrationJob = jobs.find((job) => job.kind === "RELEASE_VERIFY");
      const recordedRunning = (kind: "integration" | "ai_review") =>
        records.some(
          (r) => r.kind === kind && r.state === "running" && r.baseSha === current.baseSha && r.headSha === current.headSha,
        );
      result.set(releaseChecksKey(target.repositoryFullName, target.number), {
        ...summarizeReleaseChecks(current, records),
        enforced: getReleaseVerificationConfig(target.repositoryFullName).enforced,
        started: {
          aiReview: jobs.some((job) => job.kind === "RELEASE_REVIEW") || recordedRunning("ai_review"),
          integration: integrationJob !== undefined || recordedRunning("integration"),
          mac: parseReleaseProgress("integration", integrationJob?.progress)?.step === "mac",
        },
        integrationSetupGap: describeIntegrationSetupGap(target.repositoryFullName),
      });
    }
  } catch (error) {
    console.error("[fetchReleaseChecks] 検証記録を読めませんでした:", error);
    for (const target of releases) {
      result.set(releaseChecksKey(target.repositoryFullName, target.number), UNAVAILABLE);
    }
  }
  return result;
}
