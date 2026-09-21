"use client";

import { useCallback, useState } from "react";

import type { ImageExtractResult } from "@/lib/image-extract-format";

export function useIssueImageExtract() {
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const extract = useCallback(async (images: string[]): Promise<ImageExtractResult | null> => {
    setIsExtracting(true);
    setError(null);
    setNotConfigured(false);

    try {
      const res = await fetch("/api/issues/image-extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ images }),
      });
      if (res.status === 501) {
        setNotConfigured(true);
        return null;
      }
      if (!res.ok) {
        const data: { message?: string } = await res.json().catch(() => ({}));
        throw new Error(data.message ?? `画像の読み取りに失敗しました (${res.status})`);
      }
      return (await res.json()) as ImageExtractResult;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setIsExtracting(false);
    }
  }, []);

  return { isExtracting, error, notConfigured, extract };
}
