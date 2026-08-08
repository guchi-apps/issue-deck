"use client";

import { useRef } from "react";

import { computeFirstUnreadCommentIndex } from "@/lib/scroll-to-latest";
import type { Issue, IssueComment } from "@/types/issue";

/**
 * 選択中Issueの「最初の未読コメント」のインデックス（0始まり）を返す。
 *
 * Issue詳細画面を開くと、issue-deck-shell.tsx側のuseEffectがreadCommentCountを
 * 即座に「全件既読」まで上書きしてしまう（POST /api/issues/read）。そのため、
 * その上書きより前の時点のreadCommentCountをここでレンダリング中にrefへ
 * スナップショットしておき、Issueが切り替わるまではそのスナップショットを使い続ける。
 */
export function useFirstUnreadCommentIndex(
  issue: Issue | null,
  comments: IssueComment[],
): number {
  const snapshotRef = useRef<{ issueId: string; readCommentCount: number } | null>(null);

  if (issue && snapshotRef.current?.issueId !== issue.id) {
    snapshotRef.current = { issueId: issue.id, readCommentCount: issue.readCommentCount };
  }

  const readCommentCount =
    issue && snapshotRef.current?.issueId === issue.id ? snapshotRef.current.readCommentCount : 0;

  return computeFirstUnreadCommentIndex(readCommentCount, comments.length);
}
