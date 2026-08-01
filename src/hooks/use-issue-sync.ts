"use client";

import { useState } from "react";

export function useIssueSync() {
  const [isSyncing, setIsSyncing] = useState(false);

  async function handleSync() {
    setIsSyncing(true);
    try {
      const res = await fetch("/api/sync/issues", { method: "POST" });
      if (!res.ok) {
        throw new Error(`再同期に失敗しました (${res.status})`);
      }
      const data: { synced: number; errors: { repo: string; message: string }[] } =
        await res.json();
      if (data.errors.length > 0) {
        alert(
          `一部のリポジトリの再同期に失敗しました。\n${data.errors
            .map((e) => `${e.repo}: ${e.message}`)
            .join("\n")}`,
        );
      }
      window.location.reload();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      setIsSyncing(false);
    }
  }

  return { isSyncing, handleSync };
}
