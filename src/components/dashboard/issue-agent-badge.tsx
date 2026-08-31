import { Badge } from "@/components/ui/badge";
import type { IssueImplementationAgent } from "@/lib/dispatch/issue-session";
import { cn } from "@/lib/utils";

type IssueAgentBadgeProps = {
  agent: IssueImplementationAgent;
  className?: string;
};

/**
 * Issueを実装している／実装したローカルエージェントを示す補助バッジ（#2581）。
 *
 * **暖色（amber・orange）は使わない**（#2635）。amberは画面全体で「ユーザーの確認待ち」＝
 * 人が動かないと止まったままという意味に割り当てられており（`CheckUserReasonNotice`・
 * `WorkflowStepBadge`・一覧の「計画を承認」ボタン）、Issue一覧の行では同じ行にそれらと
 * 並ぶ。エージェントの種類を示すだけのこのバッジをorangeにすると、10pxのチップでは
 * amberと見分けが付かず「要対応」の合図に見えてしまう。Claude側はamberから最も遠い
 * 寒色帯のindigoにする——チップ・アイコンでの使用が無く、Codexのemeraldとも色相・明度の
 * 両方で離れ、「Claudeの回答待ち」がすでにblue系で描かれている点とも揃う。
 */
export function IssueAgentBadge({ agent, className }: IssueAgentBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 shrink-0 px-1.5 text-[10px] font-medium",
        agent === "codex"
          ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
          : "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
        className,
      )}
    >
      {agent === "codex" ? "Codex" : "Claude"}
    </Badge>
  );
}
