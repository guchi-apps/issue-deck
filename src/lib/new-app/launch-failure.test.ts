import { describe, expect, it } from "vitest";

import { GithubApiError } from "@/lib/github/github-api-error";
import { LAUNCH_UNAUTHORIZED_MESSAGE, decideLaunchError } from "@/lib/new-app/launch-failure";
import type { NewAppCreatedRef } from "@/lib/new-app/plan";

const REPOSITORY: NewAppCreatedRef = {
  kind: "repository",
  title: "guchi-apps/kakei-report",
  reference: "guchi-apps/kakei-report",
  url: "https://github.com/guchi-apps/kakei-report",
};

const PARENT_ISSUE: NewAppCreatedRef = {
  kind: "parent-issue",
  title: "家計レポートを立ち上げる",
  reference: "guchi-apps/issue-deck#2201",
  url: "https://github.com/guchi-apps/issue-deck/issues/2201",
};

describe("decideLaunchError", () => {
  it("何も作っていないうちの401は投げ直す（延長して最初からやり直せる）", () => {
    const decision = decideLaunchError(new GithubApiError(401, "unauthorized"), []);

    expect(decision).toEqual({ rethrow: true });
  });

  it("1つでも作った後の401は投げ直さず、最後に作ったものをstepにして返す", () => {
    const decision = decideLaunchError(new GithubApiError(401, "unauthorized"), [
      REPOSITORY,
      PARENT_ISSUE,
    ]);

    expect(decision).toEqual({
      rethrow: false,
      failure: {
        step: "parent-issue",
        reason: "launch_failed",
        message: LAUNCH_UNAUTHORIZED_MESSAGE,
      },
    });
  });

  it("401以外は、何も作っていなくても投げ直さない", () => {
    const decision = decideLaunchError(new GithubApiError(500, "boom"), []);

    expect(decision).toEqual({
      rethrow: false,
      failure: { step: "repository", reason: "launch_failed", message: "boom" },
    });
  });

  it("Errorでない値が投げられても文字列にして返す", () => {
    const decision = decideLaunchError("なにか", [REPOSITORY]);

    expect(decision).toEqual({
      rethrow: false,
      failure: { step: "repository", reason: "launch_failed", message: "なにか" },
    });
  });
});
