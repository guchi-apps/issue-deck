/**
 * リリース修正の内部確認（#4410）の判断。**純関数だけ**を置き、保存と外部操作は`release-fix-internal-run.ts`が持つ。
 *
 * 修正Issueのセッションの中で「実装 → 独立レビュー → 修正 → テスト」を繰り返し、内部確認が完了してから
 * develop向けの修正PRを1件作る。**実装担当だけの判断で合格にしない**: 完了には、独立レビューの報告・
 * 未解決指摘0件・必要テストの合格が、**同じ対象（`issue-<番号>`ブランチのHEAD SHA）に対して**そろっている必要がある。
 * 対象が変わったあとの古い合格は流用しない。
 */

/**
 * 実行予算の単位は「実際に作業した分数（稼働時間）」。既定値と、1回の活動として数える間隔の上限を決める（#4587）。
 * 往復数や系列作成からの経過時間では止めない。待機・中断・担当不在の間は算入しない。
 */
export const INTERNAL_DEFAULT_BUDGET_MINUTES = 120;
/** 報告・ハートビートの間隔がこれを超えたぶんは、待機・中断とみなして稼働時間へ算入しない（分） */
export const INTERNAL_ACTIVE_GAP_MINUTES = 10;
/** 担当の持ち時間。ハートビート・報告のたびに延びる（分） */
export const INTERNAL_LEASE_MINUTES = 30;
/** 同じ指摘が解消されないまま再度指摘された回数。進捗の根拠が無いままこれに達したら一時停止する */
export const INTERNAL_MAX_REOPEN = 2;
/** 未解決の指摘が減らず、解消の根拠も無い往復が続いたら進捗なしとみなす回数 */
export const INTERNAL_NO_PROGRESS_ROUNDS = 2;
/** 試行履歴に残す件数の上限 */
export const INTERNAL_MAX_ATTEMPTS = 60;

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
  /** 解消されないまま再び指摘された回数（同一指摘の未解消） */
  reopenCount: number;
  /** 解消した後に再発した回数 */
  regressionCount?: number;
  /** 最後に状態が動いた往復（解消の往復を進捗の根拠にする） */
  lastRound?: number;
};

/** 一時停止の原因。通常の指摘（`findings`）は停止ではなく、停滞・予算・環境・判断だけが停止になる */
export type InternalStopReason = "budget_reached" | "recurring_finding" | "no_progress" | "environment" | "needs_decision";

/** 停止から再開するときに利用者へ求める入力 */
export type InternalResumeNeed = "budget" | "direction" | "none";

export function internalResumeNeed(kind: InternalStopReason): InternalResumeNeed {
  if (kind === "budget_reached") return "budget";
  if (kind === "environment") return "none";
  return "direction";
}

export function isInternalStopReason(value: unknown): value is InternalStopReason {
  return value === "budget_reached" || value === "recurring_finding" || value === "no_progress" || value === "environment" || value === "needs_decision";
}

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
  stopped: "内部確認は一時停止しています。原因と次の操作を確かめて再開してください",
};

export function internalStopReasonMessage(reason: InternalStopReason, detail?: string): string {
  switch (reason) {
    case "budget_reached":
      return `実行予算（稼働${detail ?? INTERNAL_DEFAULT_BUDGET_MINUTES}分）に達したため一時停止しています。作業内容と指摘の記録は保持されています`;
    case "recurring_finding":
      return `同じ指摘${detail ? `（${detail}）` : ""}が、変更も解消の根拠も無いまま${INTERNAL_MAX_REOPEN}回再び指摘されました。同じ修正を繰り返さず一時停止しています`;
    case "no_progress":
      return `未解決の指摘が${INTERNAL_NO_PROGRESS_ROUNDS}往復続けて減らず、解消の根拠もありません。進捗が無いため一時停止しています`;
    case "environment":
      return `実行環境の障害で作業を続けられず一時停止しています${detail ? `（${detail}）` : ""}。回復していれば、そのまま再開できます`;
    case "needs_decision":
      return `本人の判断または権限が必要なため一時停止しています${detail ? `（${detail}）` : ""}`;
  }
}

