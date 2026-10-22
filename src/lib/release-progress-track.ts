import { releaseMergeTargetLabel, type ReleaseMergeTarget } from "@/lib/github/release-button-status";
import { isReleasePullRequest } from "@/lib/release-merge-gate";
import { resolvePullRequestReleaseVerification } from "@/lib/release-candidate-status";
import { resolveReleaseStageBadges, type ReleaseStageBadge } from "@/lib/release-stage-badges";
import type { BranchFlowDeployState } from "@/types/branch-flow";
import type { PullRequestReleaseCheckState, PullRequestSummary } from "@/types/pull-request";

/**
 * ブランチ画面の本番リリース進行バー（#4930）。工程を固定の6区切りで並べ、どこまで済んだかを返す。
 *
 * 工程バッジ（`resolveReleaseStageBadges`。#4602）は「いま動いている工程」しか持たないため、
 * 全体のどこまで進んだかが読めなかった。ここではそれに「済み・失敗・まだ」を足して固定順に並べる。
 *
 * - 動いている工程の文言・実行中かどうかは工程バッジをそのまま使う（判定を作り直さない）
 * - 統合検証・全体レビューの状態は`releaseChecks`と`resolvePullRequestReleaseVerification`から読む
 * - **根拠が取れない区切りは「まだ」にとどめ、推測で済みにしない**（#4602）。ただしバンプPRは
 *   developへマージされると束から消えるため、候補PRが開いていればバンプは済みとみなす
 *   （候補はバンプ後にしか作られない）
 * - 旧方式の候補（`isReleasePullRequest`がfalse）では統合検証・全体レビューを「対象外」にし、分母から外す
 */
export type ReleaseTrackStepKey = "bump" | "ci" | "integration" | "review" | "merge" | "deploy";

export type ReleaseTrackStepState =
  /** 済み */
  | "done"
  /** 実行中（自動で進んでいる） */
  | "running"
  /** 開始待ち・キュー待ち（自動で始まる） */
  | "waiting"
  /** 人の操作待ち（マージ待ち） */
  | "user"
  /** 失敗・要確認 */
  | "failed"
  /** まだ・根拠が取れない */
  | "todo"
  /** 対象外（旧方式の候補の検証） */
  | "skipped";

export type ReleaseTrackStep = {
  key: ReleaseTrackStepKey;
  /** 区切りの名前（「統合検証」など） */
  label: string;
  state: ReleaseTrackStepState;
  /** 動いている・止まっているときの文言（「統合検証中」など）。済み・まだ・対象外ではnull */
  status: string | null;
  /** ホバー・読み上げ用の補足 */
  title: string | null;
};

export type ReleaseTrackTone = "running" | "waiting" | "user" | "failed";

export type ReleaseTrack = {
  steps: ReleaseTrackStep[];
  /** 済みの区切りの数 */
  done: number;
  /** 対象外を除いた区切りの数 */
  total: number;
  /** バーの横に出す1つ。失敗＞人の番＞実行中＞開始待ちの順で選ぶ。無ければnull */
  headline: { key: ReleaseTrackStepKey; label: string; tone: ReleaseTrackTone; title: string | null } | null;
  /** 見出しに選ばれなかった、動いている・止まっている工程の文言 */
  others: string[];
};

export const RELEASE_TRACK_STEP_LABEL: Record<ReleaseTrackStepKey, string> = {
  bump: "バンプ",
  ci: "CI",
  integration: "統合検証",
  review: "全体レビュー",
  merge: "mainへマージ",
  deploy: "本番反映",
};

const ORDER: ReleaseTrackStepKey[] = ["bump", "ci", "integration", "review", "merge", "deploy"];

/** 工程バッジのkey（`release-stage-badges.ts`）から区切りへ */
const BADGE_STEP: Record<string, ReleaseTrackStepKey> = {
  "bump-ci": "bump",
  "bump-judgement": "bump",
  "candidate-ci": "ci",
  "candidate-judgement": "ci",
  integration: "integration",
  "ios-precheck": "integration",
  "ai-review": "review",
};

