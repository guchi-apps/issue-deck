"use client";

import { useEffect, useRef, useState } from "react";

import { AppLoadingScreen } from "@/components/loading-screen";
import { Button } from "@/components/ui/button";

// フォアグラウンドで使い続けているセッション向けの定期チェック間隔。
const POLL_INTERVAL_MS = 10 * 60 * 1000;

type AppUpdateCheckerProps = {
  currentVersion: string;
};

/**
 * PWAとしてホーム画面から起動された場合、Service Workerを使わずとも
 * ブラウザを再訪しない限り新しいビルドに気づけない（再インストールしないと
 * 更新されないように見える）。バージョン（package.jsonの値）をサーバーに
 * 問い合わせて比較し、新しいバージョンを検知したら追従させる。
 */
export function AppUpdateChecker({ currentVersion }: AppUpdateCheckerProps) {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [reloading, setReloading] = useState(false);
  const checkingRef = useRef(false);

  useEffect(() => {
    async function fetchLatestVersion() {
      if (checkingRef.current) return null;
      checkingRef.current = true;
      try {
        const res = await fetch("/api/app-version", { cache: "no-store" });
        if (!res.ok) return null;
        const data = (await res.json()) as { version?: string };
        return data.version ?? null;
      } catch {
        return null;
      } finally {
        checkingRef.current = false;
      }
    }

    // バックグラウンドから復帰した直後は、ユーザーが未保存の入力を失う心配がない
    // 安全なタイミングなので、新バージョンを検知したらそのまま自動でリロードする。
    // リロードが終わるまでは前のバージョンの画面が残り、操作しても反応しないため、
    // 読み込み中であることを画面で伝えてから実行する（#1978）。
    async function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      const latestVersion = await fetchLatestVersion();
      if (latestVersion && latestVersion !== currentVersion) {
        setReloading(true);
        window.location.reload();
      }
    }

    // 開きっぱなしのセッションは操作中の可能性があるため即リロードはせず、
    // バナーで更新を案内するに留める。
    async function checkForUpdate() {
      const latestVersion = await fetchLatestVersion();
      if (latestVersion && latestVersion !== currentVersion) {
        setUpdateAvailable(true);
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    const intervalId = window.setInterval(checkForUpdate, POLL_INTERVAL_MS);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearInterval(intervalId);
    };
  }, [currentVersion]);

  if (reloading) {
    return (
      <div className="fixed inset-0 z-100 flex flex-col bg-background">
        <AppLoadingScreen />
      </div>
    );
  }

  if (!updateAvailable) return null;

  return (
    <div className="fixed inset-x-4 bottom-4 z-50 flex items-center justify-between gap-3 rounded-lg border bg-foreground px-4 py-3 text-background shadow-lg sm:inset-x-auto sm:left-1/2 sm:w-full sm:max-w-md sm:-translate-x-1/2">
      <p className="text-sm">新しいバージョンがあります</p>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          setReloading(true);
          window.location.reload();
        }}
      >
        更新する
      </Button>
    </div>
  );
}
