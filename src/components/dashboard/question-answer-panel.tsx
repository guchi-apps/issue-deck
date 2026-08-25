"use client";

import { useState } from "react";
import {
  Check,
  ExternalLink,
  Keyboard,
  Loader2,
  MessageCircleQuestion,
  TriangleAlert,
} from "lucide-react";

import { formatRemaining, useRemainingMs } from "@/components/dashboard/use-remaining-ms";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { summarizeIssueSession } from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import {
  SESSION_QUESTION_FREE_TEXT_MAX_LENGTH,
  type SessionQuestion,
  type SessionQuestionAnswerInput,
  type SessionQuestionRequestView,
} from "@/lib/dispatch/session-question-request";
import { formatRelativeDate } from "@/lib/format-relative-date";

/**
 * ローカルセッションが`AskUserQuestion`で聞いた質問に、その場で答えるパネル（#2189）。
 *
 * **これまで、Claude Codeからの質問に答えられるのは端末とRemote Controlだけだった。**
 * 画面に出ていたのは「Remote Controlから答えてください」という案内（`LocalSessionWaitingInputNotice`）
 * だけで、スマホから選択肢を1つ選ぶためにTUIを開く必要があった。
 *
 * **端末へキーを送る経路（`send-keys`）は持たない。** ここが押された内容はサーバーの
 * `SessionQuestionRequest`に入り、質問を送った`PreToolUse(AskUserQuestion)`フックがそれを
 * 受け取って`updatedInput.answers`としてClaude Codeへ返す
 * （`src/lib/dispatch/session-question-request.ts`）。選択フォームに答えさせる操作はどこにも
 * 無いので、[docs/multi-agent/gates.md](../../../docs/multi-agent/gates.md)の禁止に触れない。
 *
 * **押せない状態でもボタンを消さずに理由を出す**（計画の承認パネルと同じ作法）。
 * **PC・スマホで同じコンポーネントを使う**（ボタンはスマホで縦積み・全幅になる）。
 */

/** 1問ぶんの選択状態。`options`は選んだラベル、`text`は「その他」の自由記述 */
type Selection = { options: string[]; text: string };

