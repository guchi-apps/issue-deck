"use client";

import { useState } from "react";

// POST /api/sync/issues の失敗（#1141）。kindで由来が違う。
type SyncError = {
  kind: "repository" | "projects-v2";
  repo: string;
  message: string;
};

// リポジトリ単位の失敗は「どのリポジトリか」が意味を持つが、Project連携の失敗は
// インストール単位（リポジトリ横断）なので、リポジトリ名を出しても意味がない。
// 以前は一律で `projects-v2: <message>` と表示しており、何が起きたのか伝わらなかった。
function describe(error: SyncError): string {
  if (error.kind === "projects-v2") {
    return `Project連携: ${error.message}`;
  }
  return `${error.repo}: ${error.message}`;
}

function summarize(errors: SyncError[]): string {
  const hasRepository = errors.some((error) => error.kind === "repository");
  const hasProject = errors.some((error) => error.kind === "projects-v2");

  if (hasRepository && hasProject) {
    return "一部のリポジトリの再同期と、Project連携に失敗しました。";
  }
  if (hasProject) {
    // Issueの取り込み自体は成功しているため、そう分かる文面にする
    return "Issueの再同期は完了しましたが、Project連携に失敗しました。進捗（Status）が最新でない可能性があります。";
  }
  return "一部のリポジトリの再同期に失敗しました。";
}

export function useIssueSync() {
  const [isSyncing, setIsSyncing] = useState(false);

  async function handleSync() {
    setIsSyncing(true);
    try {
      const res = await fetch("/api/sync/issues", { method: "POST" });
      if (!res.ok) {
        throw new Error(`再同期に失敗しました (${res.status})`);
      }
      const data: { synced: number; errors: SyncError[] } = await res.json();
      if (data.errors.length > 0) {
        alert(`${summarize(data.errors)}\n${data.errors.map(describe).join("\n")}`);
      }
      window.location.reload();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      setIsSyncing(false);
    }
  }

  return { isSyncing, handleSync };
}