const TONE_RANK: Record<ReleaseTrackTone, number> = { failed: 0, user: 1, running: 2, waiting: 3 };

type TrackPullRequest = Pick<
  PullRequestSummary,
  | "state"
  | "baseRef"
  | "headRef"
  | "ciState"
  | "ciChecks"
  | "mergeJudgement"
  | "releaseChecks"
  | "iosPrecheck"
>;

type Draft = { state: ReleaseTrackStepState; status: string | null; title: string | null };

const todo = (): Draft => ({ state: "todo", status: null, title: null });
const done = (): Draft => ({ state: "done", status: null, title: null });

/** 検証1区分の結果（実行中・開始待ちは工程バッジが上書きする） */
function verificationDraft(
  name: string,
  state: PullRequestReleaseCheckState,
  options: { enforced: boolean; cleared: boolean; rerun: boolean; reasons: string[] },
): Draft {
  switch (state) {
    case "passed":
      return done();
    case "not_applicable":
      return { state: "skipped", status: null, title: null };
    case "running":
      return { state: "waiting", status: `${name}待ち`, title: null };
    case "needs_check":
      // 止める指摘が全件判断済み（#4814）なら人の判断は済んでいる。赤にしない
      if (options.cleared) return done();
      return { state: "failed", status: `${name}要確認`, title: options.reasons.join("\n") || null };
    case "failed":
      return { state: "failed", status: `${name}が失敗`, title: options.reasons.join("\n") || null };
    case "invalidated":
      if (options.rerun) return { state: "waiting", status: `${name}の再検証待ち`, title: null };
      return { state: "failed", status: `${name}の再検証が必要`, title: options.reasons.join("\n") || null };
    case "not_run":
      return options.enforced
        ? { state: "failed", status: `${name}が未実施`, title: null }
        : { state: "skipped", status: null, title: null };
  }
}

function deployDraft(deploy: BranchFlowDeployState): Draft {
  switch (deploy.kind) {
    case "success":
      return done();
    case "running":
      return { state: "running", status: deploy.autoRetried ? "自動で再デプロイ中" : "本番反映中", title: null };
    case "waiting":
      return { state: "waiting", status: "デプロイ待ち", title: null };
    case "failure":
      return { state: "failed", status: deploy.autoRetried ? "再デプロイも失敗" : "デプロイ失敗", title: null };
  }
}

/**
 * 進行バーを組み立てる。リリースが動いていない（開いたバンプPR・候補PRが無く、リリースのデプロイも
 * 進行中・失敗でない）ときはnull。画面から起こした出し直し（`deploy.manual`）はリリースの工程ではないので扱わない
 */
