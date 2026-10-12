"use client";

import { X } from "lucide-react";

/**
 * 一覧側に出す、選択中のラベル条件（#4543）。左メニューのラベル一覧を撤去したため、
 * 既存URLなどでラベルが効いている間も、PCの一覧上で確認・解除できるようにする。
 * 選択が無いときは何も描かない。
 */
export function ActiveLabelChips({
  labels,
  onRemove,
  onClear,
}: {
  labels: string[];
  onRemove: (label: string) => void;
  onClear: () => void;
}) {
  if (labels.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2 text-xs"
      aria-label="選択中のラベル条件"
    >
      <span className="text-muted-foreground">ラベル:</span>
      {labels.map((label) => (
        <button
          key={label}
          type="button"
          onClick={() => onRemove(label)}
          title={`ラベル「${label}」の絞り込みを外す`}
          className="inline-flex max-w-full items-center gap-1 rounded-full border bg-accent px-2 py-0.5 hover:bg-accent/70"
        >
          <span className="truncate">{label}</span>
          <X className="size-3 shrink-0" aria-hidden />
        </button>
      ))}
      {labels.length > 1 && (
        <button type="button" onClick={onClear} className="text-primary hover:underline">
          すべて解除
        </button>
      )}
    </div>
  );
}
