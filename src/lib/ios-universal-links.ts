/**
 * iOSアプリのUniversal Links（#5035）。Discord等に貼ったIssue・PRのHTTPSリンクを、
 * インストール済みのアプリで開く。アプリ側の解釈は`ios/IssueDeck/UniversalLink.swift`。
 *
 * 対象は`/dashboard`のうち、Issue詳細（`mscreen=issue-detail`）・PR詳細（`mscreen=pull-requests`）・リリース画面（`mscreen=release-history`。#5046）だけ。
 * 認証・共有・ウィジェット用の`issuedeck://`とは別経路で、そちらには触れない。
 */
export const IOS_TEAM_ID = "6AA3WFTR94";
export const IOS_BUNDLE_ID = "com.gucchii.issuedeck";
export const IOS_APP_ID = `${IOS_TEAM_ID}.${IOS_BUNDLE_ID}`;

export const UNIVERSAL_LINK_MSCREENS = ["issue-detail", "pull-requests", "release-history"] as const;

export function buildAppleAppSiteAssociation() {
  return {
    applinks: {
      details: [
        {
          appIDs: [IOS_APP_ID],
          components: UNIVERSAL_LINK_MSCREENS.map((mscreen) => ({
            "/": "/dashboard",
            "?": { mscreen },
          })),
        },
      ],
    },
  };
}
