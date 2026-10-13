import { createHash } from "node:crypto";

import { redactDiagnosticText } from "@/lib/release-review-diagnostic";
import { BLOCKING_POLICY_LINES, RELEASE_REVIEW_CHECK_ITEMS, RELEASE_REVIEW_CHECKLIST_VERSION } from "@/lib/release-review-checklist";
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

export function isReleaseFixActive(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function parseReleaseFixStatus(value: string): ReleaseFixStatus | null {
  return (RELEASE_FIX_STATUSES as readonly string[]).includes(value) ? (value as ReleaseFixStatus) : null;
}

export const RELEASE_FIX_STATUS_LABEL: Record<ReleaseFixStatus, string> = {
  issue_created: "修正Issueを作成済み（未開始）",
  fix_in_progress: "指摘への修正内容を作業中",
  fix_merged: "修正をdevelopへ取り込み済み（リリースへの反映待ち）",
  rebuilding: "修正版のリリースを準備中",
  reverifying: "修正後のチェック中",
  ready: "チェックを通過（本番承認待ち）",
  awaiting_decision: "判断待ち",
  stopped: "修正が止まっています",
  superseded: "新しいリリースに置き換え済み",
};

/**
 * 修正を反映したリリースの準備（作り直し）に失敗して止めるときの理由（#4398）。
 * 巡回が`stopReason`へ書く文面と、画面が「準備に失敗」と判別する条件を同じ定数で持つ。
 */
export const REBUILD_FAILURE_REASONS = {
  selective: "選んだ修正PRで候補を作り直せませんでした。画面の「修正を入れて作り直す」から手動で作り直せます",
  closedThenDispatchFailed: "元の候補を閉じたあと、リリースworkflowの起動に失敗しました。画面の「リリースする」から起動し直してください",
  full: "候補の作り直しに失敗しました。修正は取り込み済みです。画面の「修正を入れて作り直す」から手動で作り直せます",
  // 正式版を上げる前のリリース候補（#4495）へ修正を取り込めなかった。候補と元のrevisionは残る
  rc: "修正PRをリリース候補へ取り込めませんでした。候補の改訂履歴で理由を確認してください（候補と元のrevisionは残っています）",
} as const;

/** 修正PRが足せる候補に無いと判断して止めたときの理由。この理由で止まった系列は巡回が再評価する（#4422） */
export const NOTHING_TO_ADD_REASON =
  "修正PRが元の候補の後にdevelopへ入っていないため、足すものがありません。修正PRがすでに候補に含まれていないかを確認してください";

/** 後継候補の再検証で指摘・失敗が残って止めたときの理由の目印。リリース完了系列（#4480）が次の世代を起案する合図に使う */
export const REVERIFY_FAILED_MARKER = "の再検証で指摘・失敗が残りました";

export function isReverifyFailureReason(reason: string | null | undefined): boolean {
  return reason != null && reason.includes(REVERIFY_FAILED_MARKER);
}

export function isRebuildFailureReason(reason: string | null | undefined): boolean {
  return reason != null && (Object.values(REBUILD_FAILURE_REASONS) as string[]).includes(reason);
}

/**
 * 世代数の固定上限（3回）で止めていた旧い巡回の停止理由の目印（#4589で上限を撤廃）。
 * この理由で止まった系列は、巡回が再評価して同じ修正Issueの次世代へ戻す。他の理由の停止は対象にしない。
 */
const LEGACY_GENERATION_LIMIT_MARKER = "修正の反復が上限（";

export function isLegacyGenerationLimitStopReason(reason: string | null | undefined): boolean {
  return reason != null && reason.includes(LEGACY_GENERATION_LIMIT_MARKER) && reason.includes("回）に達しました");
}

/** 画面の現在地ステップ（左から右へ進む）。`awaiting_decision`・`stopped`は進んだところで止まる */
export const RELEASE_FIX_STEPS = [
  "Issue作成",
  "計画・実装",
  "PR検証",
  "develop取り込み",
  "修正をリリースに反映",
  "修正後のチェック",
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
  /** 内部確認（#4410）の手順を本文へ含める。旧い系列・テストは省略 */
  internalReview?: boolean;
  /** 世代を進めた起案で、同じ修正Issueへ戻す（新しいIssueを作らず、このコメントとして足す） */
  continuation?: boolean;
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
    `- 世代: ${input.generation}`,
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
    ...(input.internalReview ? internalReviewSection() : []),
    "## 取り込みの流れ",
    "",
    "- この修正PRがdevelopへマージされると、issue-deckが元リリースPRの作り直しを行い、新しいSHAで統合検証と全体レビューを自動でやり直します（リリースブランチへは直接書き込みません）。",
    "- 本番mainへのマージ・デプロイは従来どおり人が承認します。",
    "- この修正はdevelop向けのPRとして作成してください。リリース候補（`release-main/*`）のブランチは編集しません。",
  );
  return { title, body: lines.join("\n") };
}

