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
 * amberと見分けが付かず「要対応」の合図に見えてしまう。
 *
 * **Claude=rose・Codex=greenは、AI使用量画面（`session-usage-panel.tsx`の
 * `AGENT_COLORS`）と揃えている**（#2667）。以前はindigo/emeraldだったが、#2667でAI使用量
 * 画面の「誰が使ったか」の色を橙・青・紫（トークン区分の色と衝突していた）から
 * rose/green/fuchsiaへ差し替えたのに合わせ、同じエージェントを指す色は画面をまたいでも
 * 揃うようにした（indigo/emeraldは`session-usage-panel.tsx`側の`OUTPUT_COLOR`・
 * `TOKEN_COLORS["github-actions"]`と近すぎて転用できなかったため、そちら側の新色に
 * 合わせている）。
 */
export function IssueAgentBadge({ agent, className }: IssueAgentBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 shrink-0 px-1.5 text-[10px] font-medium",
        agent === "codex"
          ? "border-green-300 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300"
          : "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
        className,
      )}
    >
      {agent === "codex" ? "Codex" : "Claude"}
    </Badge>
  );
}
