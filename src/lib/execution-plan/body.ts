import { computeStages, describeDependency } from "@/lib/execution-plan/validate";
import { refKey, type PlanSnapshot } from "@/lib/execution-plan/types";

const START = (version: number) => `<!-- issue-deck:execution-plan:start v${version} -->`;
const END = "<!-- issue-deck:execution-plan:end -->";
const SECTION = /<!-- issue-deck:execution-plan:start v(\d+) -->([\s\S]*?)<!-- issue-deck:execution-plan:end -->/;

/** 親Issue本文へ入れる人向けの節。**正は構造化計画で、これは写し**（手で直しても実行は変わらない） */
export function renderPlanBody(plan: PlanSnapshot, version: number): string {
  const lines = [START(version), "## 実行計画", "", `**目的**: ${plan.objective}`, "", "**全体の完了条件**"];
  for (const c of plan.completionCriteria) lines.push(`- ${c}`);
  lines.push("", "**子Issueと実行順序**");
  computeStages(plan).forEach((stage, i) => {
    lines.push(`${i + 1}. ${stage.length > 1 ? "（並行可）" : ""}`);
    for (const child of stage) {
      const deps = child.dependsOn.length ? ` — 条件: ${child.dependsOn.map(describeDependency).join("、")}` : "";
      lines.push(`   - ${refKey(child)}${child.title ? ` ${child.title}` : ""}${deps}`);
    }
  });
  lines.push("", `_計画の版: v${version}（構造化計画が正。この節は自動生成）_`, END);
  return lines.join("\n");
}

export type BodyMismatch = { kind: "missing" | "version" | "children"; message: string };

/** 本文の節と構造化計画の不一致を検出する。一致なら空 */
export function detectBodyMismatch(body: string, plan: PlanSnapshot, version: number): BodyMismatch[] {
  const match = SECTION.exec(body);
  if (!match) return [{ kind: "missing", message: "本文に実行計画の節がありません" }];
  const out: BodyMismatch[] = [];
  if (Number(match[1]) !== version) {
    out.push({ kind: "version", message: `本文はv${match[1]}、構造化計画はv${version}です` });
  }
  const inBody = new Set([...match[2].matchAll(/^\s+- ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+)/gm)].map((m) => m[1]));
  const inPlan = new Set(plan.children.map(refKey));
  const missing = [...inPlan].filter((k) => !inBody.has(k));
  const extra = [...inBody].filter((k) => !inPlan.has(k));
  if (missing.length || extra.length) {
    out.push({
      kind: "children",
      message: `子Issueが一致しません（本文に無い: ${missing.join(", ") || "なし"} / 計画に無い: ${extra.join(", ") || "なし"}）`,
    });
  }
  return out;
}
