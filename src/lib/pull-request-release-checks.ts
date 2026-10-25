import { db } from "@/lib/db";
import { loadPublishApprovedPullRequests } from "@/lib/release-publish-approval-run";
import { loadReleaseCandidateFixes } from "@/lib/release-candidate-fix";
import { describeIntegrationSetupGap, getReleaseVerificationConfig } from "@/lib/release-verification-config";
import { parseInheritanceEvidence } from "@/lib/release-finalize";
import { loadInheritedRecords } from "@/lib/release-verification";
import { parseReleaseProgress } from "@/lib/release-verification-progress";
import { attachReleaseReviewDecisions } from "@/lib/release-verification-load";
import { summarizeReleaseVerification, type ReleaseVerificationSummary } from "@/lib/release-verification-summary";
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
 * 食い違わせない）。ここは一覧向けに状態を畳み、DBを1クエリ引くだけで、GitHub APIは原則使わない（要確認の全体レビューの
 * 判断を読むときだけ、判断の有効性の確認でmainの比較を引くことがある。#4814）。
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

function stageOrUndefined(compute: () => ReleaseVerificationSummary): ReleaseVerificationSummary | undefined {
  try {
    return compute();
  } catch (error) {
    console.error("[fetchReleaseChecks] 全体レビューの段階を出せませんでした:", error);
    return undefined;
  }
}

/** 適用済みの公開準備が再実行と記録した種別を、まだ「再実行が見込める」と見てよい時間。過ぎても行が無ければ依頼の失敗を疑って問題へ戻す */
export const RERUN_EXPECTATION_WINDOW_MS = 30 * 60 * 1000;

type RerunKind = "aiReview" | "integration";

/**
 * 現在の先端に対して、再検証が自動で走る見込みがある区分（#4862）。現在の対象の未完了ジョブ（待機中・実行中）があるか、
 * 適用済みの公開準備がバンプ後のheadでその種別を再実行すると記録して間もないとき。どちらも無ければ見込まない
 */
