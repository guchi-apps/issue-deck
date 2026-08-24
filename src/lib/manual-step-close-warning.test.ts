import { describe, expect, it } from "vitest";

import { resolveManualStepCloseWarning } from "@/lib/manual-step-close-warning";

const BODY = [
  "## やること",
  "",
  "- [ ] （サブPC）pollerを入れ替える",
  "",
  "  ```bash",
  "  systemctl --user restart issue-deck-dispatch-poller.service",
  "  ```",
  "",
  "## 完了の確認方法",
  "",
  "- 動いている",
  "",
  "  ```bash",
  "  systemctl --user is-active issue-deck-dispatch-poller.service",
  "  ```",
].join("\n");

describe("resolveManualStepCloseWarning（#2256）", () => {
  it("確認コマンドがあり、通った記録が無ければ警告する", () => {
    expect(resolveManualStepCloseWarning({ body: BODY, verifiedAt: null })).toEqual({
      commands: ["systemctl --user is-active issue-deck-dispatch-poller.service"],
    });
  });

  it("すべて通った記録があれば警告しない", () => {
    expect(
      resolveManualStepCloseWarning({ body: BODY, verifiedAt: "2026-08-20T09:00:00.000Z" }),
    ).toBeNull();
  });

  // 画面での操作だけの手作業は機械的に確かめようがない。押すたびに止めるだけになる
  it("確認がコマンドで書かれていなければ警告しない", () => {
    const body = BODY.replace(
      /## 完了の確認方法[\s\S]*$/,
      "## 完了の確認方法\n\n左メニューに並べば完了です。\n",
    );
    expect(resolveManualStepCloseWarning({ body, verifiedAt: null })).toBeNull();
    expect(resolveManualStepCloseWarning({ body: null, verifiedAt: null })).toBeNull();
  });
});
