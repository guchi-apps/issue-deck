"use client";

import { AlertTriangle, Ban, CheckCircle2, ChevronDown, ChevronRight, HelpCircle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BackupCiDisplayKind } from "@/lib/backup-ci/state";
import type { BackupCiRunView, CiGateStateView } from "@/lib/backup-ci/view";
import { formatDateTime } from "@/lib/format-date-time";
import { cn } from "@/lib/utils";

/**
 * GitHub Actions障害時のバックアップCI（CircleCI・#4065）。PR詳細のdevelop向け未マージPRに出す。
 *
 * **起動は利用者が押したときだけ**（障害の自動判定・自動切替はしない）。押す前に、対象のリポジトリ・
 * PR・コミット・実行先を確認させる。元のActionsの状態は別の行に出し、どちらで検査したかを区別する。
 */

type Readiness = {
  enabled: boolean;
  circleciProjectSlug: string | null;
  circleciDefinitionId: string | null;
  mirrorActionsToCiGate: boolean;
  tokenConfigured: boolean;
  webhookConfigured: boolean;
  problems: string[];
};

type ActionsCheck = { status: string; conclusion: string | null };

const KIND_CLASS: Record<BackupCiDisplayKind, string> = {
  running: "text-primary",
  passed: "text-foreground",
  failed: "text-destructive",
  unknown: "text-amber-600 dark:text-amber-400",
  stale: "text-muted-foreground",
};

function KindIcon({ kind }: { kind: BackupCiDisplayKind }) {
  const className = "size-3.5 shrink-0";
  switch (kind) {
    case "running":
      return <Loader2 className={cn(className, "animate-spin")} />;
    case "passed":
      return <CheckCircle2 className={className} />;
    case "failed":
      return <AlertTriangle className={className} />;
    case "unknown":
      return <HelpCircle className={className} />;
    case "stale":
      return <Ban className={className} />;
  }
}

/** 元のActionsの状態の要約。共通チェックとは別に出す（Actionsの履歴を消さない） */
export function describeActionsState(checks: readonly ActionsCheck[]): string {
  if (checks.length === 0) return "GitHub Actions: ジョブが開始されていません";
  if (checks.some((c) => c.status !== "completed")) return "GitHub Actions: 待機中・実行中";
  const failed = checks.some(
    (c) => c.conclusion !== null && !["success", "skipped", "neutral"].includes(c.conclusion),
  );
  return failed ? "GitHub Actions: 失敗" : "GitHub Actions: 成功";
}