/** 修正Issue本文へ入れる、内部確認（#4410）の手順。実装担当の作業手順として読まれる */
export function internalReviewSection(): string[] {
  return [
    "## 内部確認（このセッションの中で完結させる）",
    "",
    "修正は、1つのセッション内で「実装 → 独立レビュー → 修正 → テスト」を繰り返し、**内部確認が完了してから修正PRを1件だけ**作成します。レビューのたびに修正Issue・PR・リリース候補を増やしません。",
    "",
    "- 作業場所: 元候補（base/headは上記）の凍結ブランチを一時worktreeへ取得し、そこへ修正を重ねた状態で確認する。**developの最新は混ぜない**。内部の往復では候補の作り直し・バージョン更新をしない",
    "- 独立レビュー: `Agent`ツールで**読み取り専用の別エージェント**に依頼する（実装した本人は合否を決めない）。差分だけでなく、修正を取り込んだ候補全体との整合（認可・関連エンドポイント・スキーマ・設定と配布物・旧pollerなどの互換性）を確認させ、指摘と検証結果を返させる",
    "- 修正は実装担当が行う。指摘は`scripts/report-release-fix-round.sh review`で記録するとIDが付く（`F-001`〜）。解消は根拠つきで報告する。対象のSHAは`issue-<番号>`ブランチのHEADからサーバーが取り直すので、**報告の前にpushする**",
    "- テストは`scripts/report-release-fix-round.sh test`で結果を記録する。内容が変わったら、レビューもテストもやり直す（古い合格は使われない）",
    `- 確認方針（最終候補の全体レビューと同じ基準。確認項目v${RELEASE_REVIEW_CHECKLIST_VERSION}）: 独立レビューには、修正を取り込んだ候補全体について次の観点を項目ごとに確認させ、確認済み／非該当／未確認と根拠を返させる（根拠の無い確認済みは未確認として扱う）。${RELEASE_REVIEW_CHECK_ITEMS.map((i) => i.label).join("／")}`,
    `- 指摘の区別: ${BLOCKING_POLICY_LINES.join(" ")}止めない提案だけで往復を続けない（別Issueで追跡する）`,
    "- 完了の条件: 独立レビューの実施・未解決指摘0件・必要テストの合格が、同じ内容に対してそろっていること。そろったら`scripts/create-release-fix-pr.sh`でPRを作る（通常の往復で追加Issue・PRは作らない。再実行してもPRは重複しない）",
    "- 担当: 作業の最初に`scripts/report-release-fix-round.sh claim <issue番号> <担当名>`で担当を取り、応答の`epoch`を以降の`review`・`test`へ環境変数`RELEASE_FIX_ASSIGNEE`・`RELEASE_FIX_EPOCH`で渡す（旧担当の遅延報告は記録されない）。別のエージェントから引き継ぐときも同じ記録（指摘・往復・稼働時間）から未完了の部分を続ける",
    "- 一時停止: 往復の回数では止まらない。**進捗の根拠が無い停滞**（変更も解消も無いまま同じ指摘が再指摘される・未解決が減らず解消も無い）と**実行予算（稼働時間。待機・中断は含まない）の到達**で、記録を保持したまま一時停止し、必要な操作がIssueに残る。停止中は報告できず、画面から再開（予算の追加・方針の入力）する。実行環境の障害・判断や権限の不足は`scripts/report-release-fix-round.sh pause`で報告して止める",
    "",
  ];
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
  /**
   * 内部確認（#4410）が未完了、または確認した内容と違う修正PRが現れているときの理由。無ければnull/未指定。
   * PRの作成自体はGitHub側で止められないため、強制は作り直しへ進める手前の判断（`decideReleaseFix`）に置く
   */
  internalHold?: string | null;
};

