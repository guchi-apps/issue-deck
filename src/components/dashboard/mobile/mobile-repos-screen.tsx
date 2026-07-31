"use client";

import { useState } from "react";
import { FolderGit2, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { getGithubAppInstallUrl } from "@/lib/github/install-url";
import { getRepoColor } from "@/lib/repo-color";
import type { ConnectedRepository } from "@/types/repository";

type MobileReposScreenProps = {
  repositories: ConnectedRepository[];
  onSelectRepository: (repository: ConnectedRepository) => void;
};

export function MobileReposScreen({ repositories, onSelectRepository }: MobileReposScreenProps) {
  const [query, setQuery] = useState("");

  const trimmedQuery = query.trim().toLowerCase();
  const filtered = trimmedQuery
    ? repositories.filter((repo) => repo.name.toLowerCase().includes(trimmedQuery))
    : repositories;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b p-4">
        <h1 className="text-base font-semibold">リポジトリ</h1>
      </header>

      <div className="p-4">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="リポジトリを検索..."
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {repositories.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            まだリポジトリと連携していません。
            <a href={getGithubAppInstallUrl()} className="ml-1 text-primary hover:underline">
              GitHub Appをインストール
            </a>
          </div>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            該当するリポジトリがありません
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {filtered.map((repo) => {
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
    </div>
  );
}
