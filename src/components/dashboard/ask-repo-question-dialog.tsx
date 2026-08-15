"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { BodyCleanupButton } from "@/components/dashboard/body-cleanup-button";
import { LabelPicker } from "@/components/dashboard/label-picker";
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
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import {
  describeCrossRepoQuestionRejection,
  resolveCrossRepoQuestionRejection,
  resolveDefaultCrossRepoQuestionHost,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  ASK_REPO_QUESTION_TITLE_PREFIX,
  askClaudeCommentBody,
  crossRepoQuestionCommentBody,
  resolveCrossRepoQuestionRepository,
} from "@/lib/github/ask-claude";
import { isSelectableLabelName } from "@/lib/github/start-implementation";
import { getLabelBadgeStyle } from "@/lib/label-color";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

const ASK_REPO_QUESTION_TITLE_MAX_LENGTH = 40;

/**
 * 質問の対象（#1454）。
 *
 * - `single` … 1リポジトリへの質問。GitHub Actions（mode=ask）が答える従来の経路
 * - `cross` … 複数リポジトリ横断の質問。**サブPCで質問セッションを立てて答える。**
 *   GitHub Actionsは1リポジトリしかチェックアウトしないため、こちらには使えない
 */
type AskQuestionScope = "single" | "cross";

/**
 * 質問文からIssueタイトルを機械的に生成する（Claudeによる自動生成は行わない）。
 * 改行・連続空白は1つの半角スペースにまとめ、長い質問は末尾を省略記号で丸める。
 */
export function buildAskRepoQuestionTitle(question: string): string {
  const normalized = question.trim().replace(/\s+/g, " ");
  const truncated =
    normalized.length > ASK_REPO_QUESTION_TITLE_MAX_LENGTH
      ? `${normalized.slice(0, ASK_REPO_QUESTION_TITLE_MAX_LENGTH)}…`
      : normalized;
  return `${ASK_REPO_QUESTION_TITLE_PREFIX}${truncated}`;
}

type AskRepoQuestionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositories: ConnectedRepository[];
  defaultRepositoryFullName?: string | null;
  onCreated: (issue: Issue) => void;
};

/**
 * Issueを立てずに質問だけで完結させたい要望（#691）への対応。内部的にはIssueを1件
 * 自動作成し、続けて既存の「Claudeに質問する」定型コメント（mode=ask）を投稿する。
 * mode=askの自動応答を前提とするため、claude-issue-dispatch.yml未導入のリポジトリは
 * 選択肢に出さない。
 *
 * **複数リポジトリ横断（#1454）はこのダイアログの中でモードを切り替える。** ヘッダーの
 * ボタンを増やさないのと、質問文・ラベル・タイトル生成といった中身がほとんど共通なため。
 * 横断ではActionsを使わずサブPCで質問セッションを立てるので、**リポジトリの絞り込み条件も
 * 実行先の扱いも変わる**（下のコメント参照）。
 */
