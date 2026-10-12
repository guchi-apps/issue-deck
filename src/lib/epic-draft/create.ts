import { computeEpicStages } from "@/lib/epic-draft/decompose";
import type {
  EpicChildDraft,
  EpicDraft,
  EpicIssueRef,
  EpicOutcome,
  EpicProgress,
  EpicStage,
} from "@/lib/epic-draft/types";

/** GitHub側の既存Issue（照合用）。`state`はopen/closedの両方を含める */
export type EpicGithubIssue = { number: number; id: number; state: "open" | "closed"; body: string | null };

/**
 * 作成に使うGitHub操作。**取得系が失敗したときは投げる**こと（「存在しない」と区別するため）。
 * 実装は`github.ts`（依頼者のトークン）。テストでは差し替える。
 */
export type EpicGithub = {
  listIssues(repo: string): Promise<EpicGithubIssue[]>;
  createIssue(repo: string, input: { title: string; body: string }): Promise<{ number: number; id: number }>;
  updateBody(repo: string, number: number, body: string): Promise<void>;
  listSubIssues(repo: string, number: number): Promise<EpicIssueRef[]>;
  addSubIssue(parent: EpicIssueRef, childId: number): Promise<void>;
};

export type EpicPlanInput = {
  parent: EpicIssueRef;
  objective: string;
  completionCriteria: string[];
  children: { repo: string; number: number; dependsOn: { repo: string; number: number; conditions: string[] }[] }[];
  changeNote: string;
};

/**
 * 計画の登録（#4535）。**同じ親へ同じ内容の再登録は成功として扱う（冪等）**こと。
 * `section`は#4535が親本文へ入れる節で、あれば最終本文の末尾へ足す。
 */
export type EpicPlanRegistrar = (input: EpicPlanInput) => Promise<{ ok: true; version: number; section?: string } | { ok: false; message: string }>;

export type EpicCreateParams = {
  /** 依頼の識別子（Slackなら依頼ID、Chatなら会話ID+カード）。単位キーと組で本文へ残す */
  requestKey: string;
  draft: EpicDraft;
  /** 本文末尾へ足す依頼元の情報（Slackの元投稿リンクなど） */
  footer?: string;
};

export function unitMarker(requestKey: string, unit: string): string {
  return `<!-- epic-unit: ${requestKey}/${unit} -->`;
}

function findByMarker(issues: EpicGithubIssue[], marker: string): EpicGithubIssue | null {
  const matches = issues.filter((i) => i.body?.includes(marker));
  if (matches.length > 1) throw new Error(`同じ作成単位に複数のIssueが対応しています（${marker}）`);
  return matches[0] ?? null;
}

const ref = (r: EpicIssueRef) => `${r.repo}#${r.number}`;

function parentBody(params: EpicCreateParams, children: { draft: EpicChildDraft; ref: EpicIssueRef | null }[] | null): string {
  const { draft, requestKey, footer } = params;
  const { parent } = draft;
  const lines = [
    "## 目的",
    parent.objective,
    "",
    "## 範囲",
    parent.scope || "（子Issueの範囲に従う）",
    "",
    "## 全体完了条件",
    ...parent.completionCriteria.map((c) => `- [ ] ${c}`),
    "",
    "子Issueのクローズ・PR作成だけでは親の完了条件を満たしたことにはなりません。",
  ];
  if (children) {
    const stages = computeEpicStages(draft.children) ?? [];
    lines.push("", "## 子Issueと実行順序");
    stages.forEach((keys, i) => {
      lines.push(`${i + 1}. ${keys.length > 1 ? "（並行可）" : ""}`);
      for (const key of keys) {
        const c = children.find((x) => x.draft.key === key);
        if (!c?.ref) continue;
        const deps = c.draft.dependsOn
          .map((d) => {
            const t = children.find((x) => x.draft.key === d.key)?.ref;
            return t ? `${ref(t)} が ${d.conditions.join("・")}` : "";
          })
          .filter(Boolean);
        lines.push(`   - ${ref(c.ref)} ${c.draft.title}${deps.length ? `（進む条件: ${deps.join("、")}）` : ""}`);
      }
    });
    lines.push("", "子は自動では実装を開始しません。親から実行を開始してください。");
  }
  if (footer) lines.push("", "---", footer);
  lines.push(unitMarker(requestKey, "parent"));
  return lines.join("\n");
}

function childBody(params: EpicCreateParams, child: EpicChildDraft, parentRef: EpicIssueRef): string {
  const parts = [child.body, "", `親Issue: ${ref(parentRef)}`];
  if (params.footer) parts.push("", "---", params.footer);
  parts.push(unitMarker(params.requestKey, child.key));
  return parts.join("\n");
}

