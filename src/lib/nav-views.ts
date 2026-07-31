import type { NavViewId } from "@/types/issue";

export const navViews: { id: NavViewId; label: string }[] = [
  { id: "all", label: "すべてのIssue" },
  { id: "assigned", label: "自分の担当" },
  { id: "created", label: "自分が作成" },
  { id: "favorites", label: "お気に入り" },
  { id: "recent", label: "最近更新されたIssue" },
];
