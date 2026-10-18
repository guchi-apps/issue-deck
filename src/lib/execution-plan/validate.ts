import { DEPENDENCY_WAIT_CONDITIONS, type DependencyWaitCondition } from "@/lib/dispatch/dependency-wait";
import { findReleaseCycles } from "@/lib/execution-plan/release-link";
import {
  RELEASE_GATES,
  RELEASE_TIMINGS,
  type ReleaseGate,
  type ReleaseTiming,
  formatRef,
  refKey,
  type PlanChild,
  type PlanDependency,
  type PlanIssue,
  type PlanIssueRef,
  type PlanSnapshot,
} from "@/lib/execution-plan/types";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_CHILDREN = 50;
const MAX_CRITERIA = 20;
const MAX_TEXT = 500;

export type ParseResult =
  | { ok: true; plan: PlanSnapshot }
  | { ok: false; errors: PlanIssue[] };

function parseRef(value: unknown, path: string, errors: PlanIssue[]): PlanIssueRef | null {
  if (!value || typeof value !== "object") {
    errors.push({ path, message: "`repository`（owner/repo）と`number`を持つオブジェクトで指定してください" });
    return null;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.repository !== "string" || !REPOSITORY_PATTERN.test(v.repository)) {
    errors.push({ path: `${path}.repository`, message: "`owner/repo`形式で指定してください（番号だけでは別リポジトリと区別できません）" });
    return null;
  }
  if (typeof v.number !== "number" || !Number.isInteger(v.number) || v.number < 1) {
    errors.push({ path: `${path}.number`, message: "1以上の整数で指定してください" });
    return null;
  }
  return { repository: v.repository, number: v.number };
}

function parseText(value: unknown, path: string, errors: PlanIssue[]): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    errors.push({ path, message: "空にできません" });
    return null;
  }
  if (text.length > MAX_TEXT) {
    errors.push({ path, message: `${MAX_TEXT}文字以内にしてください` });
    return null;
  }
  return text;
}

function parseDependency(value: unknown, path: string, errors: PlanIssue[]): PlanDependency | null {
  const ref = parseRef(value, path, errors);
  if (!ref) return null;
  const raw = (value as Record<string, unknown>).conditions;
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push({ path: `${path}.conditions`, message: `条件が必要です（${DEPENDENCY_WAIT_CONDITIONS.join(" / ")}）。省略を「完了」と解釈しません` });
    return null;
  }
  const conditions: DependencyWaitCondition[] = [];
  for (const [i, c] of raw.entries()) {
    if (typeof c !== "string" || !(DEPENDENCY_WAIT_CONDITIONS as readonly string[]).includes(c)) {
      errors.push({ path: `${path}.conditions[${i}]`, message: `不正な条件です: ${String(c)}（${DEPENDENCY_WAIT_CONDITIONS.join(" / ")}）` });
      return null;
    }
    if (!conditions.includes(c as DependencyWaitCondition)) conditions.push(c as DependencyWaitCondition);
  }
  return { ...ref, conditions };
}

