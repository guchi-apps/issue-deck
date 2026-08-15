"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  HandHelping,
  Loader2,
  MessageSquarePlus,
  Monitor,
  OctagonX,
  SendHorizonal,
  Square,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import {
  describeDispatchJobStatus,
  describeSessionControlRejection,
  findSessionControlJobForIssue,
  isActiveDispatchJobStatus,
  parseSessionInstruction,
  resolveSessionControlRejection,
  SESSION_CONTROL_LABELS,
  SESSION_INSTRUCTION_MAX_LENGTH,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  summarizeIssueSession,
  type IssueSessionTone,
} from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { cn } from "@/lib/utils";

/**
 * 起動したセッションの様子を出す（#1264）と、そこから止める（#1332）。
 *
 * **`DispatchJob`の状態表示（`dispatch-job-status.tsx`）が終わるところから先を担当する。**
 * ジョブの寿命は「tmuxセッションが立った」までで、その後セッションが生きているのか・人の入力を
 * 待っているのか・落ちたのかは画面のどこにも出ていなかった。
 *
 * **入力待ちのときはRemote ControlのURLを出す。** これが承認の唯一の出口で、従来はSignalyの
 * 通知の中にしか無く、通知を消すと承認待ちであること自体を知る手段が無くなっていた。
 *
 * **人が書いた1行だけを「追加指示」として送れる**（#1012）。pollerが3段階プロトコル
 * （状態確認 → 本文のみ送出 → 反映の再確認 → 確定キーを別送）で送り、承認プロンプトや
 * 選択フォームが出ている間は送らずに見送る。`docs/multi-agent/gates.md`が禁じているのは
 * **実行体が判断して内容のある入力を送ること**で、ここで本文を決めるのは人。プリセットも
 * 押すのは人という点は変わらない。答えを選ばせる操作（選択肢の確定）は引き続きRemote Control側。
 *
 * 実行はサブPCのpollerが次の巡（既定60秒間隔）で行うため、押した直後は「送信しました」を出す。
 *
 * 配色は`dispatch-job-status.tsx`に揃えている。
 */

const TONE_CLASS: Record<IssueSessionTone, string> = {
  running: "bg-primary/15 text-primary ring-primary",
  waiting: "bg-amber-500/15 text-amber-700 ring-amber-500 dark:text-amber-400",
  done: "bg-muted text-muted-foreground ring-border",
  error: "bg-destructive/15 text-destructive ring-destructive",
};

/**
 * 追加指示の定型文（#1012）。**押すのは人**で、状況を見て自動で選ぶ実行体は作らない
 * （`docs/multi-agent/gates.md`）。よく使う2つだけを置き、入力欄へ差し込むだけにしている
 * （そのまま送らないのは、送る前に手直しできる形にしておくため）。
 */
const INSTRUCTION_PRESETS = [
  "計画を承認します。実装に進んでください。",
  "CIが失敗しています。ログを確認して直してください。",
] as const;

function ToneIcon({ tone }: { tone: IssueSessionTone }) {
  const className = "size-3.5";
  switch (tone) {
    case "running":
      return <Loader2 className={cn(className, "animate-spin")} />;
    case "waiting":
      return <HandHelping className={className} />;
    case "done":
      return <CheckCircle2 className={className} />;
    case "error":
      return <AlertTriangle className={className} />;
  }
}

