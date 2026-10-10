import { createHash } from "node:crypto";

import { redactDiagnosticText } from "@/lib/release-review-diagnostic";
import type { ReleaseReviewFinding } from "@/lib/release-review-result";

/**
 * リリース候補の修正系列（#4317）の判断。**純関数だけ**を置き、外部操作は`release-fix-series-run.ts`が持つ。
 *
 * 流れ: 全体レビューの指摘／統合検証の失敗 → 修正Issue → 修正PRがdevelopへマージ → 候補の作り直し
 * （既存の`release-rebuild`）→ 新しいSHAでの再検証 → 本番承認待ち。
 * **本番mainへのマージ・デプロイは従来どおり人が承認する。自動化の終点は「検証済み候補の準備完了」。**
 */

export const RELEASE_FIX_SOURCE_KINDS = ["review_finding", "integration_failure"] as const;
export type ReleaseFixSourceKind = (typeof RELEASE_FIX_SOURCE_KINDS)[number];

/** コードの修正が要るか、仕様判断が先か。実行障害（環境）は系列にしない（`classifyIntegrationFailure`） */
export const RELEASE_FIX_CAUSE_CLASSES = ["code", "decision"] as const;
export type ReleaseFixCauseClass = (typeof RELEASE_FIX_CAUSE_CLASSES)[number];

export const RELEASE_FIX_STATUSES = [
  "issue_created",
  "fix_in_progress",
  "fix_merged",
  "rebuilding",
  "reverifying",
  "ready",
  "awaiting_decision",
  "stopped",
  "superseded",
] as const;
export type ReleaseFixStatus = (typeof RELEASE_FIX_STATUSES)[number];

/** 進行中（次の巡回で状態が進みうる）。終端は`ready`・`stopped`・`superseded` */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "issue_created",
  "fix_in_progress",
  "fix_merged",
  "rebuilding",
  "reverifying",
  "awaiting_decision",
]);

/** 修正を重ねる上限（世代）。超えたら理由付きで止め、Issueや候補を無限に増やさない */
export const RELEASE_FIX_MAX_GENERATION = 3;

export function isReleaseFixActive(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function parseReleaseFixStatus(value: string): ReleaseFixStatus | null {
  return (RELEASE_FIX_STATUSES as readonly string[]).includes(value) ? (value as ReleaseFixStatus) : null;
}

export const RELEASE_FIX_STATUS_LABEL: Record<ReleaseFixStatus, string> = {
  issue_created: "修正Issue作成済み",
  fix_in_progress: "修正PRの作業中",
  fix_merged: "developへ取り込み済み",
  rebuilding: "候補を作り直し中",
  reverifying: "再検証中",
  ready: "本番承認待ち",
  awaiting_decision: "判断待ち",
  stopped: "停止",
  superseded: "対象外（置き換え済み）",
};

/** 画面の現在地ステップ（左から右へ進む）。`awaiting_decision`・`stopped`は進んだところで止まる */
export const RELEASE_FIX_STEPS = [
  "Issue作成",
  "計画・実装",
  "PR検証",
  "develop取り込み",
  "候補作り直し",
  "再検証",
  "本番承認待ち",
] as const;

/** 状態から、現在地のステップ番号（0始まり）を返す。止まっているときは`stoppedAt`で止まった位置を渡す */
export function releaseFixStepIndex(input: {
  status: ReleaseFixStatus;
  fixPrNumber: number | null;
  successorPrNumber: number | null;
}): number {
  switch (input.status) {
    case "issue_created":
      return 1;
    case "fix_in_progress":
      return input.fixPrNumber !== null ? 2 : 1;
    case "fix_merged":
      return 3;
    case "rebuilding":
      return 4;
    case "reverifying":
      return 5;
    case "ready":
      return 6;
    default:
      // 判断待ち・停止・置き換え済みは、分かっている範囲の最後の位置
      if (input.successorPrNumber !== null) return 5;
      return input.fixPrNumber !== null ? 2 : 1;
  }
}

/** 二重起案を止める鍵。同じリリースPR・SHA・種別・指摘の組なら同じ値になる（指摘の並び順に依らない） */
export function buildReleaseFixSourceKey(input: {
  repositoryFullName: string;
  releasePrNumber: number;
  baseSha: string;
  headSha: string;
  sourceKind: ReleaseFixSourceKind;
  itemKeys: string[];
}): string {
  const material = [
    input.repositoryFullName,
    String(input.releasePrNumber),
    input.baseSha,
    input.headSha,
    input.sourceKind,
    ...[...new Set(input.itemKeys)].sort(),
  ].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 40);
}

