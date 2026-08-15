"use client";

import { Archive, CircleSlash, FolderGit2, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { getGithubAppInstallUrl } from "@/lib/github/install-url";
import { getRepoColor } from "@/lib/repo-color";
import {
  selectRepositoriesToToggle,
  summarizeRepositoryVisibility,
} from "@/lib/repository-visibility";
import { cn } from "@/lib/utils";
import type { ConnectedRepository } from "@/types/repository";

type RepositoryVisibilitySectionProps = {
  repositories: ConnectedRepository[];
  onSetRepositoryHidden: (repository: ConnectedRepository, hidden: boolean) => void;
  onSetRepositoriesHidden: (repositories: ConnectedRepository[], hidden: boolean) => void;
};

/**
 * 設定の「表示」区分（#1552）。画面に出すリポジトリを一覧で選ぶ。
 *
 * 保存ボタンは無く、チェックを変えた時点で`HiddenRepository`へ即座に反映する
 * （左メニューの目のアイコンと同じ`/api/repositories/hidden`）。**切り替える口が
 * 左メニュー・スマホのリポジトリ画面・ここの3か所あるが、状態はすべて`IssueDeckShell`の
 * `repositories`が持つ**ので、どこで変えても他の画面へその場で伝わる。
 *
 * PCの設定ダイアログとスマホの設定画面が同じこのコンポーネントを描く。
 */
export function RepositoryVisibilitySection({
  repositories,
  onSetRepositoryHidden,
  onSetRepositoriesHidden,
}: RepositoryVisibilitySectionProps) {
  const summary = summarizeRepositoryVisibility(repositories);
  const toShow = selectRepositoriesToToggle(repositories, false);
  const toHide = selectRepositoriesToToggle(repositories, true);

  if (repositories.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
        まだリポジトリと連携していません。
        <a
          href={getGithubAppInstallUrl()}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-1 text-primary hover:underline"
        >
          GitHub Appをインストール
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        チェックを外したリポジトリは、左メニューのリポジトリ一覧・Pull Request一覧・
        「ブランチとPRの流れ」・Issue作成時のリポジトリ選択肢に出なくなります。
        <span className="font-medium">Issue一覧と各ビューの件数は変わりません。</span>
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">
          {summary.total}件中<span className="font-medium">{summary.visible}件</span>を表示中
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={toShow.length === 0}
            onClick={() => onSetRepositoriesHidden(toShow, false)}
          >
            すべて表示
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={toHide.length === 0}
            onClick={() => onSetRepositoriesHidden(toHide, true)}
          >
            すべて非表示
          </Button>
        </div>
      </div>

      <ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto rounded-md border p-1">
        {repositories.map((repository) => {
          const color = getRepoColor(repository.fullName);
          return (
            <li key={repository.id}>
              {/*
                行のどこを押しても切り替わるようにする。`Checkbox`（Radix）の実体は`button`で、
                `label`のhtmlForではクリックが届かない（labelが指せるのはinput等だけ）ため、
                行のクリックで切り替え、チェックボックス自身のクリックはそこで止めて
                二重に切り替わらないようにする。
              */}
              <div
                onClick={() => onSetRepositoryHidden(repository, !repository.hidden)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 hover:bg-accent"
              >
                <Checkbox
                  checked={!repository.hidden}
                  aria-label={`${repository.name}を表示する`}
                  onClick={(event) => event.stopPropagation()}
                  onCheckedChange={(checked) =>
                    onSetRepositoryHidden(repository, checked !== true)
                  }
                />
                <span
                  className="flex size-5 shrink-0 items-center justify-center rounded"
                  style={{ backgroundColor: `${color}20`, color }}
                >
                  <FolderGit2 className="size-3" />
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-sm",
                    repository.hidden && "text-muted-foreground",
                  )}
                  title={repository.fullName}
                >
                  {repository.name}
                </span>
                {(repository.archived || repository.private || !repository.hasClaudeWorkflow) && (
                  <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                    {repository.archived && (
                      <span title="アーカイブ済み">
                        <Archive className="size-3" />
                      </span>
                    )}
                    {repository.private && (
                      <span title="プライベートリポジトリ">
                        <Lock className="size-3" />
                      </span>
                    )}
                    {!repository.hasClaudeWorkflow && (
                      <span title="issue-deckの自動化workflow（claude-issue-dispatch.yml）が見つかりません（対応可否の近似判定です）">
                        <CircleSlash className="size-3" />
                      </span>
                    )}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