export function IssueSessionStatus({
  session,
  dispatch,
  align = "end",
}: {
  session: DispatchSessionView;
  /** 画面で1回だけ取ったディスパッチの状態（#1262）。停止・終了もこの経路で積む */
  dispatch: DispatchStateHandle;
  /** 横並びのツールバー（PC）では右寄せ、縦積み（スマホ）では左寄せ */
  align?: "start" | "end";
}) {
  const summary = summarizeIssueSession(session);
  const [confirmingKill, setConfirmingKill] = useState(false);
  // 停止の失敗は押した場所に出す（`dispatch.error`は起動ボタンの下に出るため、そちらへ流さない）
  const [controlError, setControlError] = useState<string | null>(null);
  // 追加指示（#1012）。入力欄は押されるまで畳んでおく（常時出すと、停止・終了より
  // 使う機会の少ないものが場所を取る）
  const [instructionOpen, setInstructionOpen] = useState(false);
  const [instruction, setInstruction] = useState("");

  const host = dispatch.hosts.find((candidate) => candidate.name === session.host) ?? null;
  const controlJob = findSessionControlJobForIssue(
    dispatch.jobs,
    session.repositoryFullName,
    session.issueNumber,
  );
  const hasActiveControlJob = controlJob !== null && isActiveDispatchJobStatus(controlJob.status);
  const interruptRejection = resolveSessionControlRejection({
    host,
    session,
    kind: "INTERRUPT",
    hasActiveControlJob,
  });
  const killRejection = resolveSessionControlRejection({
    host,
    session,
    kind: "KILL",
    hasActiveControlJob,
  });
  const instructionRejection = resolveSessionControlRejection({
    host,
    session,
    kind: "INSTRUCTION",
    hasActiveControlJob,
  });
  // 送れる本文かどうかは受け口（`POST /api/dispatch`）と同じ関数で判定する。
  // 画面だけ緩いと、押せたのに400で弾かれる
  const instructionBody = parseSessionInstruction(instruction);
  // 消えたセッションには操作する相手がいない。`EXITED`/`FAILED`（ペインが残っている）は
  // 「閉じる」で片付けられるため、そちらは出したままにする
  const canControl = session.state !== "GONE";
  const showInterrupt = canControl && session.state === "ALIVE";
  // 追加指示は生きているセッションにしか送る相手がいない。**対応していないホストでも
  // ボタンは出したまま無効にし、理由を下に出す**（#1332の「停止」と同じ扱い。導線ごと
  // 消すと、なぜ送れないのかが画面から分からなくなる）
  const showInstruction = canControl && session.state === "ALIVE";

  async function send(kind: "interrupt" | "kill" | "instruction", body?: string) {
    setControlError(null);
    const result = await dispatch.sendSessionControl({
      repositoryFullName: session.repositoryFullName,
      issueNumber: session.issueNumber,
      hostName: session.host,
      kind,
      instruction: body,
    });
    if (!result.ok) {
      setControlError(result.message);
      return;
    }
    // 積めたときだけ入力欄を空にして畳む。失敗時に消すと、書き直すのに打ち直しになる
    if (kind === "instruction") {
      setInstruction("");
      setInstructionOpen(false);
    }
  }

  return (
    <div
      className={cn(
        "flex w-full flex-col gap-1",
        align === "end" ? "items-end" : "items-start",
      )}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ring-1 ring-inset",
          TONE_CLASS[summary.tone],
        )}
      >
        <ToneIcon tone={summary.tone} />
        {summary.label}
        {/* 添える時刻は文言に合わせる（#1353）。pollerが1巡ごとに更新するlastReportedAtを
            入力待ちに添えると、何時間前の入力待ちでも「たった今」に見える */}
        <span className="opacity-70">{formatRelativeDate(summary.at)}</span>
      </span>
      {/* 理由・案内はホバーではなく本文として出す（主な用途が外出先のスマホでホバーが無い） */}
      {summary.detail && (
        <p
          className={cn(
            "w-full break-words text-xs text-muted-foreground",
            align === "end" ? "text-right" : "text-left",
          )}
        >
          {summary.detail}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {summary.remoteControlUrl && (
          <Button variant="outline" size="sm" asChild>
            <a href={summary.remoteControlUrl} target="_blank" rel="noreferrer">
              Remote Controlで開く
              <ExternalLink />
            </a>
          </Button>
        )}
        {/* tailnet内からしか開けない（#1265）。スマホがtailnetにいれば押せる */}
        {summary.previewUrl && (
          <Button variant="outline" size="sm" asChild>
            <a href={summary.previewUrl} target="_blank" rel="noreferrer">
              <Monitor />
              開発環境を開く
            </a>
          </Button>
        )}
        {showInterrupt && (
          <Button
            variant="outline"
            size="sm"
            disabled={interruptRejection !== null || dispatch.isSubmitting}
            onClick={() => void send("interrupt")}
          >
            <Square />
            {SESSION_CONTROL_LABELS.INTERRUPT.action}
          </Button>
        )}
        {/* 追加指示（#1012）。生きているセッションにしか送る相手がいない */}
        {showInstruction && (
          <Button
            variant="outline"
            size="sm"
            disabled={instructionRejection !== null || dispatch.isSubmitting}
            onClick={() => setInstructionOpen((open) => !open)}
          >
            <MessageSquarePlus />
            {SESSION_CONTROL_LABELS.INSTRUCTION.action}
          </Button>
        )}
        {canControl && (
          <Button
            variant="outline"
            size="sm"
            disabled={killRejection !== null || dispatch.isSubmitting}
            onClick={() => setConfirmingKill(true)}
          >
            <OctagonX />
            {SESSION_CONTROL_LABELS.KILL.action}
          </Button>
        )}
      </div>
      {/* 2つの違いを画面に出す（#1557）。ボタンの文言だけでは、押すまで「動いている処理だけが
          止まる」のか「セッションごと終わる」のかが分からず、実際に問われた。
          ホバーではなく本文として出すのは上の理由・案内と同じ立場（スマホにホバーが無い）。
          並んでいるときにしか迷いようがないので、停止を出しているときだけ添える */}
      {showInterrupt && (
        <p
          className={cn(
            "w-full break-words text-xs text-muted-foreground",
            align === "end" ? "text-right" : "text-left",
          )}
        >
          「{SESSION_CONTROL_LABELS.INTERRUPT.action}
          」は今動いている処理だけを止めます（セッションは残るので、追加指示で続けられます）。「
          {SESSION_CONTROL_LABELS.KILL.action}
          」はセッションごと終了します（worktreeは残るので、次に起動すると前回の続きから再開します）。
        </p>
      )}
      {/* 本文を書く場所。**押した人が書いた1行だけを送る**（実行体が組み立てる経路は無い） */}
      {showInstruction && instructionOpen && (
        <div className="flex w-full flex-col gap-1.5">
          <div className="flex w-full gap-2">
            <Input
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (!instructionBody || instructionRejection !== null) return;
                void send("instruction", instructionBody);
              }}
              maxLength={SESSION_INSTRUCTION_MAX_LENGTH}
              placeholder="セッションへ送る指示（1行）"
              aria-label="追加指示の本文"
              disabled={dispatch.isSubmitting}
            />
            <Button
              size="sm"
              disabled={
                instructionBody === null ||
                instructionRejection !== null ||
                dispatch.isSubmitting
              }
              onClick={() => {
                if (!instructionBody) return;
                void send("instruction", instructionBody);
              }}
            >
              <SendHorizonal />
              送信
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {INSTRUCTION_PRESETS.map((preset) => (
              <Button
                key={preset}
                variant="ghost"
                size="sm"
                className="h-auto px-2 py-1 text-xs"
                disabled={dispatch.isSubmitting}
                // **差し込むだけで送らない。** 押した勢いでそのまま届くと、書き直す機会が無い
                onClick={() => setInstruction(preset)}
              >
                {preset}
              </Button>
            ))}
          </div>
          <p className="w-full break-words text-left text-xs text-muted-foreground">
            改行は送れません（{SESSION_INSTRUCTION_MAX_LENGTH}
            文字まで）。長い指示はIssueにコメントし、ここには「コメントを読んでから続けて」と送ってください。
            届くまで最大1分ほどかかり、承認プロンプトや選択フォームが出ている間は送らずに見送ります。
          </p>
        </div>
      )}
      {/* 押せない理由は押す前に出す。未処理の操作がある場合は、下のジョブの状態表示が
          同じことを言うので出さない（`killRejection`と同じ扱い） */}
      {showInstruction &&
        instructionRejection !== null &&
        instructionRejection !== "already_queued" &&
        instructionRejection !== killRejection && (
          <p
            className={cn(
              "w-full break-words text-xs text-muted-foreground",
              align === "end" ? "text-right" : "text-left",
            )}
          >
            {describeSessionControlRejection(instructionRejection, {
              hostName: session.host,
              kind: "INSTRUCTION",
            })}
          </p>
        )}
      {/* 押せない理由は押す前に出す（#1180の「選べない理由は押す前に出す」と同じ立場）。
          未処理の操作がある場合は、下のジョブの状態表示が同じことを言うので出さない */}
      {canControl && killRejection !== null && killRejection !== "already_queued" && (
        <p
          className={cn(
            "w-full break-words text-xs text-muted-foreground",
            align === "end" ? "text-right" : "text-left",
          )}
        >
          {describeSessionControlRejection(killRejection, {
            hostName: session.host,
            kind: "KILL",
          })}
        </p>
      )}
      {/* 押した操作がどこまで進んだか。pull型なので届くまで最大1分ほど何も起きない */}
      {controlJob && (
        <p
          className={cn(
            "w-full break-words text-xs",
            align === "end" ? "text-right" : "text-left",
            describeDispatchJobStatus(controlJob.status, controlJob.kind).tone === "error"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {describeDispatchJobStatus(controlJob.status, controlJob.kind).label}
          {/* 何を送った（送ろうとしている）のかを出す（#1012）。届くまで間があるため、
              これが無いと送り直してよいのか判断できない */}
          {controlJob.instruction && `「${controlJob.instruction}」`}
          {isActiveDispatchJobStatus(controlJob.status) && "（反映まで最大1分ほどかかります）"}
        </p>
      )}
      {/* poller側が返した理由（#1012）。追加指示の見送りは「なぜ送らなかったか」がここにしか
          残らない（承認プロンプト表示中・作業中・入力欄に打ちかけがある、など）。
          終わったジョブにだけ出す（送信中に前回の理由が残っていると読み違える） */}
      {controlJob?.message && !isActiveDispatchJobStatus(controlJob.status) && (
        <p
          className={cn(
            "w-full break-words text-xs text-muted-foreground",
            align === "end" ? "text-right" : "text-left",
          )}
        >
          {controlJob.message}
        </p>
      )}
      {controlError && (
        <p
          className={cn(
            "w-full break-words text-xs text-destructive",
            align === "end" ? "text-right" : "text-left",
          )}
        >
          {controlError}
        </p>
      )}

      <AlertDialog open={confirmingKill} onOpenChange={setConfirmingKill}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>このセッションを閉じますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {formatDispatchHostName(session.host)}の「{session.tmuxSessionName}」を終了します。作業中の内容は
              コミットされず、worktreeはそのまま残ります。次にこのIssueで起動したときは、前回の会話の
              続きから再開します。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dispatch.isSubmitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // 送信の結果を待たずに閉じないよう、既定の閉じる動作を止めてから実行する
                event.preventDefault();
                void send("kill").finally(() => setConfirmingKill(false));
              }}
              disabled={dispatch.isSubmitting}
            >
              {SESSION_CONTROL_LABELS.KILL.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
