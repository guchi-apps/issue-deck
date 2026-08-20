"use client";

import { useState } from "react";
import { CloudUpload } from "lucide-react";

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
import { requestDeploy } from "@/lib/deploy-request";
import { formatMonthDay, formatTimeOfDay } from "@/lib/format-date-time";

type RepositoryDeployButtonProps = {
  repositoryFullName: string;
  /** いま本番へ出ている版（`4.14.0`）。分からなければnull */
  currentVersion?: string | null;
  /** 直近のリリースがmainへ入った時刻（ISO8601）。分からなければnull */
  deployedAt?: string | null;
  /** developがmainより進んでいるコミット数。今回のデプロイでは出ないことを伝えるのに使う */
  unreleasedCommits?: number;
  /** すでに起動済みで、デプロイの実行が現れるのを待っている最中か */
  isPending: boolean;
  /** 起動に成功したあと。起動中の記録とデプロイ状況の取り直しを親が行う */
  onTriggered: () => void;
};

/**
 * 「ブランチ」画面から本番デプロイworkflow（`deploy.yml`）だけを起こすボタン（#2020）。
 *
 * **マージするものが無くても本番へ出し直せるようにするための導線。** これまで本番へ反映する
 * 手段はdevelop→mainのマージだけで、GitHubのSecretsや環境変数を変えただけのとき
 * （`deploy.yml`が本番の`.env`をまるごと書き直す）も、出すコードが無いのにリリースを
 * 1回まわす必要があった。
 *
 * **置き場所はリポジトリの節（レールの凡例の行）で、リリースの束ではない。** 束は畳まれたり
 * 本番反映済みで隠れたりするため、束に付けると「押したいときに画面に無い」ことが起こる。
 *
 * 状態は追わない——mainの`deploy.yml`の最新実行は`/api/branch-flow/deploy`が既に見ており、
 * 「デプロイ中」「デプロイ成功」は`DeployStateBadge`が出す。押してから実行が現れるまでの
 * 数秒だけ、端末に残した起動時刻（`useTriggerPending`）で「デプロイ起動中…」を出す。
 */
export function RepositoryDeployButton({
  repositoryFullName,
  currentVersion = null,
  deployedAt = null,
  unreleasedCommits = 0,
  isPending,
  onTriggered,
}: RepositoryDeployButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleTrigger() {
    setIsTriggering(true);
    setError(null);
    try {
      await requestDeploy(repositoryFullName);
      setConfirmOpen(false);
      onTriggered();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsTriggering(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-6 gap-1 px-2 text-xs"
        disabled={isTriggering || isPending}
        onClick={() => setConfirmOpen(true)}
      >
        <CloudUpload className={isTriggering || isPending ? "size-3 animate-pulse" : "size-3"} />
        {isTriggering ? "起動中..." : isPending ? "デプロイ起動中…" : "本番へ再デプロイ"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}

      {/* 押すと本番へ出るため、「リリースする」と同じように確認を挟む */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>mainを本番へ出し直しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {repositoryFullName}のmainを、いまのまま本番へデプロイし直します（deploy.ymlを
              手動で起動します）。コードは変わりません。GitHubのSecretsや環境変数を変えた後に、
              本番の.envへ反映させるときに使います。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <dl className="flex flex-col gap-1.5 rounded-md border p-2 text-xs">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">いまの本番</dt>
              <dd>
                {currentVersion ? `v${currentVersion}` : "版を特定できません"}
                {deployedAt && `（${formatMonthDay(deployedAt)} ${formatTimeOfDay(deployedAt)}に反映）`}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">出るもの</dt>
              <dd>mainの先端（いまと同じ内容）</dd>
            </div>
            {/* **developの差分は出ない。** リリースと取り違えたまま押されるのがいちばん困る */}
            {unreleasedCommits > 0 && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">developの差分</dt>
                <dd>
                  <span className="font-medium">{unreleasedCommits}コミットぶんは出ません</span>
                  （出すには「リリースする」を使います）
                </dd>
              </div>
            )}
          </dl>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isTriggering}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              disabled={isTriggering}
              onClick={(event) => {
                // 起動の結果を待たずに閉じないよう既定の閉じる動作を止める（#1548と同じ理由）。
                // 閉じてしまうと連打で複数回dispatchでき、失敗しても文言が出ない。
                event.preventDefault();
                void handleTrigger();
              }}
            >
              {isTriggering ? "起動中..." : "出し直す"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
