"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ROLLOUT_STATUS_LABELS, type RolloutStatus } from "@/lib/backup-ci/rollout";
import type { RolloutDetail, RolloutRepository } from "@/lib/backup-ci/rollout-service";

const STATUS_STYLES: Record<RolloutStatus, string> = {
  not_installed: "border-muted-foreground/40 text-muted-foreground",
  needs_setup: "border-destructive/40 text-destructive",
  awaiting_verification: "border-amber-500/50 text-amber-600 dark:text-amber-400",
  ready: "border-emerald-500/50 text-emerald-600 dark:text-emerald-400",
  update_required: "border-amber-500/50 text-amber-600 dark:text-amber-400",
  unsupported: "border-muted-foreground/40 text-muted-foreground",
};

/**
 * バックアップCIの展開（#4308）。**1リポジトリずつ選んで**導入状態・不足項目・次の操作を見て、
 * 導入／更新PRを作る。全件を一度に調べない（GitHub APIの呼び出しが対象数ぶんになるため）。
 * スマホでは縦積み（選択→状態→手順の順）。
 */
export function BackupCiRolloutSection() {
  const [repositories, setRepositories] = useState<RolloutRepository[] | null>(null);
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<RolloutDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/backup-ci/rollout")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json: { repositories: RolloutRepository[] }) => !cancelled && setRepositories(json.repositories))
      .catch(() => !cancelled && setMessage("リポジトリ一覧を取得できませんでした。"));
    return () => {
      cancelled = true;
    };
  }, []);

  const inspect = useCallback(async (repo: string) => {
    if (!repo) return;
    setLoading(true);
    setDetail(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/backup-ci/rollout?repo=${encodeURIComponent(repo)}`);
      const json = (await res.json()) as { detail?: RolloutDetail; message?: string };
      if (!res.ok || !json.detail) setMessage(json.message ?? "状態を取得できませんでした。");
      else setDetail(json.detail);
    } catch {
      setMessage("状態を取得できませんでした。");
    } finally {
      setLoading(false);
    }
  }, []);

  async function dispatch() {
    if (!selected) return;
    setDispatching(true);
    setMessage(null);
    try {
      const res = await fetch("/api/backup-ci/rollout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository: selected }),
      });
      const json = (await res.json().catch(() => ({}))) as { message?: string };
      setMessage(
        res.ok
          ? "配布を起動しました。数分でPRが作られます（自動マージはしません。対象リポジトリで内容を確認してマージしてください）。"
          : (json.message ?? "配布を起動できませんでした。"),
      );
    } finally {
      setDispatching(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">展開先のリポジトリ（1件ずつ選びます）</span>
        <select
          className="h-10 rounded-md border bg-background px-2"
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            void inspect(e.target.value);
          }}
          disabled={!repositories}
        >
          <option value="">選択してください</option>
          {repositories?.map((repo) => (
            <option key={repo.fullName} value={repo.fullName}>
              {repo.fullName}
              {repo.enabled ? "（有効）" : repo.configured ? "（設定済み）" : ""}
            </option>
          ))}
        </select>
      </label>

      {loading ? <p className="text-muted-foreground">GitHubから導入状態を確認しています…</p> : null}
      {message ? <p className="rounded-md border p-2">{message}</p> : null}

      {detail ? (
        <div className="flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLES[detail.status]}`}>
              {ROLLOUT_STATUS_LABELS[detail.status]}
            </span>
            <span className="text-xs text-muted-foreground">確認したブランチ: {detail.ref}</span>
          </div>

          {detail.missing.length > 0 ? (
            <div>
              <p className="text-xs font-semibold">不足・ずれている項目</p>
              <ul className="ml-4 list-disc break-words">
                {detail.missing.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {detail.correspondence && detail.correspondence.unsupportedJobs.length > 0 ? (
            <p className="text-xs text-muted-foreground break-words">
              バックアップCIで代替しないジョブ（既存の必須判定を維持）: {detail.correspondence.unsupportedJobs.join("、")}
            </p>
          ) : null}

          <div>
            <p className="text-xs font-semibold">次の操作</p>
            <ul className="ml-4 list-disc break-words">
              {detail.nextSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          </div>

          {detail.status === "not_installed" || detail.status === "needs_setup" || detail.status === "update_required" ? (
            <Button className="w-full sm:w-auto" disabled={dispatching} onClick={dispatch}>
              {dispatching ? "起動中…" : detail.status === "not_installed" ? "導入PRを作る" : "更新PRを作る"}
            </Button>
          ) : null}

          {detail.status === "ready" || detail.status === "awaiting_verification" ? <MigrationGuide detail={detail} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** 必須チェックの段階移行と復元の手順（対象ごと。実行は人。移行前に必ず保存コマンドを実行する） */
function MigrationGuide({ detail }: { detail: RolloutDetail }) {
  const current = detail.requiredChecks;
  return (
    <details className="rounded-md border p-2">
      <summary className="cursor-pointer text-xs font-semibold">必須チェックの移行・復元手順</summary>
      <div className="mt-2 flex flex-col gap-2 text-xs">
        <p className="break-words">
          実行する端末: {detail.migration.host}。現在の必須チェック: {current ? current.join("、") || "なし" : "取得できません（Administration権限が必要）"}
        </p>
        <p>
          移行は「通常時にも共通チェックが出ていること」「試験PRで合格と共通チェックの発行を確認したこと」の後に行います。
          レビュー・iOS検証など独立した必須チェックは残し、通常CIのジョブ（{detail.replaceContexts.join("、") || "なし"}）だけを
          <code>issue-deck/ci-gate</code>へ置き換えます。
        </p>
        {(
          [
            ["1. 移行前の設定を保存", detail.migration.backup],
            ["2. 置き換える", detail.migration.migrate],
            ["3. 確認", detail.migration.verify],
            ["戻すとき（1で保存したJSONを復元）", detail.migration.restore],
          ] as const
        ).map(([label, command]) => (
          <div key={label}>
            <p className="font-medium">{label}</p>
            <pre className="overflow-x-auto rounded bg-muted p-2 whitespace-pre-wrap break-all">{command}</pre>
          </div>
        ))}
      </div>
    </details>
  );
}
