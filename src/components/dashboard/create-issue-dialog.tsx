"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, Loader2, MessageCircleQuestion, Plus } from "lucide-react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { BodyCleanupButton } from "@/components/dashboard/body-cleanup-button";
import { LabelPicker } from "@/components/dashboard/label-picker";
import { getRepoIssueSuggestions, MentionTextarea } from "@/components/dashboard/mention-textarea";
import { StartImplementationDialog } from "@/components/dashboard/start-implementation-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  clearIssueDraft,
  readRestorableIssueDraft,
  resolveInitialIssueDraft,
  useIssueDraftAutosave,
  type IssueDraft,
  type IssueDraftKind,
} from "@/hooks/use-issue-draft";
import { useIssueCommentMutations } from "@/hooks/use-issue-comment-mutations";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import { useIssueSuggest } from "@/hooks/use-issue-suggest";
import { askClaudeCommentBody, buildAskRepoQuestionTitle } from "@/lib/github/ask-claude";
import { composeIssueBody } from "@/lib/github/followup-issue";
import {
  isSelectableLabelName,
  startImplementationDisabledReason,
} from "@/lib/github/start-implementation";
import { getLabelBadgeStyle } from "@/lib/label-color";
import { buildLocalSessionCommand, canStartLocalSession } from "@/lib/local-session";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

/**
 * リポジトリ選択欄で、claude-issue-dispatch.ymlが導入済み（IssueDeckの自動化に対応済み）の
 * リポジトリを先頭に、未導入のリポジトリをその下にまとめる。各グループ内の順序は維持する。
 */
export function groupRepositoriesByWorkflowStatus(
  repositories: ConnectedRepository[],
): { registered: ConnectedRepository[]; unregistered: ConnectedRepository[] } {
  return {
    registered: repositories.filter((repo) => repo.hasClaudeWorkflow),
    unregistered: repositories.filter((repo) => !repo.hasClaudeWorkflow),
  };
}

/**
 * 「タイトル・ラベルを自動生成」実行時の選択ラベルを算出する。
 * 進捗管理用ラベル・実装オプション用ラベル（チェックボックスで個別に選択するもの）はリセット対象外として
 * そのまま維持し、それ以外のユーザー選択可能なラベルは一度リセットしたうえで生成結果を反映する。
 */
export function mergeSuggestedLabels(prev: string[], suggested: string[]): string[] {
  return [
    ...prev.filter((name) => !isSelectableLabelName(name)),
    ...new Set(suggested.filter(isSelectableLabelName)),
  ];
}

/**
 * 種別を切り替えたときに選び直すリポジトリを決める（#1641）。
 *
 * **質問は`claude-issue-dispatch.yml`が導入済みのリポジトリでしか成立しない**（回答するのが
 * GitHub Actionsのmode=askのため）。Issueへ戻すときは絞り込みが無いので、選択をそのまま残す。
 */
export function resolveKindRepository(
  kind: IssueDraftKind,
  repositories: ConnectedRepository[],
  current: string,
): string {
  if (kind === "issue") return current;
  const askable = repositories.filter((repo) => repo.hasClaudeWorkflow);
  return askable.some((repo) => repo.fullName === current) ? current : (askable[0]?.fullName ?? "");
}

const DEFAULT_ASSIGNEE = "m-guchi";

type CreateIssueDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositories: ConnectedRepository[];
  defaultRepositoryFullName?: string | null;
  defaultTitle?: string | null;
  defaultBody?: string | null;
  /**
   * 本文の先頭に固定で付くテキスト（引き継ぎ元の情報など・#1322）。
   * 入力欄には入れず読み取り専用で表示し、作成時に入力内容の前へ連結する。
   */
  bodyPrefix?: string | null;
  issues: Issue[];
  onCreated: (issue: Issue) => void;
};

