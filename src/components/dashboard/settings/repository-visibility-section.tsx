"use client";

import { Archive, ChevronDown, ChevronRight, CircleSlash, FolderGit2, Lock } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { BRANCH_VIEW_MODE_LABELS, type BranchViewMode } from "@/lib/branch-view-visibility";
import { getGithubAppInstallUrl } from "@/lib/github/install-url";
import { getRepoColor } from "@/lib/repo-color";
import {
  isRepositoryAutomationUnsupported,
  REPOSITORY_AUTOMATION_UNSUPPORTED_TITLE,
} from "@/lib/repository-automation";
import {
  selectRepositoriesToToggle,
  summarizeRepositoryVisibility,
} from "@/lib/repository-visibility";
import { cn } from "@/lib/utils";
import type { ConnectedRepository } from "@/types/repository";

/** 単独の保存が失敗したときはfalse。それ以外（undefinedを含む）は成功として扱う */
type SaveResult = boolean | void | Promise<boolean | void>;

type RepositoryVisibilitySectionProps = {
  repositories: ConnectedRepository[];
  onSetRepositoryHidden: (repository: ConnectedRepository, hidden: boolean) => SaveResult;
  onSetRepositoriesHidden: (repositories: ConnectedRepository[], hidden: boolean) => void;
  onSetRepositoryIssueCreationExcluded: (
    repository: ConnectedRepository,
    excluded: boolean,
  ) => SaveResult;
  onSetRepositoryBranchViewMode: (
    repository: ConnectedRepository,
    mode: BranchViewMode,
  ) => SaveResult;
  /**
   * `table`: PCの設定ダイアログ。1行に3項目を並べる。
   * `accordion`: スマホの設定画面。閉じている間は状態を文章で見せ、開くと編集する。
   */
  layout?: "table" | "accordion";
};

type Option<T extends string> = { value: T; label: string };

/**
 * 3項目（全体に表示・Issue作成・ブランチ画面）で共通の分割ボタン（#5087）。
 * 現在値が塗りで示され、押せる部品はこれだけ。2択も3択も同じ見た目と操作にそろえる。
 */
