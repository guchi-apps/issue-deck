"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { clientErrorMessage } from "@/lib/client-error-message";
import { requestReleaseCandidateCancel } from "@/lib/release-request";
import type { ReleaseJourney } from "@/lib/release-journey";

/**
 * ブランチ画面のリリース候補の行から、mainマージ前の候補を取り消す（#5331）。
 * 作成中（候補PRがまだ無い）でもPR詳細を経由せず押せる。確認と古い表示からの拒否（`expectedPhase`）は
 * PR詳細の取消（`ReleaseRcCancel`）と同じ`requestReleaseCandidateCancel`を使う
 */
export function ReleaseJourneyCancel({ journey, repositoryFullName, onChanged }: {
  journey: ReleaseJourney;
  repositoryFullName: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = journey.cancelTarget;
  if (!target) return null;
  const label = journey.candidateLabel ?? "リリース候補";

  const cancel = async () => {
    if (!window.confirm(`${repositoryFullName}の${label}を取り消しますか？履歴・検証結果は残り、公開はしません。取り消した後に、新しい候補を作成できます。`)) return;
    setBusy(true);
    setError(null);
    try {
      await requestReleaseCandidateCancel(repositoryFullName, target, "ブランチ画面から取消");
      onChanged();
    } catch (cause) {
      setError(clientErrorMessage(cause));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return <div className="flex min-w-0 flex-col gap-1" data-testid="release-journey-cancel">
    <Button variant="outline" size="sm" className="w-fit text-destructive" disabled={busy} onClick={() => void cancel()}>
      {busy ? "取り消しています…" : "候補を取り消して作り直す…"}
    </Button>
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}
