"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  UploadedImage,
  UploadedImageCleanupSettings,
  UploadedImageListResponse,
  UploadedImageScanState,
  UploadedImageSummary,
} from "@/types/uploaded-image";

/**
 * アップロード済み画像の一覧・容量・削除（#2462・#2475）。
 *
 * 設定の「画像」区分を開いているあいだだけマウントされるので、取得の抑制（`enabled`）は
 * 呼び出し側に持たせていない。削除に成功したら一覧をその場から取り除き、続けて取り直す。
 *
 * **一括操作と設定の切り替えの後も同じ取り直しに乗せる。** 容量サマリーと使用状況は
 * サーバー側で組み立てているため、画面だけで辻褄を合わせようとすると必ずずれる。
 */
export function useUploadedImages() {
  const [images, setImages] = useState<UploadedImage[] | null>(null);
  const [summary, setSummary] = useState<UploadedImageSummary | null>(null);
  const [scan, setScan] = useState<UploadedImageScanState | null>(null);
  const [cleanup, setCleanup] = useState<UploadedImageCleanupSettings | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingFilename, setDeletingFilename] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
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
        return res.json() as Promise<UploadedImageListResponse>;
      })
      .then((json) => {
        if (cancelled) return;
        setImages(json.images);
        setSummary(json.summary);
        setScan(json.scan);
        setCleanup(json.cleanup);
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

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

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

  /** 「未使用をまとめてゴミ箱へ」「ゴミ箱を空にする」 */
  const runCleanup = useCallback(
    async (mode: "trash-unused" | "empty-trash"): Promise<number | null> => {
      setIsBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/issues/images/cleanup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        if (!res.ok) throw new Error(`操作に失敗しました (${res.status})`);
        const json = (await res.json()) as { count: number };
        setReloadKey((key) => key + 1);
        return json.count;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setIsBusy(false);
      }
    },
    [],
  );

  /** 自動削除のON/OFFと保持日数。切り替えた時点で保存する */
  const updateCleanupSettings = useCallback(
    async (next: { enabled: boolean; retentionDays?: number }): Promise<boolean> => {
      setIsBusy(true);
      setError(null);
      // 押した手応えを先に返す（失敗したら取り直しでサーバーの値に戻る）
      setCleanup((current) =>
        current === null
          ? current
          : { ...current, enabled: next.enabled, retentionDays: next.retentionDays ?? current.retentionDays },
      );
      try {
        const res = await fetch("/api/settings/image-cleanup", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
        if (!res.ok) throw new Error(`保存に失敗しました (${res.status})`);
        setCleanup((await res.json()) as UploadedImageCleanupSettings);
        setReloadKey((key) => key + 1);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setReloadKey((key) => key + 1);
        return false;
      } finally {
        setIsBusy(false);
      }
    },
    [],
  );

  return {
    images,
    summary,
    scan,
    cleanup,
    isLoading,
    error,
    deleteImage,
    deletingFilename,
    runCleanup,
    updateCleanupSettings,
    isBusy,
    reload,
  };
}