/**
 * Issueの作成と、単一リポジトリへの質問（#691）を1つのダイアログにまとめたもの（#1641）。
 *
 * **本文・画像添付・ラベル選択はどちらの種別でも同じもの**で、種別によって変わるのは
 * タイトル（質問は質問文から機械生成）・担当者の有無・作成後の動きだけ。質問側が独自の
 * `Textarea`を持っていたせいで、質問には画像を貼れず`#123`のIssue補完も効かなかった。
 *
 * **横断質問（#1454）はここに含めない。** 回答するのがGitHub ActionsではなくサブPCの質問
 * セッションで、リポジトリの絞り込み条件も実行先の選択も別物になるため、
 * `CrossRepoQuestionDialog`のまま独立した入口に残している。
 */
export function CreateIssueDialog({
  open,
  onOpenChange,
  repositories,
  defaultRepositoryFullName,
  defaultTitle,
  defaultBody,
  bodyPrefix,
  issues,
  onCreated,
}: CreateIssueDialogProps) {
  const { createIssue, isSubmitting: isCreatingIssue, error, setError } = useIssueMutations();
  const {
    createComment,
    isSubmitting: isCreatingComment,
    error: commentError,
    setError: setCommentError,
  } = useIssueCommentMutations();
  const isSubmitting = isCreatingIssue || isCreatingComment;

  const [kind, setKind] = useState<IssueDraftKind>("issue");
  const [repositoryFullName, setRepositoryFullName] = useState<string>("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [isImageUploading, setIsImageUploading] = useState(false);
  const [restorableDraft, setRestorableDraft] = useState<IssueDraft | null>(null);
  const hasUserSetAssignee = useRef(false);
  /**
   * 「作成+実装開始」で作成したIssue（#1323）。**入っている間だけ「実装を開始」を出す。**
   * このダイアログ自体は閉じているので、そちらはDialogの外側に並べて描画する。
   */
  const [startTargetIssue, setStartTargetIssue] = useState<Issue | null>(null);

  const { labels, assignees, isLoading: isMetaLoading } = useIssueRepoMeta(
    open ? repositoryFullName : null,
  );
  const issueSuggestions = useMemo(
    () => getRepoIssueSuggestions(issues, repositoryFullName),
    [issues, repositoryFullName],
  );
  const { registered: registeredRepositories, unregistered: unregisteredRepositories } = useMemo(
    () => groupRepositoriesByWorkflowStatus(repositories),
    [repositories],
  );
  const isQuestion = kind === "question";
  /**
   * 質問では`claude-issue-dispatch.yml`が導入済みのリポジトリしか選べない（回答するのが
   * GitHub Actionsのmode=askのため）。未導入のグループごと選択肢から落とす。
   */
  const selectableUnregisteredRepositories = isQuestion ? [] : unregisteredRepositories;
  const hasSelectableRepository =
    registeredRepositories.length + selectableUnregisteredRepositories.length > 0;
  // 「作成+実装開始」で作成したIssueの実行先を選ばせるための情報（#1323）。判定の材料は
  // Issue詳細画面（issue-detail.tsx）と同じで、リポジトリ情報が無い場合は塞がない側に倒す
  const startTargetRepository = startTargetIssue
    ? repositories.find((repo) => repo.fullName === startTargetIssue.repositoryFullName)
    : undefined;
  const selectableLabels = useMemo(
    () => labels.filter((label) => isSelectableLabelName(label.name)),
    [labels],
  );
  const {
    isGenerating: isSuggesting,
    error: suggestError,
    notConfigured: suggestNotConfigured,
    generate: generateSuggestion,
  } = useIssueSuggest();
  useEffect(() => {
    if (!open) return;
    // ダイアログを開くたびにフォームを初期状態へ戻す。明示的なプリフィル（引用元テキスト等）が
    // 渡されていればそちらを優先し、それ以外は空の状態にする（保存済みの下書きは自動では
    // 反映せず、readRestorableIssueDraftの結果をユーザーが「復元する」で選んだ場合のみ反映する）。
    // 外部トリガー（開閉）に同期する一度きりの処理であり、ループや連鎖的な再レンダリングは発生しない。
    const draft = resolveInitialIssueDraft({
      defaultRepositoryFullName,
      defaultTitle,
      defaultBody,
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKind("issue");
    setRepositoryFullName(draft.repositoryFullName);
    setTitle(draft.title);
    setBody(draft.body);
    setSelectedLabels(draft.selectedLabels);
    setAssignee(draft.assignee);
    setIsImageUploading(false);
    setError(null);
    setCommentError(null);
    hasUserSetAssignee.current = draft.assignee !== null;
    // 引き継ぎ（bodyPrefix）は本文の入力欄を空のまま始めるため、保存済み下書きの提示は止めない
    // （#1322）。閉じてしまった引き継ぎ作成の入力を復元でき、復元しても接頭辞は消えない。
    setRestorableDraft(
      readRestorableIssueDraft({ defaultRepositoryFullName, defaultTitle, defaultBody }),
    );
  }, [open, defaultRepositoryFullName, defaultTitle, defaultBody, setError, setCommentError]);

  useIssueDraftAutosave(open, {
    kind,
    repositoryFullName,
    title,
    body,
    selectedLabels,
    assignee,
  });

  useEffect(() => {
    if (!open || hasUserSetAssignee.current) return;
    if (assignees.includes(DEFAULT_ASSIGNEE)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAssignee(DEFAULT_ASSIGNEE);
    }
  }, [open, assignees]);

  /** 種別を切り替える。質問で選べないリポジトリを選んでいた場合は選び直す（#1641） */
  function selectKind(next: IssueDraftKind) {
    setKind(next);
    setRepositoryFullName((prev) => resolveKindRepository(next, repositories, prev));
  }

  function handleRestoreDraft() {
    if (!restorableDraft) return;
    // 下書きは書いていたときの種別ごと戻す（質問の書きかけを復元してIssueとして作らない）
    setKind(restorableDraft.kind);
    setRepositoryFullName(
      resolveKindRepository(
        restorableDraft.kind,
        repositories,
        defaultRepositoryFullName ?? restorableDraft.repositoryFullName,
      ),
    );
    setTitle(restorableDraft.title);
    setBody(restorableDraft.body);
    // 実装オプション用ラベル（`21.plan-required`等）は#1580でこの画面から選べなくなったが、
    // それ以前に保存された下書きには残っている。画面に出ないラベルが黙って付かないよう濾す
    setSelectedLabels(restorableDraft.selectedLabels.filter(isSelectableLabelName));
    setAssignee(restorableDraft.assignee);
    hasUserSetAssignee.current = restorableDraft.assignee !== null;
    setRestorableDraft(null);
  }

  function resetForm() {
    setKind("issue");
    setRepositoryFullName("");
    setTitle("");
    setBody("");
    setSelectedLabels([]);
    setAssignee(null);
    hasUserSetAssignee.current = false;
  }

  function toggleLabel(name: string) {
    setSelectedLabels((prev) =>
      prev.includes(name) ? prev.filter((l) => l !== name) : [...prev, name],
    );
  }

  function handleAssigneeChange(value: string) {
    hasUserSetAssignee.current = true;
    setAssignee(value === "__none__" ? null : value);
  }

  async function handleGenerateSuggestion() {
    const result = await generateSuggestion(
      body,
      labels.map((label) => ({ name: label.name, description: label.description })),
    );
    if (!result) return;
    setTitle(result.title);
    setSelectedLabels((prev) => mergeSuggestedLabels(prev, result.labels));
  }

  async function handleSubmit() {
    if (isQuestion) {
      await handleAskQuestion();
      return;
    }
    if (!repositoryFullName || !title.trim()) return;
    const issue = await createIssue({
      repositoryFullName,
      title,
      body: composeIssueBody(bodyPrefix, body),
      labels: selectedLabels,
      assignee,
    });
    if (issue) {
      resetForm();
      clearIssueDraft();
      onCreated(issue);
      onOpenChange(false);
    }
  }

  /**
   * 種別「質問」での送信（#691の「リポジトリに質問する」をここへ統合したもの・#1641）。
   *
   * Issueを1件作り、続けてGitHub Actions（mode=ask）を起こす質問コメントを投稿する。
   * **タイトルは質問文から機械的に作る**（`[質問] `接頭辞。Claudeは使わない）。この接頭辞が
   * 質問Issueかどうかの唯一の判定材料で、質問ビューとワンボタンクローズがこれを見ている。
   */
  async function handleAskQuestion() {
    if (!repositoryFullName || !body.trim()) return;
    const issue = await createIssue({
      repositoryFullName,
      title: buildAskRepoQuestionTitle(body),
      body: composeIssueBody(bodyPrefix, body),
      labels: selectedLabels,
      assignee: null,
    });
    if (!issue) return;

    const [owner, repo] = repositoryFullName.split("/");
    const comment = await createComment({
      owner,
      repo,
      number: issue.number,
      body: askClaudeCommentBody(body),
    });

    resetForm();
    clearIssueDraft();
    onOpenChange(false);
    onCreated(comment ? { ...issue, commentCount: issue.commentCount + 1 } : issue);
  }

  /**
   * 「作成+実装開始」ボタン押下時（#774・#1323）。
   *
   * Issueを作成したうえで、**実装オプションと実行先を選ぶ「実装を開始」ダイアログへ渡す**。
   * オプションは作成フォームでは選ばせず（#1580）、こちらのダイアログだけで選ぶ。
   * 「計画が必要」の初期値は、作成時に付けた種別ラベル（`50.feature`等）から決まる。
   *
   * **以前はここで直接`@claude`コメントを投稿していた（#774）。** 起動先を選ぶ余地が無く、
   * 作成したIssueは必ずGitHub Actionsで走っていた。サブPCで始めたい場合は、いったん作成して
   * Issue詳細を開き直すしかなかったため、既定がサブPCの実行先選択を挟む（#1323）。
   * 起動そのもの（`@claude`コメント・ジョブの積み込み・進捗の報告）はダイアログ側が行う。
   */
  async function handleCreateAndStart() {
    if (!repositoryFullName || !title.trim()) return;
    const issue = await createIssue({
      repositoryFullName,
      title,
      body: composeIssueBody(bodyPrefix, body),
      labels: selectedLabels,
      assignee,
    });
    if (!issue) return;

    resetForm();
    clearIssueDraft();
    onOpenChange(false);
    onCreated(issue);
    setStartTargetIssue(issue);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="sm:max-w-lg"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{isQuestion ? "リポジトリに質問する" : "新しいIssueを作成"}</DialogTitle>
            {isQuestion && (
              <DialogDescription>
                質問内容でIssueを自動作成し、Claudeに質問します。回答はコメントとして返るまで数十秒〜数分かかります。
              </DialogDescription>
            )}
          </DialogHeader>

          {restorableDraft && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
              <span>保存された下書きがあります</span>
              <Button variant="outline" size="xs" onClick={handleRestoreDraft}>
                復元する
              </Button>
            </div>
          )}

          <div className="flex flex-col gap-4">
            {/* 種別（#1641）。**本文の内容からの自動判定は行わない。** 誤判定は押した本人から
                見えないまま、質問のつもりの本文が実装Issueとして無人実行に乗る（逆もある）
                という取り返しの付きにくい間違いになるため、押した時点で確定する形にする */}
            <div className="flex flex-col gap-1.5">
              <Label>種別</Label>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  variant={isQuestion ? "outline" : "default"}
                  className="h-9 px-3 text-xs"
                  aria-pressed={!isQuestion}
                  onClick={() => selectKind("issue")}
                >
                  <Plus />
                  Issue
                </Button>
                <Button
                  type="button"
                  variant={isQuestion ? "default" : "outline"}
                  className="h-9 px-3 text-xs"
                  aria-pressed={isQuestion}
                  onClick={() => selectKind("question")}
                >
                  <MessageCircleQuestion />
                  質問
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-issue-repo">リポジトリ</Label>
              {hasSelectableRepository ? (
                <Select value={repositoryFullName} onValueChange={setRepositoryFullName}>
                  <SelectTrigger id="create-issue-repo" className="w-full">
                    <SelectValue placeholder="リポジトリを選択" />
                  </SelectTrigger>
                  <SelectContent>
                    {registeredRepositories.length > 0 && (
                      <SelectGroup>
                        {selectableUnregisteredRepositories.length > 0 && (
                          <SelectLabel>登録済み</SelectLabel>
                        )}
                        {registeredRepositories.map((repo) => (
                          <SelectItem key={repo.id} value={repo.fullName}>
                            {repo.fullName}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {selectableUnregisteredRepositories.length > 0 && (
                      <SelectGroup>
                        {registeredRepositories.length > 0 && <SelectLabel>未登録</SelectLabel>}
                        {selectableUnregisteredRepositories.map((repo) => (
                          <SelectItem key={repo.id} value={repo.fullName}>
                            {repo.fullName}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {isQuestion
                    ? "claude-issue-dispatch.ymlが導入されているリポジトリがありません。"
                    : "連携しているリポジトリがありません。"}
                </p>
              )}
              {isQuestion && (
                <p className="text-xs text-muted-foreground">
                  回答するのはGitHub Actionsのため、claude-issue-dispatch.yml導入済みのリポジトリだけ選べます。
                </p>
              )}
            </div>

            {isQuestion ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="create-issue-question-title">タイトル（自動）</Label>
                <p
                  id="create-issue-question-title"
                  className="rounded-md border border-input px-3 py-2 text-sm break-all text-muted-foreground"
                >
                  {body.trim() ? buildAskRepoQuestionTitle(body) : "質問内容から自動で作られます"}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="create-issue-title">タイトル</Label>
                <Input
                  id="create-issue-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Issueのタイトル"
                  className="md:text-sm"
                  autoFocus
                />
              </div>
            )}

            {/* 本文の入力欄は種別で変えない（#1641）。質問でも画像の貼り付け・ドラッグ&ドロップと
                `#123`のIssue補完が使えるようにするのがこの統合の主目的で、以前の質問ダイアログは
                素のTextareaだったためどちらも使えなかった */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-issue-body">{isQuestion ? "質問内容" : "本文"}</Label>
              {/* 引き継ぎ元などの固定接頭辞は入力欄に入れず、ここに読み取り専用で見せる（#1322）。
                  入力欄は1行目から自分の書きたいことを書ける状態で始まり、消してしまう心配も無い */}
              {bodyPrefix && (
                <div className="rounded-md border border-border bg-muted/50 px-3 py-2">
                  <p className="text-xs text-muted-foreground">
                    以下は本文の先頭に自動で付きます（編集不可）
                  </p>
                  <p className="mt-1 text-xs break-all whitespace-pre-wrap text-foreground">
                    {bodyPrefix.trim()}
                  </p>
                </div>
              )}
              <MentionTextarea
                id="create-issue-body"
                value={body}
                onChange={setBody}
                issueSuggestions={issueSuggestions}
                onUploadingChange={setIsImageUploading}
                repositoryFullName={repositoryFullName}
                placeholder={isQuestion ? "質問内容を入力してください" : "詳細を入力（任意）"}
                className="min-h-32 md:text-sm"
                autoFocus={isQuestion}
              />
              <div className="flex flex-wrap gap-2">
                <BodyCleanupButton value={body} onCleaned={setBody} disabled={isSubmitting} />
                {/* タイトルを機械生成する質問では出さない（生成する対象が無い） */}
                {!isQuestion && (
                  <div className="flex flex-col gap-1">
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={!body.trim() || !repositoryFullName || isMetaLoading || isSuggesting}
                      onClick={handleGenerateSuggestion}
                    >
                      {isSuggesting ? <Loader2 className="animate-spin" /> : <Bot />}
                      タイトル・ラベルを自動生成
                    </Button>
                    {suggestNotConfigured && (
                      <p className="text-xs text-muted-foreground">
                        Claudeのトークンが設定されていません
                      </p>
                    )}
                    {suggestError && <p className="text-xs text-destructive">{suggestError}</p>}
                  </div>
                )}
              </div>
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
              {selectedLabels.filter(isSelectableLabelName).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {selectedLabels.filter(isSelectableLabelName).map((name) => {
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

            {/* 実装オプション（`21.plan-required`等）はここでは選ばせない（#1580）。
                どこでエージェントを止めるかの指定で、実行先が決まって初めて意味が決まるものが
                混ざっている（撮影は無人実行専用・アーティファクトはローカル実行専用）。
                起票の時点では実行先も実施時期も未定なので、「実装を開始」ダイアログで選ぶ */}

            {/* 質問Issueに担当者は要らない（人が引き取る作業ではなく、Claudeが答えて終わる） */}
            {!isQuestion && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="create-issue-assignee">担当者</Label>
                <Select value={assignee ?? "__none__"} onValueChange={handleAssigneeChange}>
                  <SelectTrigger
                    id="create-issue-assignee"
                    className="h-9 w-full"
                    disabled={isMetaLoading}
                  >
                    <SelectValue placeholder="担当者を選択" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">未設定</SelectItem>
                    {assignees.map((login) => (
                      <SelectItem key={login} value={login}>
                        {login}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <ApiErrorMessage message={error ?? commentError} />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              キャンセル
            </Button>
            {/* 質問は実装の対象ではないため「作成+実装開始」を出さない（#1641）。
                Actionsが使えないリポジトリでもこのボタンは塞がない（#1262と同じ判断・#1323）。
                実行先の選択がこの先のダイアログにある以上、押せないとサブPCでの起動まで塞がる。
                理由はダイアログのGitHub Actionsの選択肢の説明として出す */}
            {!isQuestion && (
              <Button
                variant="secondary"
                onClick={handleCreateAndStart}
                disabled={isSubmitting || !repositoryFullName || !title.trim() || isImageUploading}
              >
                {isSubmitting ? "作成中..." : "作成+実装開始"}
              </Button>
            )}
            <Button
              onClick={handleSubmit}
              disabled={
                isSubmitting ||
                !repositoryFullName ||
                isImageUploading ||
                (isQuestion ? !body.trim() : !title.trim())
              }
            >
              {isQuestion
                ? isSubmitting
                  ? "送信中..."
                  : "質問する"
                : isSubmitting
                  ? "作成中..."
                  : "作成"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* 作成直後のオプション・実行先の選択（#1323・#1580）。実行先の既定はサブPCで、
          GitHub Actionsはフォールバック。作成フォームは閉じているため、Dialogの外側に並べて描画する */}
      {startTargetIssue && (
        <StartImplementationDialog
          issue={startTargetIssue}
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setStartTargetIssue(null);
          }}
          // ラベル・コメント数の変化は、作成時と同じ経路（onCreated）で呼び出し側へ渡す。
          // 既存分があれば更新されるため、同じIssueが二重に並ぶことはない
          onIssueUpdated={(updated) => {
            // **閉じた後に届いた更新で開き直さない**（#1434）。この`startTargetIssue`は
            // 表示するIssueと開閉状態を兼ねており、素直に代入すると`null`（閉じた状態）へ
            // 戻したものが復活する。サブPCを選んだ場合、ダイアログはジョブを積めた時点で
            // 閉じ、その後に`11.local`の付与（GitHubへの往復）の結果がここへ届くため、
            // 閉じた1秒ほど後に実行先の選択が出し直されていた。しかも積んだジョブで
            // 選んだホスト自体が塞がるため、選んだ実行先が消えた状態で開き直っていた。
            setStartTargetIssue((prev) => (prev ? updated : prev));
            onCreated(updated);
          }}
          onCommentCreated={() => {}}
          includeDispatchTargets
          actionsDisabledReason={startImplementationDisabledReason(
            startTargetRepository?.hasClaudeWorkflow,
          )}
          localSessionCommand={
            canStartLocalSession(startTargetRepository?.hasLocalStartScript)
              ? buildLocalSessionCommand(
                  startTargetIssue.repositoryFullName,
                  startTargetIssue.number,
                )
              : null
          }
          // 作成した直後なのでコメントも親子関係も無い。「取得していません」と書かせないよう空で渡す
          subIssueRelations={{ parent: null, children: [], childCount: 0 }}
        />
      )}
    </>
  );
}
