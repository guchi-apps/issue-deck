"use client";

import { Bell, ChevronDown, LayoutDashboard, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { CURRENT_USER_LOGIN } from "@/lib/mock-data";

const filters = [
  { label: "リポジトリ" },
  { label: "状態" },
  { label: "ラベル" },
  { label: "担当者" },
  { label: "並び順: 更新日" },
];

export function TopBar() {
  return (
    <header className="hidden items-center gap-3 border-b px-4 py-2 md:flex">
      <div className="flex items-center gap-2 pr-4 text-sm font-semibold">
        <LayoutDashboard className="size-5 text-primary" />
        Issue Dashboard
      </div>

      <div className="relative w-72">
        <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Issueやリポジトリを検索..." className="pl-8" />
        <kbd className="absolute top-1/2 right-2 -translate-y-1/2 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          ⌘K
        </kbd>
      </div>

      <div className="flex flex-1 flex-wrap items-center gap-2">
        {filters.map((filter) => (
          <DropdownMenu key={filter.label}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="text-xs">
                {filter.label}
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem disabled>M2以降で実装予定</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
      </div>

      <Button variant="ghost" size="icon" className="relative" aria-label="通知">
        <Bell />
        <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
          3
        </span>
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="flex items-center gap-1 rounded-md p-1 hover:bg-accent">
            <UserAvatar login={CURRENT_USER_LOGIN} className="size-7" />
            <ChevronDown className="size-3 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled>{CURRENT_USER_LOGIN}</DropdownMenuItem>
          <DropdownMenuItem disabled>ログアウト（M2以降）</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
