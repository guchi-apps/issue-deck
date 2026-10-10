import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PullRequestMergeChecks } from "@/components/dashboard/pull-request-merge-checks";
import { buildMergeChecks } from "@/lib/pull-request-merge-checks";

describe("PullRequestMergeChecks", () => {
  it("5項目を固定の順序で、記号と日本語の状態つきで出す", () => {
    const html = renderToStaticMarkup(
      <PullRequestMergeChecks
        checks={buildMergeChecks({
          pullRequest: null,
          overall: { mark: "●", state: "問題なし", tone: "ok", reason: null },
          conflict: { mark: "■", state: "あり", tone: "bad", reason: null },
          releaseCi: "success",
          releaseHeadRef: "release-main/v1",
        })}
        issueUrl={null}
        onOpenPullRequest={null}
        onOpenOverall={() => {}}
      />,
    );
    const order = ["CI", "計画", "コード", "全体〔共通〕", "競合"].map((label) => html.indexOf(`>${label}<`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("取得不可");
    expect(html).toContain("問題なし");
    expect(html).toContain("あり");
    expect(html.match(/<button/g)).toHaveLength(5);
  });
});