/**
 * 親子Issueを作る。**何度呼んでも不足分だけ作る**（GitHub側の本文の`epic-unit`識別子で照合する）。
 * - 取得に失敗したrepoは未作成と解釈せず、`reconcile`段階で止める（再作成しない）
 * - 既存Issue（`existing`）は再利用し、本文は書き換えない（担当範囲を広げない）
 * - 紐付け・計画登録・本文の最終化が失敗したら、`ok: false`と失敗段階を返す（完了とは言わない）
 */
export async function createEpic(
  params: EpicCreateParams,
  github: EpicGithub,
  registerPlan: EpicPlanRegistrar,
): Promise<EpicOutcome> {
  const { draft, requestKey } = params;
  const progress: EpicProgress = { parent: null, children: {} };
  const fail = (stage: EpicStage, error: unknown): EpicOutcome => ({
    ok: false,
    stage,
    message: error instanceof Error ? error.message : String(error),
    progress,
  });

  // 1. 照合: 親と子のrepoごとに、open/closedの両方を引く
  const repos = [...new Set([draft.parent.repo, ...draft.children.map((c) => c.repo)])];
  const listed = new Map<string, EpicGithubIssue[]>();
  try {
    for (const repo of repos) listed.set(repo, await github.listIssues(repo));
  } catch (error) {
    return fail("reconcile", error);
  }

  // 2. 親
  try {
    const marker = unitMarker(requestKey, "parent");
    let found = findByMarker(listed.get(draft.parent.repo) ?? [], marker);
    if (!found) {
      const created = await github.createIssue(draft.parent.repo, { title: draft.parent.title, body: parentBody(params, null) });
      found = { ...created, state: "open", body: marker };
    }
    progress.parent = { repo: draft.parent.repo, number: found.number, id: found.id };
  } catch (error) {
    return fail("parent", error);
  }
  const parentRef: EpicIssueRef = { repo: progress.parent.repo, number: progress.parent.number };

  // 3. 子（作成済み・再利用を除いて作る）
  for (const child of draft.children) {
    try {
      const issues = listed.get(child.repo) ?? [];
      if (child.existing) {
        const existing = issues.find((i) => i.number === child.existing);
        if (!existing) throw new Error(`再利用する ${child.repo}#${child.existing} が見つかりません`);
        progress.children[child.key] = { repo: child.repo, number: existing.number, id: existing.id, reused: true };
        continue;
      }
      let found = findByMarker(issues, unitMarker(requestKey, child.key));
      if (!found) {
        const created = await github.createIssue(child.repo, { title: child.title, body: childBody(params, child, parentRef) });
        found = { ...created, state: "open", body: null };
      }
      progress.children[child.key] = { repo: child.repo, number: found.number, id: found.id, reused: false };
    } catch (error) {
      return fail("children", error);
    }
  }
  const resolved = draft.children.map((c) => ({ draft: c, ref: progress.children[c.key] ?? null }));

  // 4. GitHubの親子関係
  try {
    const linked = await github.listSubIssues(parentRef.repo, parentRef.number);
    for (const c of resolved) {
      const r = progress.children[c.draft.key];
      if (!r) continue;
      if (linked.some((l) => l.repo === r.repo && l.number === r.number)) continue;
      await github.addSubIssue(parentRef, r.id);
    }
  } catch (error) {
    return fail("link", error);
  }

  // 5. 構造化計画（#4535）。失敗したら完了にしない
  const stages = computeEpicStages(draft.children) ?? [];
  const planInput: EpicPlanInput = {
    parent: parentRef,
    objective: draft.parent.objective,
    completionCriteria: draft.parent.completionCriteria,
    children: draft.children.map((c) => ({
      repo: progress.children[c.key]!.repo,
      number: progress.children[c.key]!.number,
      dependsOn: c.dependsOn.map((d) => ({
        repo: progress.children[d.key]!.repo,
        number: progress.children[d.key]!.number,
        conditions: d.conditions,
      })),
    })),
    changeNote: "起案時の初回登録",
  };
  let planVersion: number;
  let section = "";
  try {
    const result = await registerPlan(planInput);
    if (!result.ok) return fail("plan", result.message);
    planVersion = result.version;
    section = result.section ?? "";
  } catch (error) {
    return fail("plan", error);
  }

  // 6. 親本文の最終化（子のリンクと順序）。すでに同じなら更新しない
  try {
    const desired = [parentBody(params, resolved), section].filter(Boolean).join("\n\n");
    const current = (await github.listIssues(parentRef.repo)).find((i) => i.number === parentRef.number);
    if (!current) throw new Error("親Issueを再取得できません");
    if ((current.body ?? "") !== desired) await github.updateBody(parentRef.repo, parentRef.number, desired);
  } catch (error) {
    return fail("body", error);
  }

  return { ok: true, progress, stages, planVersion };
}