export type ReleaseCandidateObservation = {
  /** 元リリースPRが今も開いているか（番号と凍結ブランチの先端SHAが起案時のまま） */
  originStillOpen: boolean;
  originMerged: boolean;
  /** 元のリリースPRのheadより後にdevelopへ入ったPR番号（バンプPR・リリースPRは除く） */
  developPullRequests: number[];
  /** 候補の取得が最後まで済んだか。falseなら「足すものがない」と断定せず待つ（#4422）。未指定はtrue */
  complete?: boolean;
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

  // 内部確認が済んでいない修正は候補へ取り込まない。理由を示して人の判断へ回し、確認が完了すれば次の巡回で自動的に進む
  const held = waiting.filter((s) => s.fixPrNumber !== null && s.internalHold);
  if (held.length > 0) {
    return { action: "stop", status: "awaiting_decision", reason: held[0].internalHold as string, seriesIds: held.map((s) => s.id) };
  }

  if (!waiting.every((s) => s.fixPrMerged)) return { action: "wait" };

  const fixPrs = new Set(waiting.map((s) => s.fixPrNumber).filter((n): n is number => n !== null));
  const accepted = new Set(waiting.flatMap((s) => s.acceptedExtraPrs));
  if (input.selective) {
    // 元の候補へ足すのは修正PR（＋確認済みのPR）のうち、元の候補の後にdevelopへ入ったものだけ
    const developed = new Set(input.candidate.developPullRequests);
    const selectedPrs = [...new Set([...fixPrs, ...accepted])].filter((n) => developed.has(n)).sort((a, b) => a - b);
    if (selectedPrs.length === 0) {
      if (input.candidate.complete === false) return { action: "wait" };
      return {
        action: "stop",
        status: "stopped",
        reason: NOTHING_TO_ADD_REASON,
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

/**
 * 旧い巡回が再検証の失敗で一律に止めたときの停止理由（#4478より前）。この理由で止まった系列は、
 * 巡回が再評価して同じ修正Issueの次世代へ戻す。
 */
export function isLegacyReverificationStopReason(reason: string | null | undefined): boolean {
  return reason != null && /の再検証で指摘・失敗が残りました（世代 \d+）/.test(reason);
}

export type ReverificationFollowUp =
  /** 通常の追加指摘。同じ修正Issueの次世代として自動で続ける */
  | { action: "continue"; sourceKind: ReleaseFixSourceKind }
  /** 実行障害の疑い。コードの不具合と断定せず、起案せずに再実行（既存の機構）を待つ */
  | { action: "wait_rerun"; reason: string }
  /** 本人の判断・操作が要る。理由は具体的に書く */
  | { action: "human"; reason: string };

type ReverificationSectionInput = {
  state: string;
  reason: string | null;
  summary: string | null;
  findingCount: number;
};

/**
 * 再検証で修正が要ると判定された（`decideReverification`が`needs_fix`）あとの扱いを、
 * 失敗というだけで本人確認にせず区別する（#4478）。
 *
 * - 全体レビューの指摘（`needs_check`で指摘あり）→ 全件を`review_finding`として継続
 * - 全体レビューの実行失敗（`failed`）→ 実行障害。起案しない
 * - 統合検証の失敗 → 本文から実行障害（待つ）／コード（継続）／判断不能（本人）に分ける
 * - 指摘が読み取れない`needs_check` → 起案する対象が無いため本人へ
 */
export function decideReverificationFollowUp(input: {
  integration: ReverificationSectionInput;
  aiReview: ReverificationSectionInput;
}): ReverificationFollowUp {
  const { integration, aiReview } = input;
  if (aiReview.state === "needs_check" && aiReview.findingCount > 0) {
    return { action: "continue", sourceKind: "review_finding" };
  }
  const integrationBroken = integration.state === "failed" || integration.state === "needs_check";
  if (integrationBroken) {
    const kind = classifyIntegrationFailure([integration.reason, integration.summary].filter(Boolean).join("\n"));
    if (kind === "code") return { action: "continue", sourceKind: "integration_failure" };
    if (kind === "execution") {
      return { action: "wait_rerun", reason: "統合検証が実行障害の疑いで失敗しています。コードの不具合と断定できないため、修正Issueは作らず再実行を待ちます" };
    }
    return {
      action: "human",
      reason: "統合検証の失敗がコードの不具合か実行障害か判別できません。証跡を確認し、再実行するか、画面から修正Issueを起案してください",
    };
  }
  if (aiReview.state === "failed") {
    return { action: "wait_rerun", reason: "全体レビューが実行障害で完了していません。修正Issueは作らず再実行を待ちます" };
  }
  return {
    action: "human",
    reason: "全体レビューが確認を求めていますが、起案できる指摘が読み取れません。レビュー結果を確認し、必要なら画面から修正Issueを起案してください",
  };
}

/**
 * 次の世代を起案できるか。世代数では止めない（#4589）。止めるのは**同じ候補・同じ指摘の再発**だけで、
 * 進捗の無い停滞・実行予算・本人判断は内部確認の一時停止（#4587）が受け持つ。
 */
export function canStartNextGeneration(input: {
  sourceKey: string;
  ancestorSourceKeys: readonly string[];
}): { ok: true } | { ok: false; reason: string } {
  if (input.ancestorSourceKeys.includes(input.sourceKey)) {
    return { ok: false, reason: "前の世代と同じ指摘が再発しています。同じ修正を繰り返さず、原因を人が確認してください" };
  }
  return { ok: true };
}

/** 修正Issueの実行の状況（#4396）。`none`は未開始、`queued`は受付済み（起動待ち）、`running`は実行中 */
export type ReleaseFixStartState = "none" | "queued" | "running";

export type ReleaseFixStartDecision =
  | { ok: true }
  | { ok: false; reason: "not_startable" | "superseded" | "issue_closed" | "already_started"; message: string };

/**
 * 「修正を開始」を押してよいか（#4396）。**開始の導線が対象を取り違えないための判断**で、
 * 起動そのもの（権限・ホスト・確認待ち）は既存の「実装を開始」ダイアログと配車APIが担う。
 *
 * - 修正PRがまだ無い`issue_created`の系列だけが対象（作業中・終端は状態の確認に導く）
 * - 作り直しで後継の世代ができた系列、閉じたIssueは起動しない
 * - すでに受付済み・実行中なら重複して起動せず、状態の確認へ導く
 */
export function decideReleaseFixStart(input: {
  status: ReleaseFixStatus;
  hasSuccessor: boolean;
  issueState: "open" | "closed";
  startState: ReleaseFixStartState;
}): ReleaseFixStartDecision {
  if (input.hasSuccessor) {
    return { ok: false, reason: "superseded", message: "この修正は新しい世代に置き換わっています。最新の修正から開始してください。" };
  }
  if (input.status !== "issue_created") {
    return { ok: false, reason: "not_startable", message: "この修正はすでに進行中か終了しているため、開始できません。" };
  }
  if (input.issueState !== "open") {
    return { ok: false, reason: "issue_closed", message: "修正Issueが閉じられているため、開始できません。" };
  }
  if (input.startState !== "none") {
    return { ok: false, reason: "already_started", message: "すでに実行が受け付けられています。状態を確認してください。" };
  }
  return { ok: true };
}
