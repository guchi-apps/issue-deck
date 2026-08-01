import type { NavViewId } from "@/types/issue";
import type { IssueSort, IssueStateFilter } from "@/hooks/use-issue-filters";

export type QuickFilter = {
  id: string;
  name: string;
  view: NavViewId;
  q: string;
  repo: string | null;
  state: IssueStateFilter;
  labels: string[];
  assignee: string | null;
  sort: IssueSort;
};

export type QuickFilterInput = Omit<QuickFilter, "id">;
