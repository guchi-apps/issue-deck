"use client";

import { useState } from "react";
import { AlertTriangle, Check, KeyRound, Loader2, RefreshCw } from "lucide-react";

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
import { useSecretsSync, type SecretsSyncRepository } from "@/hooks/use-secrets-sync";
import { formatSecretsSyncResult, normalizeOnlyKeys } from "@/lib/secrets-sync";

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
export function SecretsSyncSection({ open }: { open: boolean }) {
  const { repositories, isLoading, error, reload } = useSecretsSync(open);
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
        <ul className="flex flex-col gap-1">
          {repositories.map((repository) => {
            const run = repository.latestRun;
            const running = run?.status === "QUEUED";
            const failed = run?.status === "FAILED" || run?.status === "TIMEOUT";
            return (
              <li key={repository.fullName} className="flex items-center gap-2 text-xs">
                {running ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : failed ? (
                  <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
                ) : (
                  <Check className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{repository.fullName}</span>
                <span
                  className={`ml-auto shrink-0 ${failed ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {run ? formatSecretsSyncResult(run) : "未実行"}
                </span>
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
              </li>
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