export function resolveReleaseProgressTrack({
  bumpPullRequest,
  candidatePullRequest,
  mergeTarget,
  deploy,
}: {
  bumpPullRequest: TrackPullRequest | null;
  candidatePullRequest: TrackPullRequest | null;
  /** 人のマージ待ち（`resolveReleaseMergeTarget`の結果） */
  mergeTarget: ReleaseMergeTarget | null;
  /** いちばん新しくmainへ入ったリリースのデプロイ状態 */
  deploy: BranchFlowDeployState | null;
}): ReleaseTrack | null {
  const bump = bumpPullRequest?.state === "open" ? bumpPullRequest : null;
  const candidate = candidatePullRequest?.state === "open" ? candidatePullRequest : null;
  const drafts: Record<ReleaseTrackStepKey, Draft> = {
    bump: todo(),
    ci: todo(),
    integration: todo(),
    review: todo(),
    merge: todo(),
    deploy: todo(),
  };

  if (bump || candidate) {
    if (bump) {
      if (bump.ciState === "failure") drafts.bump = { state: "failed", status: "バージョンバンプのCI失敗", title: null };
      else if (mergeTarget === "develop") drafts.bump = { state: "user", status: releaseMergeTargetLabel("develop"), title: null };
      else drafts.bump = { state: "running", status: "バージョンバンプ中", title: null };
    } else {
      drafts.bump = done();
    }

    if (candidate) {
      if (candidate.ciState === "success") drafts.ci = done();
      else if (candidate.ciState === "failure") drafts.ci = { state: "failed", status: "リリース候補のCI失敗", title: null };

      if (!isReleasePullRequest(candidate)) {
        drafts.integration = { state: "skipped", status: null, title: null };
        drafts.review = { state: "skipped", status: null, title: null };
      } else {
        const checks = candidate.releaseChecks;
        if (checks && !checks.unavailable) {
          const reasons = resolvePullRequestReleaseVerification(candidate).problem?.reasons ?? [];
          const enforced = checks.enforced !== false;
          const stage = checks.aiReviewStage;
          drafts.integration = verificationDraft("統合検証", checks.integration, {
            enforced,
            cleared: false,
            rerun: checks.rerun?.integration ?? false,
            reasons: reasons.filter((reason) => reason.startsWith("統合検証")),
          });
          // 証跡を待つ・確認中・統合検証の完了待ちの段階（#4664・#4763）は、結果より段階を優先する
          // （`resolveReleaseCandidateVerification`と同じ）。文言は工程バッジが入れる
          drafts.review =
            stage?.kind === "integration_waiting" || stage?.kind === "reevaluating" || stage?.kind === "awaiting_integration"
              ? { state: "waiting", status: null, title: null }
              : verificationDraft("全体レビュー", checks.aiReview, {
                  enforced,
                  cleared: stage?.kind === "needs_check" && stage.cleared === true,
                  rerun: checks.rerun?.aiReview ?? false,
                  reasons: reasons.filter((reason) => reason.startsWith("全体レビュー")),
                });
        }
      }

      if (mergeTarget === "main") drafts.merge = { state: "user", status: releaseMergeTargetLabel("main"), title: null };
    }

    // いま動いている工程は工程バッジの文言・実行中かどうかで上書きする（失敗は上書きしない）
    applyBadges(drafts, resolveReleaseStageBadges({ bumpPullRequest: bump, candidatePullRequest: candidate }));
  } else if (deploy && !deploy.manual && deploy.kind !== "success") {
    // マージ済みでデプロイだけが残っている。mainへ入った版はそこまでの工程を通っている
    for (const key of ["bump", "ci", "integration", "review", "merge"] as const) drafts[key] = done();
    drafts.deploy = deployDraft(deploy);
  } else {
    return null;
  }

  const steps = ORDER.map((key) => ({ key, label: RELEASE_TRACK_STEP_LABEL[key], ...drafts[key] }));
  const active = steps
    .filter(
      (step): step is ReleaseTrackStep & { state: ReleaseTrackTone; status: string } =>
        step.status !== null && step.state in TONE_RANK,
    )
    // 同じ重さなら工程の順（`ORDER`）を保つ（sortは安定）
    .sort((a, b) => TONE_RANK[a.state] - TONE_RANK[b.state]);
  const [first, ...rest] = active;
  return {
    steps,
    done: steps.filter((step) => step.state === "done").length,
    total: steps.filter((step) => step.state !== "skipped").length,
    headline: first ? { key: first.key, label: first.status, tone: first.state, title: first.title } : null,
    others: rest.map((step) => step.status),
  };
}

function applyBadges(drafts: Record<ReleaseTrackStepKey, Draft>, badges: ReleaseStageBadge[]) {
  const byStep = new Map<ReleaseTrackStepKey, ReleaseStageBadge>();
  for (const badge of badges) {
    const key = BADGE_STEP[badge.key];
    if (!key) continue;
    // 同じ区切りに2つ（CIと判定など）来たら、実行中のほうを残す
    const current = byStep.get(key);
    if (!current || (!current.running && badge.running)) byStep.set(key, badge);
  }
  for (const [key, badge] of byStep) {
    if (drafts[key].state === "failed") continue;
    drafts[key] = { state: badge.running ? "running" : "waiting", status: badge.label, title: badge.title };
  }
}
