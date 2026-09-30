"use client";

import { KnowledgeBoardPanel } from "@/components/dashboard/knowledge-board-panel";
import { useKnowledgeBoard } from "@/hooks/use-knowledge-board";

/**
 * 設定の「共通知識」区分（#3645）。以前は左メニューの専用画面だったが、反映PRが自動マージに
 * なり（`promotion-merge-sweep`）人が待つ画面ではなくなったため、設定の1項目へ移した。
 * 区分を開いている間だけ取得する（親が区分ごとに描画を切り替えるので、マウント時に取得する）。
 */
export function KnowledgeSection({ compact = false }: { compact?: boolean }) {
  const board = useKnowledgeBoard(true);
  return (
    <KnowledgeBoardPanel
      data={board.data}
      isLoading={board.isLoading}
      error={board.error}
      onRefresh={board.refresh}
      compact={compact}
    />
  );
}
