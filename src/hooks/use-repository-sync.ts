"use client";

import { useState } from "react";

export function useRepositorySync() {
  const [isSyncing, setIsSyncing] = useState(false);

  async function handleSync() {
    setIsSyncing(true);
    try {
      const res = await fetch("/api/sync/repositories", { method: "POST" });
      if (!res.ok) {
        throw new Error(`再同期に失敗しました (${res.status})`);
      }
      const data: { synced: number; errors: { installation: string; message: string }[] } =
        await res.json();
      if (data.errors.length > 0) {
        alert(
          `一部のインストールのリポジトリ再同期に失敗しました。\n${data.errors
            .map((e) => `${e.installation}: ${e.message}`)
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
