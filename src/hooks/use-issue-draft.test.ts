// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearIssueDraft,
  isIssueDraftEmpty,
  readIssueDraft,
  readRestorableIssueDraft,
  resolveInitialIssueDraft,
  useIssueDraftAutosave,
  writeIssueDraft,
  type IssueDraft,
} from "@/hooks/use-issue-draft";

const emptyDraft: IssueDraft = {
  repositoryFullName: "",
  title: "",
  body: "",
  selectedLabels: [],
  assignee: null,
};

afterEach(() => {
  window.localStorage.clear();
});

describe("isIssueDraftEmpty", () => {
  it("全項目が空なら true を返す", () => {
    expect(isIssueDraftEmpty(emptyDraft)).toBe(true);
  });

  it("空白のみのタイトル・本文も空とみなす", () => {
    expect(isIssueDraftEmpty({ ...emptyDraft, title: "  ", body: "\n" })).toBe(true);
  });

  it("いずれかの項目に値があれば false を返す", () => {
    expect(isIssueDraftEmpty({ ...emptyDraft, title: "タイトル" })).toBe(false);
    expect(isIssueDraftEmpty({ ...emptyDraft, body: "本文" })).toBe(false);
    expect(isIssueDraftEmpty({ ...emptyDraft, repositoryFullName: "owner/repo" })).toBe(false);
    expect(isIssueDraftEmpty({ ...emptyDraft, selectedLabels: ["bug"] })).toBe(false);
    expect(isIssueDraftEmpty({ ...emptyDraft, assignee: "octocat" })).toBe(false);
  });
});

describe("writeIssueDraft / readIssueDraft", () => {
  it("内容があれば保存され、読み出せる", () => {
    const draft: IssueDraft = { ...emptyDraft, title: "下書きタイトル", repositoryFullName: "owner/repo" };
    writeIssueDraft(draft);
    expect(readIssueDraft()).toEqual(draft);
  });

  it("全項目が空の場合は保存済みの下書きを削除する", () => {
    writeIssueDraft({ ...emptyDraft, title: "下書き" });
    expect(readIssueDraft()).not.toBeNull();

    writeIssueDraft(emptyDraft);
    expect(readIssueDraft()).toBeNull();
  });

  it("保存前は null を返す", () => {
    expect(readIssueDraft()).toBeNull();
  });

  it("壊れたJSONが保存されている場合は null を返す", () => {
    window.localStorage.setItem("issue-create-draft", "{not valid json");
    expect(readIssueDraft()).toBeNull();
  });
});

describe("clearIssueDraft", () => {
  it("保存済みの下書きを削除する", () => {
    writeIssueDraft({ ...emptyDraft, title: "下書き" });
    clearIssueDraft();
    expect(readIssueDraft()).toBeNull();
  });
});

describe("resolveInitialIssueDraft", () => {
  it("下書きも明示的なプリフィルもない場合は空の状態を返す", () => {
    expect(resolveInitialIssueDraft({})).toEqual(emptyDraft);
  });

  it("保存済みの下書きがあっても自動では復元せず空の状態を返す", () => {
    const draft: IssueDraft = {
      repositoryFullName: "owner/repo",
      title: "下書きタイトル",
      body: "下書き本文",
      selectedLabels: ["bug"],
      assignee: "octocat",
    };
    writeIssueDraft(draft);
    expect(resolveInitialIssueDraft({})).toEqual(emptyDraft);
  });

  it("defaultTitleが明示的に渡された場合はそちらを使う", () => {
    writeIssueDraft({ ...emptyDraft, title: "下書きタイトル" });
    expect(resolveInitialIssueDraft({ defaultTitle: "引用元タイトル" })).toEqual({
      ...emptyDraft,
      title: "引用元タイトル",
    });
  });

  it("defaultBodyが明示的に渡された場合はそちらを使う", () => {
    writeIssueDraft({ ...emptyDraft, body: "下書き本文" });
    expect(resolveInitialIssueDraft({ defaultBody: "## 引用元セクション" })).toEqual({
      ...emptyDraft,
      body: "## 引用元セクション",
    });
  });

  it("defaultRepositoryFullNameが渡された場合は保存済み下書きのリポジトリより優先する", () => {
    const draft: IssueDraft = {
      repositoryFullName: "owner/draft-repo",
      title: "下書きタイトル",
      body: "下書き本文",
      selectedLabels: ["bug"],
      assignee: "octocat",
    };
    writeIssueDraft(draft);
    expect(resolveInitialIssueDraft({ defaultRepositoryFullName: "owner/context-repo" })).toEqual({
      ...emptyDraft,
      repositoryFullName: "owner/context-repo",
    });
  });

  it("defaultRepositoryFullNameが渡され、保存済み下書きが無い場合はその値を使う", () => {
    expect(resolveInitialIssueDraft({ defaultRepositoryFullName: "owner/context-repo" })).toEqual({
      ...emptyDraft,
      repositoryFullName: "owner/context-repo",
    });
  });
});

describe("readRestorableIssueDraft", () => {
  it("保存済みの下書きが無い場合はnullを返す", () => {
    expect(readRestorableIssueDraft({})).toBeNull();
  });

  it("明示的なプリフィルがない場合は保存済みの下書きを返す", () => {
    const draft: IssueDraft = {
      repositoryFullName: "owner/repo",
      title: "下書きタイトル",
      body: "下書き本文",
      selectedLabels: ["bug"],
      assignee: "octocat",
    };
    writeIssueDraft(draft);
    expect(readRestorableIssueDraft({})).toEqual(draft);
  });

  it("defaultTitleが明示的に渡された場合はnullを返す", () => {
    writeIssueDraft({ ...emptyDraft, title: "下書きタイトル" });
    expect(readRestorableIssueDraft({ defaultTitle: "引用元タイトル" })).toBeNull();
  });

  it("defaultBodyが明示的に渡された場合はnullを返す", () => {
    writeIssueDraft({ ...emptyDraft, body: "下書き本文" });
    expect(readRestorableIssueDraft({ defaultBody: "## 引用元セクション" })).toBeNull();
  });

  it("defaultRepositoryFullNameのみが渡された場合は保存済みの下書きを返す", () => {
    const draft: IssueDraft = {
      repositoryFullName: "owner/draft-repo",
      title: "下書きタイトル",
      body: "下書き本文",
      selectedLabels: ["bug"],
      assignee: "octocat",
    };
    writeIssueDraft(draft);
    expect(readRestorableIssueDraft({ defaultRepositoryFullName: "owner/context-repo" })).toEqual(draft);
  });
});

describe("useIssueDraftAutosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("openの間はデバウンスしてから保存する", () => {
    const draft: IssueDraft = { ...emptyDraft, title: "入力中のタイトル" };
    renderHook(({ open, draft }) => useIssueDraftAutosave(open, draft), {
      initialProps: { open: true, draft },
    });

    expect(readIssueDraft()).toBeNull();
    vi.advanceTimersByTime(500);
    expect(readIssueDraft()).toEqual(draft);
  });

  it("デバウンス完了前にopenがfalseになった場合、保留中の内容を即座に保存する", () => {
    const draft: IssueDraft = { ...emptyDraft, title: "入力直後に閉じた内容" };
    const { rerender } = renderHook(({ open, draft }) => useIssueDraftAutosave(open, draft), {
      initialProps: { open: true, draft },
    });

    vi.advanceTimersByTime(100);
    expect(readIssueDraft()).toBeNull();

    rerender({ open: false, draft });
    expect(readIssueDraft()).toEqual(draft);
  });
});
