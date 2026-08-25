"use client";

import { useCallback, useMemo, useState } from "react";

import { useIssueOrder } from "@/hooks/use-issue-order";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { ISSUE_ORDER_CANDIDATE_LIMIT } from "@/lib/claude/limits";
import type { IssueOrderResult } from "@/lib/claude/issue-order";
import { resolveIssueOrderView, type IssueOrderView } from "@/lib/issue-order-view";
import { filterIssuesByView } from "@/lib/issue-stats";
import type { Issue } from "@/types/issue";

export type IssueOrderGuideHandle = {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** 判定を走らせてダイアログを開く */
  start: () => void;
  /** 同じ候補で判定をやり直す */
  redecide: () => void;
  /** 1位を見送って次の候補へ進める */
  dismiss: (key: string) => void;
  view: IssueOrderView;
  isDeciding: boolean;
  error: string | null;
  /** `CLAUDE_CODE_OAUTH_TOKEN`が未設定で、この機能を使えない環境か */
  notConfigured: boolean;
  /** 判定の対象になった件数（`ISSUE_ORDER_CANDIDATE_LIMIT`で頭打ち） */
  candidateCount: number;
  /** 一覧に並んでいる未着手の総数。`candidateCount`との差が対象外のぶん */
  totalCount: number;
  /** 1位が決まったら自動でサブPCへ積むか（端末ごとにlocalStorageへ保存する） */
  autoStart: boolean;
  setAutoStart: (autoStart: boolean) => void;
};

/**
 * 自動開始の設定を保存するキー。**端末ごとの設定**にする（`usePersistedState`）。
 * サブPCへ積むかどうかは、その画面を見ている端末から見た都合で決まる。
 */
const AUTO_START_STORAGE_KEY = "issue-order.auto-start";

/**
 * 「次にやること」（#1853）の開閉と判定結果を持つ。
 *
 * ダイアログは`IssueDeckShell`に1つだけ置き、PC・スマホのどちらの入口からもこの状態を使う
 * （手作業アシスタント・`use-manual-step-guide.ts`と同じ）。
 *
 * **判定に渡す候補は開いた時点のスナップショットにしない。** 手作業アシスタントと違って
 * 案内を1件ずつ進める作りではなく、結果の突き合わせは`owner/repo#番号`のキーで行うため、
 * 一覧が更新されて件数が変わっても行がずれない。むしろ最新の一覧で引き当てた方が、
 * 判定のあいだにcloseされたIssueを出さずに済む（`resolveIssueOrderView`）。
 */
export function useIssueOrderGuide(issues: Issue[]): IssueOrderGuideHandle {
  const { isDeciding, error, notConfigured, decide, clearError } = useIssueOrder();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<IssueOrderResult | null>(null);
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [autoStart, setAutoStart] = usePersistedState(AUTO_START_STORAGE_KEY, true);

  /**
   * 判定の母集団は**「未着手」ビューの定義そのもの**（`filterIssuesByView`）で、
   * ユーザーがTopBarで指定した絞り込みは通さない。
   *
   * 左メニューの「未着手」の件数と同じ数え方にするため（#1750と同じ理由）。リポジトリを1つに
   * 絞った状態で開いても、着手順は全体を見て決まってほしい——このアプリは複数リポジトリを
   * 横断で見るためのもので、「次に何をやるか」はまさに横断で決まる。
   */
  const candidates = useMemo(
    () => filterIssuesByView(issues.filter((issue) => issue.state === "open"), "not-started", null),
    [issues],
  );

  const run = useCallback(async () => {
    setResult(null);
    setDismissedKeys(new Set());
    clearError();
    setResult(await decide(candidates));
  }, [decide, clearError, candidates]);

  const start = useCallback(() => {
    setOpen(true);
    void run();
  }, [run]);

  const redecide = useCallback(() => {
    void run();
  }, [run]);

  const dismiss = useCallback((key: string) => {
    setDismissedKeys((prev) => new Set(prev).add(key));
  }, []);

  const view = useMemo(
    () => resolveIssueOrderView(result, candidates, dismissedKeys),
    [result, candidates, dismissedKeys],
  );

  return {
    open,
    setOpen,
    start,
    redecide,
    dismiss,
    view,
    isDeciding,
    error,
    notConfigured,
    candidateCount: Math.min(candidates.length, ISSUE_ORDER_CANDIDATE_LIMIT),
    totalCount: candidates.length,
    autoStart,
    setAutoStart,
  };
}
