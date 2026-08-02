"use client";

import { FolderGit2, Home, ListChecks, Settings } from "lucide-react";

import { cn } from "@/lib/utils";

const items = [
  { id: "home", label: "ホーム", icon: Home },
  { id: "repos", label: "リポジトリ", icon: FolderGit2 },
  { id: "issues", label: "Issue", icon: ListChecks },
  { id: "settings", label: "設定", icon: Settings },
] as const;

export type MobileBottomNavTab = (typeof items)[number]["id"];

type MobileBottomNavProps = {
  active?: MobileBottomNavTab;
  onSelect?: (tab: MobileBottomNavTab) => void;
};

export function MobileBottomNav({ active = "home", onSelect }: MobileBottomNavProps) {
  return (
    <nav className="flex border-t bg-background md:hidden">
      {items.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect?.(id)}
          className={cn(
            "flex flex-1 flex-col items-center gap-0.5 py-2 text-xs text-muted-foreground",
            active === id && "text-foreground",
          )}
        >
          <Icon className="size-5" />
          {label}
        </button>
      ))}
    </nav>
  );
}
