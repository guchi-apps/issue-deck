import { FENCE_PATTERN, TASK_LINE_PATTERN } from "@/lib/markdown-task-list";
import type { ManualStepPhase } from "@/lib/manual-step-phase";

/**
 * 通常Issueと旧手作業Issueで共通の「作業サマリー」の元データ（#4524）。
 *
 * 先頭に出すのは目的・完了条件・現在地・次の操作だけで、本文から読み取れない項目は
 * **推測で埋めず「記載なし」とする**。完了の判定はここでは行わない——完了条件のチェックは
 * 本文のチェックリストの状態か、手作業の完了検証（`manual-step-investigation`）の結果をそのまま映す。
 */

const PURPOSE_NEEDLES = ["目的", "できるようになること"];
const CRITERIA_NEEDLES = ["完了条件"];
/** 旧手作業Issueの完了条件に当たる節（`manual-step-body-check.ts`の必須見出しと同じ別名） */
const VERIFICATION_NEEDLES = ["完了の確認方法", "確認方法"];

export type WorkCriterion = {
  text: string;
  /** 本文のチェック状態。チェックリストでない項目はnull（達成は別の根拠で決める） */
  checked: boolean | null;
};

export type WorkSummarySource = {
  /** 目的。見出しが無ければnull */
  purpose: string | null;
  criteria: WorkCriterion[];
  /** 完了条件の取得元。`verification-method`は旧手作業の`## 完了の確認方法` */
  criteriaSource: "completion-criteria" | "verification-method" | null;
};

type Section = { heading: string; lines: string[] };

function splitSections(body: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const f = FENCE_PATTERN.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      current?.lines.push(line);
      continue;
    }
    if (fence === null) {
      const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line);
      if (heading) {
        current = { heading: heading[1], lines: [] };
        sections.push(current);
        continue;
      }
    }
    current?.lines.push(line);
  }
  return sections;
}

function findSection(sections: Section[], needles: string[]): Section | null {
  return sections.find((s) => needles.some((n) => s.heading.includes(n))) ?? null;
}

function stripFences(lines: string[]): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const f = FENCE_PATTERN.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence === null) out.push(line);
  }
  return out;
}

function parsePurpose(section: Section | null): string | null {
  if (!section) return null;
  const text = stripFences(section.lines)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("<!--"))
    .slice(0, 3)
    .join(" ");
  return text === "" ? null : text;
}

function parseCriteria(section: Section): WorkCriterion[] {
  const items: WorkCriterion[] = [];
  for (const raw of stripFences(section.lines)) {
    const task = TASK_LINE_PATTERN.exec(raw);
    if (task) {
      items.push({ text: raw.slice(task[0].length).trim(), checked: task[2].toLowerCase() === "x" });
      continue;
    }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(raw);
    if (bullet) items.push({ text: bullet[1].trim(), checked: null });
  }
  return items.filter((i) => i.text !== "");
}

export function parseIssueWorkSummary(body: string | null | undefined): WorkSummarySource {
  const sections = splitSections(body ?? "");
  const purpose = parsePurpose(findSection(sections, PURPOSE_NEEDLES));

  const criteriaSection = findSection(sections, CRITERIA_NEEDLES);
  if (criteriaSection) {
    const criteria = parseCriteria(criteriaSection);
    if (criteria.length > 0) return { purpose, criteria, criteriaSource: "completion-criteria" };
  }

  const verification = findSection(sections, VERIFICATION_NEEDLES);
  if (verification) {
    const criteria = parseCriteria(verification);
    if (criteria.length > 0) return { purpose, criteria, criteriaSource: "verification-method" };
    // コマンドだけの節は、コマンドの件数を1項目にまとめる（コマンドそのものは補足に残る）
    const commands = verification.lines.filter((l) => FENCE_PATTERN.test(l)).length / 2;
    if (commands >= 1) {
      return {
        purpose,
        criteria: [{ text: "「完了の確認方法」のコマンドがすべて終了コード0になる", checked: null }],
        criteriaSource: "verification-method",
      };
    }
  }
  return { purpose, criteria: [], criteriaSource: null };
}

/**
 * 完了条件の達成数。チェックリストは本文の状態、それ以外（旧手作業の確認方法）は完了検証が
 * すべて成功したときだけ全件達成にする。**未確認は未達成として数える。**
 */
export function countAchievedCriteria(
  source: WorkSummarySource,
  verificationPassed: boolean,
): { achieved: number; total: number } {
  const total = source.criteria.length;
  const achieved = source.criteria.filter((c) => (c.checked === null ? verificationPassed : c.checked)).length;
  return { achieved, total };
}

/** 現在地。依存待ち（操作不要）と本人の操作待ちを取り違えないよう、別の値にする */
export type WorkStatus =
  | "running"
  | "dependency_wait"
  | "user_action"
  | "ai_verifying"
  | "failed"
  | "done"
  /** 完了検証が成功しないままクローズされた（手作業Issueのみ） */
  | "closed"
  | "idle";

/**
 * 手作業の代表状態（#4426）と前提条件の待ちから、共通の現在地を決める。
 * 本人の操作待ち・完了・失敗は、依存待ちより優先する（質問が出ているのに「待機中」と言わない）。
 */
export function resolveWorkStatus(input: {
  phase: ManualStepPhase | null;
  blockingCount: number;
  sessionRunning: boolean;
  questionPending: boolean;
  isOpen: boolean;
}): WorkStatus {
  const { phase, blockingCount, sessionRunning, questionPending, isOpen } = input;
  if (phase === "done") return "done";
  if (phase === "closed") return "closed";
  if (!isOpen) return "done";
  if (phase === "user_action" || questionPending) return "user_action";
  if (phase === "verify_failed" || phase === "ai_stopped") return "failed";
  if (blockingCount > 0) return "dependency_wait";
  if (phase === "ai_verifying") return "ai_verifying";
  if (phase === "ai_working" || sessionRunning) return "running";
  return "idle";
}
