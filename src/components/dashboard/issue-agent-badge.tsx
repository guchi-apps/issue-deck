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
 *
 * #3075で実行状況の●（`agent-model-color.ts`）とAI使用量画面の色を、朱寄りの赤・青寄りの
 * 緑へ差し替えたのに合わせ、バッジもred/emeraldへ寄せた（roseは●の赤より紫寄り、greenは
 * ●の緑より黄寄りで、並ぶと別の色に見える）。
 */
export function IssueAgentBadge({ agent, className }: IssueAgentBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 shrink-0 px-1.5 text-[10px] font-medium",
        agent === "codex"
          ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
          : "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300",
        className,
      )}
    >
      {agent === "codex" ? "Codex" : "Claude"}
    </Badge>
  );
}
