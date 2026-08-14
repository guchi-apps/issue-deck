import { describe, expect, it } from "vitest";

import {
  describeProgressReportFailure,
  type ProgressReportFailureReason,
} from "@/lib/progress-report-message";

describe("describeProgressReportFailure", () => {
  const failures: ProgressReportFailureReason[] = [
    "project_disabled",
    "unknown_repository",
    "unknown_status",
    "not_in_project",
    "issue_closed",
  ];

  it.each(failures)("%s は理由が伝わる日本語を返す", (reason) => {
    const message = describeProgressReportFailure(reason);
    expect(message).toBeTruthy();
    expect(message).toMatch(/。$/);
  });

  it("unchanged は失敗ではないためnullを返す", () => {
    expect(describeProgressReportFailure("unchanged")).toBeNull();
  });

  it("未知の理由でも汎用の文言を返す", () => {
    expect(describeProgressReportFailure("something_new")).toBe("進捗を変更できませんでした。");
  });
});
