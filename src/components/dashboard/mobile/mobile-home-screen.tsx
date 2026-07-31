"use client";

import { useState } from "react";
import { Bell, FolderGit2, Menu, Search } from "lucide-react";

import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { getGithubAppInstallUrl } from "@/lib/github/install-url";
import { mockLabelSummary, overviewStats } from "@/lib/mock-data";
import { getRepoColor } from "@/lib/repo-color";
import type { NavViewId } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

type MobileHomeScreenProps = {
  activeView: NavViewId;
  onSelectView: (view: NavViewId) => void;
  repositories: ConnectedRepository[];
  onSelectRepository: (repository: ConnectedRepository) => void;
};

export function MobileHomeScreen({
  activeView,
  onSelectView,
  repositories,
  onSelectRepository,
}: MobileHomeScreenProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="flex items-center justify-between border-b p-4">
        <button type="button" onClick={() => setMenuOpen(true)} aria-label="メニュー">
          <Menu className="size-5" />
        </button>
        <span className="text-base font-semibold">Issue Dashboard</span>
        <Bell className="size-5" />
      </header>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetHeader className="border-b p-4">
            <SheetTitle>Issue Dashboard</SheetTitle>
          </SheetHeader>
          <SidebarNav
            activeView={activeView}
            onSelectView={(view) => {
              onSelectView(view);
              setMenuOpen(false);
            }}
            repositories={repositories}
            onSelectRepository={(repo) => {
              onSelectRepository(repo);
              setMenuOpen(false);
            }}
            className="flex"
          />
        </SheetContent>
      </Sheet>

      <div className="p-4">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Issueを検索..." className="pl-8" />
        </div>
      </div>

      <div className="px-4">
        <h2 className="mb-2 text-sm font-semibold">概要</h2>
        <div className="grid grid-cols-3 gap-2">
          {overviewStats.map((stat) => (
            <Card key={stat.label} className="gap-1 p-3">
              <p className="text-[11px] text-muted-foreground">{stat.label}</p>
              <p className="text-lg font-semibold">{stat.value}</p>
              <p className="text-[10px] text-muted-foreground">{stat.diffLabel}</p>
            </Card>
          ))}
        </div>
      </div>

      <div className="mt-6 px-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">リポジトリ</h2>
          <a href={getGithubAppInstallUrl()} className="text-xs text-primary hover:underline">
            追加
          </a>
        </div>
        {repositories.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            まだリポジトリと連携していません。
            <a href={getGithubAppInstallUrl()} className="ml-1 text-primary hover:underline">
              GitHub Appをインストール
            </a>
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {repositories.map((repo) => {
              const color = getRepoColor(repo.fullName);
              return (
                <li key={repo.id}>
                  <button
                    type="button"
                    onClick={() => onSelectRepository(repo)}
                    className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
                  >
                    <span className="flex items-center gap-2 truncate">
                      <span
                        className="flex size-6 shrink-0 items-center justify-center rounded"
                        style={{ backgroundColor: `${color}20`, color }}
                      >
                        <FolderGit2 className="size-3.5" />
                      </span>
                      <span className="truncate">{repo.name}</span>
                    </span>
                    {repo.private && (
                      <span className="shrink-0 text-xs text-muted-foreground">Private</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-6 px-4 pb-4">
        <h2 className="mb-2 text-sm font-semibold">ラベル</h2>
        <ul className="flex flex-col gap-1">
          {mockLabelSummary.map((label) => (
            <li key={label.name} className="flex items-center justify-between px-2 py-1.5 text-sm">
              <span className="flex items-center gap-2">
                <span className="size-2 rounded-full" style={{ backgroundColor: label.color }} />
                {label.name}
              </span>
              <span className="text-xs text-muted-foreground">{label.count}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
