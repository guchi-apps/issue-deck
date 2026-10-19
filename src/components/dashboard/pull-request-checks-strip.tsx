"use client";

import { useState } from "react";

import { useGithubReferenceNavigation } from "@/components/dashboard/github-reference-navigation";
import { PullRequestMergeChecks } from "@/components/dashboard/pull-request-merge-checks";
import { useNow } from "@/hooks/use-now";
import { useReleaseCandidates } from "@/hooks/use-release-candidates";
import { buildMergeChecks, cellsFromSummary } from "@/lib/pull-request-merge-checks";
import { buildReleaseCheckCells } from "@/lib/release-candidate-checks";
import type { PullRequestSummary } from "@/types/pull-request";

/** 個別PRでは使わない共通結果の置き場（`buildMergeChecks`の入力を満たすだけで、描画には使わない） */
const NO_RELEASE_CELLS = buildReleaseCheckCells({ source: { status: "loading" }, pullRequestNumber: 0, nowMs: 0 });

type StripProps = {
  pullRequest: PullRequestSummary;
  onOpenPullRequest?: (() => void) | null;
  /** 2グループ表示（#4427）。ブランチ画面など従来の1列表示が要る場所だけfalse */
  grouped?: boolean;
  showCandidateNote?: boolean;
  pullRequestEvidenceLabel?: string;
  className?: string;
};

/**
 * PR詳細・PR一覧・ブランチ画面で共通のチェック（#4366）。個別PRは「このPR」の3項目（CI・コード・競合）だけを出し、
 * リリース候補の共通結果は出さない（#4841。個別PRの判断に使わないため）。
 * リリースPR自身（develop→main）の行だけは、リリース候補の共通結果（全体レビュー・統合検証・iOS検証）を
 * 含む6項目を、リポジトリ単位で共有する取得から作る。**検証は起動しない**（読むだけ）。
 *
 * @param onOpenPullRequest 個別PRの詳細を開く。省略時は証跡の導線を出さない（既に詳細を開いている画面）
 */
export function PullRequestChecksStrip(props: StripProps) {
  return props.pullRequest.kind === "release" ? (
    <ReleasePullRequestChecksStrip {...props} />
  ) : (
    <OwnPullRequestChecksStrip {...props} />
  );
}

function OwnPullRequestChecksStrip({ pullRequest, onOpenPullRequest, pullRequestEvidenceLabel, className }: StripProps) {
  const checks = buildMergeChecks({ ...cellsFromSummary(pullRequest), release: NO_RELEASE_CELLS }).filter(
    (check) => !check.common,
  );
  return (
    <PullRequestMergeChecks
      className={className}
      ownOnly
      pullRequestEvidenceLabel={pullRequestEvidenceLabel}
      checks={checks}
      candidate={null}
      onOpenPullRequest={onOpenPullRequest ?? null}
      onOpenCandidate={null}
    />
  );
}

function ReleasePullRequestChecksStrip({
  pullRequest,
  onOpenPullRequest,
  grouped = true,
  showCandidateNote = false,
  pullRequestEvidenceLabel,
  className,
}: StripProps) {
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
  // リリースPR自身にはCI・コードレビューが無く常に未実施になるため出さない（#4859）
  const checks = buildMergeChecks({ ...cellsFromSummary(pullRequest), release }).filter(
    (check) => check.key !== "ci" && check.key !== "code",
  );

  return (
    <PullRequestMergeChecks
      className={className}
      grouped={grouped}
      showCandidateNote={showCandidateNote}
      pullRequestEvidenceLabel={pullRequestEvidenceLabel}
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
