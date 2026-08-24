"use client";

import { ExternalLink, TriangleAlert } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { RepositoryDeployButton } from "@/components/dashboard/repository-deploy-button";
import { cn } from "@/lib/utils";
import type { DeployFailureIssueRef } from "@/types/branch-flow";

/**
 * 本番デプロイが失敗しているときに、失敗が見えている場所へそのまま出す帯（#2236）。
 *
 * **押せる場所を、失敗が見えている場所に置く。** 「本番へ再デプロイ」は#2020から
 * 「ブランチとPRの流れ」画面のリポジトリの節にあるが、そこは失敗の表示とは離れた行で、
 * PR詳細とIssue詳細には入口が無かった。落ちたことに気づいた人が、画面を移らずに
 * 出し直せるようにする。
 *
 * 出す先は3つで、**中身は同じもの**（見出しと説明だけ画面ごとに変える）。
 *
 * - ブランチ画面: 落ちた版の束の中
 * - PR詳細: 「デプロイ失敗」ピルの下
 * - Issue詳細: 自動起票したデプロイ失敗Issueのパネル（`deploy-failure-panel.tsx`）
 *
 * **ボタンは`RepositoryDeployButton`をそのまま使う。** 確認ダイアログ（押すと本番へ出るため
 * 必ず挟む）と`POST /api/repositories/deploy`の呼び出しを、3画面ぶん書き分けないため。
 */
export type DeployFailureAlertProps = {
  repositoryFullName: string;
  /** 見出し。画面ごとに主語が変わる（「このPRの変更は本番へ出ていません」など） */
  title: string;
  /** 失敗した版（`1.4.2`）。分からなければnull */
  version?: string | null;
  /** いま本番に出ている版（`1.4.1`）。分からなければnull */
  previousVersion?: string | null;
  /** 自動で1回やり直したうえでの失敗か（`run_attempt >= 2`。#2134） */
  autoRetried?: boolean;
  /** 失敗したジョブ名。空なら行ごと出さない */
  failedJobs?: string[];
  /** 失敗した実行のログURL */
  runUrl?: string | null;
  /** 追跡している自動起票Issue。無ければリンクを出さない */
  failureIssue?: DeployFailureIssueRef | null;
  /** 説明の下に足す補足（Issue詳細だけが使う） */
  footer?: React.ReactNode;
  /** すでに起動済みで実行が現れるのを待っている最中か */
  isPending?: boolean;
  /** 起動に成功したあと */
  onTriggered?: () => void;
  /** ボタンを1行占有させる（スマホ幅） */
  compact?: boolean;
  className?: string;
};

export function DeployFailureAlert({
  repositoryFullName,
  title,
  version = null,
  previousVersion = null,
  autoRetried = false,
  failedJobs = [],
  runUrl = null,
  failureIssue = null,
  footer,
  isPending = false,
  onTriggered,
  compact = false,
  className,
}: DeployFailureAlertProps) {
  const versionLabel = version ? `v${version}` : "最新のmain";
  // **「1つ前の版のまま」で止めない。** 版が分かるなら書く。デプロイが失敗したときにいちばん
  // 知りたいのは「いま本番で動いているのは何か」なので、そこを曖昧にしない。
  const previousLabel = previousVersion ? `v${previousVersion}` : "1つ前の版";

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-destructive bg-destructive/10 p-3",
        className,
      )}
    >
      <p className="flex items-center gap-1.5 text-sm font-semibold text-destructive">
        <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
        {title}
      </p>

      <p className="text-xs leading-relaxed">
        {versionLabel}のデプロイが失敗しました{autoRetried && "（自動で1回やり直しても失敗）"}。
        <span className="font-medium">本番は{previousLabel}のままです。</span>
        {failedJobs.length > 0 && (
          <>
            {" "}
            失敗したジョブ: <span className="font-mono">{failedJobs.join(", ")}</span>
          </>
        )}
      </p>

      <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", compact && "flex-col items-stretch")}>
        <RepositoryDeployButton
          repositoryFullName={repositoryFullName}
          currentVersion={previousVersion}
          tone="destructive"
          block={compact}
          isPending={isPending}
          onTriggered={onTriggered}
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {runUrl && (
            // 実行ログはアプリ内に対応する画面が無いので別タブで開く（`DeployStateBadge`と同じ）
            <a
              href={runUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <ExternalLink className="size-3" aria-hidden="true" />
              実行ログを開く
            </a>
          )}
          {failureIssue && (
            <GithubReferenceLink
              href={failureIssue.htmlUrl}
              reference={{ repositoryFullName, number: failureIssue.number, kind: "issue" }}
              className="text-primary hover:underline"
            >
              デプロイ失敗 #{failureIssue.number}
            </GithubReferenceLink>
          )}
        </div>
      </div>

      {footer && <div className="text-xs leading-relaxed text-muted-foreground">{footer}</div>}
    </div>
  );
}
