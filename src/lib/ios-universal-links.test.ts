import { describe, expect, it } from "vitest";

import { buildAppleAppSiteAssociation, IOS_APP_ID } from "./ios-universal-links";

describe("AASA", () => {
  it("アプリIDと、Issue/PR詳細の/dashboardだけを対象にする", () => {
    const [detail] = buildAppleAppSiteAssociation().applinks.details;
    expect(detail.appIDs).toEqual([IOS_APP_ID]);
    expect(IOS_APP_ID).toBe("6AA3WFTR94.com.gucchii.issuedeck");
    expect(detail.components).toEqual([
      { "/": "/dashboard", "?": { mscreen: "issue-detail" } },
      { "/": "/dashboard", "?": { mscreen: "pull-requests" } },
      { "/": "/dashboard", "?": { mscreen: "release-history" } },
    ]);
  });
});
