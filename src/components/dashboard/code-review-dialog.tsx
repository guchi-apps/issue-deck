"use client";

import { useEffect, useMemo, useState } from "react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useDispatchState } from "@/hooks/use-dispatch-state";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import {
  canCodeReviewRepository,
  describeCodeReviewRejection,
  resolveCodeReviewRejection,
  resolveDefaultCodeReviewHost,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  buildCodeReviewIssueBody,
  buildCodeReviewTitle,
  CODE_REVIEW_FOCUS_MAX_LENGTH,
  codeReviewRequestCommentBody,
} from "@/lib/github/code-review";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

/**
 * 重点的に見る観点のプリセット（#698）。**押すと本文へ足すだけ**で、選択状態は持たない。
 *
 * 観点を自由記述だけにすると、たいてい空のまま実行されて「リポジトリ全体を薄く見る」結果に
 * なる。よく使う切り口を並べておくと、押すだけで焦点が付く。
 */
const FOCUS_PRESETS = [
  "認証・認可",
  "競合・二重実行",
  "エラー処理",
  "テストの穴",
  "CLAUDE.mdとの矛盾",
] as const;

/**
 * リポジトリ全体のコードレビューを実行するダイアログ（#698）。Claude Codeの`/code-review`に
 * 当たるものを、1リポジトリまるごとに対して走らせる。
 *
 * 流れは横断質問（`CrossRepoQuestionDialog`）と同じ。**レビューIssueを1件作り、依頼コメントを
 * 投稿し、サブPCへレビューのジョブを積む。** 記録をGitHubのIssueにしてあるので、通知・
 * 実行中バッジ・実行の取り消し・スマホ表示は既存の仕組みがそのまま効く。
 *
 * **記録先は「レビュー対象のリポジトリ」で、選ばせない。** 横断質問が専用の`question`
 * リポジトリを既定にしているのは参照範囲が全リポジトリだからで、こちらは対象が1つに決まって
 * いる。指摘とコードが同じ場所にある方が、後から辿れる。
 *
 * **選択肢に出るのは、そのホストがレビューできるリポジトリだけ**（サブPCにチェックアウトが
 * あるもの）。選ばせてから断らない——読むコードが無ければレビューは成立しない。
 */