export function AskRepoQuestionDialog({
  open,
  onOpenChange,
  repositories,
  defaultRepositoryFullName,
  onCreated,
}: AskRepoQuestionDialogProps) {
  const { createIssue, isSubmitting: isCreatingIssue, error: createError, setError: setCreateError } =
    useIssueMutations();
  const {
    createComment,
    isSubmitting: isCreatingComment,
    error: commentError,
    setError: setCommentError,
  } = useIssueCommentMutations();

  const [scope, setScope] = useState<AskQuestionScope>("single");
  const [repositoryFullName, setRepositoryFullName] = useState("");
  const [question, setQuestion] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [hostName, setHostName] = useState<string | null>(null);
  /**
   * 横断質問で、Issueとコメントは作れたのにジョブを積めなかった場合に残る質問Issue（#1454）。
   *
   * **これがある間は作成をやり直さない。** そのまま再送信するとIssueが二重に作られる。
   * ボタンの文言も「起動を再試行」に変える。
   */
  const [pendingIssue, setPendingIssue] = useState<Issue | null>(null);

  // 開いている間だけ取得する（閉じているダイアログのためにポーリングを増やさない）。
  // 横断を選んだときだけ要る情報なので、モードも条件に含める
  const dispatch = useDispatchState(open && scope === "cross");
  const { setError: setDispatchError } = dispatch;

  /**
   * 単一リポジトリの質問で選べるリポジトリ。**`claude-issue-dispatch.yml`が要る**
   * （回答するのがGitHub Actionsのため）。
   */
  const askableRepositories = useMemo(
    () => repositories.filter((repo) => repo.hasClaudeWorkflow),
    [repositories],
  );
  /**
   * 横断質問で質問Issueを置けるリポジトリ。**ワークフローの有無で絞らない**（#1454）。
   * 回答するのはサブPCのセッションで、記録先には`gh issue comment`で書くだけなので、
   * `claude-issue-dispatch.yml`が無いリポジトリ（横断質問専用の`question`など）でも成立する。
   */
  const recordableRepositories = repositories;
  const selectableRepositories = scope === "cross" ? recordableRepositories : askableRepositories;

  const { labels, isLoading: isMetaLoading } = useIssueRepoMeta(
    open ? repositoryFullName : null,
  );
  const selectableLabels = useMemo(
    () => labels.filter((label) => isSelectableLabelName(label.name)),
    [labels],
  );

  useEffect(() => {
    if (!open) return;
    const initialRepo =
      defaultRepositoryFullName &&
      askableRepositories.some((repo) => repo.fullName === defaultRepositoryFullName)
        ? defaultRepositoryFullName
        : (askableRepositories[0]?.fullName ?? "");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScope("single");
    setRepositoryFullName(initialRepo);
    setQuestion("");
    setSelectedLabels([]);
    setHostName(null);
    setPendingIssue(null);
    setCreateError(null);
    setCommentError(null);
    setDispatchError(null);
    // askableRepositoriesはrepositoriesから毎レンダー再計算されるため依存に含めない
    // （含めると開いている間に無関係な再選択が発生し得る）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultRepositoryFullName, setCreateError, setCommentError, setDispatchError]);

  const isSubmitting = isCreatingIssue || isCreatingComment || dispatch.isSubmitting;

  /**
   * 横断質問の起動先。**選ばれていなければ既定（選べるホストの先頭）を使う。**
   * GitHub Actionsへのフォールバックは無い（横断はサブPC限定）。
   */
  const defaultHostName = resolveDefaultCrossRepoQuestionHost(dispatch.hosts);
  const effectiveHostName = hostName ?? defaultHostName ?? dispatch.hosts[0]?.name ?? null;
  const selectedHost = dispatch.hosts.find((host) => host.name === effectiveHostName) ?? null;
  /**
   * 押す前に出す拒否理由（#1454）。**まだIssueを作っていないので、未完了ジョブと生存セッションの
   * 判定は無い**（そちらは積む時点でAPI側が見る）。
   */
  const crossRejection =
    scope === "cross"
      ? resolveCrossRepoQuestionRejection({
          host: selectedHost,
          hasActiveJob: false,
          blockingSession: null,
        })
      : null;
  const crossRejectionMessage =
    crossRejection && effectiveHostName
      ? describeCrossRepoQuestionRejection(crossRejection, { hostName: effectiveHostName })
      : crossRejection
        ? "横断質問を実行できるホストがありません（サブPCのpollerが動いているか確認してください）。"
        : null;

  function toggleLabel(name: string) {
    setSelectedLabels((prev) =>
      prev.includes(name) ? prev.filter((l) => l !== name) : [...prev, name],
    );
  }

  /** モードを切り替える。記録先は各モードで選べる範囲へ寄せ直す */
  function selectScope(next: AskQuestionScope) {
    setScope(next);
    setPendingIssue(null);
    if (next === "cross") {
      // 横断の既定は`question`リポジトリ（#1454）。無ければ今の選択をそのまま活かす
      setRepositoryFullName(
        (prev) =>
          resolveCrossRepoQuestionRepository(
            recordableRepositories.map((repo) => repo.fullName),
            prev || (recordableRepositories[0]?.fullName ?? ""),
          ) ?? "",
      );
      return;
    }
    setRepositoryFullName((prev) =>
      askableRepositories.some((repo) => repo.fullName === prev)
        ? prev
        : (askableRepositories[0]?.fullName ?? ""),
    );
  }

  async function handleSubmit() {
    if (!repositoryFullName || !question.trim()) return;
    if (scope === "cross") {
      await submitCrossRepoQuestion();
      return;
    }

    const issue = await createIssue({
      repositoryFullName,
      title: buildAskRepoQuestionTitle(question),
      body: question,
      labels: selectedLabels,
      assignee: null,
    });
    if (!issue) return;

    const [owner, repo] = repositoryFullName.split("/");
    const comment = await createComment({
      owner,
      repo,
      number: issue.number,
      body: askClaudeCommentBody(question),
    });

    setQuestion("");
    setSelectedLabels([]);
    onOpenChange(false);
    onCreated(comment ? { ...issue, commentCount: issue.commentCount + 1 } : issue);
  }

  /**
   * 横断質問（#1454）。質問Issueを作る → Actionsを起こさない質問コメントを投稿する →
   * サブPCへ質問セッションのジョブを積む、の順で進める。
   *
   * **ジョブを積めなかった場合、質問Issueは作り直さない。** 作成済みのIssueを持っておき、
   * 再送信では積み直しだけを行う（やり直すたびに質問Issueが増えるのを避ける）。
   */
  async function submitCrossRepoQuestion() {
    if (!effectiveHostName) return;

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

  const isCross = scope === "cross";
  const canSubmit =
    !isSubmitting &&
    Boolean(repositoryFullName) &&
    Boolean(question.trim()) &&
    (!isCross || (crossRejection === null && effectiveHostName !== null));

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
          <DialogTitle>{isCross ? "複数リポジトリに質問する" : "リポジトリに質問する"}</DialogTitle>
          <DialogDescription>
            {isCross
              ? "質問内容でIssueを自動作成し、サブPCで全リポジトリを参照できる質問セッションを起動します。回答はそのIssueのコメントとして返ります。"
              : "質問内容でIssueを自動作成し、Claudeに質問します。回答はコメントとして返るまで数十秒〜数分かかります。"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>質問の範囲</Label>
            <div className="flex gap-1.5">
              <Button
                type="button"
                variant={isCross ? "outline" : "default"}
                className="h-9 px-3 text-xs"
                onClick={() => selectScope("single")}
              >
                1つのリポジトリ
              </Button>
              <Button
                type="button"
                variant={isCross ? "default" : "outline"}
                className="h-9 px-3 text-xs"
                onClick={() => selectScope("cross")}
              >
                複数のリポジトリ（横断）
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ask-repo-question-repo">
              {isCross ? "質問Issueの記録先" : "リポジトリ"}
            </Label>
            {selectableRepositories.length > 0 ? (
              <Select value={repositoryFullName} onValueChange={setRepositoryFullName}>
                <SelectTrigger id="ask-repo-question-repo" className="w-full">
                  <SelectValue placeholder="リポジトリを選択" />
                </SelectTrigger>
                <SelectContent>
                  {selectableRepositories.map((repo) => (
                    <SelectItem key={repo.id} value={repo.fullName}>
                      {repo.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-muted-foreground">
                {isCross
                  ? "連携しているリポジトリがありません。"
                  : "claude-issue-dispatch.ymlが導入されているリポジトリがありません。"}
              </p>
            )}
            {isCross && (
              <p className="text-xs text-muted-foreground">
                質問と回答を残す場所です。参照するのはここだけではなく、サブPCにあるリポジトリ全部です。
              </p>
            )}
          </div>

          {isCross && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ask-repo-question-host">実行先</Label>
              {dispatch.hosts.length > 1 ? (
                <Select
                  value={effectiveHostName ?? ""}
                  onValueChange={(value) => setHostName(value)}
                >
                  <SelectTrigger id="ask-repo-question-host" className="w-full">
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
              {crossRejectionMessage && (
                <p className="text-xs text-destructive">{crossRejectionMessage}</p>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ask-repo-question-body">質問内容</Label>
            <Textarea
              id="ask-repo-question-body"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="質問内容を入力してください"
              className="min-h-32 md:text-sm"
              autoFocus
            />
            <BodyCleanupButton
              value={question}
              onCleaned={setQuestion}
              disabled={isSubmitting}
            />
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
