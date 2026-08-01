import {
  CheckCircle2,
  FolderGit2,
  ListChecks,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { NavViewId } from "@/types/issue";

export const navViews: { id: NavViewId; label: string }[] = [
  { id: "all", label: "すべてのIssue" },
  { id: "assigned", label: "自分の担当" },
  { id: "created", label: "自分が作成" },
  { id: "favorites", label: "お気に入り" },
  { id: "recent", label: "最近更新されたIssue" },
];

export const navViewIcons: Record<NavViewId, LucideIcon> = {
  all: ListChecks,
  assigned: CheckCircle2,
  created: FolderGit2,
  favorites: Star,
  recent: SlidersHorizontal,
};