/** 進行中の系列を1本に絞るキー（`activeKey`のユニーク制約に使う） */
export function releaseFixActiveKey(repositoryFullName: string, releasePrNumber: number, sourceKey: string): string {
  return `${repositoryFullName}#${releasePrNumber}:${sourceKey}`;
}

/** 指摘1件の識別子。題・ファイル・行から決め、機密や長文には依存しない */
export function reviewFindingKey(finding: Pick<ReleaseReviewFinding, "title" | "file" | "line">): string {
  return `${finding.title.trim()}|${finding.file ?? ""}|${finding.line ?? ""}`;
}

const EXECUTION_FAILURE_PATTERNS: ReadonlyArray<RegExp> = [
  /exit(?:ed)?(?: with)?(?: code)?\s*12[67]\b/i,
  /command not found/i,
  /permission denied/i,
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/,
  /tmux/i,
  /ENOSPC|no space left/i,
  /Mac(?:が)?(?:未接続|に接続できません)/,
  /ホスト(?:が|に)(?:オフライン|接続できません|ありません)/,
  /(?:実行先|能力ホスト)が(?:ありません|見つかりません)/,
  /認証(?:に失敗|エラー)/,
  /timed? ?out|時間切れ/i,
];

/**
 * 統合検証の失敗が、コードの不具合ではなく**実行障害（環境）**かを文面から見分ける。
 * テスト・ビルド・競合のような「コードを直して解消するもの」は`code`。**観測できた事実だけで決め、
 * 迷うときは`code`にはしない**——環境が原因かもしれないものへ不要なコード修正を強制しないため
 * 「判断が付かない」を`unknown`で返し、画面は再実行を先に勧める。
 */
export function classifyIntegrationFailure(text: string | null | undefined): "execution" | "code" | "unknown" {
  const body = (text ?? "").trim();
  if (body === "") return "unknown";
  if (EXECUTION_FAILURE_PATTERNS.some((pattern) => pattern.test(body))) return "execution";
  if (/(?:test|テスト|build|ビルド|lint|型チェック|tsc|conflict|競合|failed|FAIL)/i.test(body)) return "code";
  return "unknown";
}

export type ReleaseFixDraftItem = {
  /** 指摘・失敗工程の題 */
  title: string;
  detail: string | null;
  file: string | null;
  evidence: string | null;
  recommendation: string | null;
  pullRequests: number[];
};

const ITEM_TEXT_MAX = 2000;

function clean(text: string | null | undefined): string | null {
  if (!text) return null;
  const redacted = redactDiagnosticText(text).trim();
  return redacted === "" ? null : redacted.slice(0, ITEM_TEXT_MAX);
}

/** 全体レビューの指摘を、機密を除いた起案用の項目へ写す */
export function itemFromFinding(finding: ReleaseReviewFinding): ReleaseFixDraftItem {
  return {
    title: clean(finding.title) ?? "（題なし）",
    detail: clean([finding.detail, finding.impact ? `影響: ${finding.impact}` : null].filter(Boolean).join("\n")),
    file: finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : null,
    evidence: clean(finding.evidence),
    recommendation: clean(finding.recommendation),
    pullRequests: finding.pullRequests,
  };
}

