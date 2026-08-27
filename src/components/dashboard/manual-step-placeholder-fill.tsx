"use client";

import { ChevronDown, ChevronRight, ClipboardPaste, Lock, Pencil } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * 手順の`<控えたkey>`へ値を埋める欄（#2403）。
 *
 * この画面を実際に使うのは、スマホでissue-deckを開き、Tailscale越しのターミナルアプリへ
 * 切り替えて打ち、また戻ってくる人。前の手順が出した値（トークン・ID）を次の手順へ渡す
 * ところが往復のいちばん詰まる場所で、これまでは「代行できません」と出るだけで**埋める
 * 場所も、前の出力から持ってくる手段も画面に無かった**。
 *
 * 埋めた値の行き先は3つに分かれる。
 *
 * - **画面**: このタブの中だけ（`useManualStepValues`＝sessionStorage。閉じれば消える）
 * - **サーバー**: 「承認して実行」を押したときだけ届き、ジョブが終われば捨てる
 * - **Issue**: 一切書かない（本文にもコメントにも）
 *
 * **「貼り付け」はクリップボードの読み取りが使えるときだけ出す。** `copyText`の書き込み側は
 * `document.execCommand("copy")`という逃げ道があるが、**読み取りに同じ逃げ道は無い**ので、
 * セキュアコンテキストでない経路（tailnet越しのhttpで開発サーバーを見る等）では
 * 押しても何も起きないボタンになる。出さずに手入力へ落とす。
 */
export function ManualStepPlaceholderFill({
  placeholders,
  values,
  onChange,
  onClear,
  previousOutput,
  filled,
}: {
  /** この手順に含まれる、名前の付くプレースホルダの表記（`ManualStepRunEntry.placeholders`） */
  placeholders: readonly string[];
  /** いま埋まっている値。まだ何も無ければ`null` */
  values: Record<string, string> | null;
  onChange: (placeholder: string, value: string) => void;
  onClear: () => void;
  /**
   * 前の手順の代行実行の出力（#2403）。あれば「出力から選ぶ」を出し、行をタップで流し込む。
   * **値を目で探して打ち直させない**ためのもので、無ければこの節ごと出さない。
   */
  previousOutput?: { label: string; text: string } | null;
  /** すべての穴が埋まっているか。埋まっていれば1行のまとめへ畳む */
  filled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  if (placeholders.length === 0) return null;

  // 埋まっていて、直す操作もしていなければ1行にまとめる。**消せる導線は畳んでも残す**
  // （値がシークレットのことがあり、席を離れる前に消したくなる）
  if (filled && !editing) {
    return (
      <section className="flex flex-col gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-2.5">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
          <Pencil className="size-3.5 shrink-0" aria-hidden />
          埋める値
        </h4>
        <ul className="flex flex-col gap-1">
          {placeholders.map((placeholder) => (
            <li
              key={placeholder}
              className="flex items-baseline gap-2 font-mono text-[11px] text-muted-foreground"
            >
              <span className="shrink-0">{placeholder}</span>
              <span className="truncate text-foreground">{values?.[placeholder] ?? ""}</span>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button variant="outline" size="xs" onClick={() => setEditing(true)}>
            値を直す
          </Button>
          <Button variant="outline" size="xs" onClick={onClear}>
            値を消す
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
        <Pencil className="size-3.5 shrink-0" aria-hidden />
        埋める値
      </h4>
      {placeholders.map((placeholder) => (
        <div key={placeholder} className="flex flex-col gap-1">
          <label
            className="font-mono text-[11px] text-muted-foreground"
            htmlFor={`manual-step-value-${placeholder}`}
          >
            {placeholder}
          </label>
          <div className="flex gap-2">
            {/* **スマホ幅で16px未満にしない**（#1442。`text-base md:text-sm`） */}
            <Input
              id={`manual-step-value-${placeholder}`}
              value={values?.[placeholder] ?? ""}
              onChange={(event) => onChange(placeholder, event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            {canReadClipboard() && (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void pasteInto(placeholder, onChange)}
              >
                <ClipboardPaste />
                貼り付け
              </Button>
            )}
          </div>
        </div>
      ))}

      {previousOutput && (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            aria-expanded={pickerOpen}
            className="flex items-center gap-1 self-start text-[11px] font-semibold text-muted-foreground"
          >
            {pickerOpen ? (
              <ChevronDown className="size-3.5" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden />
            )}
            {previousOutput.label}の出力から選ぶ
          </button>
          {pickerOpen && (
            <ul className="flex flex-col overflow-hidden rounded-md border bg-background">
              {outputLines(previousOutput.text).map((line, index) => (
                <li key={`${index}-${line}`} className="border-b last:border-b-0">
                  <button
                    type="button"
                    // **入れる先は最初の穴**。複数ある手順で「どの穴へ入れるか」を選ばせると
                    // 押す回数が増えるだけなので、埋まっていない先頭へ入れて直させる
                    onClick={() => onChange(firstEmpty(placeholders, values), line)}
                    className="block w-full truncate px-2.5 py-2 text-left font-mono text-[11px] hover:bg-muted"
                  >
                    {line}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
        <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span>
          入力した値は<strong className="font-semibold">このタブの中だけ</strong>
          に残ります（タブを閉じると消えます）。Issueの本文にもコメントにも書きません。
          「承認して実行」を押したときだけサブPCへ送り、実行が終われば捨てます。
        </span>
      </p>
      <div className="flex justify-end">
        <Button variant="outline" size="xs" onClick={onClear}>
          値を消す
        </Button>
      </div>
    </section>
  );
}

/**
 * 出力から選ばせる行。**空行を落とし、前後の空白を落として、末尾から拾う**——欲しい値
 * （発行されたトークン・ID）はたいてい最後に出る。長すぎる行は選んでも欄に入りきらない
 * ので出さない（`normalizeManualStepPlaceholderValues`が捨てる長さと同じ考え方）。
 */
export function outputLines(text: string, limit = 12): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line.length <= 200);
  return lines.slice(-limit);
}

/** まだ埋まっていない最初の穴（全部埋まっていれば先頭） */
function firstEmpty(
  placeholders: readonly string[],
  values: Record<string, string> | null,
): string {
  return placeholders.find((placeholder) => !values?.[placeholder]) ?? placeholders[0];
}

/**
 * クリップボードを読めるか。**セキュアコンテキスト（https・localhost）にしか生えない。**
 * 書き込み側（`copyText`）と違い、非セキュアコンテキストで動く代わりの手段が無い。
 */
function canReadClipboard(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function";
}

async function pasteInto(
  placeholder: string,
  onChange: (placeholder: string, value: string) => void,
): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    // 端末のコピーは末尾に改行が付くことが多い。**先に落としてから入れる**——
    // 改行入りの値は`normalizeManualStepPlaceholderValues`が捨てるため、
    // そのまま渡すと「押したのに何も入らない」ように見える
    const value = text.trim();
    if (value !== "") onChange(placeholder, value);
  } catch {
    // 許可されなかった・空だった場合は何もしない（手で入力できる）
  }
}
