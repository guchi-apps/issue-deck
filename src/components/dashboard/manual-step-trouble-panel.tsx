"use client";

import { ChevronDown, ChevronRight, Loader2, MessageSquarePlus, Search, TriangleAlert, X } from "lucide-react";
import { useState } from "react";

import { ManualStepFixPanel } from "@/components/dashboard/manual-step-fix-panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { manualStepFixKey, useManualStepFix } from "@/hooks/use-manual-step-fix";
import type { ManualStepCommandKind } from "@/lib/manual-step-command";
import {
  MANUAL_STEP_TROUBLE_CATEGORIES,
  MANUAL_STEP_TROUBLE_DETAIL_MAX_LENGTH,
  MANUAL_STEP_TROUBLE_PASTED_MAX_LENGTH,
  type ManualStepTroubleCategory,
  type ManualStepTroubleReport,
} from "@/lib/manual-step-trouble";
import { cn } from "@/lib/utils";

/**
 * 手作業アシスタントで想定外のことが起きたときの出口（#2299）。
 *
 * 代行実行の失敗は終了コードと出力が画面に届くので、押さずに原因を調べられる（#1869）。
 * けれど**手作業の多くは代行できない**——ブラウザでの操作、メインPC・VPSでの作業、値を
 * 埋めてから実行するコマンドは人が自分で実行する。そこで「コマンドの出力が手順書と違う」
 * 「外部ツールの画面が手順書と違う」が起きても、画面には「実行した・次へ」と「あとで」しか
 * 無かった。手順書は実態とずれたまま次の人へ渡る。
 *
 * ここで受け取るのは**人が書いた状況**で、出口は3つ。
 *
 * 1. **原因を調べる** … Claudeが原因と直し案を出す（コマンド／手順の説明文）。適用は人が押す
 * 2. **Issueに記録して次へ** … 解決しなかったつまずきをIssueコメントに残す。次に同じ手作業を
 *    開いた人の最初の画面に出る
 * 3. **閉じる** … 何も残さずに戻る
 *
 * **貼り付けた出力・画面の文言はIssueへ入れない**（`lib/manual-step-trouble.ts`）。このリポジトリは
 * PUBLICで、手作業の出力にはシークレットが混ざりうる。Claudeへ送るかどうかも、そのつど
 * チェックで決める（既定オフ）。
 */
export type ManualStepTroubleTarget = {
  kind: ManualStepCommandKind;
  /** `## やること`の手順の行、または確認コマンドの開きフェンスの行。無ければnull */
  line: number | null;
  /** 手順の通し番号（1始まり）。`## 完了の確認方法`ではnull */
  order: number | null;
  /** 手順の総数。`order`がnullならnull */
  count: number | null;
  /** 記録に残す手順の見出し */
  text: string;
};

