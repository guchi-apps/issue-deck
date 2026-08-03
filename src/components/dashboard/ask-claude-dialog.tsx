"use client";

import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { askClaudeCommentBody } from "@/lib/github/ask-claude";
import type { Issue, IssueComment } from "@/types/issue";

type AskClaudeDialogProps = {
  issue: Issue;
  onCommentCreated: (comment: IssueComment) => void;
  onIssueUpdated: (issue: Issue) => void;
  /** トリガーボタンを自前で描画したい場合に指定する（Issue詳細画面での利用を想定） */
  renderTrigger: (isSubmitting: boolean) => ReactNode;
};

/**
 * 「Claudeに質問する」ボタン押下時に、質問文を入力させるダイアログ。
 * コード変更やブランチ作成を伴わない読み取り専用の質問として、定型プレフィックス
 * 付きのコメントを投稿する（claude-issue-dispatch.ymlのmode=ask判定に使う）。
 */
export function AskClaudeDialog({ issue, onCommentCreated, onIssueUpdated, renderTrigger }: AskClaudeDialogProps) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const { createComment, isSubmitting } = useIssueCommentMutations();

  async function handleAsk() {
    if (!question.trim()) return;

    const [owner, repo] = issue.repositoryFullName.split("/");
    const created = await createComment({
      owner,
      repo,
      number: issue.number,
      body: askClaudeCommentBody(question),
    });
    if (!created) return;

    onCommentCreated(created);
    onIssueUpdated({ ...issue, commentCount: issue.commentCount + 1 });
    setQuestion("");
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{renderTrigger(isSubmitting)}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Claudeに質問する</DialogTitle>
          <DialogDescription>
            コードは変更されません。回答はコメントとして返るまで数十秒〜数分かかります。
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="質問内容を入力してください"
          rows={4}
          autoFocus
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={isSubmitting}>
              キャンセル
            </Button>
          </DialogClose>
          <Button onClick={handleAsk} disabled={isSubmitting || !question.trim()}>
            質問する
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