function SegmentedControl<T extends string>({
  label,
  options,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  options: Option<T>[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex max-w-full overflow-hidden rounded-md border bg-background",
        disabled && "opacity-50",
      )}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
            className={cn(
              "min-h-8 whitespace-nowrap px-2.5 text-xs transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
              index > 0 && "border-l",
              selected
                ? "bg-primary font-semibold text-primary-foreground"
                : "text-muted-foreground hover:bg-accent disabled:hover:bg-transparent",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

const DISPLAY_OPTIONS: Option<"shown" | "hidden">[] = [
  { value: "shown", label: "表示" },
  { value: "hidden", label: "非表示" },
];
const ISSUE_CREATION_OPTIONS: Option<"candidate" | "excluded">[] = [
  { value: "candidate", label: "候補" },
  { value: "excluded", label: "除外" },
];
const BRANCH_VIEW_OPTIONS_WIDE: Option<BranchViewMode>[] = [
  { value: "always", label: "常に" },
  { value: "active", label: "動きがある時だけ" },
  { value: "never", label: "表示しない" },
];
const BRANCH_VIEW_OPTIONS_NARROW: Option<BranchViewMode>[] = [
  { value: "always", label: "常に" },
  { value: "active", label: "動きがある時" },
  { value: "never", label: "しない" },
];

/** 閉じている行に出す、現在の状態の文章 */
function describeRepositorySettings(repository: ConnectedRepository): string {
  if (repository.hidden) return "全体から非表示（他の設定は保持しています）";
  const mode = repository.branchViewMode ?? "always";
  return `全体に表示 ・ Issue作成: ${
    repository.excludedFromIssueCreation ? "除外" : "候補"
  } ・ ブランチ画面: ${BRANCH_VIEW_MODE_LABELS[mode]}`;
}

function RepositoryBadges({ repository }: { repository: ConnectedRepository }) {
  if (!(repository.archived || repository.private || isRepositoryAutomationUnsupported(repository))) {
    return null;
  }
  return (
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
      {isRepositoryAutomationUnsupported(repository) && (
        <span title={REPOSITORY_AUTOMATION_UNSUPPORTED_TITLE}>
          <CircleSlash className="size-3" />
        </span>
      )}
    </span>
  );
}

/**
 * 設定の「表示」区分（#1552）。リポジトリごとに3項目を設定する。
 *
 * - **全体に表示**: Issue一覧・PR一覧・通知・Issue作成の選択肢・ブランチ画面から消すか（`HiddenRepository`）
 * - **Issue作成**: 「Issueを作成」ダイアログの選択肢に出すか（#2760）
 * - **ブランチ画面**: ブランチ画面の並びだけを変える（#5087）
 *
 * 保存ボタンは無く、操作した時点で反映する。**行全体のクリックでは何も変わらない**（#5087。
 * 以前は行のどこを押しても全体表示が切り替わり、別の設定を押したときに二重に動きかねなかった）。
 * 通信に失敗したら親が値を戻すので、ここでは理由を行の下に出す。
 *
 * 状態はすべて`IssueDeckShell`の`repositories`が持つので、どこで変えても他の画面へその場で伝わる。
 * PCの設定ダイアログとスマホの設定画面が同じこのコンポーネントを描く（`layout`で配置だけ変える）。
 */
export function RepositoryVisibilitySection({
  repositories,
  onSetRepositoryHidden,
  onSetRepositoriesHidden,
  onSetRepositoryIssueCreationExcluded,
  onSetRepositoryBranchViewMode,
  layout = "table",
}: RepositoryVisibilitySectionProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  // アコーディオンは同時に1件だけ開く
  const [openId, setOpenId] = useState<string | null>(null);

  const summary = summarizeRepositoryVisibility(repositories);
  const toShow = selectRepositoriesToToggle(repositories, false);
  const toHide = selectRepositoriesToToggle(repositories, true);
  const branchHiddenCount = repositories.filter(
    (repository) => !repository.hidden && (repository.branchViewMode ?? "always") !== "always",
  ).length;

  /** 保存の成否に応じて、その行の理由表示を更新する */
  async function save(repository: ConnectedRepository, what: string, run: () => SaveResult) {
    setErrors((prev) => {
      if (!(repository.id in prev)) return prev;
      const { [repository.id]: _removed, ...rest } = prev;
      return rest;
    });
    const result = await run();
    if (result === false) {
      setErrors((prev) => ({
        ...prev,
        [repository.id]: `${repository.name}の「${what}」を保存できませんでした（通信エラー）。元の値に戻しました。`,
      }));
    }
  }

  const setDisplay = (repository: ConnectedRepository, value: "shown" | "hidden") =>
    save(repository, "全体に表示", () => onSetRepositoryHidden(repository, value === "hidden"));
  const setIssueCreation = (repository: ConnectedRepository, value: "candidate" | "excluded") =>
    save(repository, "Issue作成", () =>
      onSetRepositoryIssueCreationExcluded(repository, value === "excluded"),
    );
  const setBranchView = (repository: ConnectedRepository, mode: BranchViewMode) =>
    save(repository, "ブランチ画面", () => onSetRepositoryBranchViewMode(repository, mode));

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

  const controls = (repository: ConnectedRepository, narrow: boolean) => {
    const globallyHidden = repository.hidden;
    return {
      display: (
        <SegmentedControl
          label={`${repository.name}を全体に表示`}
          options={DISPLAY_OPTIONS}
          value={globallyHidden ? "hidden" : "shown"}
          onChange={(value) => setDisplay(repository, value)}
        />
      ),
      issueCreation: (
        <SegmentedControl
          label={`${repository.name}をIssue作成の選択肢に含める`}
          options={ISSUE_CREATION_OPTIONS}
          value={repository.excludedFromIssueCreation ? "excluded" : "candidate"}
          disabled={globallyHidden}
          onChange={(value) => setIssueCreation(repository, value)}
        />
      ),
      branchView: (
        <SegmentedControl
          label={`${repository.name}のブランチ画面での表示`}
          options={narrow ? BRANCH_VIEW_OPTIONS_NARROW : BRANCH_VIEW_OPTIONS_WIDE}
          value={repository.branchViewMode ?? "always"}
          disabled={globallyHidden}
          onChange={(value) => setBranchView(repository, value)}
        />
      ),
    };
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        <strong className="font-medium text-foreground">全体に表示</strong>
        を「非表示」にしたリポジトリは、左メニューのリポジトリ一覧・Issue一覧・各ビューの件数・
        Pull Request一覧・「ブランチ」画面・通知・Issue作成時のリポジトリ選択肢に出なくなります
        （左メニューの「すべて表示する」でそのリポジトリを選べば、Issueは一覧に出せます）。
        <strong className="font-medium text-foreground"> Issue作成</strong>
        を「除外」にすると、一覧などには残したまま「Issueを作成」ダイアログの選択肢からだけ外します。
        <strong className="font-medium text-foreground"> ブランチ画面</strong>
        は「ブランチ」画面の並びだけを変えます。他の画面・通知・件数は変わりません。
        全体に非表示のリポジトリでは、あとの2項目は使われませんが設定は残り、再表示すると元に戻ります。
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">
          {summary.total}件中<span className="font-medium">{summary.visible}件</span>を表示中
          {branchHiddenCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {` ・ ブランチ画面で省く設定: ${branchHiddenCount}件`}
            </span>
          )}
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

      {layout === "table" ? (
        <div className="max-h-96 overflow-auto rounded-md border">
          <div className="min-w-[640px]">
            <div className="grid grid-cols-[minmax(0,1fr)_7rem_7rem_16rem] gap-2 border-b px-2 py-1.5 text-[11px] text-muted-foreground">
              <span>リポジトリ</span>
              <span>
                <b className="block font-semibold text-foreground">全体に表示</b>
                一覧・通知など全部
              </span>
              <span>
                <b className="block font-semibold text-foreground">Issue作成</b>選択肢に出すか
              </span>
              <span>
                <b className="block font-semibold text-foreground">ブランチ画面</b>この画面の並びだけ
              </span>
            </div>
            <ul>
              {repositories.map((repository) => {
                const color = getRepoColor(repository.fullName);
                const parts = controls(repository, false);
                return (
                  <li key={repository.id} className="border-b last:border-b-0">
                    <div className="grid grid-cols-[minmax(0,1fr)_7rem_7rem_16rem] items-center gap-2 px-2 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="flex size-5 shrink-0 items-center justify-center rounded"
                          style={{ backgroundColor: `${color}20`, color }}
                        >
                          <FolderGit2 className="size-3" />
                        </span>
                        <span className="min-w-0">
                          <span
                            className={cn(
                              "block truncate text-sm",
                              repository.hidden && "text-muted-foreground",
                            )}
                            title={repository.fullName}
                          >
                            {repository.name}
                          </span>
                          {repository.hidden && (
                            <span className="block text-[11px] text-muted-foreground">
                              全体から非表示のため右の2項目は使われません（設定は保持）
                            </span>
                          )}
                        </span>
                        <RepositoryBadges repository={repository} />
                      </div>
                      <div>{parts.display}</div>
                      <div>{parts.issueCreation}</div>
                      <div>{parts.branchView}</div>
                    </div>
                    {errors[repository.id] && (
                      <p role="alert" className="px-2 pb-2 text-xs text-destructive">
                        {errors[repository.id]}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : (
        <ul className="flex flex-col overflow-hidden rounded-md border">
          {repositories.map((repository) => {
            const open = openId === repository.id;
            const parts = controls(repository, true);
            const color = getRepoColor(repository.fullName);
            const panelId = `repository-settings-${repository.id}`;
            return (
              <li key={repository.id} className={cn("border-b last:border-b-0", open && "bg-accent/40")}>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() => setOpenId(open ? null : repository.id)}
                  className="flex w-full items-start gap-2 px-3 py-2.5 text-left"
                >
                  <span
                    className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded"
                    style={{ backgroundColor: `${color}20`, color }}
                  >
                    <FolderGit2 className="size-3" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          "truncate text-sm font-medium",
                          repository.hidden && "text-muted-foreground",
                        )}
                      >
                        {repository.name}
                      </span>
                      <RepositoryBadges repository={repository} />
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {describeRepositorySettings(repository)}
                    </span>
                  </span>
                  {open ? (
                    <ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                </button>
                {open && (
                  <div id={panelId} className="flex flex-col gap-3 px-3 pb-3 pl-10">
                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] text-muted-foreground">全体に表示</span>
                      {parts.display}
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] text-muted-foreground">Issue作成</span>
                      {parts.issueCreation}
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] text-muted-foreground">ブランチ画面</span>
                      {parts.branchView}
                    </div>
                    {repository.hidden && (
                      <p className="text-[11px] text-muted-foreground">
                        全体から非表示のため、Issue作成とブランチ画面は使われません（設定は保持）。
                      </p>
                    )}
                  </div>
                )}
                {errors[repository.id] && (
                  <p role="alert" className="px-3 pb-2 text-xs text-destructive">
                    {errors[repository.id]}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