export type ReleaseFixIssueInput = {
  repositoryFullName: string;
  releasePrNumber: number;
  releaseVersion: string | null;
  baseSha: string;
  headSha: string;
  sourceKind: ReleaseFixSourceKind;
  causeClass: ReleaseFixCauseClass;
  items: ReleaseFixDraftItem[];
  /** 仕様判断が要るときの、具体的な判断内容（利用者が書く） */
  decisionQuestion: string | null;
  /** 再検証が失敗して続けて起案するとき、前の世代の系列の修正Issue */
  previousIssueNumber: number | null;
  generation: number;
  /** 指摘・失敗に関係するPR（無ければ空） */
  relatedPullRequests: number[];
  /** 修正後に満たす検証条件 */
  verifyConditions: string[];
};

/** 修正Issueの目印。本文の先頭に置き、巡回が起案済みのIssueを本文から探し直せるようにする */
export function releaseFixSeriesMarker(sourceKey: string): string {
  return `<!-- issue-deck-release-fix:${sourceKey} -->`;
}

export const RELEASE_FIX_SOURCE_LABEL: Record<ReleaseFixSourceKind, string> = {
  review_finding: "全体レビューの指摘",
  integration_failure: "統合検証の失敗",
};

/** 修正Issueの題と本文を組み立てる。**引き継ぐのは機密除去済みの根拠だけ** */
export function buildReleaseFixIssue(input: ReleaseFixIssueInput, sourceKey: string): { title: string; body: string } {
  const first = input.items[0]?.title ?? "リリース候補の指摘";
  const more = input.items.length > 1 ? ` ほか${input.items.length - 1}件` : "";
  const title = `リリース候補 #${input.releasePrNumber} の修正: ${first}${more}`.slice(0, 240);

  const lines: string[] = [
    releaseFixSeriesMarker(sourceKey),
    "",
    `${input.repositoryFullName} のリリース候補（${RELEASE_FIX_SOURCE_LABEL[input.sourceKind]}）から起案した修正です（#4317）。`,
    "",
    "## 対象のリリース候補",
    "",
    `- 元リリースPR: #${input.releasePrNumber}${input.releaseVersion ? `（v${input.releaseVersion}）` : ""}`,
    `- base（main）: \`${input.baseSha}\``,
    `- head（凍結ブランチ）: \`${input.headSha}\``,
    `- 種別: ${RELEASE_FIX_SOURCE_LABEL[input.sourceKind]}`,
    `- 世代: ${input.generation}（上限${RELEASE_FIX_MAX_GENERATION}）`,
    ...(input.previousIssueNumber ? [`- 前の修正Issue: #${input.previousIssueNumber}（再検証で別の問題が残った）`] : []),
    ...(input.relatedPullRequests.length > 0
      ? [`- 関連PR: ${input.relatedPullRequests.map((n) => `#${n}`).join("、")}`]
      : []),
    "",
    input.causeClass === "decision" ? "## 判断が必要な内容" : "## 指摘・失敗の内容",
    "",
  ];
  if (input.causeClass === "decision" && input.decisionQuestion) {
    lines.push(input.decisionQuestion.trim(), "", "実装の前に、この判断について計画で方針を示して承認を得てください。", "");
  }
  input.items.forEach((item, index) => {
    lines.push(`### ${index + 1}. ${item.title}`, "");
    if (item.file) lines.push(`- 場所: \`${item.file}\``);
    if (item.pullRequests.length > 0) lines.push(`- 関連PR: ${item.pullRequests.map((n) => `#${n}`).join("、")}`);
    if (item.detail) lines.push("", item.detail);
    if (item.evidence) lines.push("", "根拠:", "", "```", item.evidence, "```");
    if (item.recommendation) lines.push("", `推奨対応: ${item.recommendation}`);
    lines.push("");
  });
  lines.push(
    "## 修正後の検証条件",
    "",
    ...input.verifyConditions.map((condition) => `- ${condition}`),
    "",
    "## 取り込みの流れ",
    "",
    "- この修正PRがdevelopへマージされると、issue-deckが元リリースPRの作り直しを行い、新しいSHAで統合検証と全体レビューを自動でやり直します（リリースブランチへは直接書き込みません）。",
    "- 本番mainへのマージ・デプロイは従来どおり人が承認します。",
    "- この修正はdevelop向けのPRとして作成してください。リリース候補（`release-main/*`）のブランチは編集しません。",
  );
  return { title, body: lines.join("\n") };
}

/** 修正後に満たす検証条件（種別ごとの既定） */
export function defaultVerifyConditions(sourceKind: ReleaseFixSourceKind): string[] {
  return sourceKind === "integration_failure"
    ? [
        "失敗した工程（テスト・ビルドなど）が、修正後の統合検証で成功する",
        "作り直し後の候補で統合検証と全体レビューが自動で再実行され、旧SHAの結果を流用しない",
      ]
    : [
        "指摘された問題がコード上で解消されていることを、PR本文に根拠付きで記載する",
        "作り直し後の候補で全体レビューと統合検証が自動で再実行され、旧SHAの結果を流用しない",
      ];
}

// ---------------------------------------------------------------------------
// 巡回の判断

export type ReleaseFixSeriesSnapshot = {
  id: string;
  status: ReleaseFixStatus;
  issueNumber: number;
  fixPrNumber: number | null;
  /** 修正PRがdevelopへマージ済みか */
  fixPrMerged: boolean;
  /** 修正PRが（マージされずに）閉じられたか */
  fixPrClosedUnmerged: boolean;
  acceptedExtraPrs: number[];
};

export type ReleaseCandidateObservation = {
  /** 元リリースPRが今も開いているか（番号と凍結ブランチの先端SHAが起案時のまま） */
  originStillOpen: boolean;
  originMerged: boolean;
  /** 元のリリースPRのheadより後にdevelopへ入ったPR番号（バンプPR・リリースPRは除く） */
  developPullRequests: number[];
};

export type ReleaseFixDecision =
  | { action: "wait" }
  | { action: "stop"; status: "stopped" | "superseded" | "awaiting_decision"; reason: string; /** 止める対象の系列ID */ seriesIds: string[] }
  | {
      action: "rebuild";
      seriesIds: string[];
      /**
       * PRを選んだ作り直し（#4335）で元の候補へ足すPR。修正PRと、利用者が「含めてよい」と確認したPRだけ。
       * 選んだ作り直しに対応していないリポジトリでは空（従来どおりdevelopの最新を取り込む）
       */
      selectedPrs: number[];
    };

/**
 * 同じリリースPRに結び付いた進行中の系列をまとめて見て、次の操作を決める。
 *
 * - 元リリースPRが取消・マージ・置き換えされていたら、**誤った候補へ取り込まない**（`superseded`）
 * - 全部の修正PRがdevelopへ入るまで待つ。修正PRが閉じられたら理由付きで止める
 * - **PRを選んだ作り直し（#4335）に対応したリポジトリでは、修正PRだけを元の候補へ足す**。無関係な変更は
 *   入らないので判断待ちにしない（画面の手動選択と同じ`requestSelectiveRebuild`を通る）
 * - 対応していないリポジトリの作り直しはdevelop全体を取り込むため、**修正と無関係な変更**が入っていれば
 *   自動で作り直さず、該当PRを示して判断待ちにする（利用者が「含めてよい」と確認したPRは除く）
 */
export function decideReleaseFix(input: {
  series: readonly ReleaseFixSeriesSnapshot[];
  candidate: ReleaseCandidateObservation;
  /** 選んだ作り直しに対応しているか（未指定は非対応＝従来どおり） */
  selective?: boolean;
}): ReleaseFixDecision {
  const waiting = input.series.filter((s) => ["issue_created", "fix_in_progress", "fix_merged", "awaiting_decision"].includes(s.status));
  if (waiting.length === 0) return { action: "wait" };
  const ids = waiting.map((s) => s.id);

  if (input.candidate.originMerged) {
    return { action: "stop", status: "superseded", reason: "元のリリース候補はすでに本番へマージされています。修正は次のリリースへ回してください", seriesIds: ids };
  }
  if (!input.candidate.originStillOpen) {
    return {
      action: "stop",
      status: "superseded",
      reason: "元のリリース候補が取り消された、または別の候補へ置き換えられています。誤った候補へは取り込みません",
      seriesIds: ids,
    };
  }

  const closed = waiting.filter((s) => s.fixPrClosedUnmerged);
  if (closed.length > 0) {
    return {
      action: "stop",
      status: "stopped",
      reason: `修正PR（Issue #${closed.map((s) => s.issueNumber).join("、#")}）がマージされずに閉じられました。続けるには修正を起案し直してください`,
      seriesIds: closed.map((s) => s.id),
    };
  }

  if (!waiting.every((s) => s.fixPrMerged)) return { action: "wait" };

  const fixPrs = new Set(waiting.map((s) => s.fixPrNumber).filter((n): n is number => n !== null));
  const accepted = new Set(waiting.flatMap((s) => s.acceptedExtraPrs));
  if (input.selective) {
    // 元の候補へ足すのは修正PR（＋確認済みのPR）のうち、元の候補の後にdevelopへ入ったものだけ
    const developed = new Set(input.candidate.developPullRequests);
    const selectedPrs = [...new Set([...fixPrs, ...accepted])].filter((n) => developed.has(n)).sort((a, b) => a - b);
    if (selectedPrs.length === 0) {
      return {
        action: "stop",
        status: "stopped",
        reason: "修正PRが元の候補の後にdevelopへ入っていないため、足すものがありません。修正PRがすでに候補に含まれていないかを確認してください",
        seriesIds: ids,
      };
    }
    return { action: "rebuild", seriesIds: ids, selectedPrs };
  }
  const unrelated = input.candidate.developPullRequests.filter((n) => !fixPrs.has(n) && !accepted.has(n));
  if (unrelated.length > 0) {
    return {
      action: "stop",
      status: "awaiting_decision",
      reason:
        `修正待ちの間にdevelopへ修正と無関係な変更（${unrelated.map((n) => `#${n}`).join("、")}）が入りました。` +
        "作り直しはdevelopの最新を取り込むため、自動では作り直しません。含めてよい場合は「含めて作り直す」を、含めたくない場合は該当変更の扱いを決めてください",
      seriesIds: ids,
    };
  }
  return { action: "rebuild", seriesIds: ids, selectedPrs: [] };
}

/** 再検証の結果から、候補が本番承認待ちになったか・修正が要るかを決める */
export function decideReverification(input: {
  integration: "passed" | "failed" | "needs_check" | "pending" | "not_applicable";
  aiReview: "passed" | "failed" | "needs_check" | "pending" | "not_applicable";
}): "ready" | "needs_fix" | "pending" {
  const states = [input.integration, input.aiReview];
  if (states.some((s) => s === "pending")) return "pending";
  if (states.some((s) => s === "failed" || s === "needs_check")) return "needs_fix";
  return "ready";
}

/** 次の世代を起案できるか。上限・同一問題の再発で止める（無限にIssueや候補を増やさない） */
export function canStartNextGeneration(input: {
  generation: number;
  sourceKey: string;
  ancestorSourceKeys: readonly string[];
}): { ok: true } | { ok: false; reason: string } {
  if (input.generation > RELEASE_FIX_MAX_GENERATION) {
    return {
      ok: false,
      reason: `修正の反復が上限（${RELEASE_FIX_MAX_GENERATION}回）に達しました。原因を人が整理してから進めてください`,
    };
  }
  if (input.ancestorSourceKeys.includes(input.sourceKey)) {
    return { ok: false, reason: "前の世代と同じ指摘が再発しています。同じ修正を繰り返さず、原因を人が確認してください" };
  }
  return { ok: true };
}