export function CodeReviewDialog({
  open,
  onOpenChange,
  repositories,
  defaultRepositoryFullName,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositories: ConnectedRepository[];
  defaultRepositoryFullName?: string | null;
  onCreated: (issue: Issue) => void;
}) {
  const { createIssue, isSubmitting: isCreatingIssue, error: createError, setError: setCreateError } =
    useIssueMutations();
  const {
    createComment,
    isSubmitting: isCreatingComment,
    error: commentError,
    setError: setCommentError,
  } = useIssueCommentMutations();

  const [repositoryFullName, setRepositoryFullName] = useState("");
  const [focus, setFocus] = useState("");
  const [hostName, setHostName] = useState<string | null>(null);
  /**
   * Issueは作れたのにジョブを積めなかった場合に残るレビューIssue（横断質問と同じ扱い）。
   * **これがある間は作り直さない。** 再送信では積み直しだけを行う。
   */
  const [pendingIssue, setPendingIssue] = useState<Issue | null>(null);

  // 開いている間だけ取得する（閉じているダイアログのためにポーリングを増やさない）
  const dispatch = useDispatchState(open);
  const { setError: setDispatchError, hosts } = dispatch;

  /** レビューできるリポジトリ＝どこかのホストにチェックアウトがあるもの */
  const reviewableRepositories = useMemo(
    () => repositories.filter((repo) => canCodeReviewRepository(hosts, repo.fullName)),
    [repositories, hosts],
  );

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocus("");
    setHostName(null);
    setPendingIssue(null);
    setCreateError(null);
    setCommentError(null);
    setDispatchError(null);
  }, [open, setCreateError, setCommentError, setDispatchError]);

  // 選択肢はホストの申告が届いてから確定するため、リポジトリの初期値は別に決める
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRepositoryFullName((current) => {
      if (current && reviewableRepositories.some((repo) => repo.fullName === current)) return current;
      if (
        defaultRepositoryFullName &&
        reviewableRepositories.some((repo) => repo.fullName === defaultRepositoryFullName)
      ) {
        return defaultRepositoryFullName;
      }
      return reviewableRepositories[0]?.fullName ?? "";
    });
  }, [open, defaultRepositoryFullName, reviewableRepositories]);

  const isSubmitting = isCreatingIssue || isCreatingComment || dispatch.isSubmitting;

  const defaultHostName = resolveDefaultCodeReviewHost(hosts, repositoryFullName);
  const effectiveHostName = hostName ?? defaultHostName ?? hosts[0]?.name ?? null;
  const selectedHost = hosts.find((host) => host.name === effectiveHostName) ?? null;

  /** 押す前に出す拒否理由。まだIssueを作っていないので、未完了ジョブの判定は無い */
  const rejection = repositoryFullName
    ? resolveCodeReviewRejection({
        host: selectedHost,
        repositoryFullName,
        hasActiveJob: false,
      })
    : null;
  const rejectionMessage =
    rejection && effectiveHostName
      ? describeCodeReviewRejection(rejection, {
          hostName: effectiveHostName,
          repositoryFullName,
        })
      : rejection
        ? "コードレビューを実行できるホストがありません（サブPCのpollerが動いているか確認してください）。"
        : null;

  function appendFocusPreset(preset: string) {
    setFocus((current) => {
      if (current.includes(preset)) return current;
      const next = current.trim() === "" ? preset : `${current.trim()}・${preset}`;
      return next.slice(0, CODE_REVIEW_FOCUS_MAX_LENGTH);
    });
  }

  /**
   * レビューIssueを作る → 依頼コメントを投稿する → サブPCへレビューのジョブを積む。
   * 積めなかった場合、Issueは作り直さない（押し直しでは起動だけをやり直す）。
   */
  async function handleSubmit() {
    if (!repositoryFullName || !effectiveHostName || rejection) return;

    let issue = pendingIssue;
    if (!issue) {
      const created = await createIssue({
        repositoryFullName,
        title: buildCodeReviewTitle(repositoryFullName),
        body: buildCodeReviewIssueBody({ repositoryFullName, focus }),
        labels: [],
        assignee: null,
      });
      if (!created) return;

      const [owner, repo] = repositoryFullName.split("/");
      const comment = await createComment({
        owner,
        repo,
        number: created.number,
        body: codeReviewRequestCommentBody(focus),
      });
      issue = comment ? { ...created, commentCount: created.commentCount + 1 } : created;
      setPendingIssue(issue);
    }

    const enqueued = await dispatch.enqueue({
      repositoryFullName: issue.repositoryFullName,
      issueNumber: issue.number,
      hostName: effectiveHostName,
      kind: "code_review",
    });
    // 積めなかった理由は`dispatch.error`に入り、下のApiErrorMessageへ出る。
    // **ダイアログは閉じない**（作成済みのIssueへ、そのまま積み直せるようにする）
    if (!enqueued) return;

    setFocus("");
    setPendingIssue(null);
    onOpenChange(false);
    onCreated(issue);
  }

  const canSubmit = !isSubmitting && Boolean(repositoryFullName) && rejection === null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSubmit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>コードレビューを実行</DialogTitle>
          <DialogDescription>
            サブPCで読み取り専用のセッションを立て、リポジトリ全体を読みます。結果はレビュー用に作るIssueのコメントとして返ります。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="code-review-repo">対象リポジトリ</Label>
            {reviewableRepositories.length > 0 ? (
              <Select value={repositoryFullName} onValueChange={setRepositoryFullName}>
                <SelectTrigger id="code-review-repo" className="w-full">
                  <SelectValue placeholder="リポジトリを選択" />
                </SelectTrigger>
                <SelectContent>
                  {reviewableRepositories.map((repo) => (
                    <SelectItem key={repo.id} value={repo.fullName}>
                      {repo.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-muted-foreground">
                レビューできるリポジトリがありません（サブPCにチェックアウトがあり、pollerが動いているリポジトリだけを選べます）。
              </p>
            )}
            {reviewableRepositories.length > 0 && (
              <p className="text-xs text-muted-foreground">
                サブPCにチェックアウトがあるリポジトリだけを表示しています（{repositories.length}件中{" "}
                {reviewableRepositories.length}件）。
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="code-review-focus">重点的に見てほしい観点（任意）</Label>
            <div className="flex flex-wrap gap-1.5">
              {FOCUS_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  size="xs"
                  variant="outline"
                  className={cn("rounded-full", focus.includes(preset) && "bg-accent")}
                  onClick={() => appendFocusPreset(preset)}
                >
                  {preset}
                </Button>
              ))}
            </div>
            <Textarea
              id="code-review-focus"
              value={focus}
              maxLength={CODE_REVIEW_FOCUS_MAX_LENGTH}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="例: 認証まわりと dispatch の競合"
              className="min-h-20 md:text-sm"
            />
            <p className="text-xs text-muted-foreground">
              空のままでもレビューできます。観点を書くと、そこから優先して読みます。
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="code-review-host">実行先</Label>
            {hosts.length > 1 ? (
              <Select value={effectiveHostName ?? ""} onValueChange={(value) => setHostName(value)}>
                <SelectTrigger id="code-review-host" className="w-full">
                  <SelectValue placeholder="実行先を選択" />
                </SelectTrigger>
                <SelectContent>
                  {hosts.map((host) => (
                    <SelectItem key={host.name} value={host.name}>
                      {formatDispatchHostName(host.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm">
                {effectiveHostName
                  ? formatDispatchHostName(effectiveHostName)
                  : "実行できるホストがありません"}
              </p>
            )}
            {rejectionMessage && <p className="text-xs text-destructive">{rejectionMessage}</p>}
          </div>

          {repositoryFullName && (
            <p className="text-xs text-muted-foreground">
              実行すると <span className="font-medium">{repositoryFullName}</span> に「
              {buildCodeReviewTitle(repositoryFullName)}」というIssueが1件作られ、結果はそこへ返ります。
            </p>
          )}

          {pendingIssue && (
            <p className="text-xs text-muted-foreground">
              レビューIssue #{pendingIssue.number} は作成済みです。もう一度押すと、起動だけをやり直します。
            </p>
          )}
          <ApiErrorMessage message={createError ?? commentError ?? dispatch.error} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isSubmitting ? "送信中..." : pendingIssue ? "起動を再試行" : "レビューを開始"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
