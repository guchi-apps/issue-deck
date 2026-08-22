"use client";

import { IssueDependents } from "@/components/dashboard/issue-dependents";
import { IssueDetailSection } from "@/components/dashboard/issue-detail-section";
import { ManualStepPrerequisites } from "@/components/dashboard/manual-step-prerequisites";
import type { IssueDependent } from "@/lib/issue-dependents";
import type {
  ManualStepPrerequisite,
  ManualStepPrerequisiteSummary,
} from "@/lib/manual-step-prerequisites";

/**
 * 手作業Issue以外のIssue詳細に出す「実施順序」（#2003）。
 *
 * 中身は手作業Issueと同じ2つ——待っている相手（`ManualStepPrerequisites`）と、自分を待って
 * いる相手（`IssueDependents`）。**手作業Issueではこれを使わず`ManualStepPanel`の中に置く**。
 * 実行者にとっては「あなたの手作業を待っています」と同じ判断のための材料で、離すと押す場所
 * から遠くなるため（`manual-step-panel.tsx`）。
 *
 * 前提が残っている間は畳めなくする。畳まれていると、順序を書いた意味が無くなる——書いた側は
 * 出したつもりでも、読む側は開くまで気付かない。
 */
export function IssueOrderSection({
  prerequisites,
  prerequisiteSummary,
  dependents,
  repositoryFullName,
  idPrefix,
}: {
  prerequisites: ManualStepPrerequisite[];
  /** 参照が1件も無ければnull */
  prerequisiteSummary: ManualStepPrerequisiteSummary | null;
  dependents: IssueDependent[];
  repositoryFullName: string;
  /**
   * 中の見出しに付けるidの前置き。PC版とスマホ版は同時にDOMへ乗るため、
   * 呼び出し側が別の値を渡してidの重複を避ける（`ManualStepPrerequisites`と同じ理由）
   */
  idPrefix: string;
}) {
  const hasPrerequisites = prerequisiteSummary !== null && prerequisites.length > 0;
  const hasDependents = dependents.length > 0;
  const blocking = prerequisiteSummary?.blocking.length ?? 0;
  /**
   * **前提が全部そろっていて、自分を待っている相手もいないときは節ごと出さない**（#2057）。
   *
   * その状態の畳んだ行は「実施順序 1 前提はそろっている」で、開いても押す先が無く、読んでも
   * 次にやることが変わらない。順序を書いた意味があるのは、待たされているか待たせているかの
   * どちらかが成立しているときだけ。**前提待ちが1件でもあれば従来どおり**（開いたまま・
   * 注意色で出す）で、そこは変えていない。
   */
  if (blocking === 0 && !hasDependents) return null;

  return (
    <IssueDetailSection
      id="issue-order"
      title="実施順序"
      count={prerequisites.length + dependents.length}
      forceOpen={blocking > 0}
      tone={blocking > 0 ? "attention" : "default"}
      summary={
        <span className="text-xs text-muted-foreground">
          {[
            blocking > 0 ? `前提${blocking}件待ち` : hasPrerequisites ? "前提はそろっている" : null,
            hasDependents ? `${dependents.length}件が完了を待っている` : null,
          ]
            .filter(Boolean)
            .join(" / ")}
        </span>
      }
    >
      <div className="flex flex-col gap-2">
        {hasPrerequisites && (
          <ManualStepPrerequisites
            prerequisites={prerequisites}
            summary={prerequisiteSummary}
            repositoryFullName={repositoryFullName}
            titleId={`${idPrefix}-issue-order-prerequisites-title`}
          />
        )}
        {hasDependents && (
          <IssueDependents
            dependents={dependents}
            repositoryFullName={repositoryFullName}
            titleId={`${idPrefix}-issue-order-dependents-title`}
          />
        )}
      </div>
    </IssueDetailSection>
  );
}
