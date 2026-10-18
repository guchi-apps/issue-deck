import type { RefObservation } from "@/lib/parent-run/decide";
import { formatRef, refKey, type PlanChild, type PlanIssueRef, type PlanSnapshot, type ReleaseGate } from "@/lib/execution-plan/types";

/**
 * 作業Issueの依存条件とリリースの接続（#4523）。副作用を持たない純関数だけを置く。
 *
 * **新しいリリース機構は作らない。** 既存の候補（`ReleaseCandidate.frozenPrs`）・マージ関門
 * （`evaluateReleaseMergeGate`）へ、実行計画の`timing`（pre-release / post-release / independent）から
 * 導いた「公開前に終わっていない前提」を渡すだけにする。
 *
 * - Issueのクローズだけでは成立としない。PRを持たない作業（環境設定など）は、クローズに加えて
 *   作業の検証結果（`verifiedAt`）が記録されたときだけ成立とする
 * - 取得失敗・曖昧（PRが複数など）は成立とも未成立とも言わず、`unknown`として止める
 * - 検証後にIssueが再オープンされた場合の記録は古い証跡として成功と扱わない
 */

/** 観測の結果、公開前の前提が満たされているか。`unknown`は取得失敗・曖昧で、成立とは扱わない */
export type PrerequisiteState = "satisfied" | "pending" | "unknown";

export type PrerequisiteJudgement = { state: PrerequisiteState; reason: string; next: string };

/** PRを持たない作業か（Issueの実装PRが無い＝環境設定・確認などのコード外の作業） */
function hasNoPr(obs: RefObservation): boolean {
  return obs.pr.kind === "none";
}

/**
 * `pre-release`の子1件が、候補の公開前に必要な状態まで進んだかを判定する。
 * - 実装PRを持つ子: PRが統合ブランチ（develop）へマージ済みなら成立（候補の対象に含まれる）
 * - PRを持たない子: クローズ済み**かつ**検証結果が記録されているときだけ成立
 */
