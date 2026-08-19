import {
  describeIssueStage,
  extractExplicitPrerequisites,
  type ManualStepPrerequisite,
} from "@/lib/manual-step-prerequisites";
import type { Issue } from "@/types/issue";

/**
 * 逆向きの順序——**このIssueの完了を待っている相手**を集める（#2003）。
 *
 * 前提条件（`manual-step-prerequisites.ts`）は「自分が何を待つか」しか答えない。
 * `guchi-apps/subpc`の#39（停止したランナーを起こす手作業）のように、**自分が終わるまで
 * 何が止まっているのかを知りたい側**からは、番号を書いた相手の本文を開くまで分からなかった。
 *
 * 材料は前提条件と同じ本文テキストで、**画面がすでに持っているIssue一覧を走査するだけ**。
 * GitHub APIも`sub_issues`のWebhook購読も足していない。
 *
 * **辿るのは`## 前提条件`に書かれた前提だけ**で、`## 関連`の起点から補った前提は辿らない。
 * 手作業Issueは起点Issueへ紐付けて起票する決まり（CLAUDE.md）なので、起点まで辿ると
 * 「手作業Issueを持つ親Issueすべて」に、実際には待っていない相手が並んでしまう。
 * 親子の関係はIssue詳細の「子Issue」がすでに出している。
 */
export type IssueDependent = {
  /** 待っている側のIssue */
  id: string;
  repositoryFullName: string;
  number: number;
  title: string;
  htmlUrl: string;
  /** 待っている側がどこまで進んでいるか（前提条件の表示と同じ判定） */
  stage: ManualStepPrerequisite["stage"];
  label: string;
  stepIndex: ManualStepPrerequisite["stepIndex"];
  manualStep: boolean;
};

/**
 * `issue`を`## 前提条件`に挙げているIssueを集める。
 *
 * **クローズ済みのIssueは含めない。** もう待っていないものを並べると、実施の順番を確かめる
 * ための一覧が過去の履歴で埋まる。
 *
 * @param issue 待たれている側（いま開いているIssue）
 * @param issues 走査する母集団。絞り込み前の全Issueでよい
 */
export function computeIssueDependents(issue: Issue, issues: Issue[]): IssueDependent[] {
  const dependents: IssueDependent[] = [];

  for (const candidate of issues) {
    if (candidate.id === issue.id) continue;
    if (candidate.state !== "open") continue;

    const declares = extractExplicitPrerequisites(candidate).some(
      (reference) =>
        reference.repositoryFullName === issue.repositoryFullName &&
        reference.number === issue.number,
    );
    if (!declares) continue;

    const stage = describeIssueStage(candidate);
    dependents.push({
      id: candidate.id,
      repositoryFullName: candidate.repositoryFullName,
      number: candidate.number,
      title: candidate.title,
      htmlUrl: candidate.htmlUrl,
      stage: stage.stage,
      label: stage.label,
      stepIndex: stage.stepIndex,
      manualStep: stage.manualStep,
    });
  }

  // 進んでいるものほど先に出す（developまで来ているIssueは、待たせている影響が大きい）。
  // 同じ段階なら番号の小さい順で、開くたびに並びが変わらないようにする
  dependents.sort((a, b) => {
    if (a.stepIndex !== b.stepIndex) return (b.stepIndex ?? -1) - (a.stepIndex ?? -1);
    if (a.repositoryFullName !== b.repositoryFullName) {
      return a.repositoryFullName < b.repositoryFullName ? -1 : 1;
    }
    return a.number - b.number;
  });

  return dependents;
}

/**
 * 先頭に出す1行。**待たせている影響まで書く**——番号を並べるだけでは、実行者が
 * 「だから何を急ぐのか」を読み取れない。
 */
export function summarizeIssueDependents(
  dependents: IssueDependent[],
  repositoryFullName: string,
): string {
  if (dependents.length === 0) return "";
  const head = dependents[0];
  const prefix = head.repositoryFullName === repositoryFullName ? "" : head.repositoryFullName;
  const reference = `${prefix}#${head.number}`;
  const rest = dependents.length > 1 ? `ほか${dependents.length - 1}件` : "";
  return rest
    ? `このIssueが終わるまで ${reference} と${rest}は先へ進めません。`
    : `このIssueが終わるまで ${reference} は先へ進めません。`;
}
