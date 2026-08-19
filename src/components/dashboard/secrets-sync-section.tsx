"use client";

import { Fragment, useState } from "react";
import { AlertTriangle, Check, KeyRound, Loader2, RefreshCw } from "lucide-react";

import { FleetRepositoryRow } from "@/components/dashboard/fleet-repository-row";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useNow } from "@/hooks/use-now";
import { useSecretsSync, type SecretsSyncRepository } from "@/hooks/use-secrets-sync";
import { formatRelativeDate } from "@/lib/format-relative-date";
import {
  describeSecretsSyncResult,
  normalizeOnlyKeys,
  type SecretSyncRunView,
} from "@/lib/secrets-sync";

/**
 * 1Password → GitHub のシークレット同期を画面から起こす（#1309）。
 *
 * **押した先でsecretを書くのはissue-deckではなく、対象リポジトリのActions**
 * （`sync-secrets.yml`）。issue-deckが持つのは起動する権限だけで、Secrets書き込み権限は
 * 持たない。ここに出るのは件数と失敗した項目名だけで、**値も値の長さも出さない**。
 *
 * フリート横断の運用という点で「共有ワークフローのバージョン」と同じ性質のため、
 * アプリ設定ダイアログの隣に置いている。
 */
/**
 * 段を改めて全文を出す長い文（失敗の理由・失敗した項目名）。無ければ`null`（#1942）。
 *
 * 以前は1本の文字列を行の右端へ縮まない指定で置いていたため、`sync-secrets.yml`が
 * 見つからない等の長い理由が画面幅を超え、横スクロールしないと読めなかった。
 */
function secretsSyncDetail(run: SecretSyncRunView): string | null {
  const result = describeSecretsSyncResult(run);
  if (result.kind === "message") return result.message;
  if (result.kind === "counts" && result.failedKeys.length > 0) {
    return `失敗: ${result.failedKeys.join(", ")}`;
  }
  return null;
}

/** 1リポジトリぶんの結果。**件数は折り返して並べる**（#1942） */
function SecretsSyncResultLine({
  run,
  nowMs,
}: {
  run: SecretSyncRunView | null;
  nowMs: number | null;
}) {
  if (!run) return <span className="text-muted-foreground/60">未実行</span>;

  const result = describeSecretsSyncResult(run);
  // `useNow`はマウント前にnullを返す。そのあいだは時刻を出さない（#1891）
  const relative = nowMs === null ? null : formatRelativeDate(run.finishedAt ?? run.startedAt, nowMs);

  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5 text-muted-foreground tabular-nums">
      {result.kind === "running" && <span>実行中...</span>}
      {result.kind === "counts" &&
        [
          { label: "同期", value: result.synced, bad: false },
          { label: "スキップ", value: result.skipped, bad: false },
          { label: "失敗", value: result.failed, bad: true },
        ].map((count, index) => (
          <Fragment key={count.label}>
            {index > 0 && <span className="opacity-40">·</span>}
            <span
              className={
                count.value === 0
                  ? "opacity-50"
                  : count.bad
                    ? "font-medium text-destructive"
                    : undefined
              }
            >
              {`${count.label} ${count.value}`}
            </span>
          </Fragment>
        ))}
      {relative && <span className="opacity-70">{relative}</span>}
    </span>
  );
}

export function SecretsSyncSection({ open }: { open: boolean }) {
  const { repositories, isLoading, error, reload } = useSecretsSync(open);
  const nowMs = useNow();
  const [only, setOnly] = useState("");
  const [confirmTarget, setConfirmTarget] = useState<SecretsSyncRepository | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const onlyIsValid = normalizeOnlyKeys(only) !== null;

  async function handleSync(repository: SecretsSyncRepository) {
    const [owner, repo] = repository.fullName.split("/");
    setSubmitting(repository.fullName);
    setActionError(null);
    try {
      const res = await fetch("/api/secrets-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, only }),
      });
      const json: { message?: string } = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.message ?? `起動に失敗しました (${res.status})`);
      setConfirmTarget(null);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">1Password → GitHub のシークレット同期</span>
        <Button variant="ghost" size="sm" onClick={reload} disabled={isLoading} aria-label="再取得">
          <RefreshCw className={isLoading ? "animate-spin" : undefined} />
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      <div className="flex flex-col gap-1">
        <Label htmlFor="secrets-sync-only" className="text-xs font-normal text-muted-foreground">
          対象キー（カンマ区切り。空なら全件）
        </Label>
        <Input
          id="secrets-sync-only"
          value={only}
          onChange={(e) => setOnly(e.target.value)}
          placeholder="SIGNALY_WEBHOOK_URL,DB_NAME"
          aria-invalid={!onlyIsValid}
        />
      </div>

      {!error && isLoading && repositories.length === 0 && (
        <p className="text-xs text-muted-foreground">読み込み中...</p>
      )}

      {repositories.length === 0 && !isLoading ? (
        <p className="text-xs text-muted-foreground">対象のリポジトリがありません。</p>
      ) : (
        <ul className="flex flex-col">
          {repositories.map((repository) => {
            const run = repository.latestRun;
            const running = run?.status === "QUEUED";
            const failed = run?.status === "FAILED" || run?.status === "TIMEOUT";
            return (
              <FleetRepositoryRow
                key={repository.fullName}
                fullName={repository.fullName}
                icon={
                  running ? (
                    <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                  ) : failed ? (
                    <AlertTriangle className="size-3.5 text-destructive" />
                  ) : (
                    <Check
                      className={`size-3.5 text-muted-foreground ${run ? "" : "opacity-60"}`}
                    />
                  )
                }
                result={<SecretsSyncResultLine run={run} nowMs={nowMs} />}
                detail={run ? secretsSyncDetail(run) : null}
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 shrink-0 px-2"
                    disabled={running || !onlyIsValid || submitting !== null}
                    onClick={() => {
                      setActionError(null);
                      setConfirmTarget(repository);
                    }}
                  >
                    <KeyRound />
                    同期
                  </Button>
                }
              />
            );
          })}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        1Password（値の正）から、そのリポジトリのGitHub secret / variableへ値を写します。
        書き込むのはissue-deckではなく<strong>対象リポジトリのActions</strong>で、issue-deckは
        起動するだけです。<strong>1Passwordの日次枠（アカウント全体で1,000件/日）を消費する</strong>
        ため、値を変えたときだけ実行してください。変えた項目が分かっているなら対象キーで絞ると、
        消費もその件数だけになります。
      </p>

      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(next) => !next && setConfirmTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTarget?.fullName} のシークレットを同期しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {normalizeOnlyKeys(only)
                ? `対象は ${normalizeOnlyKeys(only)} の${normalizeOnlyKeys(only)?.split(",").length}件です。`
                : "マニフェスト全件（20〜30件）が対象です。"}
              1Password側の読み取り1件につきサービスアカウントの日次枠（アカウント全体で1,000件/日）を
              1件消費します。枠を使い切るとフリート全体のデプロイが止まります。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting !== null}
              onClick={(e) => {
                // ダイアログを閉じる既定の動作を止め、起動の成否を見てから閉じる
                e.preventDefault();
                if (confirmTarget) void handleSync(confirmTarget);
              }}
            >
              {submitting !== null ? "起動中..." : "同期する"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
