import {
  AGENT_BASE_COLORS,
  AGENT_MODEL_TIER_COLORS,
  agentModelColor,
} from "@/lib/agent-model-color";
import { CLAUDE_MODEL_SHORT_LABELS, type ClaudeModel } from "@/lib/app-settings";
import type { IssueImplementationAgent } from "@/lib/dispatch/issue-session";
import { sessionUsageModelLabel } from "@/lib/session-usage-view";
import { cn } from "@/lib/utils";

const AGENT_NAMES: Readonly<Record<IssueImplementationAgent, string>> = {
  claude: "Claude",
  codex: "Codex",
};

function describeModel(model: string): string {
  return CLAUDE_MODEL_SHORT_LABELS[model as ClaudeModel] ?? sessionUsageModelLabel(model);
}

/**
 * 実行状況の行頭の●（#3075）。**色でエージェント（Claude=赤系・Codex=緑系）、濃さでモデルの
 * 重さ**を表す。モデルの段が決まらない行（未集計のセッション・既定モデルで積んだジョブ）は、
 * エージェント色の中抜きにする——推定で塗ると、実際に立ったモデルと食い違いうるため。
 *
 * 最も重い段はダークモードの背景に沈むので、薄い輪郭を付けて形を保つ。
 */
export function ModelDot({
  agent,
  model,
  className,
}: {
  agent: IssueImplementationAgent;
  model: string | null;
  className?: string;
}) {
  const color = agentModelColor(agent, model);
  const label =
    color && model
      ? `${AGENT_NAMES[agent]} ${describeModel(model)}`
      : `${AGENT_NAMES[agent]}（モデル未確定）`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-agent={agent}
      className={cn(
        "size-2 shrink-0 rounded-full",
        color ? "ring-1 ring-black/10 dark:ring-white/30" : "border-[1.5px]",
        className,
      )}
      style={color ? { backgroundColor: color } : { borderColor: AGENT_BASE_COLORS[agent] }}
    />
  );
}

/** ●の凡例。実行状況の末尾に1つだけ置く */
export function ModelDotLegend({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground",
        className,
      )}
    >
      {(["claude", "codex"] as const).map((agent) => (
        <span key={agent} className="inline-flex items-center gap-1">
          <span className="inline-flex items-center gap-0.5" aria-hidden>
            {AGENT_MODEL_TIER_COLORS[agent].map((color) => (
              <span
                key={color}
                className="size-2 rounded-full ring-1 ring-black/10 dark:ring-white/30"
                style={{ backgroundColor: color }}
              />
            ))}
          </span>
          {AGENT_NAMES[agent]}
        </span>
      ))}
      <span>濃いほど重いモデル</span>
    </p>
  );
}
