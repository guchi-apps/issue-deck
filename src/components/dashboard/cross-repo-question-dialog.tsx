"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { BodyCleanupButton } from "@/components/dashboard/body-cleanup-button";
import { LabelPicker } from "@/components/dashboard/label-picker";
import { getRepoIssueSuggestions, MentionTextarea } from "@/components/dashboard/mention-textarea";
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
import { useDispatchState } from "@/hooks/use-dispatch-state";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import {
  describeCrossRepoQuestionRejection,
  resolveCrossRepoQuestionRejection,
  resolveDefaultCrossRepoQuestionHost,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  buildAskRepoQuestionTitle,
  crossRepoQuestionCommentBody,
  resolveCrossRepoQuestionRepository,
} from "@/lib/github/ask-claude";
import { isSelectableLabelName } from "@/lib/github/start-implementation";
import { getLabelBadgeStyle } from "@/lib/label-color";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

type CrossRepoQuestionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositories: ConnectedRepository[];
  defaultRepositoryFullName?: string | null;
  /** 本文の`#123`補完に使う（記録先リポジトリのIssueだけを候補にする） */
  issues: Issue[];
  onCreated: (issue: Issue) => void;
};

/**
 * 複数リポジトリ横断の質問（#1454）。質問Issueを1件作り、**サブPCで全リポジトリを参照できる
 * 質問セッションを立てて**答えさせる。GitHub Actionsは1リポジトリしかチェックアウトしないため、
 * こちらの経路では使えない。
 *
 * **単一リポジトリへの質問はここには無い**（#1641）。本文・画像添付・ラベルがIssue作成と同じ
 * ものである以上、入口を分ける理由が無いため、新規作成ダイアログ（`CreateIssueDialog`）の
 * 「質問」種別へ移した。このダイアログが横断だけを扱うのは、リポジトリの絞り込み条件
 * （ワークフロー不要）も実行先の選択も単一とは別物で、種別として並べると条件分岐が
 * 増えるだけになるため。
 */
