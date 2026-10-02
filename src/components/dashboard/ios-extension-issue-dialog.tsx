"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BodyCleanupButton } from "@/components/dashboard/body-cleanup-button";
import { ImageExtractButton } from "@/components/dashboard/image-extract-button";
import { getRepoIssueSuggestions, MentionTextarea } from "@/components/dashboard/mention-textarea";
import { StartImplementationDialog } from "@/components/dashboard/start-implementation-dialog";
import type { ClaudeLocalModelSetting, CodexModelSetting, DefaultDispatchAgent } from "@/lib/app-settings";
import { startImplementationDisabledReason } from "@/lib/github/start-implementation";
import { buildLocalSessionCommand, canStartLocalSession } from "@/lib/local-session";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";
import {
  buildIosExtensionIssue,
  IOS_EXTENSION_KINDS,
  IOS_EXTENSION_KIND_LABELS,
  type IosExtension,
  type IosExtensionKind,
} from "@/lib/ios-extensions";

export type IosExtensionIssueTarget = {
  repositoryFullName: string;
  /** 編集依頼のときだけ。追加のときはnull */
  extension: IosExtension | null;
};

/** 起票後の「実装を開始」（`StartImplementationDialog`）に渡す値。作成フォームと同じもの */
export type IosExtensionStartProps = {
  repositories: ConnectedRepository[];
  /** `#123`のIssue補完の候補 */
  issues: Issue[];
  /**
   * 実装開始で届く更新（`11.local`の付与など）の反映先。**画面を移さず一覧へ入れるだけのものを渡す**
   * （詳細を開く`onCreated`をつなぐと、実行先を選んだ直後に画面が切り替わる。#1434）
   */
  onIssueUpdated: (issue: Issue) => void;
  onNightlyRunQueued?: () => void;
  claudeLocalModel: ClaudeLocalModelSetting;
  codexModel: CodexModelSetting;
  defaultDispatchAgent?: DefaultDispatchAgent;
  dispatchFailoverEnabled?: boolean;
  dispatchFailoverThresholdPercent?: number;
};

/**
 * iOS拡張の追加・編集依頼（#3708）。種類別テンプレートでIssueを起票するだけで、Swiftは生成しない。
 * 起票は通常のIssue作成API（`POST /api/issues`）で、実装は通常の実装エージェント経路に任せる。
 */
