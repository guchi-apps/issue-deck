"use client";

import { Check, Copy, MonitorSmartphone, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { copyText } from "@/lib/copy-text";
import { matchManualStepDeviceNames, type ManualStepGuide } from "@/lib/manual-step-guide";
import { splitShellCommandLines } from "@/lib/shell-command-lines";
import { cn } from "@/lib/utils";

/**
 * 手作業を自分で実行するときの「どこで実行するか」（#1882・#4315）。
 *
 * 人が実行するのは、権限・本人認証・物理操作などAIにできない部分だけに絞られている。
 * そのとき分かりにくいのが**どこへ入って、どのディレクトリで打つのか**なので、
 * 接続・移動・実行を**コピーして一度で実行できる1行**にまとめて出す（`buildManualStepOneLiner`）。
 * 以前は「つなぐ → 移動する → 実行する」を番号付きで並べていたが、順番に実行する前提を
 * 残さないため番号は出さない。
 *
 * **出すのは本文から拾ったものだけ。** 接続コマンドが書かれていなければ組み込まず、
 * ホスト名から`ssh …`を組み立てたりしない——推測した接続先を出すと、確かめる手間が増える。
 *
 * **PC・スマホで同じコンポーネントを使う。**
 */
export function ManualStepWhereToRun({
  where,
  device,
  command,
  /** 代行できない理由（サブPC・VPS以外の手作業など）。あれば見出しの下に出す */
  reason,
}: {
  where: ManualStepGuide["where"];
  /**
   * その手順を実行する端末（#2052）。`resolveManualStepDevice`で解決済みの値を受ける——
   * ここで`where.device`を読み直すと、手順ごとに違う端末が案内できなくなる。
   */
  device: string | null;
  /** 実行するコマンド。手順にコマンドが無い場合は`null` */
  command: string | null;
  reason?: string | null;
}) {
  const oneLiner = buildManualStepOneLiner(where, command, device);
  if (oneLiner === null) return null;

  return (
    <section className="flex flex-col gap-2 rounded-md border border-violet-500/40 bg-violet-500/5 p-2.5">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
        <MonitorSmartphone className="size-3.5 shrink-0" aria-hidden />
        手元で実行する{device === null ? "" : `（${device}）`}
      </h4>
      {reason != null && reason !== "" && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>{reason}</span>
        </p>
      )}
      <span className="flex min-w-0 items-start gap-1.5">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded border bg-background p-2 font-mono text-xs leading-relaxed">
          {oneLiner}
        </pre>
        <LineCopyButton command={oneLiner} />
      </span>
    </section>
  );
}

/**
 * 手元で実行する1行コマンドを作る（#4315）。書かれていないものは足さない。
 *
 * - 作業ディレクトリがパスとして読めるときだけ`cd <dir> && …`から始める（「不要」や
 *   リポジトリ名だけの記載を`cd`にすると動かない）
 * - 手元（ブラウザ・メインPC）以外で接続コマンドが書かれていれば、`ssh 宛先 '…'`の形で
 *   1行にする。ユーザー切り替え（`sudo -u`）など本文に無い操作は組み立てない
 *   （VPSの実行ユーザーはセッションが所有者を確認して、報告のコマンドに書く）
 * - 接続も移動も足せず、コマンドそのままになるなら`null`（呼び出し側が本文のコードをそのまま出す）
 *
 * @param device その手順を実行する端末（`resolveManualStepDevice`の結果）
 */
export function buildManualStepOneLiner(
  where: ManualStepGuide["where"],
  command: string | null,
  device: string | null = where.device,
): string | null {
  if (command === null || command.trim() === "") return null;
  const names = matchManualStepDeviceNames(device);
  const isLocal = names.length === 1 && LOCAL_DEVICES.includes(names[0]);
  const connect = isLocal ? null : where.connect;
  const hasDirectory = where.directory !== null && /^[~/.]/.test(where.directory);
  if (connect === null && !hasDirectory) return null;

  // &&や改行で繋がったコマンドは、失敗した時点で止まるよう&&の1本にまとめる
  const body = splitShellCommandLines(command).join(" && ");
  const inner = hasDirectory ? `cd ${where.directory} && ${body}` : body;
  return connect === null ? inner : `${connect} ${shellSingleQuote(inner)}`;
}

function shellSingleQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * 手元に居るだけで作業できる端末（#2052）。ここへ`ssh …`は要らない。
 *
 * 接続コマンドは`## 前提条件`の1行から拾ったもので、**どの端末へ入るためのものかまでは
 * 分からない**。ブラウザ・メインPCの手順でそれを出すと、`ssh subpc`してから
 * ブラウザを開けと読める案内になる。
 */
const LOCAL_DEVICES = ["ブラウザ", "メインPC"];

/** 1行だけを個別にコピーする（#2818）。「まとめてコピー」はこの並び全体を対象にする */
function LineCopyButton({ command }: { command: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  async function handleCopy() {
    const ok = await copyText(command);
    setState(ok ? "copied" : "failed");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1500);
  }

  const label =
    state === "copied" ? "コピーしました" : state === "failed" ? "コピーできませんでした" : "この行をコピー";

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      aria-label={label}
      title={label}
      className={cn(
        "mt-0.5 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border bg-background text-muted-foreground transition hover:text-foreground",
        state === "copied" && "text-primary",
        state === "failed" && "text-destructive",
      )}
    >
      {state === "copied" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

