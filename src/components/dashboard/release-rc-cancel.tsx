"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { classifyRcBlock } from "@/lib/release-rc";
import { requestReleaseCandidateCancel } from "@/lib/release-request";
import type { RcCandidateView } from "@/lib/release-rc-run";

/** 失敗・記録不一致の候補を正規に終了し、新しい候補へ進む出口（#4696）。 */
export function ReleaseRcCancel({ candidate, repositoryFullName, onChanged }: {
  candidate: RcCandidateView;
  repositoryFullName: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (candidate.phase !== "review" || !["needs_fix", "fixing"].includes(candidate.status.status)) return null;

  const cancel = async () => {
    if (!window.confirm(`${repositoryFullName}の${candidate.label}を取り消しますか？履歴・検証結果は残り、公開はしません。取り消した後、ブランチ画面から修正を含む新しい候補を作成してください。`)) return;
    setBusy(true);
    setError(null);
    try {
      const block = classifyRcBlock({ candidateId: candidate.id, sequence: candidate.sequence, prNumber: candidate.prNumber,
        phase: "review", status: candidate.status.status, statusLabel: candidate.status.label });
      await requestReleaseCandidateCancel(repositoryFullName, block, "修正を含む新しい候補で検証し直すため、PR詳細から取消");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "候補を取り消せませんでした");
    } finally {
      setBusy(false);
    }
  };

  return <section aria-label="候補の作り直し" className="rounded-md border p-3">
    <p>この候補を終了し、修正を含む新しい候補で検証し直せます。履歴と過去の検証結果は残ります。</p>
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void cancel()}>
      {busy ? "取り消しています…" : "候補を取り消して作り直す"}
    </Button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
