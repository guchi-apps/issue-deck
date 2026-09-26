import type { DispatchAgent } from "@/lib/dispatch/dispatch-job";

/**
 * 別のAIで続ける（#3496）の、画面側の判定と文面。
 *
 * 要約の生成と元セッションの停止はサブPCのpollerが行う（`scripts/lib/session-handoff.sh`）。
 * ここが持つのは、ダイアログが出す判断材料（枠の使い切り）と、Issueへ残す記録の本文だけ。
 */

/** 引き継ぎ先の初期値は、元と逆のエージェント（枠が切れた側から、もう一方へ移す用途が中心のため） */
export function pickHandoffInitialAgent(from: DispatchAgent): DispatchAgent {
  return from === "codex" ? "claude" : "codex";
}

/** 画面に出すエージェント名。「実装を開始」ダイアログのチップと同じ言い方に揃える */
export function describeHandoffAgent(agent: DispatchAgent): string {
  return agent === "codex" ? "Codex CLI" : "Claude Code";
}

/** ClaudeとCodexの枠に共通する部分。どちらの取得結果もこの形に当てはまる */
export type QuotaWindow = {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  /** リセット時刻（epoch秒）。取得できなかった場合はnull */
  resetsAt: number | null;
  /** `rejected`なら上限に達している。取得できなかった場合はnull・省略 */
  status?: string | null;
  /** リセット時刻を過ぎていて、現在の使用量が分からない枠（Codexの転記スナップショット） */
  expired?: boolean;
};

export type AgentQuotaSummary = {
  /** 上限に達している枠がある（新しく始めても進まない）。**取得できていないときはfalse** */
  exhausted: boolean;
  /** チップへ添える短い補足。取得できていなければnull */
  hint: string | null;
  /** 使い切っているときに、その枠が戻る時刻（epoch秒）。使い切っていない・不明ならnull */
  resetsAt: number | null;
};

/**
 * エージェントの枠の様子を1つにまとめる。
 *
 * **使い切りと判定するのは、取得できた枠が上限に達しているときだけ**（`status`が`rejected`、または
 * 残りが0%以下）。取得に失敗した・古い値しか無いときは`exhausted: false`にして、押せる状態を保つ——
 * 取得の不調で「選べない」に倒すと、引き継ぎそのものが塞がる。
 */
export function summarizeAgentQuota(
  windows: readonly QuotaWindow[] | null | undefined,
): AgentQuotaSummary {
  const live = (windows ?? []).filter((window) => window.expired !== true);
  if (live.length === 0) return { exhausted: false, hint: null, resetsAt: null };

  const exhaustedWindows = live.filter(
    (window) => window.status === "rejected" || window.remainingPercent <= 0,
  );
  if (exhaustedWindows.length > 0) {
    const resets = exhaustedWindows
      .map((window) => window.resetsAt)
      .filter((value): value is number => value !== null);
    return {
      exhausted: true,
      hint: `${exhaustedWindows[0].label}枠を使い切り`,
      // 使い切った枠がすべて戻るのは、最も遅いリセットの時刻
      resetsAt: resets.length > 0 ? Math.max(...resets) : null,
    };
  }

  const busiest = live.reduce((max, window) => (window.usedPercent > max.usedPercent ? window : max));
  return {
    exhausted: false,
    hint: `${busiest.label}枠 ${Math.round(busiest.usedPercent)}%使用`,
    resetsAt: null,
  };
}

/**
 * 引き継ぎの記録としてIssueへ残すコメント本文。**押したのは人**なので、役割マーカーは付けない
 * （画面から投稿するコメントは、人の操作の記録としてそのまま残る）。
 *
 * 元セッションを止めることを、この記録から後で読み取れるようにしておく。
 */
export function describeHandoffComment(params: {
  from: DispatchAgent;
  to: DispatchAgent;
  /** 引き継ぎ先のモデル名（表示名）。決まっていなければ省略 */
  modelLabel?: string | null;
  includeTranscript: boolean;
}): string {
  const target = params.modelLabel
    ? `${describeHandoffAgent(params.to)}（${params.modelLabel}）`
    : describeHandoffAgent(params.to);
  const lines = [
    `別のAIで続けます: ${describeHandoffAgent(params.from)} → ${target}`,
    "",
    "元のセッションを停止し、直近のやり取りとブランチの状態を引き継いだ新しいセッションを起動します。",
    params.includeTranscript
      ? "元セッションの転記（全文）も添えています。"
      : "元セッションの転記（全文）は添えていません。",
  ];
  return lines.join("\n");
}
