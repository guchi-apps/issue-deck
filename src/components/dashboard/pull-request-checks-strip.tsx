"use client";

import { useState } from "react";

import { useGithubReferenceNavigation } from "@/components/dashboard/github-reference-navigation";
import { PullRequestMergeChecks } from "@/components/dashboard/pull-request-merge-checks";
import { useNow } from "@/hooks/use-now";
import { useReleaseCandidates } from "@/hooks/use-release-candidates";
import { buildMergeChecks, cellsFromSummary } from "@/lib/pull-request-merge-checks";
import { buildReleaseCheckCells } from "@/lib/release-candidate-checks";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * PR詳細・PR一覧・ブランチ画面で共通の6チェック（#4366）。個別PRの値は`PullRequestSummary`から、
 * リリース候補の共通結果（全体レビュー・統合検証・Mac検証）はリポジトリ単位で共有する取得から作る
 * （同じ判定対象・同じ状態定義なので、画面ごとに食い違わない）。**検証は起動しない**（読むだけ）。
 *
 * @param onOpenPullRequest 個別PRの詳細を開く。省略時は証跡の導線を出さない（既に詳細を開いている画面）
 */
export function PullRequestChecksStrip({
  pullRequest,
  onOpenPullRequest,
  className,
}: {
  pullRequest: PullRequestSummary;
  onOpenPullRequest?: (() => void) | null;
  className?: string;
}) {
  const source = useReleaseCandidates(pullRequest.repositoryFullName);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const navigation = useGithubReferenceNavigation();
  // 経過時間の表示用。時計が動くのは、実行中・待機中の候補があるときだけ（全行で常時回さない）
  const now = useNow(5_000, source.status === "loaded" && source.candidates.length > 0);

  const release = buildReleaseCheckCells({
    source,
    pullRequestNumber: pullRequest.number,
    selectedNumber,
    nowMs: now ?? 0,
  });
  const checks = buildMergeChecks({ ...cellsFromSummary(pullRequest), release });

  return (
    <PullRequestMergeChecks
      className={className}
      checks={checks}
      candidate={release.candidate}
      choices={release.choices}
      onSelectCandidate={setSelectedNumber}
      onOpenPullRequest={onOpenPullRequest ?? null}
      // アプリ内の詳細へ遷移できない場所（遷移先の提供が無い）では、候補PRをGitHubで開く
      onOpenCandidate={(number) => {
        if (navigation) {
          navigation.openReference({ repositoryFullName: pullRequest.repositoryFullName, number, kind: "pull" });
        } else {
          window.open(`https://github.com/${pullRequest.repositoryFullName}/pull/${number}`, "_blank", "noopener,noreferrer");
        }
      }}
    />
  );
}