/** 依存の循環を探す。見つかれば`A → B → A`の経路を返す（子の間の辺だけが対象） */
export function findDependencyCycle(children: readonly PlanChild[]): string[] | null {
  const byKey = new Map(children.map((c) => [refKey(c), c]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (key: string): string[] | null => {
    state.set(key, 1);
    stack.push(key);
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      const next = refKey(dep);
      if (!byKey.has(next)) continue;
      if (state.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(key, 2);
    return null;
  };
  for (const key of byKey.keys()) {
    if (!state.has(key)) {
      const found = visit(key);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 入力を検証して`PlanSnapshot`へ正規化する（IOなし）。**1つでも問題があれば計画を返さず、全ての問題を列挙する。**
 * 存在確認・権限・GitHubとの対応は`register.ts`が行う。
 */
export function parsePlanInput(payload: unknown, parent: PlanIssueRef): ParseResult {
  const errors: PlanIssue[] = [];
  if (!payload || typeof payload !== "object") {
    return { ok: false, errors: [{ path: "", message: "計画はオブジェクトで指定してください" }] };
  }
  const p = payload as Record<string, unknown>;
  const objective = parseText(p.objective, "objective", errors);

  const criteria: string[] = [];
  if (!Array.isArray(p.completionCriteria) || p.completionCriteria.length === 0) {
    errors.push({ path: "completionCriteria", message: "親全体の完了条件が1件以上必要です" });
  } else if (p.completionCriteria.length > MAX_CRITERIA) {
    errors.push({ path: "completionCriteria", message: `${MAX_CRITERIA}件以内にしてください` });
  } else {
    for (const [i, c] of p.completionCriteria.entries()) {
      const text = parseText(c, `completionCriteria[${i}]`, errors);
      if (text) criteria.push(text);
    }
  }

  const children: PlanChild[] = [];
  if (!Array.isArray(p.children) || p.children.length === 0) {
    errors.push({ path: "children", message: "子Issueが1件以上必要です" });
  } else if (p.children.length > MAX_CHILDREN) {
    errors.push({ path: "children", message: `${MAX_CHILDREN}件以内にしてください` });
  } else {
    const seen = new Set<string>();
    for (const [i, raw] of p.children.entries()) {
      const path = `children[${i}]`;
      const ref = parseRef(raw, path, errors);
      if (!ref) continue;
      const key = refKey(ref);
      if (key === refKey(parent)) {
        errors.push({ path, message: `親Issue（${key}）を子にはできません` });
        continue;
      }
      if (seen.has(key)) {
        errors.push({ path, message: `子Issue ${key}が重複しています` });
        continue;
      }
      seen.add(key);
      const r = raw as Record<string, unknown>;
      const dependsOn: PlanDependency[] = [];
      const rawDeps = r.dependsOn ?? [];
      if (!Array.isArray(rawDeps)) {
        errors.push({ path: `${path}.dependsOn`, message: "配列で指定してください" });
        continue;
      }
      const depKeys = new Set<string>();
      for (const [j, d] of rawDeps.entries()) {
        const dep = parseDependency(d, `${path}.dependsOn[${j}]`, errors);
        if (!dep) continue;
        const depKey = refKey(dep);
        if (depKey === key) {
          errors.push({ path: `${path}.dependsOn[${j}]`, message: `${key}が自分自身に依存しています` });
          continue;
        }
        if (depKeys.has(depKey)) {
          errors.push({ path: `${path}.dependsOn[${j}]`, message: `依存先 ${depKey}が重複しています（条件は1件にまとめてください）` });
          continue;
        }
        depKeys.add(depKey);
        dependsOn.push(dep);
      }
      let timing: ReleaseTiming | undefined;
      if (r.timing !== undefined) {
        if (typeof r.timing !== "string" || !(RELEASE_TIMINGS as readonly string[]).includes(r.timing)) {
          errors.push({ path: `${path}.timing`, message: `不正なリリース区分です（${RELEASE_TIMINGS.join(" / ")}）` });
          continue;
        }
        timing = r.timing as ReleaseTiming;
      }
      let gate: ReleaseGate | undefined;
      if (r.gate !== undefined) {
        if (timing !== "pre-release") {
          errors.push({ path: `${path}.gate`, message: "止める工程（gate）は区分が`pre-release`のときだけ指定できます" });
          continue;
        }
        if (typeof r.gate !== "string" || !(RELEASE_GATES as readonly string[]).includes(r.gate)) {
          errors.push({ path: `${path}.gate`, message: `不正な工程です（${RELEASE_GATES.join(" / ")}）` });
          continue;
        }
        gate = r.gate as ReleaseGate;
      }
      const title = typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 200) : undefined;
      children.push({ ...ref, ...(title ? { title } : {}), ...(timing ? { timing } : {}), ...(gate ? { gate } : {}), dependsOn });
    }
  }

  if (errors.length === 0) {
    const cycle = findDependencyCycle(children);
    if (cycle) {
      errors.push({
        path: "children",
        message: `依存が循環しています: ${cycle.join(" → ")}。どれかの依存を外してください`,
      });
    }
  }
  if (errors.length === 0) {
    for (const cycle of findReleaseCycles(children)) {
      errors.push({
        path: "children",
        message: `リリース前に必須の作業が、リリース後にしか成立しない条件を待っています: ${cycle.path.join(" → ")}。${cycle.fix}`,
      });
    }
  }
  if (errors.length > 0 || !objective) return { ok: false, errors };
  return { ok: true, plan: { objective, completionCriteria: criteria, children } };
}

/**
 * 実行の段（並行可能な範囲）。同じ段の子は互いに依存せず並行できる。
 * 子の間の依存だけで決め、子以外への依存（外部の前提）は段を押し下げない。
 */
export function computeStages(plan: PlanSnapshot): PlanChild[][] {
  const byKey = new Map(plan.children.map((c) => [refKey(c), c]));
  const level = new Map<string, number>();
  const levelOf = (child: PlanChild): number => {
    const key = refKey(child);
    const cached = level.get(key);
    if (cached !== undefined) return cached;
    level.set(key, 0); // 循環は`parsePlanInput`で排除済み。再入の保険
    let max = 0;
    for (const dep of child.dependsOn) {
      const target = byKey.get(refKey(dep));
      if (target) max = Math.max(max, levelOf(target) + 1);
    }
    level.set(key, max);
    return max;
  };
  const stages: PlanChild[][] = [];
  for (const child of plan.children) (stages[levelOf(child)] ??= []).push(child);
  return stages;
}

export function describeDependency(dep: PlanDependency): string {
  return `${formatRef(dep)}（${dep.conditions.join("+")}）`;
}