export function judgePreReleaseChild(
  child: PlanChild,
  obs: RefObservation,
  verifiedAt: Date | null,
): PrerequisiteJudgement {
  const ref = formatRef(child);
  if (obs.issue === "error") {
    return { state: "unknown", reason: `${ref}の状態を取得できません（${obs.error ?? "不明"}）`, next: "取得できるまで待つか、接続・権限を確認する" };
  }
  if (obs.issue === "missing") {
    return { state: "unknown", reason: `${ref}が見つかりません`, next: "実行計画から外すか、正しいIssueへ差し替える" };
  }
  const pr = obs.pr;
  if (pr.kind === "error") {
    return { state: "unknown", reason: `${ref}の実装PRを確認できません（${pr.message}）`, next: "取得できるまで待つ" };
  }
  if (pr.kind === "many") {
    return { state: "unknown", reason: `${ref}の実装PRが複数あります（${pr.numbers.map((n) => `#${n}`).join(", ")}）`, next: "対象のPRを1つに絞る" };
  }
  if (pr.kind === "one") {
    if (!pr.merged) return { state: "pending", reason: `${ref}のPR #${pr.number}がまだマージされていません`, next: `PR #${pr.number}をdevelopへマージする` };
    if (pr.integration === undefined) {
      return { state: "unknown", reason: `${ref}のPR #${pr.number}のマージ先が統合ブランチか確認できません`, next: "取得できるまで待つ" };
    }
    if (!pr.integration) {
      return { state: "pending", reason: `${ref}のPR #${pr.number}は統合ブランチ（develop）以外へのマージです`, next: "developへ反映する" };
    }
    return { state: "satisfied", reason: `${ref}のPR #${pr.number}がdevelopへマージ済み`, next: "" };
  }
  // PRなし: クローズ＋検証結果の記録
  if (obs.issue === "open") {
    return verifiedAt
      ? { state: "pending", reason: `${ref}は検証結果が記録されていますが、Issueが再オープンされています（古い証跡は使いません）`, next: "作業をやり直して検証結果を記録し直す" }
      : { state: "pending", reason: `${ref}の作業が完了していません`, next: "作業を実施し、完了後に検証する" };
  }
  if (!verifiedAt) {
    return { state: "pending", reason: `${ref}はクローズ済みですが、作業の検証結果が記録されていません（クローズだけでは成立としません）`, next: "作業の検証を行い、結果を記録する" };
  }
  return { state: "satisfied", reason: `${ref}は完了し、検証結果が記録されています`, next: "" };
}

/**
 * `post-release`などPRを持たない作業が、検証まで終わっているか。親の完了判定に使う。
 * クローズだけでは完了としない。
 */
export function isNonCodeWorkVerified(obs: RefObservation, verifiedAt: Date | null): boolean {
  return obs.pr.kind === "none" && obs.issue === "closed" && verifiedAt !== null;
}

/** タイミングが指定された、PRを持たない作業（環境設定・確認など）か */
export function isTimedNonCodeWork(child: PlanChild, obs: RefObservation): boolean {
  return child.timing !== undefined && hasNoPr(obs);
}

export type ReleasePrerequisiteBlocker = {
  ref: string;
  title: string | null;
  gate: ReleaseGate;
  state: Exclude<PrerequisiteState, "satisfied">;
  /** 何が止めているか */
  reason: string;
  /** 次に行うこと */
  next: string;
  /** どの親の計画に由来するか */
  parent: string;
};

export type PlanForRelease = {
  parent: PlanIssueRef;
  plan: PlanSnapshot;
  /** 子（`refKey`）ごとの検証結果の記録時刻 */
  verifiedAt: Map<string, Date | null>;
};

/**
 * 候補の公開前に終わっていない`pre-release`の前提を返す。
 *
 * 対応付けは**候補に含まれる機能（実装PRが`candidatePrNumbers`にある子）を持つ計画だけ**。含まれない計画
 * （無関係なIssue・別機能）は関門に混ぜない。前提そのものは他リポジトリのIssueでもよい
 * （候補のリポジトリに現れないことを、無関係の根拠にしない）。
 */
export function evaluateReleasePrerequisites(input: {
  candidateRepository: string;
  candidatePrNumbers: readonly number[];
  plans: readonly PlanForRelease[];
  observations: ReadonlyMap<string, RefObservation>;
}): ReleasePrerequisiteBlocker[] {
  const inCandidate = new Set(input.candidatePrNumbers);
  const blockers: ReleasePrerequisiteBlocker[] = [];
  for (const entry of input.plans) {
    const hasFeatureInCandidate = entry.plan.children.some((child) => {
      if (child.timing === "independent" || child.timing === "pre-release") return false;
      if (child.repository !== input.candidateRepository) return false;
      const obs = input.observations.get(refKey(child));
      return obs?.pr.kind === "one" && inCandidate.has(obs.pr.number);
    });
    if (!hasFeatureInCandidate) continue;
    for (const child of entry.plan.children) {
      if (child.timing !== "pre-release") continue;
      const key = refKey(child);
      const obs = input.observations.get(key);
      const judgement: PrerequisiteJudgement = obs
        ? judgePreReleaseChild(child, obs, entry.verifiedAt.get(key) ?? null)
        : { state: "unknown", reason: `${key}を観測できていません`, next: "取得できるまで待つ" };
      if (judgement.state === "satisfied") continue;
      blockers.push({
        ref: key,
        title: child.title ?? null,
        gate: child.gate ?? "merge",
        state: judgement.state,
        reason: judgement.reason,
        next: judgement.next,
        parent: formatRef(entry.parent),
      });
    }
  }
  return blockers;
}

export type ReleaseCycle = {
  /** `A → B → リリース → A`の経路 */
  path: string[];
  /** 根拠 */
  reason: string;
  /** 直すべき依存 */
  fix: string;
};

const PRODUCTION_CONDITIONS = ["released", "verified"] as const;

/**
 * 循環を探す。**リリース前に必須の作業（`pre-release`と、それが依存する子）が、本番反映・本番検証
 * （`released`/`verified`）の成立を待っていると、リリースを止める前提がリリースを待つ**ことになる。
 * 待ち先が`independent`（リリースと無関係）なら循環にならない。計画外の参照は判断できないので対象にしない。
 */
export function findReleaseCycles(children: readonly PlanChild[]): ReleaseCycle[] {
  const byKey = new Map(children.map((c) => [refKey(c), c]));
  const cycles: ReleaseCycle[] = [];
  const reported = new Set<string>();
  for (const root of children) {
    if (root.timing !== "pre-release") continue;
    const rootKey = refKey(root);
    // rootから依存先をたどる（子の間の辺だけ）
    const seen = new Set<string>([rootKey]);
    const queue: { child: PlanChild; trail: string[] }[] = [{ child: root, trail: [rootKey] }];
    while (queue.length > 0) {
      const { child, trail } = queue.shift() as { child: PlanChild; trail: string[] };
      for (const dep of child.dependsOn) {
        const depKey = refKey(dep);
        const target = byKey.get(depKey);
        if (!target) continue;
        const needsProduction = dep.conditions.some((c) => (PRODUCTION_CONDITIONS as readonly string[]).includes(c));
        if (needsProduction && target.timing !== "independent") {
          const id = `${refKey(child)}->${depKey}`;
          if (!reported.has(id)) {
            reported.add(id);
            cycles.push({
              path: [...trail, depKey, "リリース", rootKey],
              reason: `${rootKey}はリリース前に必須ですが、${refKey(child)}が${depKey}の本番反映（${dep.conditions.join("/")}）を待っています。本番反映はリリースの後にしか成立しません`,
              fix: `${refKey(child)}から${depKey}への依存条件を\`merged\`に改めるか、${refKey(child)}を\`post-release\`にしてください`,
            });
          }
          continue;
        }
        if (!seen.has(depKey)) {
          seen.add(depKey);
          queue.push({ child: target, trail: [...trail, depKey] });
        }
      }
    }
  }
  return cycles;
}