/** 一時停止の原因ごとの、再開に必要な操作（画面とIssueコメントに出す） */
export function internalNextAction(reason: InternalStopReason): string {
  switch (reason) {
    case "budget_reached":
      return "実行予算を追加して再開する（追加する稼働時間を指定）";
    case "recurring_finding":
    case "no_progress":
      return "指摘と記録を確かめ、進め方の方針を入力して再開する";
    case "environment":
      return "実行環境が回復していることを確かめて再開する（入力は不要）";
    case "needs_decision":
      return "判断または権限を与えたうえで、方針を入力して再開する";
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
  /** すでに一時停止している */
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
 * 一時停止の判定。通常のレビュー指摘や往復数だけでは止めず、**進捗の根拠が無い停滞**と**実行予算への到達**のときだけ`stop`を返す。
 * 進捗の根拠: 指摘の解消・未解決件数の減少・確認対象（SHA）の変更。件数だけで停滞を断定しない。
 * 完了できる状態（`gateComplete`）は、予算に達していても止めない。
 */
export function decideInternalStop(input: {
  rounds: readonly InternalRoundRecord[];
  findings: readonly InternalFindingRecord[];
  /** 稼働時間（分）。待機・中断は含まない */
  activeMinutes: number;
  budgetMinutes: number;
  gateComplete?: boolean;
}): { stop: false } | { stop: true; reason: InternalStopReason; detail?: string } {
  if (input.gateComplete) return { stop: false };
  const reviewed = input.rounds.filter((r) => r.reviewVerdict !== null).sort((a, b) => a.round - b.round);
  const latest = reviewed[reviewed.length - 1];
  const overBudget = input.activeMinutes >= input.budgetMinutes;
  // 最新のレビューが合格なら停滞ではない（テスト待ち）。予算だけを見る
  if (latest?.reviewVerdict === "pass") return overBudget ? { stop: true, reason: "budget_reached", detail: String(input.budgetMinutes) } : { stop: false };

  const tailSize = INTERNAL_NO_PROGRESS_ROUNDS + 1;
  const tail = reviewed.slice(-tailSize);
  const tailStartRound = tail[0]?.round ?? 0;
  // 直近の往復に、解消の根拠（その間に解消した指摘）があるか
  const resolvedInTail = tail.length > 1 && input.findings.some((f) => f.status === "resolved" && (f.lastRound ?? 0) > tailStartRound);
  const counts = tail.map((r) => r.openFindingCount);
  const notDecreasing = tail.length >= tailSize && counts.slice(1).every((n, i) => n >= counts[i]) && counts[counts.length - 1] > 0;
  const unchangedTarget = tail.length >= 2 && tail[tail.length - 1].reviewTargetSha !== null && tail[tail.length - 1].reviewTargetSha === tail[tail.length - 2].reviewTargetSha;

  const recurring = input.findings.find((f) => f.status === "open" && f.reopenCount >= INTERNAL_MAX_REOPEN);
  if (recurring && !resolvedInTail && (unchangedTarget || notDecreasing)) return { stop: true, reason: "recurring_finding", detail: recurring.key };
  if (notDecreasing && !resolvedInTail) return { stop: true, reason: "no_progress" };
  if (overBudget) return { stop: true, reason: "budget_reached", detail: String(input.budgetMinutes) };
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

/**
 * 稼働時間の加算。前回の活動からの間隔のうち、`INTERNAL_ACTIVE_GAP_MINUTES`までを算入し、それを超えたぶん
 * （待機・中断・担当不在）は算入しない。一時停止中は呼ばない（呼び出し側が止める）。
 */
export function accrueActiveSeconds(input: { activeSeconds: number; lastActivityAt: Date | null; now: Date }): number {
  if (!input.lastActivityAt) return input.activeSeconds;
  const gap = Math.max(0, Math.floor((input.now.getTime() - input.lastActivityAt.getTime()) / 1000));
  return input.activeSeconds + Math.min(gap, INTERNAL_ACTIVE_GAP_MINUTES * 60);
}

export type InternalAttempt = {
  at: string;
  kind: "claim" | "handover" | "release" | "pause" | "resume";
  by: string | null;
  detail: string | null;
  sha: string | null;
};

export function appendAttempt(history: unknown, attempt: InternalAttempt): InternalAttempt[] {
  const list = Array.isArray(history) ? (history as InternalAttempt[]) : [];
  return [...list, attempt].slice(-INTERNAL_MAX_ATTEMPTS);
}

export type ResumeDecision =
  | { ok: true; addMinutes: number }
  | { ok: false; error: "input_required"; message: string };

/** 再開に必要な入力が足りているか。予算到達なら稼働時間の追加、停滞・判断待ちなら方針の入力を求める */
export function decideInternalResume(input: { kind: InternalStopReason; addMinutes: number | null; direction: string | null }): ResumeDecision {
  const need = internalResumeNeed(input.kind);
  if (need === "budget" && !(input.addMinutes !== null && input.addMinutes > 0)) {
    return { ok: false, error: "input_required", message: "実行予算に達しています。追加する稼働時間（分）を指定してください" };
  }
  if (need === "direction" && (input.direction === null || input.direction.trim() === "")) {
    return { ok: false, error: "input_required", message: "同じ修正を繰り返さないため、進め方の方針を入力してください" };
  }
  return { ok: true, addMinutes: input.addMinutes !== null && input.addMinutes > 0 ? Math.min(input.addMinutes, 1440) : 0 };
}

/** 旧方式の停止理由（文面）を、新方式の原因へ読み替える。判断できないものは予算到達として再評価へ回す */
export function classifyLegacyStopReason(text: string): InternalStopReason {
  if (text.includes("同じ指摘")) return "recurring_finding";
  if (text.includes("減っていません")) return "no_progress";
  return "budget_reached";
}
