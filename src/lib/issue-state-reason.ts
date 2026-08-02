import type { IssueStateReason } from "@/types/issue";

export function closedStateLabel(stateReason: IssueStateReason): string {
  switch (stateReason) {
    case "not_planned":
      return "Closed (not planned)";
    default:
      return "Closed";
  }
}
