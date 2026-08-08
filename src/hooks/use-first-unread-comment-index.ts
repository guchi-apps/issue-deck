"use client";

import { useState } from "react";

import { computeFirstUnreadCommentIndex } from "@/lib/scroll-to-latest";
import type { Issue, IssueComment } from "@/types/issue";

/**
 * 選択中Issueの「最初の未読コメント」のインデックス（0始まり）を返す。
 *
 * Issue詳細画面を開くと、issue-deck-shell.tsx側のuseEffectがreadCommentCountを
 * 即座に「全件既読」まで上書きしてしまう（POST /api/issues/read）。そのため、
 * その上書きより前の時点のreadCommentCountをここでスナップショットしておき、
 * Issueが切り替わるまではそのスナップショットを使い続ける（レンダリング中のref
 * アクセスはreact-hooks/refsルールで禁止されているため、Reactが公式に推奨する
 * 「前回レンダーの情報を保存する」パターンに従いuseStateで保持する）。
 */
export function useFirstUnreadCommentIndex(
  issue: Issue | null,
  comments: IssueComment[],
): number {
  const [snapshot, setSnapshot] = useState<{ issueId: string; readCommentCount: number } | null>(
    null,
  );

  if (issue && snapshot?.issueId !== issue.id) {
    setSnapshot({ issueId: issue.id, readCommentCount: issue.readCommentCount });
  }

  const readCommentCount =
    issue && snapshot?.issueId === issue.id ? snapshot.readCommentCount : 0;

  return computeFirstUnreadCommentIndex(readCommentCount, comments.length);
}
