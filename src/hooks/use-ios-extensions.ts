"use client";

import { useCallback, useEffect, useState } from "react";

import type { IosExtension } from "@/lib/ios-extensions";

export type IosExtensionRepository = {
  fullName: string;
  htmlUrl: string;
  extensions: IosExtension[];
  scannedFiles: number;
  truncated: boolean;
  error: string | null;
};

/** iOS拡張の一覧（#3708）。`active`のときだけ取得する（画面を開いたときだけGitHubを呼ぶ） */
export function useIosExtensions(active = true) {
  const [repositories, setRepositories] = useState<IosExtensionRepository[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (force = false) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/repositories/ios-extensions${force ? "?refresh=1" : ""}`);
      const json = (await response.json().catch(() => null)) as { repositories?: IosExtensionRepository[] } | null;
      if (!response.ok) throw new Error(`iOS拡張を取得できませんでした (${response.status})`);
      setRepositories(json?.repositories ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "iOS拡張を取得できませんでした");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [active, refresh]);

  return { repositories, isLoading, error, refresh };
}