export function IosExtensionIssueDialog({
  target,
  repositories,
  start,
  onClose,
  onCreated,
}: {
  target: IosExtensionIssueTarget | null;
  repositories: string[];
  start: IosExtensionStartProps;
  onClose: () => void;
  onCreated: (issue: Issue) => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {target && <DialogForm key={`${target.repositoryFullName}:${target.extension?.path}:${target.extension?.name}`} target={target} repositories={repositories} start={start} onClose={onClose} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  );
}

function DialogForm({
  target,
  repositories,
  start,
  onClose,
  onCreated,
}: {
  target: IosExtensionIssueTarget;
  repositories: string[];
  start: IosExtensionStartProps;
  onClose: () => void;
  onCreated: (issue: Issue) => void;
}) {
  const isEdit = target.extension !== null;
  const [repositoryFullName, setRepositoryFullName] = useState(target.repositoryFullName);
  const [kind, setKind] = useState<IosExtensionKind>(target.extension?.kind ?? "widget");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Issue | null>(null);
  const [isImageUploading, setIsImageUploading] = useState(false);
  // 起票後に「実装を開始」で開く。起票したIssueは一覧へ反映済みで、表示用に最新の更新を持つ
  const [startTarget, setStartTarget] = useState<Issue | null>(null);
  const startRepository = startTarget
    ? start.repositories.find((repo) => repo.fullName === startTarget.repositoryFullName)
    : undefined;
  const issueSuggestions = useMemo(
    () => getRepoIssueSuggestions(start.issues, repositoryFullName),
    [start.issues, repositoryFullName],
  );

  const draft = buildIosExtensionIssue({
    mode: isEdit ? "edit" : "add",
    repositoryFullName,
    kind,
    target: target.extension ?? undefined,
    description,
  });

  async function submit() {
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryFullName, title: draft.title, body: draft.body, labels: ["50.feature"] }),
      });
      const json = (await response.json().catch(() => null)) as { issue?: Issue } | null;
      if (!response.ok || !json?.issue) throw new Error(`Issueを起票できませんでした (${response.status})`);
      setCreated(json.issue);
      start.onIssueUpdated(json.issue);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Issueを起票できませんでした");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEdit ? "拡張の編集を依頼" : "拡張を追加"}（Issue起票）</DialogTitle>
        <DialogDescription>種類別のテンプレートでIssueを作成します。実装は通常のIssueと同じ経路で進みます。</DialogDescription>
      </DialogHeader>

      {created ? (
        <div className="space-y-3 text-sm">
          <p>Issue #{created.number} を起票しました。</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setStartTarget(startTarget ?? created)}>実装を開始…</Button>
            <Button variant="outline" size="sm" onClick={() => { onCreated(created); onClose(); }}>Issueを開く</Button>
          </div>
          <p className="text-xs text-muted-foreground">「実装を開始」で、実行先・オプションを選んで実装エージェントを起動できます。</p>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          {!isEdit && (
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">リポジトリ</span>
              <select className="w-full rounded-lg border bg-transparent px-2 py-1.5" value={repositoryFullName} onChange={(event) => setRepositoryFullName(event.target.value)}>
                {repositories.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          )}
          <fieldset className="space-y-1" disabled={isEdit}>
            <legend className="text-xs text-muted-foreground">種類</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {IOS_EXTENSION_KINDS.map((value) => (
                <label key={value} className="flex items-center gap-1.5">
                  <input type="radio" name="ios-extension-kind" checked={kind === value} onChange={() => setKind(value)} />
                  {IOS_EXTENSION_KIND_LABELS[value]}
                </label>
              ))}
            </div>
          </fieldset>
          {target.extension && <p className="font-mono text-xs text-muted-foreground">{target.extension.name}（{target.extension.path}）</p>}
          <div className="space-y-1">
            <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
              <label htmlFor="ios-extension-description" className="flex h-6 items-center text-xs text-muted-foreground">
                {isEdit ? "変えたい内容" : "表示したい内容"}
              </label>
              <BodyCleanupButton value={description} onCleaned={setDescription} disabled={isSubmitting} />
              <ImageExtractButton value={description} onChange={setDescription} disabled={isSubmitting} />
            </div>
            <MentionTextarea
              id="ios-extension-description"
              value={description}
              onChange={setDescription}
              issueSuggestions={issueSuggestions}
              onUploadingChange={setIsImageUploading}
              repositoryFullName={repositoryFullName}
              placeholder="例: 今日の予定を3件表示する（画像は貼り付け・ドラッグ&ドロップで添付できます）"
              className="h-36 max-h-36 min-h-0 field-sizing-fixed leading-snug md:text-sm md:leading-normal"
              showPreviewToggle={false}
            />
          </div>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">起票されるIssueのプレビュー</summary>
            <p className="mt-2 font-semibold text-foreground">{draft.title}</p>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/30 p-2">{draft.body}</pre>
          </details>
          {error && <p role="alert" className="text-destructive">{error}</p>}
        </div>
      )}

      {startTarget && (
        <StartImplementationDialog
          issue={startTarget}
          open
          onOpenChange={(nextOpen) => { if (!nextOpen) setStartTarget(null); }}
          onIssueUpdated={(updated) => {
            // 閉じた後に届いた更新で開き直さない（#1434）
            setStartTarget((prev) => (prev ? updated : prev));
            start.onIssueUpdated(updated);
          }}
          onCommentCreated={() => {}}
          onNightlyRunQueued={start.onNightlyRunQueued}
          includeDispatchTargets
          actionsDisabledReason={startImplementationDisabledReason(startRepository?.hasClaudeWorkflow)}
          localSessionCommand={
            canStartLocalSession(startRepository?.hasLocalStartScript)
              ? buildLocalSessionCommand(startTarget.repositoryFullName, startTarget.number)
              : null
          }
          subIssueRelations={{ parent: null, children: [], childCount: 0 }}
          claudeLocalModel={start.claudeLocalModel}
          codexModel={start.codexModel}
          defaultDispatchAgent={start.defaultDispatchAgent}
          dispatchFailoverEnabled={start.dispatchFailoverEnabled}
          dispatchFailoverThresholdPercent={start.dispatchFailoverThresholdPercent}
        />
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{created ? "閉じる" : "キャンセル"}</Button>
        {!created && <Button onClick={() => void submit()} disabled={isSubmitting || isImageUploading}>{isSubmitting ? "起票中…" : "Issueを起票"}</Button>}
      </DialogFooter>
    </>
  );
}
