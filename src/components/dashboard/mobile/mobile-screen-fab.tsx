"use client";

import { MessageCircleQuestion, Plus } from "lucide-react";

type MobileScreenFabProps = {
  /**
   * 下端に絞り込み行・ビュー切り替え行など固定の帯がある画面で立てる（#1645）。
   * true: 帯を避けて `bottom-22` / false: `bottom-4`
   */
  raised?: boolean;
  onCreateIssue: () => void;
  onAskCrossRepoQuestion: () => void;
};

/**
 * スマホの右下に常時表示する操作ボタン（#2660）。設定画面を除く全モバイル画面で
 * 共通のこの1つに一本化している。**位置・見た目を画面ごとに変えない**——
 * 同じ動作のボタンが画面ごとに違う位置にあると探すことになるため（#1690・#1945）。
 */
export function MobileScreenFab({ raised, onCreateIssue, onAskCrossRepoQuestion }: MobileScreenFabProps) {
  return (
    <div className={`absolute right-4 z-20 flex items-center gap-3 ${raised ? "bottom-22" : "bottom-4"}`}>
      <button
        type="button"
        onClick={onAskCrossRepoQuestion}
        aria-label="複数リポジトリに質問する"
        className="flex size-14 items-center justify-center rounded-full border bg-background shadow-lg"
      >
        <MessageCircleQuestion className="size-6" />
      </button>
      <button
        type="button"
        onClick={onCreateIssue}
        aria-label="新しいIssueを作成"
        className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
      >
        <Plus className="size-6" />
      </button>
    </div>
  );
}
