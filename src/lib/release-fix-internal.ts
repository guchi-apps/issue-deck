/**
 * リリース修正の内部確認（#4410）の判断。**純関数だけ**を置き、保存と外部操作は`release-fix-internal-run.ts`が持つ。
 *
 * 修正Issueのセッションの中で「実装 → 独立レビュー → 修正 → テスト」を繰り返し、内部確認が完了してから
 * develop向けの修正PRを1件作る。**実装担当だけの判断で合格にしない**: 完了には、独立レビューの報告・
 * 未解決指摘0件・必要テストの合格が、**同じ対象（`issue-<番号>`ブランチのHEAD SHA）に対して**そろっている必要がある。
 * 対象が変わったあとの古い合格は流用しない。
 */

/** 往復の上限。独立レビューを実施した回数で数える */
export const INTERNAL_MAX_ROUNDS = 5;
/** 内部確認を始めてからの上限時間（分）。修正系列の作成から数える */
export const INTERNAL_MAX_MINUTES = 120;
/** 同じ指摘を再オープンしてよい回数。これに達したら同じ修正を繰り返さず人へ渡す */
export const INTERNAL_MAX_REOPEN = 2;
/** 未解決の指摘が減らない往復が続いたら進捗なしとみなす回数 */
export const INTERNAL_NO_PROGRESS_ROUNDS = 2;

export type InternalReviewVerdict = "pass" | "findings";
export type InternalTestState = "passed" | "failed";
export type InternalFindingStatus = "open" | "resolved";

export type InternalRoundRecord = {
  round: number;
  reviewVerdict: InternalReviewVerdict | null;
  reviewTargetSha: string | null;
  testState: InternalTestState | null;
  testTargetSha: string | null;
  /** その往復のレビュー時点で未解決だった指摘の件数 */
  openFindingCount: number;
};

export type InternalFindingRecord = {
  key: string;
  title: string;
  status: InternalFindingStatus;
  reopenCount: number;
};

export type InternalStopReason = "max_rounds" | "timed_out" | "recurring_finding" | "no_progress";

export type InternalGateBlocker =
  | "no_review"
  | "review_target_changed"
  | "open_findings"
  | "tests_not_run"
  | "tests_failed"
  | "tests_target_changed"
  | "stopped";

export type InternalGate = {
  /** 内部確認が完了し、修正PRを作ってよい */
  complete: boolean;
  /** 完了できない理由（完了ならnull）。上のものほど先に直す */
  blocker: InternalGateBlocker | null;
  /** 確認の対象にした（完了時に`complete`を支えている）SHA */
  targetSha: string | null;
  /** 画面と報告に出す、利用者向けの文 */
  message: string;
};

const BLOCKER_MESSAGE: Record<InternalGateBlocker, string> = {
  no_review: "独立レビューが未実施です",
  review_target_changed: "独立レビュー後に対象の内容が変わったため、レビューをやり直す必要があります",
  open_findings: "未解決の指摘が残っています",
  tests_not_run: "必要なテストが未実施です",
  tests_failed: "必要なテストが失敗しています",
  tests_target_changed: "テスト後に対象の内容が変わったため、テストをやり直す必要があります",
  stopped: "内部確認が上限に達したため止まっています",
};

export function internalStopReasonMessage(reason: InternalStopReason, detail?: string): string {
  switch (reason) {
    case "max_rounds":
      return `独立レビューの往復が上限（${INTERNAL_MAX_ROUNDS}回）に達しました。残っている指摘と進め方を人が判断してください`;
    case "timed_out":
      return `内部確認が上限時間（${INTERNAL_MAX_MINUTES}分）を超えました。残っている指摘と進め方を人が判断してください`;
    case "recurring_finding":
      return `同じ指摘${detail ? `（${detail}）` : ""}が解消されないまま${INTERNAL_MAX_REOPEN}回再発しました。同じ修正を繰り返さず、原因と方針を人が判断してください`;
    case "no_progress":
      return `未解決の指摘が${INTERNAL_NO_PROGRESS_ROUNDS}往復続けて減っていません。進捗が無いため、進め方を人が判断してください`;
  }
}

/**
 * 内部確認の完了判定。**最新の往復の記録だけ**を見る（古い往復の合格を持ち越さない）。
 * `currentSha`は確認時点の`issue-<番号>`ブランチのHEAD（サーバーが取り直した値）。
 */
export function evaluateInternalGate(input: {
  rounds: readonly InternalRoundRecord[];
  findings: readonly InternalFindingRecord[];
  currentSha: string | null;
  /** すでに停止（上限・再発・進捗なし）している */
  stopped?: boolean;
}): InternalGate {
  const fail = (blocker: InternalGateBlocker, targetSha: string | null = null): InternalGate => ({
    complete: false,
    blocker,
    targetSha,
    message: BLOCKER_MESSAGE[blocker],
  });
  if (input.stopped) return fail("stopped");
  const latest = [...input.rounds].sort((a, b) => b.round - a.round)[0];
  if (!latest || latest.reviewVerdict === null || latest.reviewTargetSha === null) return fail("no_review");
  if (input.currentSha === null || latest.reviewTargetSha !== input.currentSha) return fail("review_target_changed", latest.reviewTargetSha);
  if (latest.reviewVerdict === "findings" || input.findings.some((f) => f.status === "open")) return fail("open_findings", latest.reviewTargetSha);
  if (latest.testState === null) return fail("tests_not_run", latest.reviewTargetSha);
  if (latest.testState === "failed") return fail("tests_failed", latest.reviewTargetSha);
  if (latest.testTargetSha !== input.currentSha) return fail("tests_target_changed", latest.reviewTargetSha);
  return { complete: true, blocker: null, targetSha: input.currentSha, message: "独立レビュー・テストが同じ対象で完了しています" };
}

