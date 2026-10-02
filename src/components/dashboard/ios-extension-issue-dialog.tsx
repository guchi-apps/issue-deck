"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { Issue } from "@/types/issue";
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

/**
 * iOS拡張の追加・編集依頼（#3708）。種類別テンプレートでIssueを起票するだけで、Swiftは生成しない。
 * 起票は通常のIssue作成API（`POST /api/issues`）で、実装は通常の実装エージェント経路に任せる。
 */
export function IosExtensionIssueDialog({
  target,
  repositories,
  onClose,
  onCreated,
}: {
  target: IosExtensionIssueTarget | null;
  repositories: string[];
  onClose: () => void;
  onCreated: (issue: Issue) => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {target && <DialogForm key={`${target.repositoryFullName}:${target.extension?.path}:${target.extension?.name}`} target={target} repositories={repositories} onClose={onClose} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  );
}

function DialogForm({
  target,
  repositories,
  onClose,
  onCreated,
}: {
  target: IosExtensionIssueTarget;
  repositories: string[];
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
          <Button variant="outline" size="sm" onClick={() => { onCreated(created); onClose(); }}>Issueを開く</Button>
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
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{isEdit ? "変えたい内容" : "表示したい内容"}</span>
            <Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="例: 今日の予定を3件表示する" />
          </label>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">起票されるIssueのプレビュー</summary>
            <p className="mt-2 font-semibold text-foreground">{draft.title}</p>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/30 p-2">{draft.body}</pre>
          </details>
          {error && <p role="alert" className="text-destructive">{error}</p>}
        </div>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{created ? "閉じる" : "キャンセル"}</Button>
        {!created && <Button onClick={() => void submit()} disabled={isSubmitting}>{isSubmitting ? "起票中…" : "Issueを起票"}</Button>}
      </DialogFooter>
    </>
  );
}
