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

/**
 * 子の作業がリリースに対してどこに位置するか（#4523）。省略は従来どおり（リリースの関門に関与しない通常の子）。
 * - `pre-release`: 候補の公開（mainへのマージ）より前に完了している必要がある（環境設定など）
 * - `post-release`: 公開後に行う（本番確認など）。候補の公開は止めず、親の完了は止める
 * - `independent`: この機能のリリースと無関係。関門にも「本番反映」の完了判定にも混ぜない
 */
export const RELEASE_TIMINGS = ["pre-release", "post-release", "independent"] as const;
export type ReleaseTiming = (typeof RELEASE_TIMINGS)[number];

/** `pre-release`の子がどの工程を止めるか。`merge`＝候補のmainマージ前、`deploy`＝本番デプロイ前（マージがデプロイを起こすため、どちらもマージ前に判定する） */
export const RELEASE_GATES = ["merge", "deploy"] as const;
export type ReleaseGate = (typeof RELEASE_GATES)[number];

export type PlanChild = PlanIssueRef & {
  /** リリースとの前後関係（任意）。旧計画は未指定のまま動く */
  timing?: ReleaseTiming;
  /** `pre-release`のときだけ指定できる、止める工程（既定は`merge`） */
  gate?: ReleaseGate;
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
