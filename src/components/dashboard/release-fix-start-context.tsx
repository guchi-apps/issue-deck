"use client";

import { createContext } from "react";

import type { Issue } from "@/types/issue";

/**
 * リリース修正Issueの「修正を開始」の送り先（#4396）。**ここでは起動しない**。受け取ったIssueで
 * 既存の「実装を開始」ダイアログ（`StartImplementationDialog`）を開くのがシェルの仕事で、
 * AI・ホスト・オプションの選択と、権限・確認待ちなどの制約はそのダイアログが持つ。
 * 提供されない画面ではボタンを出さない（修正Issueの詳細から開始する従来どおり）。
 */
export const ReleaseFixStartContext = createContext<((issue: Issue) => void) | undefined>(undefined);
