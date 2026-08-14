"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, Loader2, Mic } from "lucide-react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { LabelPicker } from "@/components/dashboard/label-picker";
import { getRepoIssueSuggestions, MentionTextarea } from "@/components/dashboard/mention-textarea";
import { StartImplementationDialog } from "@/components/dashboard/start-implementation-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
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
import { useIssueBodyCleanup } from "@/hooks/use-issue-body-cleanup";
import {
  clearIssueDraft,
  readRestorableIssueDraft,
  resolveInitialIssueDraft,
  useIssueDraftAutosave,
  type IssueDraft,
} from "@/hooks/use-issue-draft";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import { useIssueSuggest } from "@/hooks/use-issue-suggest";
import { PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
import { composeIssueBody } from "@/lib/github/followup-issue";
import {
  isSelectableLabelName,
  planRequiredDefaultForLabels,
  START_IMPLEMENTATION_OPTIONS,
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
 * 種別ラベル（`50.feature`等）の選択に「計画が必要」を追従させた結果を返す（#1317）。
 * 既に一致していれば`null`を返し、呼び出し側の書き込み自体を止める（再レンダリングの連鎖を作らない）。
 *
 * バグ修正から新機能へ選び直したときに付き、逆に選び直したときに外れる必要があるため、
 * 付け外しの**両方向**を扱う。ユーザーが自分でチェックを触った後に呼ばないのは呼び出し側の責務。
 */
export function syncPlanRequiredLabel(selectedLabels: string[]): string[] | null {
  const shouldSelect = planRequiredDefaultForLabels(selectedLabels);
  if (shouldSelect === selectedLabels.includes(PLAN_REQUIRED_LABEL)) return null;
  return shouldSelect
    ? [...selectedLabels, PLAN_REQUIRED_LABEL]
    : selectedLabels.filter((name) => name !== PLAN_REQUIRED_LABEL);
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
  const { createIssue, isSubmitting, error, setError } = useIssueMutations();

  const [repositoryFullName, setRepositoryFullName] = useState<string>("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [isImageUploading, setIsImageUploading] = useState(false);
  const [restorableDraft, setRestorableDraft] = useState<IssueDraft | null>(null);
  const hasUserSetAssignee = useRef(false);
  /**
   * 「計画が必要」のチェックをユーザー自身が触ったか（#1317）。
   * 触った後は種別ラベルからの既定で上書きしない（担当者欄と同じ扱い）。
   */
  const hasUserSetPlanRequired = useRef(false);
  /**
   * 「作成+実装開始」で作成したIssue（#1323）。**入っている間だけ実行先の選択を出す。**
   * このダイアログ自体は閉じているので、実行先の選択はDialogの外側に並べて描画する。
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
  const {
    isGenerating: isCleaningUpBody,
    error: bodyCleanupError,
    notConfigured: bodyCleanupNotConfigured,
    generate: generateBodyCleanup,
  } = useIssueBodyCleanup();

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
    setRepositoryFullName(draft.repositoryFullName);
    setTitle(draft.title);
    setBody(draft.body);
    setSelectedLabels(draft.selectedLabels);
    setAssignee(draft.assignee);
    setIsImageUploading(false);
    setError(null);
    hasUserSetAssignee.current = draft.assignee !== null;
    hasUserSetPlanRequired.current = false;
    // 引き継ぎ（bodyPrefix）は本文の入力欄を空のまま始めるため、保存済み下書きの提示は止めない
    // （#1322）。閉じてしまった引き継ぎ作成の入力を復元でき、復元しても接頭辞は消えない。
    setRestorableDraft(
      readRestorableIssueDraft({ defaultRepositoryFullName, defaultTitle, defaultBody }),
    );
  }, [open, defaultRepositoryFullName, defaultTitle, defaultBody, setError]);

  useIssueDraftAutosave(open, {
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

  useEffect(() => {
    if (!open || hasUserSetPlanRequired.current) return;
    // 種別ラベル（50.feature等）の選択に「計画が必要」を追従させる（#1317）。ラベル選択欄・
    // 「タイトル・ラベルを自動生成」・下書きの復元のどこから種別が変わっても同じ既定になるよう、
    // 個々の操作ではなく選択済みラベルの変化に紐づける。既定と一致した時点でnullが返り書き込みが
    // 止まるため、連鎖的な再レンダリングは起きない。ユーザーがチェックを触った後は上書きしない。
    const next = syncPlanRequiredLabel(selectedLabels);
    if (!next) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedLabels(next);
  }, [open, selectedLabels]);

  function handleRestoreDraft() {
    if (!restorableDraft) return;
    setRepositoryFullName(defaultRepositoryFullName ?? restorableDraft.repositoryFullName);
    setTitle(restorableDraft.title);
    setBody(restorableDraft.body);
    setSelectedLabels(restorableDraft.selectedLabels);
    setAssignee(restorableDraft.assignee);
    hasUserSetAssignee.current = restorableDraft.assignee !== null;
    setRestorableDraft(null);
  }

  function resetForm() {
    setRepositoryFullName("");
    setTitle("");
    setBody("");
    setSelectedLabels([]);
    setAssignee(null);
    hasUserSetAssignee.current = false;
    hasUserSetPlanRequired.current = false;
  }

  function toggleLabel(name: string) {
    // 「計画が必要」はチェックボックスからしか来ない（ラベル選択欄からは除外されている）ため、
    // ここで触ったことを記録すれば、以降は種別ラベルからの既定で上書きされない（#1317）
    if (name === PLAN_REQUIRED_LABEL) hasUserSetPlanRequired.current = true;
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

  async function handleGenerateBodyCleanup() {
    const result = await generateBodyCleanup(body);
    if (!result) return;
    setBody(result.text);
  }

  async function handleSubmit() {
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
   * 「作成+実装開始」ボタン押下時（#774・#1323）。
   *
   * Issueを作成したうえで、**実行先だけを選ぶ「実装を開始」ダイアログへ渡す**。
   * 実装オプション（`21.plan-required`等）はこの画面のチェックボックスで選び済みで、作成時に
   * ラベルとして付いた状態で渡るため、そちらは出さない（`showOptions={false}`）。
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
            <DialogTitle>新しいIssueを作成</DialogTitle>
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
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-issue-repo">リポジトリ</Label>
              <Select value={repositoryFullName} onValueChange={setRepositoryFullName}>
                <SelectTrigger id="create-issue-repo" className="w-full">
                  <SelectValue placeholder="リポジトリを選択" />
                </SelectTrigger>
                <SelectContent>
                  {registeredRepositories.length > 0 && (
                    <SelectGroup>
                      {unregisteredRepositories.length > 0 && <SelectLabel>登録済み</SelectLabel>}
                      {registeredRepositories.map((repo) => (
                        <SelectItem key={repo.id} value={repo.fullName}>
                          {repo.fullName}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {unregisteredRepositories.length > 0 && (
                    <SelectGroup>
                      {registeredRepositories.length > 0 && <SelectLabel>未登録</SelectLabel>}
                      {unregisteredRepositories.map((repo) => (
                        <SelectItem key={repo.id} value={repo.fullName}>
                          {repo.fullName}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
            </div>

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

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-issue-body">本文</Label>
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
                placeholder="詳細を入力（任意）"
                className="min-h-32 md:text-sm"
              />
              <div className="flex flex-wrap gap-2">
                <div className="flex flex-col gap-1">
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={!body.trim() || isCleaningUpBody}
                    onClick={handleGenerateBodyCleanup}
                  >
                    {isCleaningUpBody ? <Loader2 className="animate-spin" /> : <Mic />}
                    音声入力を整理
                  </Button>
                  {bodyCleanupNotConfigured && (
                    <p className="text-xs text-muted-foreground">
                      Claudeのトークンが設定されていません
                    </p>
                  )}
                  {bodyCleanupError && <p className="text-xs text-destructive">{bodyCleanupError}</p>}
                </div>
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

            <div className="flex flex-col gap-3">
              {START_IMPLEMENTATION_OPTIONS.map((option) => (
                <div key={option.key} className="flex items-start gap-2">
                  <Checkbox
                    id={`create-issue-option-${option.key}`}
                    checked={selectedLabels.includes(option.githubLabel)}
                    onCheckedChange={() => toggleLabel(option.githubLabel)}
                    className="mt-0.5"
                  />
                  <Label
                    htmlFor={`create-issue-option-${option.key}`}
                    className="flex-col items-start gap-0.5"
                  >
                    {option.label}
                    <span className="text-xs font-normal text-muted-foreground">
                      {option.description}
                    </span>
                  </Label>
                </div>
              ))}
            </div>

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

            <ApiErrorMessage message={error} />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              キャンセル
            </Button>
            {/* Actionsが使えないリポジトリでもこのボタンは塞がない（#1262と同じ判断・#1323）。
                実行先の選択がこの先のダイアログにある以上、押せないとサブPCでの起動まで塞がる。
                理由はダイアログのGitHub Actionsの選択肢の説明として出す */}
            <Button
              variant="secondary"
              onClick={handleCreateAndStart}
              disabled={isSubmitting || !repositoryFullName || !title.trim() || isImageUploading}
            >
              {isSubmitting ? "作成中..." : "作成+実装開始"}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isSubmitting || !repositoryFullName || !title.trim() || isImageUploading}
            >
              {isSubmitting ? "作成中..." : "作成"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* 作成直後の実行先選択（#1323）。既定はサブPCで、GitHub Actionsはフォールバック。
          作成フォームは閉じているため、Dialogの外側に並べて描画する */}
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
            setStartTargetIssue(updated);
            onCreated(updated);
          }}
          onCommentCreated={() => {}}
          includeDispatchTargets
          showOptions={false}
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
