"use client";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { useReleaseChanges } from "@/hooks/use-release-changes";

type ReleaseChangeListProps = {
  repositoryFullName: string;
  /** 確認ダイアログを開いているか。閉じている間は取得しない */
  enabled: boolean;
  /** 作成済みリリースPRの番号。あればその固定範囲を表示する（後からdevelopへ入った変更を混ぜない） */
  releasePullRequestNumber?: number | null;
};

/**
 * リリース起動確認の「今回反映する内容」（PR単位。#4201）。PC・スマホで共通。
 *
 * 取得中・取得失敗・変更0件・PRに対応づかないコミットを区別して出す。失敗を0件として
 * 見せないのが要点で、「出す変更がありません」と誤認したまま起動させない。
 */
export function ReleaseChangeList({
  repositoryFullName,
  enabled,
  releasePullRequestNumber = null,
}: ReleaseChangeListProps) {
  const { data, isLoading, error } = useReleaseChanges(
    repositoryFullName,
    enabled,
    releasePullRequestNumber,
  );
  const prUrl = (number: number) => `https://github.com/${repositoryFullName}/pull/${number}`;

  if (error) {
    return (
      <p className="text-xs text-destructive">
        今回反映する内容を取得できませんでした（{error}）。変更0件ではありません。GitHubで差分を確認してください。
      </p>
    );
  }
  if (isLoading || !data) {
    return <p className="text-xs text-muted-foreground">今回反映する内容を取得中...</p>;
  }
  if (data.pullRequests.length === 0 && data.unknownCommits.length === 0) {
    return <p className="text-xs text-muted-foreground">mainに未反映のPRはありません。</p>;
  }

  return (
    <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto rounded-md border p-2">
      <p className="text-xs font-medium text-muted-foreground">
        今回反映する内容（PR {data.pullRequests.length}件
        {data.source === "release-pr" ? "・作成済みリリースPRの範囲" : ""}
        {data.headSha ? `・${data.headSha}まで` : ""}）
      </p>
      <ul className="flex flex-col gap-1 text-xs">
        {data.pullRequests.map((pr) => (
          <li key={pr.number} className="flex flex-col gap-0.5">
            <GithubReferenceLink href={prUrl(pr.number)} className="hover:underline">
              #{pr.number} {pr.title}
              {pr.isVersionBump ? "（バージョンバンプ）" : ""}
            </GithubReferenceLink>
            {pr.issueNumber !== null && (
              <GithubReferenceLink
                href={`https://github.com/${repositoryFullName}/issues/${pr.issueNumber}`}
                className="pl-3 text-muted-foreground hover:underline"
              >
                関連Issue #{pr.issueNumber}
              </GithubReferenceLink>
            )}
          </li>
        ))}
      </ul>
      {data.unknownCommits.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t pt-1.5 text-xs text-muted-foreground">
          <p>PRとの対応を特定できないコミット（{data.unknownCommits.length}件）</p>
          <ul className="flex flex-col gap-0.5">
            {data.unknownCommits.map((commit) => (
              <li key={commit.sha}>
                {commit.sha.slice(0, 7)} {commit.title}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.truncated && (
        <p className="text-xs text-muted-foreground">
          コミットが多いため一部のみ表示しています。残りはGitHubで確認してください。
        </p>
      )}
    </div>
  );
}