/**
 * 上限・同一指摘の再発・進捗なしの判定。通常のレビュー指摘だけでは止めず、これらに当たったときだけ`stop`を返す。
 * `startedAt`は内部確認の開始時刻（修正系列の作成）。
 */
export function decideInternalStop(input: {
  rounds: readonly InternalRoundRecord[];
  findings: readonly InternalFindingRecord[];
  startedAt: Date;
  now: Date;
  /** 上限内にゲートが完了済みなら、時間上限では止めない（完了後の再評価で巻き戻さない） */
  gateComplete?: boolean;
}): { stop: false } | { stop: true; reason: InternalStopReason; detail?: string } {
  const reviewed = input.rounds.filter((r) => r.reviewVerdict !== null).sort((a, b) => a.round - b.round);

  const recurring = input.findings.find((f) => f.reopenCount >= INTERNAL_MAX_REOPEN && f.status === "open");
  if (recurring) return { stop: true, reason: "recurring_finding", detail: recurring.key };

  // 時間上限は、レビューがpassでも完了前なら適用する（テスト完了待ちで120分を超えたらPRを作らせない）
  if (!input.gateComplete && input.now.getTime() - input.startedAt.getTime() >= INTERNAL_MAX_MINUTES * 60 * 1000) {
    return { stop: true, reason: "timed_out" };
  }

  // 最新の往復が合格なら、回数・進捗の上限に達していても止めない（完了できる状態を止めない）
  const latest = reviewed[reviewed.length - 1];
  if (latest?.reviewVerdict === "pass") return { stop: false };

  if (reviewed.length >= INTERNAL_MAX_ROUNDS) return { stop: true, reason: "max_rounds" };
  if (input.now.getTime() - input.startedAt.getTime() >= INTERNAL_MAX_MINUTES * 60 * 1000) {
    return { stop: true, reason: "timed_out" };
  }
  if (reviewed.length >= INTERNAL_NO_PROGRESS_ROUNDS + 1) {
    const tail = reviewed.slice(-(INTERNAL_NO_PROGRESS_ROUNDS + 1));
    const counts = tail.map((r) => r.openFindingCount);
    // 先頭より後の往復が、どれも直前より件数を減らしていない（かつ未解決が残っている）
    const stalled = counts.slice(1).every((n, i) => n >= counts[i]) && counts[counts.length - 1] > 0;
    if (stalled) return { stop: true, reason: "no_progress" };
  }
  return { stop: false };
}

/** 次の指摘ID。`F-001`から連番 */
export function nextFindingKey(existingKeys: readonly string[]): string {
  const max = existingKeys.reduce((acc, key) => {
    const n = /^F-(\d+)$/.exec(key)?.[1];
    return n ? Math.max(acc, Number(n)) : acc;
  }, 0);
  return `F-${String(max + 1).padStart(3, "0")}`;
}

export type ReviewReport = {
  verdict: InternalReviewVerdict;
  /** 新しく見つかった指摘 */
  newFindings: { title: string; detail?: string | null }[];
  /** 今回も解消していない既存の指摘（再発として数える。すでに`resolved`なら再オープン） */
  stillOpen: string[];
  /** 今回の確認で解消を確かめた指摘と、その根拠 */
  resolved: { key: string; resolution: string }[];
};

/** レビュー報告の整合性。`pass`なのに指摘が残る、`findings`なのに指摘が無い報告を弾く */
export function validateReviewReport(report: ReviewReport, current: readonly InternalFindingRecord[]): string | null {
  const open = new Set(current.filter((f) => f.status === "open").map((f) => f.key));
  for (const r of report.resolved) open.delete(r.key);
  for (const key of report.stillOpen) open.add(key);
  const known = new Set(current.map((f) => f.key));
  for (const key of [...report.stillOpen, ...report.resolved.map((r) => r.key)]) {
    if (!known.has(key)) return `未知の指摘ID ${key} です`;
  }
  const remaining = open.size + report.newFindings.length;
  if (report.verdict === "pass" && remaining > 0) return "verdictがpassですが、未解決の指摘が残っています。解消の根拠を報告するか、verdictをfindingsにしてください";
  if (report.verdict === "findings" && remaining === 0) return "verdictがfindingsですが、未解決の指摘がありません";
  if (report.resolved.some((r) => r.resolution.trim() === "")) return "解消の根拠（resolution）が空です";
  return null;
}

/**
 * 修正PRの観測（巡回）に使う、内部確認の保留判断。内部確認を求める系列で、PRが未完了のまま、または確認した内容と
 * 違う内容で現れたときは作り直しへ進めない。**PRそのものはGitHub側で作れてしまうため、強制は取り込み（作り直し）の手前に置く。**
 * `gate`は**PRのhead SHAを`currentSha`として**評価したもの（マージ後にブランチが消えても照合できる）。
 */
export function decideInternalHold(input: {
  required: boolean;
  gate: InternalGate;
}): { hold: false } | { hold: true; reason: string } {
  if (!input.required || input.gate.complete) return { hold: false };
  return { hold: true, reason: `${INTERNAL_HOLD_PREFIX}${input.gate.message}。内部確認が完了するまで修正を候補へ取り込みません` };
}

/** 判断待ちの理由が内部確認の保留によるものかを見分ける印（画面の主操作を出し分ける） */
export const INTERNAL_HOLD_PREFIX = "内部確認: ";

export function isInternalHoldReason(reason: string | null | undefined): boolean {
  return reason != null && reason.startsWith(INTERNAL_HOLD_PREFIX);
}
