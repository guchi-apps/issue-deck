import type { EpicPlanInput, EpicPlanRegistrar } from "@/lib/epic-draft/create";
import { renderPlanBody } from "@/lib/execution-plan/body";
import { getPlanView, savePlan } from "@/lib/execution-plan/register";
import { refKey } from "@/lib/execution-plan/types";

type PlanShape = {
  objective: string;
  completionCriteria: string[];
  children: { repository: string; number: number; dependsOn: { repository: string; number: number; conditions: string[] }[] }[];
};

/**
 * 登録済みの計画が、これから登録する内容と同じか。子と依存・条件に加え、**親の目的・完了条件も比べる**
 * （違うまま成功にすると、親本文だけ新しい目的になり、実行制御が正とする計画は古いまま残る）。
 * 文字列は登録時の検証（`trim`）に揃えて比べる。完了条件は順序も意味を持つので並べ替えない
 */
function samePlan(registered: PlanShape, input: EpicPlanInput): boolean {
  const norm = (plan: PlanShape) =>
    JSON.stringify([
      plan.objective.trim(),
      plan.completionCriteria.map((c) => c.trim()),
      plan.children
        .map((c) => `${c.repository}#${c.number}<-${c.dependsOn.map((d) => `${d.repository}#${d.number}:${[...d.conditions].sort().join("+")}`).sort().join(",")}`)
        .sort(),
    ]);
  return (
    norm(registered) ===
    norm({
      objective: input.objective,
      completionCriteria: input.completionCriteria,
      children: input.children.map((c) => ({ repository: c.repo, number: c.number, dependsOn: c.dependsOn.map((d) => ({ repository: d.repo, number: d.number, conditions: d.conditions })) })),
    })
  );
}

/**
 * 実行計画の登録（#4535の`savePlan`）への接続。**同じ親へ同じ内容（目的・完了条件・子と依存）の再登録は成功**として扱う（再開で二重登録しない）。
 * 親に別内容の計画が既にあるときは上書きせず失敗にする（版管理は`PATCH`の再計画で行う）。
 */
export function getEpicPlanRegistrar(userId: string): EpicPlanRegistrar {
  return async (input) => {
    const parent = { repository: input.parent.repo, number: input.parent.number };
    const existing = await getPlanView(parent);
    if (existing) {
      if (!samePlan(existing.plan, input)) {
        return { ok: false, message: `${refKey(parent)} には別の内容の実行計画（v${existing.currentVersion}）が既にあります。再計画で更新してください` };
      }
      return { ok: true, version: existing.currentVersion, section: renderPlanBody(existing.plan, existing.currentVersion) };
    }
    const result = await savePlan({
      parent,
      author: userId,
      changeNote: input.changeNote,
      payload: {
        objective: input.objective,
        completionCriteria: input.completionCriteria,
        children: input.children.map((c) => ({
          repository: c.repo,
          number: c.number,
          dependsOn: c.dependsOn.map((d) => ({ repository: d.repo, number: d.number, conditions: d.conditions })),
        })),
      },
    });
    if (!result.ok) return { ok: false, message: result.errors.map((e) => `${e.path}: ${e.message}`).join(" / ").slice(0, 400) };
    return { ok: true, version: result.view.currentVersion, section: renderPlanBody(result.view.plan, result.view.currentVersion) };
  };
}
