import type { ReleaseVerificationState } from "@/lib/release-merge-gate";
import { viewReleaseProgress, type ReleaseVerificationProgress } from "@/lib/release-verification-progress";

/**
 * 統合検証の「再開」を出してよいか・受けてよいか（#5020）。画面（`IntegrationSection`）と
 * `POST /api/repositories/release/integration-rerun`が同じ判定を使う。
 *
 * 「中断」は記録（`ReleaseVerification`）の状態ではなく、記録が`waiting`/`running`のまま最新ジョブが
 * 終了・取消済みであることから導かれる表示（`describeSection`と同じ`viewReleaseProgress`の段階）。
 * そのため判定は記録の状態だけでなく、ジョブから作った進捗を入力に取る。
 * 応答なし（`stalled`）はジョブが生きているので対象にしない。実行中・待機中も対象にしない。
 */
export type IntegrationResumeReason = "interrupted" | "no_job" | "failed";

export type IntegrationResumeDecision =
  | { ok: true; reason: IntegrationResumeReason }
  | { ok: false; reason: "in_progress" | "finished" };

export function decideIntegrationResume(input: {
  state: ReleaseVerificationState | "invalidated";
  progress: ReleaseVerificationProgress | null;
  nowMs: number;
}): IntegrationResumeDecision {
  const { state, progress, nowMs } = input;
  if (state === "failed") return { ok: true, reason: "failed" };
  if (state === "waiting" || state === "running") {
    // ジョブが1件も無いまま待っている行も、動いているものが無いので再開できる（積み直しは対象の重複を弾く）
    if (!progress) return { ok: true, reason: "no_job" };
    const phase = viewReleaseProgress(progress, nowMs).phase;
    return phase === "canceled" || phase === "ended" ? { ok: true, reason: "interrupted" } : { ok: false, reason: "in_progress" };
  }
  return { ok: false, reason: "finished" };
}

export type IntegrationResumeView = { kind: "none" } | { kind: "ready"; lead: string; buttonLabel: string };

export function describeIntegrationResume(
  section: { state: ReleaseVerificationState | "invalidated"; progress: ReleaseVerificationProgress | null },
  nowMs: number,
): IntegrationResumeView {
  const decision = decideIntegrationResume({ state: section.state, progress: section.progress, nowMs });
  if (!decision.ok) return { kind: "none" };
  return {
    kind: "ready",
    buttonLabel: "統合検証を再開",
    lead:
      decision.reason === "failed"
        ? "統合検証が失敗しています。実行先の問題などで失敗した場合は、同じ対象でやり直せます。コードの問題なら、修正して作り直してください。"
        : "検証が中断されています。同じ対象でやり直します。",
  };
}
