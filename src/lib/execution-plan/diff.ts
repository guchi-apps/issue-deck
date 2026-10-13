import { refKey, type PlanChild, type PlanIssue, type PlanSnapshot } from "@/lib/execution-plan/types";

export type PlanDiff = {
  /** 新しい版で増えた子（追加対象。実行範囲に入れるかは明示して決める） */
  added: string[];
  /** 新しい版で外れた子 */
  removed: string[];
  /** 依存・条件が変わった子 */
  changed: string[];
  /** 変わらない子 */
  kept: string[];
  objectiveChanged: boolean;
  criteriaChanged: boolean;
};

const signature = (c: PlanChild) =>
  JSON.stringify(
    [...c.dependsOn]
      .map((d) => [refKey(d), [...d.conditions].sort()] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
  );

export function diffPlans(prev: PlanSnapshot, next: PlanSnapshot): PlanDiff {
  const before = new Map(prev.children.map((c) => [refKey(c), c]));
  const after = new Map(next.children.map((c) => [refKey(c), c]));
  const diff: PlanDiff = {
    added: [],
    removed: [],
    changed: [],
    kept: [],
    objectiveChanged: prev.objective !== next.objective,
    criteriaChanged: JSON.stringify(prev.completionCriteria) !== JSON.stringify(next.completionCriteria),
  };
  for (const [key, child] of after) {
    const old = before.get(key);
    if (!old) diff.added.push(key);
    else if (signature(old) !== signature(child)) diff.changed.push(key);
    else diff.kept.push(key);
  }
  for (const key of before.keys()) if (!after.has(key)) diff.removed.push(key);
  return diff;
}

/**
 * 再計画の検査。**完了済みの子は外せない**（成果を保持する）。
 * 稼働中（実行に結びつく版に含まれ、まだ完了していない）の子を外すときは、黙って外さず明示を求める。
 */
export function validateReplan(
  prev: PlanSnapshot,
  next: PlanSnapshot,
  options: { completed: ReadonlySet<string>; confirmRemove: ReadonlySet<string> },
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const { removed } = diffPlans(prev, next);
  for (const key of removed) {
    if (options.completed.has(key)) {
      issues.push({ path: "children", message: `${key}は完了済みの成果なので計画から外せません` });
    } else if (!options.confirmRemove.has(key)) {
      issues.push({ path: "children", message: `${key}を外すには、\`confirmRemove\`へ明示してください（黙って対象を減らしません）` });
    }
  }
  return issues;
}
