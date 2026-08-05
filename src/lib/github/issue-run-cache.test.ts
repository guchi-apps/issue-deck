import { beforeEach, describe, expect, it } from "vitest";

import {
  clearIssueRunCache,
  getIssueRunCache,
  issueRunCacheKey,
  ISSUE_RUN_CACHE_TTL_MS,
  ISSUE_RUN_NEGATIVE_CACHE_TTL_MS,
  setIssueRunCache,
} from "@/lib/github/issue-run-cache";

const KEY = issueRunCacheKey("m-guchi", "issue-deck", 123);
const NOW = new Date(2026, 7, 4, 12, 0, 0).getTime();

describe("issueRunCache", () => {
  beforeEach(() => {
    clearIssueRunCache();
  });

  it("コメント件数が同じならキャッシュを再利用する", () => {
    setIssueRunCache(KEY, { runId: 42, commentCount: 3, completed: true }, NOW);

    expect(getIssueRunCache(KEY, 3, NOW + 1000)).toMatchObject({ runId: 42, completed: true });
  });

  it("コメントが増えていればキャッシュを使わない（新しい実行ログの可能性があるため）", () => {
    setIssueRunCache(KEY, { runId: 42, commentCount: 3, completed: true }, NOW);

    expect(getIssueRunCache(KEY, 4, NOW + 1000)).toBeNull();
  });

  it("コメントが削除されて減った場合もキャッシュを使わない", () => {
    setIssueRunCache(KEY, { runId: 42, commentCount: 3, completed: true }, NOW);

    expect(getIssueRunCache(KEY, 2, NOW + 1000)).toBeNull();
  });

  it("未キャッシュのキーはnullを返す", () => {
    expect(getIssueRunCache(KEY, 3, NOW)).toBeNull();
  });

  it("TTLを過ぎたキャッシュは使わない", () => {
    setIssueRunCache(KEY, { runId: 42, commentCount: 3, completed: true }, NOW);

    expect(getIssueRunCache(KEY, 3, NOW + ISSUE_RUN_CACHE_TTL_MS - 1)).not.toBeNull();
    expect(getIssueRunCache(KEY, 3, NOW + ISSUE_RUN_CACHE_TTL_MS)).toBeNull();
  });

  it("実行ログが見つからなかった場合は短いTTLで確認し直す", () => {
    setIssueRunCache(KEY, { runId: null, commentCount: 3, completed: true }, NOW);

    expect(getIssueRunCache(KEY, 3, NOW + ISSUE_RUN_NEGATIVE_CACHE_TTL_MS - 1)).not.toBeNull();
    expect(getIssueRunCache(KEY, 3, NOW + ISSUE_RUN_NEGATIVE_CACHE_TTL_MS)).toBeNull();
  });

  it("同じキーへの再設定は上書きされる", () => {
    setIssueRunCache(KEY, { runId: 42, commentCount: 3, completed: false }, NOW);
    setIssueRunCache(KEY, { runId: 42, commentCount: 3, completed: true }, NOW + 1000);

    expect(getIssueRunCache(KEY, 3, NOW + 2000)).toMatchObject({ completed: true });
  });

  it("キーはowner/repo/issue番号で区別される", () => {
    setIssueRunCache(KEY, { runId: 42, commentCount: 3, completed: true }, NOW);

    expect(getIssueRunCache(issueRunCacheKey("m-guchi", "issue-deck", 124), 3, NOW)).toBeNull();
    expect(getIssueRunCache(issueRunCacheKey("m-guchi", "other", 123), 3, NOW)).toBeNull();
  });
});
