import { agentModelColor, AGENT_BASE_COLORS, pickPrimaryModel } from "@/lib/agent-model-color";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  resolveIssueImplementationAgent,
  type IssueImplementationAgent,
} from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { sessionUsageModelLabel } from "@/lib/session-usage-view";

/**
 * Issue一覧の行の右端に出す「●モデル名・実行ホスト」（#5581）。
 *
 * 「Claude」「Codex」の文字バッジの代わりに、●の色でエージェントを、濃淡でモデルの重さを示す
 * （実行状況の●と同じ`agentModelColor`）。モデルが転記から分かるまでは中抜きの●と
 * 「モデル確認中」を出す。
 */
export function IssueSessionRuntime({
  session,
}: {
  session: Pick<DispatchSessionView, "models" | "host" | "codexThreadKnown">;
}) {
  const agent: IssueImplementationAgent = resolveIssueImplementationAgent(session);
  const primary = pickPrimaryModel(session.models) ?? session.models[0] ?? null;
  const color = agentModelColor(agent, primary);
  const label = primary ? sessionUsageModelLabel(primary) : "モデル確認中";
  const host = formatDispatchHostName(session.host);
  return (
    <span
      data-session-runtime
      className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
    >
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full border-2"
        style={
          color
            ? { backgroundColor: color, borderColor: color }
            : { borderColor: AGENT_BASE_COLORS[agent] }
        }
      />
      <span className="shrink-0 font-semibold text-foreground">{label}</span>
      <span className="truncate">・{host}</span>
    </span>
  );
}
