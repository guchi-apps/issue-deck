"use client";

import { ArrowRightLeft, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  AgentChip,
  CodexLimitationsNotice,
  ModelChip,
  ModelPickNotice,
} from "@/components/dashboard/agent-model-chips";
import {
  AGENT_ENTRIES,
  AUTO_PICK,
  CODEX_MODEL_ENTRIES,
  MODEL_ENTRIES,
} from "@/components/dashboard/start-implementation-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useClaudeUsage } from "@/hooks/use-claude-usage";
import { useCodexUsage } from "@/hooks/use-codex-usage";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { useModelPick } from "@/hooks/use-model-pick";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import {
  describeClaudeModel,
  describeCodexModel,
  parseClaudeLocalModel,
  parseCodexLocalModel,
  resolveCodexInitialModel,
  type ClaudeLocalModel,
  type ClaudeLocalModelSetting,
  type CodexLocalModel,
  type CodexModelSetting,
} from "@/lib/app-settings";
import {
  describeDispatchEnqueueRejection,
  resolveDispatchAgentRejection,
  type DispatchAgent,
} from "@/lib/dispatch/dispatch-job";
import { resolveIssueImplementationAgent } from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import {
  describeHandoffAgent,
  describeHandoffComment,
  pickHandoffInitialAgent,
  summarizeAgentQuota,
} from "@/lib/dispatch/session-handoff";
import { formatResetSentence } from "@/lib/format-reset";
import { findLatestPlanCommentBody } from "@/lib/github/planning-phase";
import { cn } from "@/lib/utils";
import type { Issue, IssueComment } from "@/types/issue";

/** ダイアログを開いた状態の選択（Claude Codeのモデル）。「おまかせ」を含む */
type ClaudeChoice = ClaudeLocalModelSetting;
/** ダイアログを開いた状態の選択（Codexのモデル）。「おまかせ」を含む */
type CodexChoice = CodexLocalModel | typeof AUTO_PICK;

/**
 * 「別のAIで続ける」（#3496）。**いまのセッションのやり取りとブランチの状態を引き継いだ、新しい
 * セッションを別のAI（またはモデル）で起こす。**
 *
 * 使い方の中心は、Claudeの5時間枠・週間枠で止まった作業をCodex CLIで続けること。同じ経路で
 * Codex→Claude Code、同じエージェントでモデルだけを替える引き継ぎもできる。同じセッションのまま
 * モデルを替えることはできない（CLIが別物で、会話の状態を受け渡せない）ので、**新しいセッションを
 * 起こし、元のセッションは停止する**（同じ作業ディレクトリを2つのAIが編集しないため）。
 *
 * 引き継ぎ要約の生成と元セッションの停止はサブPCのpollerが行う（`scripts/lib/session-handoff.sh`）。
 * 画面は選択肢と判断材料（枠の様子）を出して、ジョブに`handoffFrom`を付けて積むだけ。
 *
 * 選び方は「実装を開始」ダイアログ（`start-implementation-dialog.tsx`）に揃えている
 * （エージェントとモデルのチップは`agent-model-chips.tsx`で共有）。**実行先とオプションは選ばせない**
 * ——引き継ぐのは動いていた（動いている）セッションのホストで、オプションはIssueのラベルとして
 * すでに付いている。
 */
