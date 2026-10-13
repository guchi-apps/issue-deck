/**
 * Slack・Chat共通の親子Issue起案（#4537）の型。
 *
 * 子の参照は常に`owner/repo`と番号の組で持つ（番号だけで別リポジトリを指さない）。
 * 条件の語彙は#4321/#4535の`closed/merged/released/verified`をそのまま使い、ここでは定義し直さない。
 */

export const EPIC_MAX_CHILDREN = 5;

export type EpicCondition = "closed" | "merged" | "released" | "verified";
export const EPIC_CONDITIONS: readonly EpicCondition[] = ["closed", "merged", "released", "verified"];

export type EpicDependency = {
  /** 依存先の子の`key` */
  key: string;
  conditions: EpicCondition[];
};

export type EpicChildDraft = {
  /** 案の中で一意な安定キー（`c1`など）。再開時の照合識別子になる */
  key: string;
  repo: string;
  title: string;
  /** 独立した要件と観測可能な完了条件 */
  body: string;
  /** 同じ成果の既存Issueがあるとき、新規作成せずこの番号を再利用する */
  existing?: number;
  dependsOn: EpicDependency[];
};

export type EpicDraft = {
  parent: {
    repo: string;
    title: string;
    objective: string;
    completionCriteria: string[];
    scope: string;
  };
  children: EpicChildDraft[];
};

export type EpicIssueRef = { repo: string; number: number };

/** 作成の途中経過。再開時は照合し直すので、ここは報告用 */
export type EpicProgress = {
  parent: (EpicIssueRef & { id: number }) | null;
  children: Record<string, (EpicIssueRef & { id: number; reused: boolean }) | undefined>;
};

export type EpicStage = "reconcile" | "parent" | "children" | "link" | "body" | "plan";

export type EpicOutcome =
  | { ok: true; progress: EpicProgress; stages: string[][]; planVersion: number }
  | { ok: false; stage: EpicStage; message: string; progress: EpicProgress };
