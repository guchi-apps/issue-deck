import { Badge } from "@/components/ui/badge";
import type { IssueImplementationAgent } from "@/lib/dispatch/issue-session";
import { cn } from "@/lib/utils";

type IssueAgentBadgeProps = {
  agent: IssueImplementationAgent;
  className?: string;
};

/** Issueを実装している／実装したローカルエージェントを示す補助バッジ（#2581）。 */
export function IssueAgentBadge({ agent, className }: IssueAgentBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 shrink-0 px-1.5 text-[10px] font-medium",
        agent === "codex"
          ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
          : "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300",
        className,
      )}
    >
      {agent === "codex" ? "Codex" : "Claude"}
    </Badge>
  );
}