export function SessionHandoffButton({
  issue,
  session,
  dispatch,
  comments,
  claudeLocalModel,
  codexModel: codexModelSetting,
  onCommentCreated,
}: {
  issue: Issue;
  /** 引き継ぎ元のセッション。動いているものでも、終了したものでもよい（転記が残っていれば引き継げる） */
  session: DispatchSessionView;
  dispatch: DispatchStateHandle;
  /** 承認済みの計画を「おまかせ」の判定へ渡すために使う。取りに行かず、既にあるものだけを読む */
  comments: readonly IssueComment[];
  /** 設定（設定 ＞ 実行）の値。開いたときに最初から選ばれるモデル */
  claudeLocalModel: ClaudeLocalModelSetting;
  codexModel: CodexModelSetting;
  /** 引き継ぎの記録を投稿できたときに、コメント一覧へ反映する */
  onCommentCreated: (comment: IssueComment) => void;
}) {
  const [open, setOpen] = useState(false);
  const fromAgent: DispatchAgent = resolveIssueImplementationAgent(session);
  const alive = session.state === "ALIVE";

  const [agent, setAgent] = useState<DispatchAgent>(pickHandoffInitialAgent(fromAgent));
  const [claudeModel, setClaudeModel] = useState<ClaudeChoice>(claudeLocalModel);
  const [codexModel, setCodexModel] = useState<CodexChoice>(() =>
    resolveCodexInitialModel(codexModelSetting),
  );
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const claudeModelPick = useModelPick("claude");
  const codexModelPick = useModelPick("codex");
  const { reset: resetClaudeModelPick, pick: pickClaudeModel } = claudeModelPick;
  const { reset: resetCodexModelPick, pick: pickCodexModel } = codexModelPick;
  const autoPickedRef = useRef<Record<DispatchAgent, boolean>>({ claude: false, codex: false });
  // 開くたびの初期化effectから最新の設定値を読むためのref（設定の保存で値が変わっても、
  // 開いている間の選択を巻き戻さない）
  const claudeLocalModelRef = useRef(claudeLocalModel);
  const codexModelSettingRef = useRef(codexModelSetting);
  useEffect(() => {
    claudeLocalModelRef.current = claudeLocalModel;
    codexModelSettingRef.current = codexModelSetting;
  });

  // 開いている間だけ枠を取る。閉じているダイアログのために探りリクエスト（Claudeは送信そのもので
  // 5時間枠が始まる）を増やさない
  const claudeUsage = useClaudeUsage(open);
  const codexUsage = useCodexUsage(open);
  const { createComment, isSubmitting: isCreatingComment } = useIssueCommentMutations();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    // 開くたびに、元と逆のエージェントから選び直させる（前回の選択を持ち越さない）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAgent(pickHandoffInitialAgent(fromAgent));
    setClaudeModel(claudeLocalModelRef.current);
    setCodexModel(resolveCodexInitialModel(codexModelSettingRef.current));
    setIncludeTranscript(false);
    autoPickedRef.current = { claude: false, codex: false };
    // 前回の判定結果は持ち越さない。Issueの内容もラベルも変わっているかもしれない
    resetClaudeModelPick();
    resetCodexModelPick();
    setNow(Date.now());
  }, [open, fromAgent, resetClaudeModelPick, resetCodexModelPick]);

  const isCodexAgent = agent === "codex";
  const modelPick = isCodexAgent ? codexModelPick : claudeModelPick;
  const modelChoice: ClaudeChoice | CodexChoice = isCodexAgent ? codexModel : claudeModel;
  const modelEntries = isCodexAgent ? CODEX_MODEL_ENTRIES : MODEL_ENTRIES;
  const pickedModel: ClaudeLocalModel | CodexLocalModel | null = isCodexAgent
    ? parseCodexLocalModel(modelPick.result?.model)
    : parseClaudeLocalModel(modelPick.result?.model);
  const effectiveModel: ClaudeLocalModel | CodexLocalModel | null =
    modelChoice === AUTO_PICK ? pickedModel : modelChoice;
  /** 「おまかせ」を選んだのに、まだ何で立つか決まっていない状態 */
  const isPickPending = modelChoice === AUTO_PICK && pickedModel === null;

  function selectModel(next: ClaudeChoice | CodexChoice) {
    if (isCodexAgent) setCodexModel(next as CodexChoice);
    else setClaudeModel(next as ClaudeChoice);
    if (next !== AUTO_PICK) return;
    void (isCodexAgent ? pickCodexModel : pickClaudeModel)({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      planComment: findLatestPlanCommentBody(comments),
    });
  }

  // 初期値が「おまかせ」のときの自動判定。モデル欄はダイアログを開いた時点で出ているので、
  // 開いたあとエージェントごとに1回だけ走らせる（失敗しても繰り返さない）
  useEffect(() => {
    if (!open || autoPickedRef.current[agent]) return;
    const isInitialPick = isCodexAgent
      ? codexModelSetting === AUTO_PICK && codexModel === AUTO_PICK
      : claudeLocalModel === AUTO_PICK && claudeModel === AUTO_PICK;
    if (!isInitialPick) return;
    autoPickedRef.current[agent] = true;
    void (isCodexAgent ? pickCodexModel : pickClaudeModel)({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      planComment: findLatestPlanCommentBody(comments),
    });
  }, [
    open,
    agent,
    isCodexAgent,
    claudeLocalModel,
    codexModelSetting,
    claudeModel,
    codexModel,
    pickClaudeModel,
    pickCodexModel,
    issue.repositoryFullName,
    issue.number,
    comments,
  ]);

  const quotas: Record<DispatchAgent, ReturnType<typeof summarizeAgentQuota>> = {
    claude: summarizeAgentQuota(claudeUsage.data?.windows),
    codex: summarizeAgentQuota(codexUsage.data?.windows),
  };
  const fromQuota = quotas[fromAgent];
  const fromResetSentence =
    fromQuota.exhausted && fromQuota.resetsAt !== null
      ? formatResetSentence(fromQuota.resetsAt, now)
      : null;

  const host = dispatch.hosts.find((candidate) => candidate.name === session.host) ?? null;
  const agentRejection = resolveDispatchAgentRejection(host, agent);
  const pauseReason = dispatch.agentPause[agent];
  const hostRejection =
    host === null
      ? describeDispatchEnqueueRejection("host_unknown", { hostName: session.host })
      : !host.online
        ? describeDispatchEnqueueRejection("host_offline", { hostName: session.host })
        : null;
  const pausedRejection = pauseReason
    ? describeDispatchEnqueueRejection("agent_paused", {
        hostName: session.host,
        agentPauseReason: pauseReason,
      })
    : null;
  const quotaRejection = quotas[agent].exhausted
    ? `${describeHandoffAgent(agent)}の枠を使い切っているため、続きが進みません。`
    : null;
  const blockedReason = hostRejection ?? agentRejection ?? pausedRejection ?? quotaRejection;
  const isSubmitting = dispatch.isSubmitting || isCreatingComment;

  async function handleStart() {
    const ok = await dispatch.enqueue({
      repositoryFullName: issue.repositoryFullName,
      issueNumber: issue.number,
      hostName: session.host,
      agent,
      model: effectiveModel,
      handoffFrom: fromAgent,
      handoffTranscript: includeTranscript,
    });
    if (!ok) return;

    // 引き継ぎの記録をIssueへ残す。失敗しても起動は進んでいるので、ここで止めない
    const [owner, repo] = issue.repositoryFullName.split("/");
    const created = await createComment({
      owner,
      repo,
      number: issue.number,
      body: describeHandoffComment({
        from: fromAgent,
        to: agent,
        modelLabel: effectiveModel
          ? isCodexAgent
            ? describeCodexModel(effectiveModel as CodexLocalModel)
            : describeClaudeModel(effectiveModel as ClaudeLocalModel)
          : null,
        includeTranscript,
      }),
    });
    if (created) onCommentCreated(created);
    setOpen(false);
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ArrowRightLeft />
        別のAIで続ける
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex flex-col gap-0 overflow-hidden">
          <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 pb-4 sm:gap-4">
            <DialogHeader>
              <DialogTitle>別のAIで続ける</DialogTitle>
              <DialogDescription>
                いまのセッションの内容を引き継いだ新しいセッションを起動します。
                {alive
                  ? "元のセッションは、引き継ぎの開始時に停止します（同じ作業ディレクトリを2つのAIが触らないため）。"
                  : "元のセッションは終了しています。"}
              </DialogDescription>
            </DialogHeader>

            {fromQuota.exhausted && (
              <p className="flex items-start gap-2 rounded-md bg-amber-500/15 px-2.5 py-2 text-xs text-amber-700 ring-1 ring-inset ring-amber-500/40 dark:text-amber-400">
                <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {describeHandoffAgent(fromAgent)}の枠を使い切っています。
                  {fromResetSentence ? `${fromResetSentence}。` : ""}
                </span>
              </p>
            )}

            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">エージェント</p>
              <div role="radiogroup" aria-label="エージェント" className="grid grid-cols-2 gap-2">
                {AGENT_ENTRIES.map((entry) => (
                  <AgentChip
                    key={entry.agent}
                    icon={entry.icon}
                    label={describeHandoffAgent(entry.agent)}
                    isDefault={false}
                    hint={quotas[entry.agent].hint}
                    disabled={quotas[entry.agent].exhausted}
                    selected={agent === entry.agent}
                    onSelect={() => setAgent(entry.agent)}
                  />
                ))}
              </div>
              {agent === "codex" && <CodexLimitationsNotice />}
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">モデル</p>
              <div role="radiogroup" aria-label="モデル" className="flex flex-col gap-2">
                <ModelChip
                  icon={Sparkles}
                  label="おまかせ"
                  fit="Issueの内容から選ぶ"
                  selected={modelChoice === AUTO_PICK}
                  onSelect={() => selectModel(AUTO_PICK)}
                />
                <div
                  className={cn(
                    "grid gap-2",
                    modelEntries.length === 4 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-3",
                  )}
                >
                  {modelEntries.map((entry) => (
                    <ModelChip
                      key={entry.model}
                      label={entry.label}
                      fit={entry.fit}
                      selected={modelChoice === entry.model}
                      picked={modelChoice === AUTO_PICK && pickedModel === entry.model}
                      probability={
                        modelChoice === AUTO_PICK && modelPick.result?.source === "jev"
                          ? modelPick.result.probabilities?.[entry.model]
                          : undefined
                      }
                      onSelect={() => selectModel(entry.model)}
                    />
                  ))}
                </div>
              </div>
              {modelChoice === AUTO_PICK && (
                <ModelPickNotice
                  agent={agent}
                  isPicking={modelPick.isPicking}
                  result={modelPick.result}
                  error={modelPick.error}
                />
              )}
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">引き継ぐ内容</p>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
                <li>直近のやり取り（末尾30件までの抜粋。ツールの出力は除く）</li>
                <li>ブランチの状態（コミットの一覧と未コミットの変更）</li>
                <li>
                  Issue本文・コメント・承認済みの計画は、新しいセッションの最初の指示にもともと入っています
                </li>
              </ul>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  id="session-handoff-transcript"
                  checked={includeTranscript}
                  onCheckedChange={(checked) => setIncludeTranscript(checked === true)}
                  className="mt-0.5"
                />
                <span className="flex flex-col">
                  <span>元セッションの転記（全文）も添える</span>
                  <span className="text-xs text-muted-foreground">
                    長く、読むほど枠を使います。既定はオフ（抜粋だけ）です。
                  </span>
                </span>
              </label>
            </div>

            {blockedReason && <p className="text-xs text-destructive">{blockedReason}</p>}
            {dispatch.error && <p className="text-xs text-destructive">{dispatch.error}</p>}
          </div>
          <DialogFooter className="flex-row justify-end">
            <DialogClose asChild>
              <Button variant="outline" className="flex-1 sm:flex-none" disabled={isSubmitting}>
                キャンセル
              </Button>
            </DialogClose>
            <Button
              className="flex-1 sm:flex-none"
              onClick={() => void handleStart()}
              // 「おまかせ」の判定が終わるまで押させない。決まる前に押すと、選んだつもりのない
              // モデルで立つ
              disabled={isSubmitting || isPickPending || blockedReason !== null}
            >
              引き継いで開始
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