/** 共通チェックに今どちらの経路の結果を出しているか（#4113） */
export function describeCiGate(gate: Pick<CiGateStateView, "state" | "sourceLabel" | "publishFailure">): string {
  if (gate.publishFailure) return `共通チェック: 発行できませんでした（${gate.publishFailure}）`;
  return `共通チェック issue-deck/ci-gate: ${gate.state}（${gate.sourceLabel}の結果を採用）`;
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

export function PullRequestBackupCi({
  repositoryFullName,
  prNumber,
  headSha,
  headRef,
  actionsChecks,
}: {
  repositoryFullName: string;
  prNumber: number;
  headSha: string;
  headRef: string;
  actionsChecks: readonly ActionsCheck[];
}) {
  const [owner, repo] = repositoryFullName.split("/");
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [runs, setRuns] = useState<BackupCiRunView[]>([]);
  const [gate, setGate] = useState<CiGateStateView | null>(null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // 取り直しの合図。押した直後・設定の保存後に増やす
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(async () => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const params = new URLSearchParams({ owner, repo, number: String(prNumber) });
    async function fetchOnce() {
      const res = await fetch(`/api/pull-requests/backup-ci?${params}`, { cache: "no-store" }).catch(() => null);
      if (cancelled || !res?.ok) return;
      const json = (await res.json().catch(() => null)) as {
        readiness?: Readiness;
        runs?: BackupCiRunView[];
        gate?: CiGateStateView | null;
      } | null;
      if (cancelled || !json || !json.readiness || !Array.isArray(json.runs)) return;
      setReadiness(json.readiness);
      setRuns(json.runs);
      setGate(json.gate ?? null);
      // 実行中の間だけ15秒おきに取り直す
      if (json.runs[0]?.displayKind === "running") timer = setTimeout(() => void fetchOnce(), 15_000);
    }
    void fetchOnce();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [owner, repo, prNumber, reloadKey]);

  const latest = runs[0] ?? null;
  const running = latest?.displayKind === "running";

  const start = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/pull-requests/backup-ci", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, number: prNumber }),
      });
      const json = (await res.json().catch(() => ({}))) as { reused?: boolean; message?: string; error?: string };
      if (!res.ok) setMessage(json.message ?? `起動できませんでした（${json.error ?? res.status}）`);
      else if (json.reused) setMessage("このPRではバックアップCIがすでに実行中です。新しくは起動していません。");
      setConfirming(false);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const ready = readiness !== null && readiness.problems.length === 0;
  const latestIsCurrent = latest !== null && latest.headSha === headSha;

  return (
    <section aria-label="バックアップCI" className="flex flex-col gap-1.5 border-b px-4 py-3">
      <button
        type="button"
        className="flex items-center gap-1 text-left text-xs font-semibold text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        バックアップCI（GitHub Actions障害時）
      </button>
      <p className="text-xs text-muted-foreground">{describeActionsState(actionsChecks)}</p>
      {gate && gate.headSha === headSha && (
        <p className="text-xs text-muted-foreground">
          {describeCiGate(gate)}
        </p>
      )}
      {latest && (
        <div className={cn("flex flex-wrap items-center gap-1.5 text-xs", KIND_CLASS[latest.displayKind])}>
          <KindIcon kind={latest.displayKind} />
          <span className="font-medium">
            CircleCI: {latest.statusLabel}（{latest.attempt}回目）
          </span>
          {!latestIsCurrent && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">古いHEADの結果</span>
          )}
          {latest.logUrl && (
            <a href={latest.logUrl} target="_blank" rel="noreferrer" className="underline">
              ログを開く
            </a>
          )}
        </div>
      )}

      {latest && latestIsCurrent && latest.status === "passed" && (
        <p className="text-xs text-muted-foreground">
          developへのマージ: {latest.mergeStatusLabel ?? "判定待ち"}
          {latest.mergeReason && `（${latest.mergeReason}）`}
          {latest.mergeCommitSha && ` ${shortSha(latest.mergeCommitSha)}`}
        </p>
      )}

      {open && (
        <div className="flex flex-col gap-2 text-xs">
          {latest?.statusReason && <p className="text-muted-foreground">{latest.statusReason}</p>}
          {latest && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
              <dt>head / base</dt>
              <dd className="font-mono">
                {shortSha(latest.headSha)} / {shortSha(latest.baseSha)}
              </dd>
              <dt>検査したコミット</dt>
              <dd className="font-mono">{shortSha(latest.testedSha)}（baseへheadをマージした結果）</dd>
              <dt>検査定義</dt>
              <dd className="font-mono break-all">{latest.definitionDigest?.slice(0, 19) ?? "—"}</dd>
              <dt>開始</dt>
              <dd>{formatDateTime(latest.requestedAt)}</dd>
              {latest.gateState && (
                <>
                  <dt>共通チェック</dt>
                  <dd>
                    {latest.gateState.startsWith("publish_failed")
                      ? `発行できませんでした（${latest.gateState}）`
                      : `issue-deck/ci-gate: ${latest.gateState.split(":")[0]}`}
                  </dd>
                </>
              )}
            </dl>
          )}
          {latest && latest.checks.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {latest.checks.map((check) => (
                <li
                  key={`${check.group}/${check.id}`}
                  className={cn(
                    "flex items-center gap-1.5",
                    check.status === "passed" ? "text-foreground" : "text-destructive",
                  )}
                >
                  {check.status === "passed" ? (
                    <CheckCircle2 className="size-3 shrink-0" />
                  ) : (
                    <AlertTriangle className="size-3 shrink-0" />
                  )}
                  <span>
                    [{check.group}] {check.name}
                    {check.status === "missing" && "（結果なし）"}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {readiness && readiness.problems.length > 0 && (
            <ul className="list-disc pl-4 text-amber-700 dark:text-amber-400">
              {readiness.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          {readiness && !readiness.webhookConfigured && ready && (
            <p className="text-muted-foreground">
              完了Webhookの署名鍵が未設定のため、結果はサブPCの巡回（約30秒ごと）で回収します。
            </p>
          )}

          {confirming ? (
            <div className="flex flex-col gap-1.5 rounded-md border p-2">
              <p className="font-medium">次の内容でCircleCIを起動します。</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                <dt>リポジトリ</dt>
                <dd>{repositoryFullName}</dd>
                <dt>PR</dt>
                <dd>
                  #{prNumber}（{headRef}）
                </dd>
                <dt>コミット</dt>
                <dd className="font-mono">{shortSha(headSha)}（baseへマージした結果を検査）</dd>
                <dt>実行先</dt>
                <dd className="break-all">CircleCI {readiness?.circleciProjectSlug}</dd>
              </dl>
              <p className="text-muted-foreground">
                GitHub Actionsのジョブが開始されない・止まっているときだけ使ってください。無料枠のクレジットを消費します。
              </p>
              <div className="flex gap-2">
                <Button size="xs" onClick={() => void start()} disabled={busy}>
                  {busy && <Loader2 className="size-3 animate-spin" />}
                  起動する
                </Button>
                <Button size="xs" variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
                  やめる
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button size="xs" variant="outline" disabled={!ready || running} onClick={() => setConfirming(true)}>
                バックアップCIで実行
              </Button>
            </div>
          )}
          {message && <p className="text-destructive">{message}</p>}

          {readiness && <BackupCiSettingForm owner={owner} repo={repo} readiness={readiness} onSaved={reload} />}
        </div>
      )}
    </section>
  );
}

function BackupCiSettingForm({
  owner,
  repo,
  readiness,
  onSaved,
}: {
  owner: string;
  repo: string;
  readiness: Readiness;
  onSaved: () => Promise<void>;
}) {
  const [show, setShow] = useState(false);
  const [enabled, setEnabled] = useState(readiness.enabled);
  const [slug, setSlug] = useState(readiness.circleciProjectSlug ?? "");
  const [definitionId, setDefinitionId] = useState(readiness.circleciDefinitionId ?? "");
  const [mirror, setMirror] = useState(readiness.mirrorActionsToCiGate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!show) {
    return (
      <button type="button" className="self-start text-muted-foreground underline" onClick={() => setShow(true)}>
        このリポジトリのバックアップCI設定
      </button>
    );
  }

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/repositories/backup-ci-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner,
          repo,
          enabled,
          circleciProjectSlug: slug,
          circleciDefinitionId: definitionId,
          mirrorActionsToCiGate: mirror,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) {
        setError(json.message ?? `保存できませんでした（${json.error ?? res.status}）`);
        return;
      }
      await onSaved();
      setShow(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-2">
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        このリポジトリでバックアップCIを使えるようにする
      </label>
      <label className="flex flex-col gap-0.5">
        CircleCIのプロジェクトスラッグ
        <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="circleci/<org-id>/<project-id>" />
      </label>
      <label className="flex flex-col gap-0.5">
        パイプライン定義ID
        <Input value={definitionId} onChange={(e) => setDefinitionId(e.target.value)} placeholder="xxxxxxxx-xxxx-..." />
      </label>
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
        通常時もGitHub Actionsの結果を共通チェック（issue-deck/ci-gate）へ写す
      </label>
      <p className="text-muted-foreground">
        必須チェックを共通チェックへ移したあとは外さないでください（外すと通常のPRがマージできなくなります）。
      </p>
      <p className="text-muted-foreground">APIトークンとWebhookの署名鍵はサーバーの環境変数で設定します（docs/backup-ci.md）。</p>
      {error && <p className="text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button size="xs" onClick={() => void save()} disabled={saving}>
          保存
        </Button>
        <Button size="xs" variant="outline" onClick={() => setShow(false)} disabled={saving}>
          閉じる
        </Button>
      </div>
    </div>
  );
}
