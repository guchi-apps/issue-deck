"use client";

import { useCallback, useEffect, useState } from "react";

import type { UploadedImage } from "@/types/uploaded-image";

/**
 * アップロード済み画像の一覧と削除（#2462）。
 *
 * 設定の「画像」区分を開いているあいだだけマウントされるので、取得の抑制（`enabled`）は
 * 呼び出し側に持たせていない。削除に成功したら一覧をその場から取り除き、続けて取り直す。
 */
export function useUploadedImages() {
  const [images, setImages] = useState<UploadedImage[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingFilename, setDeletingFilename] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // 区分を開いたタイミング・削除後の取り直しのタイミングで動く取得であり、
    // ループや連鎖的な再レンダリングは発生しない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError(null);

    fetch("/api/issues/images")
      .then((res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return res.json() as Promise<{ images: UploadedImage[] }>;
      })
      .then((json) => {
        if (!cancelled) setImages(json.images);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const deleteImage = useCallback(async (filename: string): Promise<boolean> => {
    setDeletingFilename(filename);
    setError(null);
    try {
      const res = await fetch(`/api/issues/images/${filename}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`削除に失敗しました (${res.status})`);
      setImages((current) => current?.filter((image) => image.filename !== filename) ?? null);
      setReloadKey((key) => key + 1);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setDeletingFilename(null);
    }
  }, []);

  return { images, isLoading, error, deleteImage, deletingFilename };
}
