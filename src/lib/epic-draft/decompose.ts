import {
  EPIC_CONDITIONS,
  EPIC_MAX_CHILDREN,
  type EpicChildDraft,
  type EpicCondition,
  type EpicDraft,
} from "@/lib/epic-draft/types";

/**
 * AIが返した親子案（JSON文字列）を型付きの案へ読む。**読めない・足りない場合は`null`**で、
 * 呼び出し側は親子を作らず従来の単一Issue／失敗報告に倒す（定型の空Epicは作らない）。
 */
export function parseEpicDraft(json: string): EpicDraft | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const parent = r.parent as Record<string, unknown> | undefined;
  if (!parent || typeof parent !== "object" || !Array.isArray(r.children)) return null;
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const children: EpicChildDraft[] = [];
  for (const c of r.children as unknown[]) {
    if (!c || typeof c !== "object") return null;
    const o = c as Record<string, unknown>;
    const deps = Array.isArray(o.dependsOn) ? o.dependsOn : [];
    children.push({
      key: s(o.key, 20),
      repo: s(o.repo, 200),
      title: s(o.title, 200),
      body: s(o.body, 6000),
      ...(typeof o.existing === "number" && Number.isInteger(o.existing) && o.existing > 0 ? { existing: o.existing } : {}),
      dependsOn: deps.map((d) => {
        const dd = (d ?? {}) as Record<string, unknown>;
        return {
          key: s(dd.key, 20),
          conditions: (Array.isArray(dd.conditions) ? dd.conditions : []).filter(
            (x): x is EpicCondition => typeof x === "string" && (EPIC_CONDITIONS as readonly string[]).includes(x),
          ),
        };
      }),
    });
  }
  return {
    parent: {
      repo: s(parent.repo, 200),
      title: s(parent.title, 200),
      objective: s(parent.objective, 2000),
      completionCriteria: (Array.isArray(parent.completionCriteria) ? parent.completionCriteria : [])
        .filter((x): x is string => typeof x === "string" && x.trim() !== "")
        .map((x) => x.trim().slice(0, 300))
        .slice(0, 10),
      scope: s(parent.scope, 2000),
    },
    children,
  };
}

/**
 * 案を作成前に検証する。1つでも問題があれば作らない（全部を返す）。
 * `canUseRepo`は権限内（接続済みかつ依頼者が使える）か。親と子のrepoごとに通す。
 */
export function validateEpicDraft(draft: EpicDraft, canUseRepo: (repo: string) => boolean): string[] {
  const errors: string[] = [];
  const { parent, children } = draft;
  if (!parent.title || !parent.objective) errors.push("親のタイトルと目的が必要です");
  if (parent.completionCriteria.length === 0) errors.push("親の全体完了条件が必要です");
  if (children.length < 2) errors.push("子が2件未満です（分割が必要な依頼ではありません）");
  if (children.length > EPIC_MAX_CHILDREN) errors.push(`子が${EPIC_MAX_CHILDREN}件を超えています（${children.length}件）。範囲を絞ってください`);
  if (!canUseRepo(parent.repo)) errors.push(`${parent.repo || "親の対象"} は権限内のリポジトリではありません`);
  const keys = new Set<string>();
  for (const c of children) {
    if (!c.key) errors.push("キーのない子があります");
    else if (keys.has(c.key)) errors.push(`子のキー ${c.key} が重複しています`);
    keys.add(c.key);
    if (!c.title || !c.body) errors.push(`子 ${c.key}: タイトルと本文（要件・完了条件）が必要です`);
    if (!canUseRepo(c.repo)) errors.push(`子 ${c.key}: ${c.repo || "対象"} は権限内のリポジトリではありません`);
  }
  for (const c of children) {
    for (const d of c.dependsOn) {
      if (!keys.has(d.key)) errors.push(`子 ${c.key}: 存在しない依存先 ${d.key}`);
      else if (d.key === c.key) errors.push(`子 ${c.key}: 自分自身には依存できません`);
      if (d.conditions.length === 0) errors.push(`子 ${c.key}: 依存先 ${d.key} の条件がありません`);
    }
    if (new Set(c.dependsOn.map((d) => d.key)).size !== c.dependsOn.length) errors.push(`子 ${c.key}: 依存先が重複しています`);
  }
  if (errors.length === 0 && computeEpicStages(children) === null) errors.push("依存関係が循環しています");
  return errors;
}

/** 並行できる範囲ごとの段（キー）。循環があれば`null` */
export function computeEpicStages(children: EpicChildDraft[]): string[][] | null {
  const remaining = new Map(children.map((c) => [c.key, new Set(c.dependsOn.map((d) => d.key))]));
  const stages: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([k]) => k);
    if (ready.length === 0) return null;
    stages.push(ready);
    for (const k of ready) remaining.delete(k);
    for (const deps of remaining.values()) for (const k of ready) deps.delete(k);
  }
  return stages;
}
