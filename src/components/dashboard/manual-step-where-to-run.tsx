"use client";

import { Check, Copy, MonitorSmartphone, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/copy-text";
import { matchManualStepDeviceNames, type ManualStepGuide } from "@/lib/manual-step-guide";

/**
 * 手作業を自分で実行するときの「どこから実行するか」（#1882）。
 *
 * 代行実行が失敗したとき、人は本番VPSやサブPCへ入って同じことをやり直す。そのときいちばん
 * 分からないのが**どこへ入って、どのディレクトリで打つのか**だった。手順のコマンドは
 * 画面に出ているが、それは`cd`済みの場所で打つ前提で書かれており、接続先は
 * `## 前提条件`の「実行するデバイス」の括弧書きにしか無い（チップからは落としている）。
 *
 * ここでは**接続 → 移動 → 実行**を1つの並びにして、まとめてコピーできるようにする。
 * 代行実行はホームディレクトリから走る（`scripts/run-manual-step.sh`）ので、`cd`の行を
 * 省略すると手元での再現にならない。
 *
 * **出すのは本文から拾ったものだけ。** 接続コマンドが書かれていなければその行ごと出さず、
 * ホスト名から`ssh …`を組み立てたりしない——推測した接続先を出すと、それが正しいかを
 * 確かめる手間が増える。
 *
 * **PC・スマホで同じコンポーネントを使う**（アシスタントの他の部品と同じ方針）。
 */
export function ManualStepWhereToRun({
  where,
  device,
  command,
  /** 代行できない理由（サブPC以外の手作業など）。あれば見出しの下に出す */
  reason,
}: {
  where: ManualStepGuide["where"];
  /**
   * その手順を実行する端末（#2052）。`resolveManualStepDevice`で解決済みの値を受ける——
   * ここで`where.device`を読み直すと、手順ごとに違う端末が案内できなくなる。
   */
  device: string | null;
  /** 実行するコマンド。手順にコマンドが無い場合は`null`で、接続と移動だけを案内する */
  command: string | null;
  reason?: string | null;
}) {
  const lines = buildWhereToRunLines(where, command, device);
  if (lines.length === 0) return null;

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
      <ol className="flex flex-col gap-2">
        {lines.map((line, order) => (
          <li key={line.command} className="flex gap-2">
            <span
              className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-violet-500/40 bg-violet-500/10 font-mono text-[10px] text-violet-700 dark:text-violet-300"
              aria-hidden
            >
              {order + 1}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">{line.label}</span>
              <pre className="overflow-x-auto rounded border bg-background p-2 font-mono text-xs leading-relaxed">
                {line.command}
              </pre>
            </span>
          </li>
        ))}
      </ol>
      {/* **スマホでは全幅の1つにする**（#2403）。この並びは「コピー → ターミナルアプリで実行 →
          戻る」の起点で、押す先が右下の小さなボタンだと片手では届きにくい。PCでは従来どおり右寄せ */}
      <div className="flex sm:justify-end">
        <CopyAllButton lines={lines.map((line) => line.command)} />
      </div>
    </section>
  );
}

type WhereToRunLine = { label: string; command: string };

/**
 * 手元に居るだけで作業できる端末（#2052）。ここへ`ssh …`は要らない。
 *
 * 接続コマンドは`## 前提条件`の1行から拾ったもので、**どの端末へ入るためのものかまでは
 * 分からない**。ブラウザ・メインPCの手順でそれを出すと、`ssh subpc`してから
 * ブラウザを開けと読める案内になる。
 */
const LOCAL_DEVICES = ["ブラウザ", "メインPC"];

/**
 * 「接続 → 移動 → 実行」の並びを作る。**書かれていない行は出さない。**
 *
 * 移動の行は、カレントディレクトリがパスとして読める場合だけ出す（`## 前提条件`には
 * 「不要」やリポジトリ名だけが書かれることもあり、そのまま`cd`にすると動かない）。
 *
 * @param device その手順を実行する端末（`resolveManualStepDevice`の結果）
 */
export function buildWhereToRunLines(
  where: ManualStepGuide["where"],
  command: string | null,
  device: string | null = where.device,
): WhereToRunLine[] {
  const names = matchManualStepDeviceNames(device);
  const isLocal = names.length === 1 && LOCAL_DEVICES.includes(names[0]);
  const connect = isLocal ? null : where.connect;
  const lines: WhereToRunLine[] = [];
  if (connect !== null) {
    lines.push({ label: "つなぐ", command: connect });
  }
  if (where.directory !== null && /^[~/.]/.test(where.directory)) {
    lines.push({ label: "移動する", command: `cd ${where.directory}` });
  }
  if (command !== null && command.trim() !== "") {
    lines.push({ label: "実行する（本文に書かれたコマンド）", command });
  }
  // 実行するコマンドだけが分かっていて、接続も移動も無いなら案内する値が無い
  return lines.length <= 1 && connect === null ? [] : lines;
}

/** 並び全体を1回でコピーする。**コピーできたときだけ成功表示を出す**（`markdown-body`と同じ） */
function CopyAllButton({ lines }: { lines: string[] }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  async function handleCopy() {
    const ok = await copyText(lines.join("\n"));
    setState(ok ? "copied" : "failed");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1500);
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="w-full sm:w-auto"
      onClick={() => void handleCopy()}
    >
      {state === "copied" ? <Check /> : <Copy />}
      {state === "copied"
        ? "コピーしました"
        : state === "failed"
          ? "コピーできませんでした"
          : `${lines.length}行まとめてコピー`}
    </Button>
  );
}
