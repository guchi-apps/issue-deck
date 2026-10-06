"use client";

import { Check, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { formatMonthDayTime } from "@/lib/format-date-time";
import type { ChatMemoryOp } from "@/lib/chat/session";
import type { ChatActionRecord, ChatFreshness, ChatMemory, ChatMemoryItem } from "@/lib/chat/types";

function formatTime(iso: string | null): string {
  return iso ? formatMonthDayTime(iso) : "不明";
}

function MemoryList({
  title,
  kind,
  items,
  onOp,
}: {
  title: string;
  kind: "agreement" | "openQuestion";
  items: ChatMemoryItem[];
  onOp: (op: ChatMemoryOp) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[11px] font-bold">{title}</h3>
      <ul className="flex flex-col gap-1">
        {items.length === 0 && <li className="text-[11px] text-muted-foreground">まだありません。</li>}
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-1 text-xs">
            <span className={item.resolvedAt ? "flex-1 text-muted-foreground line-through" : "flex-1"}>{item.text}</span>
            {kind === "openQuestion" && !item.resolvedAt && (
              <Button variant="ghost" size="icon-sm" aria-label="解決済みにする" onClick={() => onOp({ op: "resolve", id: item.id })}><Check /></Button>
            )}
            <Button variant="ghost" size="icon-sm" aria-label="削除" onClick={() => onOp({ op: "remove", kind, id: item.id })}><Trash2 /></Button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (!text) return;
          onOp({ op: "add", kind, text });
          setDraft("");
        }}
      >
        <input
          aria-label={`${title}を追加`}
          maxLength={300}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="h-7 min-w-0 flex-1 rounded border bg-transparent px-1.5 text-xs"
        />
        <Button type="submit" variant="outline" size="icon-sm" aria-label="追加"><Plus /></Button>
      </form>
    </section>
  );
}

/**
 * 会話メモ（合意した方針・未解決の質問）と、調査した時点／いまの状態、実行記録（#4047）。
 * メモは再開時の手がかりで、**実行してよい操作の根拠にはならない**（実行は確認カードだけ）。
 */
export function ChatMemoryPanel({
  memory,
  freshness,
  actions,
  onOp,
}: {
  memory: ChatMemory;
  freshness: ChatFreshness[] | null;
  actions: ChatActionRecord[];
  onOp: (op: ChatMemoryOp) => void;
}) {
  return (
    <div className="flex flex-col gap-3 text-xs">
      <p className="text-[11px] text-muted-foreground">メモは再開時の手がかりです。操作の許可にはなりません（実行は確認カードを押したときだけ）。</p>
      <MemoryList title="合意した方針" kind="agreement" items={memory.agreements} onOp={onOp} />
      <MemoryList title="未解決の質問" kind="openQuestion" items={memory.openQuestions} onOp={onOp} />

      <section className="flex flex-col gap-1">
        <h3 className="text-[11px] font-bold">調査結果（調査時点 → いま）</h3>
        {memory.findings.length === 0 && <p className="text-[11px] text-muted-foreground">状態を確認すると、その時点の結果がここに残ります。</p>}
        {memory.findings.map((finding) => {
          const fresh = freshness?.find((item) => item.repo === finding.repo && item.number === finding.number);
          return (
            <div key={`${finding.repo}#${finding.number}`} className="rounded border p-1.5">
              <p className="font-mono">{finding.repo}#{finding.number} <span className="font-sans text-muted-foreground">{finding.title}</span></p>
              <p className="text-[10px] text-muted-foreground">調査時点: {formatTime(finding.capturedAt)}</p>
              {fresh?.error && <p className="text-[11px] text-destructive">いまの状態を取得できません：{fresh.error}</p>}
              {fresh && !fresh.error && fresh.changes.length === 0 && <p className="text-[11px] text-emerald-700 dark:text-emerald-300">調査時点から変化はありません。</p>}
              {fresh?.changes.map((change) => (
                <p key={change.label} className="text-[11px]">
                  <span className="font-semibold">{change.label}</span>：{change.before} → <span className="font-semibold text-amber-700 dark:text-amber-300">{change.after}</span>（いま）
                </p>
              ))}
            </div>
          );
        })}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-[11px] font-bold">実行記録</h3>
        {actions.length === 0 && <p className="text-[11px] text-muted-foreground">この会話から実行した操作はありません。</p>}
        {actions.map((action, index) => (
          <p key={`${action.at}-${index}`} className="text-[11px]">
            <span className="text-muted-foreground">{formatTime(action.at)}</span> {action.type === "repair" ? "PR自動修正" : "Issue作成"}
            {action.number != null && ` ${action.repo}#${action.number}`}：{action.message}
          </p>
        ))}
      </section>
    </div>
  );
}
