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

// 保存済み下書きは自動では復元せず、明示的なプリフィル（引用元テキスト等）または
// 文脈から渡されたdefaultRepositoryFullNameのみを初期値として返す。保存済み下書きの
// 復元はreadRestorableIssueDraftの結果をユーザーが明示的に選んだ場合のみ行う。
export function resolveInitialIssueDraft(defaults: IssueDraftDefaults): IssueDraft {
  return {
    repositoryFullName: defaults.defaultRepositoryFullName ?? "",
    title: defaults.defaultTitle ?? "",
    body: defaults.defaultBody ?? "",
    selectedLabels: [],
    assignee: null,
  };
}

// 「復元する」操作で提示できる保存済み下書きを返す。明示的なプリフィルがある場合や、
// 保存済み下書きが無い（または空の）場合はnullを返す。
export function readRestorableIssueDraft(defaults: IssueDraftDefaults): IssueDraft | null {
  const hasExplicitPrefill = Boolean(defaults.defaultTitle || defaults.defaultBody);
  if (hasExplicitPrefill) return null;
  const draft = readIssueDraft();
  if (!draft || isIssueDraftEmpty(draft)) return null;
  return draft;
}

// ダイアログが開いている間、フォーム値の変更をデバウンスしてlocalStorageに保存する。
// ダイアログが閉じる際は、デバウンス中の内容を破棄せず即座に書き込む。
export function useIssueDraftAutosave(open: boolean, draft: IssueDraft) {
  useEffect(() => {
    if (!open) {
      writeIssueDraft(draft);
      return;
    }
    const timer = window.setTimeout(() => {
      writeIssueDraft(draft);
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draftはオブジェクトの中身で比較したいためJSON化して依存に渡す
  }, [open, JSON.stringify(draft)]);
}