export function ManualStepTroublePanel({
  repositoryFullName,
  issueNumber,
  target,
  isRecording,
  onRecord,
  onApplyCommand,
  onApplyInstruction,
  onClose,
}: {
  repositoryFullName: string;
  issueNumber: number;
  target: ManualStepTroubleTarget;
  isRecording: boolean;
  /** つまずきをIssueコメントとして残す。成功したら呼び出し側が閉じて次へ進める */
  onRecord: (report: ManualStepTroubleReport) => Promise<{ ok: boolean; message?: string }>;
  /** コマンドの修正案を本文へ書き戻す（`run`がtrueなら書き戻したあと実行する） */
  onApplyCommand?: (params: {
    line: number;
    command: string;
    run: boolean;
  }) => Promise<{ ok: boolean; message?: string }>;
  /** 手順の説明文の直し案を本文へ書き戻す */
  onApplyInstruction?: (params: {
    line: number;
    instruction: string;
  }) => Promise<{ ok: boolean; message?: string }>;
  onClose: () => void;
}) {
  const [category, setCategory] = useState<ManualStepTroubleCategory | null>(null);
  const [detail, setDetail] = useState("");
  const [pasted, setPasted] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  // **既定はオフ。** 貼り付け欄には出力がそのまま入るため、送ることを選ぶのは毎回人にする
  const [consent, setConsent] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fix = useManualStepFix();

  const trimmedDetail = detail.trim();
  const tooLong =
    trimmedDetail.length > MANUAL_STEP_TROUBLE_DETAIL_MAX_LENGTH ||
    pasted.trim().length > MANUAL_STEP_TROUBLE_PASTED_MAX_LENGTH;
  const canSubmit = trimmedDetail !== "" && !tooLong;

  function buildReport(): ManualStepTroubleReport {
    return {
      category,
      detail: trimmedDetail,
      // 同意が無ければ**送らない**（画面に書いたものは残るが、リクエストには載せない）
      pasted: consent ? pasted.trim() : "",
    };
  }

  async function handleDiagnose() {
    setError(null);
    await fix.report({
      repositoryFullName,
      number: issueNumber,
      kind: target.kind,
      line: target.line,
      report: buildReport(),
    });
  }

  async function handleRecord() {
    setError(null);
    const result = await onRecord(buildReport());
    if (!result.ok) setError(result.message ?? "Issueに記録できませんでした。");
  }

  async function handleApply(
    apply: () => Promise<{ ok: boolean; message?: string }>,
    fallback: string,
  ) {
    setIsApplying(true);
    setError(null);
    const result = await apply();
    setIsApplying(false);
    if (!result.ok) {
      setError(result.message ?? fallback);
      return;
    }
    fix.dismiss();
    onClose();
  }

  const diagnosed =
    fix.state !== null && fix.state.key === manualStepFixKey(target.kind, target.line)
      ? fix.state
      : null;

  return (
    <section className="flex flex-col gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        うまくいかない
        <span className="ml-auto font-normal text-muted-foreground">
          {target.order === null ? "完了の確認方法" : `手順 ${target.order} について`}
        </span>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="閉じる">
          <X />
        </Button>
      </h4>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold text-muted-foreground">何が起きましたか？</span>
        <div className="flex flex-wrap gap-1.5">
          {MANUAL_STEP_TROUBLE_CATEGORIES.map((entry) => (
            <button
              key={entry.value}
              type="button"
              aria-pressed={category === entry.value}
              onClick={() => setCategory(category === entry.value ? null : entry.value)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[11px] leading-5 transition-colors",
                category === entry.value
                  ? "border-amber-500 bg-background font-semibold text-amber-700 dark:text-amber-300"
                  : "border-input bg-background text-muted-foreground hover:bg-muted",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <Textarea
          value={detail}
          onChange={(event) => setDetail(event.target.value)}
          placeholder="手順書と実際がどう違ったかを書いてください（例: 1Passwordの画面に「新規アイテム」が無く、右上の「＋」しかありませんでした）"
          className="min-h-14 text-xs"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          onClick={() => setPasteOpen((open) => !open)}
          aria-expanded={pasteOpen}
          className="flex items-center gap-1 self-start text-[11px] font-semibold text-muted-foreground"
        >
          {pasteOpen ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden />
          )}
          出力・画面の文言を貼る（任意）
        </button>
        {pasteOpen && (
          <>
            <Textarea
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder="エラーメッセージや、画面に出ている文言をそのまま貼れます"
              className="min-h-14 font-mono text-xs"
            />
            <label className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
              <Checkbox
                checked={consent}
                onCheckedChange={(checked) => setConsent(checked === true)}
                className="mt-0.5 shrink-0"
              />
              <span>
                貼った内容をClaudeへ送って原因を調べる。
                <strong className="font-semibold">
                  シークレットが混ざっていないか確かめてから
                </strong>
                チェックしてください。
              </span>
            </label>
          </>
        )}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Issueに残るのは分類・上に書いた内容・手順の番号だけです（貼った内容は残しません）。
        </p>
      </div>

      {tooLong && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>長すぎるため送れません。要点だけを残してください。</span>
        </p>
      )}
      {(error ?? fix.error) !== null && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{error ?? fix.error}</span>
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={isRecording || isApplying}>
          閉じる
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canSubmit || isRecording || isApplying}
          onClick={() => void handleRecord()}
        >
          {isRecording ? <Loader2 className="animate-spin" /> : <MessageSquarePlus />}
          Issueに記録して次へ
        </Button>
        <Button
          size="sm"
          disabled={!canSubmit || fix.isLoading || isRecording || isApplying}
          onClick={() => void handleDiagnose()}
        >
          {fix.isLoading ? <Loader2 className="animate-spin" /> : <Search />}
          {fix.isLoading ? "原因を調べています" : "原因を調べる"}
        </Button>
      </div>

      {diagnosed !== null && (
        <ManualStepFixPanel
          fix={diagnosed.fix}
          currentCommand={diagnosed.currentCommand}
          currentInstruction={diagnosed.currentInstruction}
          isApplying={isApplying}
          error={null}
          onApply={(command, options) => {
            if (!onApplyCommand || target.line === null) return;
            void handleApply(
              () => onApplyCommand({ line: target.line as number, command, run: options.run }),
              "修正を適用できませんでした。",
            );
          }}
          onApplyInstruction={
            onApplyInstruction && target.line !== null
              ? (instruction) =>
                  void handleApply(
                    () => onApplyInstruction({ line: target.line as number, instruction }),
                    "手順を直せませんでした。",
                  )
              : undefined
          }
          onDismiss={fix.dismiss}
        />
      )}
    </section>
  );
}