export function QuestionAnswerPanel({
  request,
  session,
  dispatch,
  onCheckUserResolved,
}: {
  request: SessionQuestionRequestView;
  /** 質問したセッション。見つかっていなければ`null` */
  session: DispatchSessionView | null;
  dispatch: DispatchStateHandle;
  /**
   * 回答を送って確認待ちが解けたときに呼ぶ（#2341。計画の承認パネルと同じ）。サーバーが
   * `00.check-user`と理由ラベルを外すのと同じことを、手元のIssueにも先に反映させる。
   * 「端末・Remote Controlで答える」では呼ばない（人はまだ答えていない）。
   */
  onCheckUserResolved?: () => void;
}) {
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [error, setError] = useState<string | null>(null);
  // 押した結果は**どの質問に対して押したのか**まで持つ（#2158と同じ理由）。Issue詳細は
  // Issueを切り替えてもアンマウントされないため、`"answer"`だけを覚えると別の質問に
  // 差し替わっても「回答を送りました」が残る
  const [sent, setSent] = useState<{ requestId: string; decision: "answer" | "defer" } | null>(
    null,
  );

  const remainingMs = useRemainingMs(request.expiresAt);
  const hostLabel = request.hostName ? formatDispatchHostName(request.hostName) : "ローカル";
  const sessionGone = session !== null && session.state !== "ALIVE";
  // 「ここからは送れない」と言うだけでは、どこで答えればよいのかが画面から辿れない
  const remoteControlUrl = session ? summarizeIssueSession(session).remoteControlUrl : null;

  function selectionOf(question: SessionQuestion): Selection {
    return selections[question.question] ?? { options: [], text: "" };
  }

  function toggleOption(question: SessionQuestion, label: string) {
    setSelections((prev) => {
      const current = prev[question.question] ?? { options: [], text: "" };
      const has = current.options.includes(label);
      const options = question.multiSelect
        ? has
          ? current.options.filter((value) => value !== label)
          : [...current.options, label]
        : has
          ? []
          : [label];
      return { ...prev, [question.question]: { ...current, options } };
    });
  }

  function setFreeText(question: SessionQuestion, text: string) {
    setSelections((prev) => {
      const current = prev[question.question] ?? { options: [], text: "" };
      return { ...prev, [question.question]: { ...current, text } };
    });
  }

  async function send(decision: "answer" | "defer") {
    setError(null);
    const answers: SessionQuestionAnswerInput[] = request.questions.map((question) => {
      const selection = selectionOf(question);
      const text = selection.text.trim();
      return {
        question: question.question,
        options: selection.options,
        ...(text ? { text } : {}),
      };
    });
    const result = await dispatch.answerQuestion({
      id: request.id,
      decision,
      ...(decision === "answer" ? { answers } : {}),
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSent({ requestId: request.id, decision });
    if (decision !== "defer") onCheckUserResolved?.();
  }

  // 送った直後、または他の経路（フックの受け取り・期限切れ）で決まった後の表示。
  // **いま出ている質問に対して押したものだけを見る**（別の質問の結果は持ち越さない）
  const sentForThisRequest = sent?.requestId === request.id ? sent.decision : null;
  const decided = sentForThisRequest ?? decisionOf(request.status);
  if (decided) {
    return (
      <QuestionDecisionResult
        decision={decided}
        hostLabel={hostLabel}
        questions={request.questions}
        answers={request.answers}
        remoteControlUrl={remoteControlUrl}
      />
    );
  }

  // **全部の質問に答えるまで送れない。** 1問でも空だとツールの結果が
  // 「(no option selected)」になり、何を聞かれて何を答えたのかが後から読めない
  const allAnswered = request.questions.every((question) => {
    const selection = selectionOf(question);
    return selection.options.length > 0 || selection.text.trim().length > 0;
  });
  const canSend = !sessionGone && remainingMs > 0;
  // 質問を読めないまま操作させない（保存した形が壊れていた場合。まず起きないが、
  // 起きたときに「選べない空のパネル」を出すよりは端末へ寄せる）
  const unreadable = request.questions.length === 0;

  return (
    <section className="overflow-hidden rounded-md border border-amber-500/50 bg-card">
      <header className="flex items-start gap-2.5 border-b border-amber-500/50 bg-amber-500/10 p-3">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-amber-500/80 text-amber-950">
          <MessageCircleQuestion className="size-3.5" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-400">
            質問の回答を待っています
          </h3>
          <p className="text-xs text-muted-foreground">
            {hostLabel}のセッションが{formatRelativeDate(request.createdAt)}に聞いています
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-sm font-medium tabular-nums text-amber-700 dark:text-amber-400">
            {formatRemaining(remainingMs)}
          </div>
          <div className="text-[10px] text-muted-foreground">あと</div>
        </div>
      </header>

      <div className="flex flex-col gap-4 p-3">
        {unreadable ? (
          <p className="text-xs text-muted-foreground">
            質問の内容を読み取れませんでした。Remote Controlか端末から答えてください。
          </p>
        ) : (
          request.questions.map((question) => (
            <QuestionBlock
              key={question.question}
              question={question}
              selection={selectionOf(question)}
              disabled={!canSend || dispatch.isSubmitting}
              onToggleOption={(label) => toggleOption(question, label)}
              onChangeText={(text) => setFreeText(question, text)}
            />
          ))
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button
            size="sm"
            disabled={!canSend || unreadable || !allAnswered || dispatch.isSubmitting}
            onClick={() => void send("answer")}
          >
            {dispatch.isSubmitting ? <Loader2 className="animate-spin" /> : <Check />}
            回答を送る
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!canSend || dispatch.isSubmitting}
            onClick={() => void send("defer")}
          >
            <Keyboard />
            端末・Remote Controlで答える
          </Button>
        </div>

        {!allAnswered && !unreadable && (
          <p className="text-[11px] text-muted-foreground">
            すべての質問に答えると送れます（どれとも違うときは「その他」に書いてください）。
          </p>
        )}
        {sessionGone && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            このセッションは終了しています。回答は届きません。続きを頼むには
            「セッションを復旧」から起こし直してください。
          </p>
        )}
        {error && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          送るとセッションはこの回答のまま作業を続けます。送った内容はIssueコメントにも残ります。
          待ち時間が切れると端末に従来どおりの選択フォームが出て、ここからは送れなくなります。
        </p>
      </div>
    </section>
  );
}

function QuestionBlock({
  question,
  selection,
  disabled,
  onToggleOption,
  onChangeText,
}: {
  question: SessionQuestion;
  selection: Selection;
  disabled: boolean;
  onToggleOption: (label: string) => void;
  onChangeText: (text: string) => void;
}) {
  // 選んだ選択肢に`preview`（モックアップ・コード片）があれば出す。**選んだものだけ**——
  // 全部を並べるとパネルが読めなくなるうえ、比べる材料は選び直せば入れ替わる
  const preview = question.options.find(
    (option) => selection.options.includes(option.label) && option.preview,
  )?.preview;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {question.header && (
          <span className="rounded border bg-muted px-1.5 py-px text-[10.5px] font-semibold text-muted-foreground">
            {question.header}
          </span>
        )}
        {question.multiSelect && (
          <span className="text-[10.5px] font-semibold text-amber-700 dark:text-amber-400">
            複数選べます
          </span>
        )}
      </div>
      <p className="text-sm font-semibold leading-relaxed">{question.question}</p>

      <div className="flex flex-col gap-1.5">
        {question.options.map((option) => {
          const selected = selection.options.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              // 単一選択でもラジオではなくボタンにしている。押すたびに選び直せる形の方が、
              // スマホで押し間違えたときの取り消しが分かりやすい
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onToggleOption(option.label)}
              className={`flex items-start gap-2.5 rounded-md border p-2.5 text-left transition-colors disabled:opacity-60 ${
                selected
                  ? "border-amber-500/50 bg-amber-500/10"
                  : "bg-card hover:bg-muted disabled:hover:bg-card"
              }`}
            >
              <span
                aria-hidden
                className={`mt-0.5 flex size-4 shrink-0 items-center justify-center border ${
                  question.multiSelect ? "rounded-sm" : "rounded-full"
                } ${selected ? "border-amber-500 bg-amber-500" : "border-muted-foreground"}`}
              >
                {selected && (
                  <Check className="size-3 text-amber-950" strokeWidth={3.5} aria-hidden />
                )}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13px] font-medium leading-snug">{option.label}</span>
                {option.description && (
                  <span className="text-[11.5px] leading-relaxed text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {preview && (
        <pre className="max-h-56 overflow-auto rounded-md border bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
          {preview}
        </pre>
      )}

      <Textarea
        value={selection.text}
        disabled={disabled}
        onChange={(event) => onChangeText(event.target.value)}
        maxLength={SESSION_QUESTION_FREE_TEXT_MAX_LENGTH}
        rows={2}
        placeholder="どれとも違うときは、ここに書いて送れます（任意）"
        className="text-[12.5px]"
      />
    </div>
  );
}

function QuestionDecisionResult({
  decision,
  hostLabel,
  questions,
  answers,
  remoteControlUrl,
}: {
  decision: "answer" | "defer" | "expired";
  hostLabel: string;
  questions: readonly SessionQuestion[];
  /** 送った回答。取得が追い付く前は`null`（送ったこと自体は確定している） */
  answers: Record<string, string> | null;
  /** 端末で答えることになったときの行き先。無ければリンクを出さない */
  remoteControlUrl: string | null;
}) {
  const answerElsewhere = decision === "defer" || decision === "expired";
  const tone = answerElsewhere
    ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
    : "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";

  return (
    <section className={`flex flex-col gap-2 rounded-md border p-3 text-xs ${tone}`}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          {answerElsewhere ? (
            <Keyboard className="size-3.5" aria-hidden />
          ) : (
            <Check className="size-3.5" aria-hidden />
          )}
        </span>
        <span className="leading-relaxed">
          {decision === "answer" && (
            <>
              <strong className="font-semibold">回答を送りました。</strong>
              {hostLabel}のセッションが続きを進めます。この内容はIssueコメントにも残しました。
            </>
          )}
          {answerElsewhere && (
            <>
              <strong className="font-semibold">端末に選択フォームを出しました。</strong>
              ここからは送れません。Remote Controlか
              <code className="mx-1 rounded bg-background/60 px-1 py-0.5 font-mono">
                tmux attach
              </code>
              で答えてください。
            </>
          )}
        </span>
      </div>
      {decision === "answer" && answers && (
        <ul className="flex flex-col gap-0.5 pl-6 text-foreground">
          {questions.map((question) => (
            <li key={question.question} className="text-[11.5px] leading-relaxed">
              <span className="font-semibold">{question.header || question.question}</span>
              {" — "}
              {answers[question.question] ?? "（回答なし）"}
            </li>
          ))}
        </ul>
      )}
      {answerElsewhere && remoteControlUrl && (
        <Button variant="outline" size="sm" className="self-start" asChild>
          <a href={remoteControlUrl} target="_blank" rel="noreferrer">
            Remote Controlで答える
            <ExternalLink />
          </a>
        </Button>
      )}
    </section>
  );
}

function decisionOf(
  status: SessionQuestionRequestView["status"],
): "answer" | "defer" | "expired" | null {
  switch (status) {
    case "ANSWERED":
      return "answer";
    case "DEFERRED":
      return "defer";
    case "EXPIRED":
      return "expired";
    case "WAITING":
      return null;
  }
}
