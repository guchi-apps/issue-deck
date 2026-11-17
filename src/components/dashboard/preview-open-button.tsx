"use client";

import { ExternalLink, Loader2, MonitorPlay } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

import type { DispatchHostView, DispatchJobView, PreviewAction } from "@/lib/dispatch/dispatch-job";
import {
  describePreviewRejection,
  resolvePreviewOpenState,
  selectPreviewJob,
} from "@/lib/dispatch/preview-server";

/**
 * リポジトリの「developを開く」ワンタップ導線（#5495）。
 *
 * 状態（サブPCの申告・直近のジョブ）はシェルが**1回だけ**取得している（`useDispatchState`を
 * 画面ごとに呼ぶとポーリングが増える。#1262）ので、ここへはコンテキストで配る。
 * 提供されていない場所（テスト・設定画面など）ではボタンを出さない。
 */
export type PreviewOpenContextValue = {
  hosts: readonly DispatchHostView[];
  jobs: readonly DispatchJobView[];
  isLoaded: boolean;
  onRequestPreview: (params: {
    hostName: string;
    repositoryFullName: string;
    action: PreviewAction;
  }) => Promise<{ ok: true } | { ok: false; message: string }>;
};

const PreviewOpenContext = createContext<PreviewOpenContextValue | null>(null);

export function PreviewOpenProvider({
  value,
  children,
}: {
  value: PreviewOpenContextValue;
  children: ReactNode;
}) {
  return <PreviewOpenContext.Provider value={value}>{children}</PreviewOpenContext.Provider>;
}

/**
 * 押すと確認環境を起動し、準備ができたら同じ場所が「開く」（tailnetのURLへの`<a href>`）に変わる。
 * **`window.open`は呼ばない**——起動は非同期で、完了後に自動で開くとスマホはポップアップとして
 * ブロックする。人が「開く」を押す形にする。
 */
export function PreviewOpenButton({ repositoryFullName }: { repositoryFullName: string }) {
  const context = useContext(PreviewOpenContext);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  if (!context || !context.isLoaded) return null;

  // 確認環境を起こせるホスト（申告しているサブPC）。動いているものがあるホストを優先する
  const host =
    context.hosts.find((candidate) => candidate.preview?.repository === repositoryFullName) ??
    context.hosts.find((candidate) => candidate.online && candidate.previewCapable === true) ??
    context.hosts[0] ??
    null;
  const state = resolvePreviewOpenState({
    host,
    repositoryFullName,
    job: host ? selectPreviewJob(context.jobs, host.name) : null,
    now: new Date(),
  });

  // 起こせないリポジトリ（開発サーバーを持たない・チェックアウトが無い）では出さない。
  // ホスト全体の理由（応答なし等）は確認環境の画面が持つので、ここでは行を増やさない
  if (state.kind === "blocked") {
    if (state.reason === "no_dev_server" || state.reason === "repository_unavailable") return null;
    return (
      <span className="text-xs text-muted-foreground" title={describePreviewRejection(state.reason)}>
        developを開けません
      </span>
    );
  }

  if (state.kind === "starting") {
    return (
      <Button type="button" variant="outline" size="sm" disabled title={state.message}>
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        確認環境を準備中…
      </Button>
    );
  }

  if (state.kind === "open") {
    if (!state.url) {
      return (
        <span className="text-xs text-muted-foreground">
          起動中（tailnetのURLが出せないホストです）
        </span>
      );
    }
    return (
      <Button
        variant="outline"
        size="sm"
        asChild
        title={`developの確認環境を開く${state.commit ? `（${state.commit}）` : ""}`}
      >
        <a href={state.url} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="size-3.5" aria-hidden />
          developを開く
        </a>
      </Button>
    );
  }

  async function start() {
    if (!host || !context) return;
    setSubmitting(true);
    setError(null);
    const result = await context.onRequestPreview({
      hostName: host.name,
      repositoryFullName,
      action: "start",
    });
    setSubmitting(false);
    if (!result.ok) setError(result.message);
  }

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={submitting}
        onClick={start}
        title={
          state.replacing
            ? `起動には数分かかります。動いている ${state.replacing} の確認環境は止まります（同時に動かせるのは1つ）`
            : "developの最新で起動します（数分かかります）。準備ができたら「developを開く」に変わります"
        }
      >
        {submitting ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <MonitorPlay className="size-3.5" aria-hidden />
        )}
        developを確認環境で起動
      </Button>
      <span className="text-[11px] text-muted-foreground">
        数分かかります{state.replacing ? `。${state.replacing.split("/")[1] ?? state.replacing}の確認環境は止まります` : ""}
      </span>
      {error && (
        <span className="text-[11px] text-destructive" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
