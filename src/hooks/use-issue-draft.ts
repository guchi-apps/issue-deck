"use client";

import { useEffect } from "react";

const DRAFT_STORAGE_KEY = "issue-create-draft";
const SAVE_DEBOUNCE_MS = 500;

export type IssueDraft = {
  repositoryFullName: string;
  title: string;
  body: string;
  selectedLabels: string[];
  assignee: string | null;
};

export function isIssueDraftEmpty(draft: IssueDraft): boolean {
  return (
    !draft.repositoryFullName &&
    !draft.title.trim() &&
    !draft.body.trim() &&
    draft.selectedLabels.length === 0 &&
    draft.assignee === null
  );
}

export function readIssueDraft(): IssueDraft | null {
  const stored = window.localStorage.getItem(DRAFT_STORAGE_KEY);
  if (stored === null) return null;
  try {
    return JSON.parse(stored) as IssueDraft;
  } catch (error) {
    console.error("[use-issue-draft] failed to parse stored draft", error);
    return null;
  }
}

export function writeIssueDraft(draft: IssueDraft): void {
  if (isIssueDraftEmpty(draft)) {
    window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

export function clearIssueDraft(): void {
  window.localStorage.removeItem(DRAFT_STORAGE_KEY);
}

export type IssueDraftDefaults = {
  defaultRepositoryFullName?: string | null;
  defaultTitle?: string | null;
  defaultBody?: string | null;
};

// 引用元テキストなどdefault系propsが明示的に渡されている場合はそちらを優先し、
// それ以外の通常の新規作成の場合のみ保存済み下書きを復元する。
export function resolveInitialIssueDraft(defaults: IssueDraftDefaults): IssueDraft {
  const hasExplicitPrefill = Boolean(
    defaults.defaultRepositoryFullName || defaults.defaultTitle || defaults.defaultBody,
  );
  const draft = hasExplicitPrefill ? null : readIssueDraft();
  return {
    repositoryFullName: draft?.repositoryFullName ?? defaults.defaultRepositoryFullName ?? "",
    title: draft?.title ?? defaults.defaultTitle ?? "",
    body: draft?.body ?? defaults.defaultBody ?? "",
    selectedLabels: draft?.selectedLabels ?? [],
    assignee: draft?.assignee ?? null,
  };
}

// ダイアログが開いている間、フォーム値の変更をデバウンスしてlocalStorageに保存する。
export function useIssueDraftAutosave(open: boolean, draft: IssueDraft) {
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      writeIssueDraft(draft);
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draftはオブジェクトの中身で比較したいためJSON化して依存に渡す
  }, [open, JSON.stringify(draft)]);
}
