import type { DependencyWaitCondition } from "@/lib/dispatch/dependency-wait";

/**
 * 親子Issueの実行計画（#4535）の共通形式。
 *
 * **完了条件の語彙は#4321の`closed/merged/released/verified`をそのまま使う**（二重の完了定義を作らない）。
 * Issueのクローズ・PR作成・developへのマージ・本番反映・検証成功は別の条件で、前者が成立しても
 * 後者を満たしたとはみなさない。
 */

/** 子Issueの参照。**常に`owner/repo`と番号の組**で、番号だけで別リポジトリを指さない */
export type PlanIssueRef = { repository: string; number: number };

export type PlanDependency = PlanIssueRef & {
  /** この依存先がどうなれば進めてよいか（全部成立で成立） */
  conditions: DependencyWaitCondition[];
};

export type PlanChild = PlanIssueRef & {
  /** 画面・本文用の短い説明（任意。構造の判断には使わない） */
  title?: string;
  dependsOn: PlanDependency[];
};

export type PlanSnapshot = {
  /** 親の目的 */
  objective: string;
  /** 親全体の完了条件（子のクローズ・PR作成では満たされない） */
  completionCriteria: string[];
  children: PlanChild[];
};

export type PlanIssue = { path: string; message: string };

export function formatRef(ref: PlanIssueRef): string {
  return `${ref.repository}#${ref.number}`;
}

export function refKey(ref: PlanIssueRef): string {
  return formatRef(ref);
}