export function expectedRerunKinds(input: {
  activeJobKinds: readonly string[];
  finalizations: readonly { status: string; finalHeadSha: string | null; handoffEvidence: unknown; updatedAt: Date }[];
  headSha: string;
  now: Date;
}): Record<RerunKind, boolean> {
  const result: Record<RerunKind, boolean> = {
    aiReview: input.activeJobKinds.includes("RELEASE_REVIEW"),
    integration: input.activeJobKinds.includes("RELEASE_VERIFY"),
  };
  for (const f of input.finalizations) {
    if (f.status !== "applied" || f.finalHeadSha !== input.headSha) continue;
    if (input.now.getTime() - f.updatedAt.getTime() > RERUN_EXPECTATION_WINDOW_MS) continue;
    for (const e of parseInheritanceEvidence(f.handoffEvidence)) {
      if (e.action !== "rerun") continue;
      if (e.kind === "ai_review") result.aiReview = true;
      if (e.kind === "integration") result.integration = true;
    }
  }
  return result;
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
    const [rows, runningJobs, activeJobs, finalizations, fixes] = await Promise.all([
      db.releaseVerification.findMany({ where, orderBy: { updatedAt: "desc" } }),
      db.dispatchJob.findMany({
        where: {
          kind: { in: ["RELEASE_VERIFY", "RELEASE_REVIEW"] },
          status: "RUNNING",
          OR: releases.map((t) => ({ repositoryFullName: t.repositoryFullName, prNumber: t.number })),
        },
        select: { kind: true, repositoryFullName: true, prNumber: true, baseSha: true, headSha: true, progress: true },
      }),
      // 待機中のジョブ（実行中は上で引いている）。再検証が見込めるかの判定に使う（#4862）
      db.dispatchJob.findMany({
        where: {
          kind: { in: ["RELEASE_VERIFY", "RELEASE_REVIEW"] },
          status: { in: ["QUEUED", "CLAIMED"] },
          OR: releases.map((t) => ({ repositoryFullName: t.repositoryFullName, prNumber: t.number })),
        },
        select: { kind: true, repositoryFullName: true, prNumber: true, baseSha: true, headSha: true },
      }),
      db.releaseCandidateFinalization.findMany({
        where: {
          status: "applied",
          finalHeadSha: { not: null },
          OR: releases.map((t) => ({ repositoryFullName: t.repositoryFullName, prNumber: t.number })),
        },
        select: { repositoryFullName: true, prNumber: true, status: true, finalHeadSha: true, handoffEvidence: true, updatedAt: true },
      }),
      // 修正系列の進み具合（#4972）。補助の情報なので、読めなくても検証の状態は返す
      loadReleaseCandidateFixes(releases).catch((error) => {
        console.error("[fetchReleaseChecks] 修正系列を読めませんでした:", error);
        return new Map<string, import("@/lib/release-fix-series").ReleaseCandidateFix>();
      }),
    ]);
    const approvedByRepo = new Map<string, Set<number>>();
    for (const repositoryFullName of new Set(releases.map((t) => t.repositoryFullName))) {
      approvedByRepo.set(
        repositoryFullName,
        await loadPublishApprovedPullRequests(
          repositoryFullName,
          releases.filter((t) => t.repositoryFullName === repositoryFullName),
        ),
      );
    }
    for (const target of releases) {
      const current = { baseSha: target.baseSha, headSha: target.headSha };
      const ownRecords = rows
        .filter((row) => row.repoFullName === target.repositoryFullName && row.prNumber === target.number)
        .flatMap((row) => {
          const kind = parseReleaseVerificationKind(row.kind);
          const state = parseReleaseVerificationState(row.state);
          if (!kind || !state) return [];
          return [{ kind, state, baseSha: row.baseSha, headSha: row.headSha, unverifiedScope: row.unverifiedScope }];
        });
      // 公開準備で引き継いだ種別は、バンプ後の先端の行が無い。リリース画面・ゲートと同じ派生記録を足し、
      // 引継ぎ済みを「再検証が必要」と見せない（#4862）
      const records = [...ownRecords, ...(await loadInheritedRecords(target.repositoryFullName, target.number, ownRecords))];
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
      // 全体レビューの段階（#4664）。リリース画面の要約と同じ関数で出し、一覧と詳細で食い違わせない。
      // 補助の情報なので、出せなくても検証の状態そのもの（取得不能にはしない）は返す
      const reviewSummary = stageOrUndefined(() => {
        const detailRows = rows.flatMap((row) => {
          const kind = parseReleaseVerificationKind(row.kind);
          const state = parseReleaseVerificationState(row.state);
          if (!kind || !state || row.repoFullName !== target.repositoryFullName || row.prNumber !== target.number) {
            return [];
          }
          return [{ ...row, kind, state }];
        });
        return summarizeReleaseVerification({ current, rows: detailRows, enforced: true, aiReviewAssignee: "" });
      });
      // 要確認の全体レビューだけ、指摘への判断を読んで段階へ反映する（#4814）。止める指摘がすべて非修正の判断済みなら
      // 一覧でも赤の「検証要確認」にしない。読めなければ判断なしと同じ（従来どおり要確認）
      const aiReviewStage =
        reviewSummary?.aiReview.stage?.kind === "needs_check"
          ? (await attachReleaseReviewDecisions(target.repositoryFullName, target.number, current, reviewSummary)).aiReview
              .stage
          : reviewSummary?.aiReview.stage;
      result.set(releaseChecksKey(target.repositoryFullName, target.number), {
        ...summarizeReleaseChecks(current, records),
        aiReviewStage,
        publishApproved: approvedByRepo.get(target.repositoryFullName)?.has(target.number) === true,
        fix: fixes.get(releaseChecksKey(target.repositoryFullName, target.number)) ?? null,
        enforced: getReleaseVerificationConfig(target.repositoryFullName).enforced,
        started: {
          aiReview: jobs.some((job) => job.kind === "RELEASE_REVIEW") || recordedRunning("ai_review"),
          integration: integrationJob !== undefined || recordedRunning("integration"),
          mac: parseReleaseProgress("integration", integrationJob?.progress)?.step === "mac",
        },
        integrationSetupGap: describeIntegrationSetupGap(target.repositoryFullName),
        rerun: expectedRerunKinds({
          activeJobKinds: [...jobs, ...activeJobs.filter(
            (job) =>
              job.repositoryFullName === target.repositoryFullName &&
              job.prNumber === target.number &&
              job.baseSha === current.baseSha &&
              job.headSha === current.headSha,
          )].map((job) => job.kind),
          finalizations: finalizations.filter(
            (f) => f.repositoryFullName === target.repositoryFullName && f.prNumber === target.number,
          ),
          headSha: current.headSha,
          now: new Date(),
        }),
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
