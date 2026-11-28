"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { describeAutoPublishView, type AutoPublishStepState, type AutoPublishView } from "@/lib/release-autopilot-view";
import type { RcCandidateView } from "@/lib/release-rc-run";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";
import { cn } from "@/lib/utils";

export function autoPublishViewOf(candidate: RcCandidateView | null, verification: ReleaseVerificationSummary | null): AutoPublishView | null {
  if (!candidate) return null;
  return describeAutoPublishView({
    phase: candidate.phase,
    autoPublish: candidate.autoPublish,
    importing: candidate.revisions.some((revision) => revision.status === "requested"),
    productionStopped: Boolean(candidate.production?.stopReason),
    verification,
  });
}

const CHIP = {
  running: { text: "自動実行中", className: "border border-purple-500/60 text-purple-700 dark:text-purple-300", frame: "border-purple-500/60" },
  stopped: { text: "停止・あなたの番", className: "bg-amber-500 text-amber-950", frame: "border-amber-500" },
  completed: { text: "公開完了", className: "border border-green-600/60 text-green-700 dark:text-green-400", frame: "border-green-600/60" },
} as const;

const MARK: Record<AutoPublishStepState, { mark: string; className: string }> = {
  done: { mark: "✓", className: "text-green-600 dark:text-green-500" },
  current: { mark: "●", className: "text-purple-600 dark:text-purple-400" },
  failed: { mark: "■", className: "text-destructive" },
  todo: { mark: "○", className: "text-muted-foreground" },
};

const BAR: Record<AutoPublishStepState, string> = {
  done: "bg-green-600 dark:bg-green-500",
  current: "bg-purple-600 dark:bg-purple-500",
  failed: "bg-destructive",
  todo: "bg-muted-foreground/20",
};

/** 本番公開の全自動の状態・工程と、止める／再開する操作。本番PR詳細とスマホのリリースシートで共有する */
export function ReleaseAutoPublishCard({ candidate, repositoryFullName, verification, onChanged }: {
  candidate: RcCandidateView;
  repositoryFullName: string;
  verification: ReleaseVerificationSummary | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = autoPublishViewOf(candidate, verification);
  if (!view) return null;
  const [owner, repo] = repositoryFullName.split("/");

  const post = async (url: string, body: object): Promise<boolean> => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.ok) return true;
    const failed = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    setError(
      failed?.error === "already_publishing"
        ? "本番へのマージを始めているため止められません"
        : (failed?.message ?? "操作できませんでした。状態を取り直してください"),
    );
    return false;
  };

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch {
      setError("通信に失敗しました");
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const stop = () => {
    if (!window.confirm(`${repositoryFullName}の${candidate.label}の自動公開を止めますか？候補と検証結果は残ります。`)) return;
    void act(() => post("/api/repositories/release/rc", { owner, repo, action: "stop_auto", candidateId: candidate.id }));
  };

  const resume = () =>
    void act(async () => {
      const rerun = view.resume?.rerun;
      const target = verification?.target;
      // やり直せなければ再開しない（同じ理由で止まり直すだけになる）
      if (rerun && target && candidate.prNumber !== null) {
        const accepted = await post(`/api/repositories/release/${rerun === "integration" ? "integration-rerun" : "review-rerun"}`, {
          owner,
          repo,
          pullRequestNumber: candidate.prNumber,
          baseSha: target.baseSha,
          headSha: target.headSha,
        });
        if (!accepted) return;
      }
      await post("/api/repositories/release/rc", { owner, repo, action: "resume_auto", candidateId: candidate.id });
    });

  const chip = CHIP[view.mode];
  return (
    <section aria-label="本番公開の自動実行" className={cn("flex flex-col gap-3 rounded-[10px] border-[1.5px] bg-card p-3.5 text-sm", chip.frame)} data-testid="release-auto-publish-card" data-mode={view.mode}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={cn("rounded-full px-2.5 py-0.5 font-bold", chip.className)}>{chip.text}</span>
        <span className="text-muted-foreground">{candidate.label}</span>
      </div>
      <h3 className="text-[15px] font-semibold text-balance">{view.headline}</h3>
      {view.note && <p className="break-words text-xs text-muted-foreground">{view.note}</p>}
      <div className="grid grid-cols-6 gap-[3px]" aria-hidden="true">
        {view.steps.map((step) => (
          <span key={step.label} className={cn("h-1.5 rounded-sm", BAR[step.state])} />
        ))}
      </div>
      <ol className="flex flex-col" aria-label="本番公開の工程">
        {view.steps.map((step) => (
          <li key={step.label} className="flex gap-2.5 py-1.5" aria-current={step.state === "current" || step.state === "failed" ? "step" : undefined}>
            <span className={cn("w-4 shrink-0", MARK[step.state].className)} aria-hidden="true">{MARK[step.state].mark}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className={cn(step.state === "current" || step.state === "failed" ? "font-semibold" : step.state === "todo" && "text-muted-foreground")}>
                {step.label}
              </span>
              {step.details.length > 0 && (
                <dl className="flex flex-col gap-1 rounded-md bg-muted/50 p-2.5 text-xs">
                  {step.details.map((detail) => (
                    <div key={detail.label} className="flex justify-between gap-2">
                      <dt>{detail.label}</dt>
                      <dd className="text-muted-foreground">{detail.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </li>
        ))}
      </ol>
      {view.resume && (
        <Button className="min-h-11 w-full gap-1.5 font-bold sm:w-fit sm:px-4" disabled={busy} onClick={resume}>
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          {view.resume.label}
        </Button>
      )}
      {view.canStop && (
        <Button variant="outline" className="min-h-11 w-full gap-1.5 font-bold sm:w-fit sm:px-4" disabled={busy} onClick={stop}>
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          自動公開を止める
        </Button>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
  );
}