export function CrossRepoQuestionDialog({
  open,
  onOpenChange,
  repositories,
  defaultRepositoryFullName,
  issues,
  onCreated,
}: CrossRepoQuestionDialogProps) {
  const { createIssue, isSubmitting: isCreatingIssue, error: createError, setError: setCreateError } =
    useIssueMutations();
  const {
    createComment,
    isSubmitting: isCreatingComment,
    error: commentError,
    setError: setCommentError,
  } = useIssueCommentMutations();

  const [repositoryFullName, setRepositoryFullName] = useState("");
  const [question, setQuestion] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [hostName, setHostName] = useState<string | null>(null);
  const [isImageUploading, setIsImageUploading] = useState(false);
  /**
   * Issueとコメントは作れたのにジョブを積めなかった場合に残る質問Issue（#1454）。
   *
   * **これがある間は作成をやり直さない。** そのまま再送信するとIssueが二重に作られる。
   * ボタンの文言も「起動を再試行」に変える。
   */
  const [pendingIssue, setPendingIssue] = useState<Issue | null>(null);

  // 開いている間だけ取得する（閉じているダイアログのためにポーリングを増やさない）
  const dispatch = useDispatchState(open);
  const { setError: setDispatchError } = dispatch;

  /**
   * 質問Issueを置けるリポジトリ。**ワークフローの有無で絞らない**（#1454）。
   * 回答するのはサブPCのセッションで、記録先には`gh issue comment`で書くだけなので、
   * `claude-issue-dispatch.yml`が無いリポジトリ（横断質問専用の`question`など）でも成立する。
   */
  const recordableRepositories = repositories;

  const { labels, isLoading: isMetaLoading } = useIssueRepoMeta(open ? repositoryFullName : null);
  const selectableLabels = useMemo(
    () => labels.filter((label) => isSelectableLabelName(label.name)),
    [labels],
  );
  const issueSuggestions = useMemo(
    () => getRepoIssueSuggestions(issues, repositoryFullName),
    [issues, repositoryFullName],
  );

  useEffect(() => {
    if (!open) return;
    // 記録先の既定は`question`リポジトリ（#1454）。無ければ渡された文脈のリポジトリか一覧の先頭
    const fallback =
      defaultRepositoryFullName &&
      recordableRepositories.some((repo) => repo.fullName === defaultRepositoryFullName)
        ? defaultRepositoryFullName
        : (recordableRepositories[0]?.fullName ?? "");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRepositoryFullName(
      resolveCrossRepoQuestionRepository(
        recordableRepositories.map((repo) => repo.fullName),
        fallback,
      ) ?? "",
    );
    setQuestion("");
    setSelectedLabels([]);
    setHostName(null);
    setIsImageUploading(false);
    setPendingIssue(null);
    setCreateError(null);
    setCommentError(null);
    setDispatchError(null);
    // recordableRepositoriesはrepositoriesから毎レンダー再計算されるため依存に含めない
    // （含めると開いている間に無関係な再選択が発生し得る）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultRepositoryFullName, setCreateError, setCommentError, setDispatchError]);

  const isSubmitting = isCreatingIssue || isCreatingComment || dispatch.isSubmitting;

  /**
   * 起動先。**選ばれていなければ既定（選べるホストの先頭）を使う。**
   * GitHub Actionsへのフォールバックは無い（横断はサブPC限定）。
   */
  const defaultHostName = resolveDefaultCrossRepoQuestionHost(dispatch.hosts);
  const effectiveHostName = hostName ?? defaultHostName ?? dispatch.hosts[0]?.name ?? null;
  const selectedHost = dispatch.hosts.find((host) => host.name === effectiveHostName) ?? null;
  /**
   * 押す前に出す拒否理由（#1454）。**まだIssueを作っていないので、未完了ジョブと生存セッションの
   * 判定は無い**（そちらは積む時点でAPI側が見る）。
   */
  const rejection = resolveCrossRepoQuestionRejection({
    host: selectedHost,
    hasActiveJob: false,
    blockingSession: null,
  });
  const rejectionMessage =
    rejection && effectiveHostName
      ? describeCrossRepoQuestionRejection(rejection, { hostName: effectiveHostName })
      : rejection
        ? "横断質問を実行できるホストがありません（サブPCのpollerが動いているか確認してください）。"
        : null;

  function toggleLabel(name: string) {
    setSelectedLabels((prev) =>
      prev.includes(name) ? prev.filter((l) => l !== name) : [...prev, name],
    );
  }

  /**
   * 質問Issueを作る → Actionsを起こさない質問コメントを投稿する →
   * サブPCへ質問セッションのジョブを積む、の順で進める。
   *
   * **ジョブを積めなかった場合、質問Issueは作り直さない。** 作成済みのIssueを持っておき、
   * 再送信では積み直しだけを行う（やり直すたびに質問Issueが増えるのを避ける）。
   */
  async function handleSubmit() {
    if (!repositoryFullName || !question.trim() || !effectiveHostName) return;

    let issue = pendingIssue;
    if (!issue) {
      const created = await createIssue({
        repositoryFullName,
        title: buildAskRepoQuestionTitle(question),
        body: question,
        labels: selectedLabels,
        assignee: null,
      });
      if (!created) return;

      const [owner, repo] = repositoryFullName.split("/");
      const comment = await createComment({
        owner,
        repo,
        number: created.number,
        body: crossRepoQuestionCommentBody(question),
      });
      issue = comment ? { ...created, commentCount: created.commentCount + 1 } : created;
      setPendingIssue(issue);
    }

    const enqueued = await dispatch.enqueue({
      repositoryFullName: issue.repositoryFullName,
      issueNumber: issue.number,
      hostName: effectiveHostName,
      kind: "cross_repo_question",
    });
    // 積めなかった理由は`dispatch.error`に入り、下のApiErrorMessageへ出る。
    // **ダイアログは閉じない**（作成済みのIssueへ、そのまま積み直せるようにする）
    if (!enqueued) return;

    setQuestion("");
    setSelectedLabels([]);
    setPendingIssue(null);
    onOpenChange(false);
    onCreated(issue);
  }

  const canSubmit =
    !isSubmitting &&
    Boolean(repositoryFullName) &&
    Boolean(question.trim()) &&
    !isImageUploading &&
    rejection === null &&
    effectiveHostName !== null;

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
          <DialogTitle>複数リポジトリに質問する</DialogTitle>
          <DialogDescription>
            質問内容でIssueを自動作成し、サブPCで全リポジトリを参照できる質問セッションを起動します。回答はそのIssueのコメントとして返ります。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cross-repo-question-repo">質問Issueの記録先</Label>
            {recordableRepositories.length > 0 ? (
              <Select value={repositoryFullName} onValueChange={setRepositoryFullName}>
                <SelectTrigger id="cross-repo-question-repo" className="w-full">
                  <SelectValue placeholder="リポジトリを選択" />
                </SelectTrigger>
                <SelectContent>
                  {recordableRepositories.map((repo) => (
                    <SelectItem key={repo.id} value={repo.fullName}>
                      {repo.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-muted-foreground">連携しているリポジトリがありません。</p>
            )}
            <p className="text-xs text-muted-foreground">
              質問と回答を残す場所です。参照するのはここだけではなく、サブPCにあるリポジトリ全部です。
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cross-repo-question-host">実行先</Label>
            {dispatch.hosts.length > 1 ? (
              <Select value={effectiveHostName ?? ""} onValueChange={(value) => setHostName(value)}>
                <SelectTrigger id="cross-repo-question-host" className="w-full">
                  <SelectValue placeholder="実行先を選択" />
                </SelectTrigger>
                <SelectContent>
                  {dispatch.hosts.map((host) => (
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
            {selectedHost && (
              <p className="text-xs text-muted-foreground">
                参照範囲: {formatDispatchHostName(selectedHost.name)}にある全リポジトリ（
                {selectedHost.repositories.length}件）
              </p>
            )}
            {rejectionMessage && <p className="text-xs text-destructive">{rejectionMessage}</p>}
          </div>

          {/* 質問内容の入力欄は新規作成ダイアログと同じ部品（#1641）。画像の貼り付けと
              `#123`のIssue補完が横断質問でも使える */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cross-repo-question-body">質問内容</Label>
            <MentionTextarea
              id="cross-repo-question-body"
              value={question}
              onChange={setQuestion}
              issueSuggestions={issueSuggestions}
              onUploadingChange={setIsImageUploading}
              repositoryFullName={repositoryFullName}
              placeholder="質問内容を入力してください"
              className="min-h-32 md:text-sm"
              autoFocus
            />
            <BodyCleanupButton value={question} onCleaned={setQuestion} disabled={isSubmitting} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>ラベル</Label>
            <LabelPicker
              labels={selectableLabels}
              selectedNames={selectedLabels}
              onToggle={toggleLabel}
              isLoading={isMetaLoading}
              trigger={
                <Button variant="outline" className="h-9 w-fit px-3" disabled={isMetaLoading}>
                  {selectedLabels.length > 0 ? `ラベル (${selectedLabels.length})` : "ラベルを選択"}
                  <ChevronDown className="size-3.5" />
                </Button>
              }
            />
            {selectedLabels.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selectedLabels.map((name) => {
                  const label = labels.find((l) => l.name === name);
                  return (
                    <span
                      key={name}
                      className="rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ring-border"
                      style={getLabelBadgeStyle(label?.color ?? "#64748b")}
                    >
                      {name}
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {pendingIssue && (
            <p className="text-xs text-muted-foreground">
              質問Issue #{pendingIssue.number} は作成済みです。もう一度押すと、起動だけをやり直します。
            </p>
          )}
          <ApiErrorMessage message={createError ?? commentError ?? dispatch.error} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isSubmitting ? "送信中..." : pendingIssue ? "起動を再試行" : "質問する"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
