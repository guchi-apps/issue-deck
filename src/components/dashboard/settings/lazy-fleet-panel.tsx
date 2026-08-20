"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";

type LazyFleetPanelProps = {
  icon: LucideIcon;
  title: string;
  /** 何をする区画かの1行。開いていなくても常に出す */
  description: string;
  /** 開くと何を取りに行くか。**開く前にだけ**出す（開いた後は結果が答えになる） */
  loadHint?: string;
  /** 見出しの右に出す状態のチップ。開かなくても分かるものだけを渡す */
  badge?: ReactNode;
  children: ReactNode;
};

/**
 * 「フリート運用」の各区画を、**押すまで読み込まないカード**にする（#2022）。
 *
 * **なぜ畳むか。** 以前はこの区分を開いた時点で、共有ワークフローのタグ照会（GitHubへの
 * 問い合わせ）とシークレット同期の履歴がまとめて走っていた。1つを見に来ただけでも
 * 全部が走り、開くまでの待ちも、見ないものの取得に費やされていた。
 *
 * **畳めば必ず取得が減るとは限らない。** 中身が自分で取りに行く区画（このカードの本来の
 * 相手）では減るが、外側が先に取っているデータを表示するだけの区画では、減るのは
 * 描画だけになる（設定のPAT一覧がそれで、警告バッジのために先読みしている）。
 *
 * **一度開いたら、閉じてもアンマウントしない。** 中のフックは`open`が真になった時点で
 * 取得するため、開閉のたびにマウントし直すと同じ取得が何度も走る。畳むときは`hidden`で
 * 隠すだけにして、入力中の値（対象キーなど）と取得済みの結果を保つ。
 */
export function LazyFleetPanel({
  icon: Icon,
  title,
  description,
  loadHint,
  badge,
  children,
}: LazyFleetPanelProps) {
  const [open, setOpen] = useState(false);
  // 一度でも開いたか。真になったら以後は隠すだけで、中身は消さない
  const [mounted, setMounted] = useState(false);
  // 見出しの文字列をidにしない（空白や記号を含み、`aria-controls`の参照が壊れる）
  const contentId = useId();

  return (
    <section className="rounded-lg border">
      <div className="flex items-start gap-2 p-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium">{title}</span>
          <span className="text-xs text-muted-foreground">{description}</span>
          {/* 押すと何が起きるかは、押す前にだけ要る */}
          {!mounted && loadHint && (
            <span className="text-xs text-muted-foreground">{loadHint}</span>
          )}
        </div>

        {badge}

        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => {
            setMounted(true);
            setOpen((current) => !current);
          }}
          className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
        >
          {open ? "閉じる" : "開く"}
          <ChevronRight className={`size-3 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
      </div>

      {mounted && (
        <div id={contentId} hidden={!open} className="border-t p-3">
          {children}
        </div>
      )}
    </section>
  );
}
