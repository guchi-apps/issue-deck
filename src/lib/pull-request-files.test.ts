import { describe, expect, it } from "vitest";

import type { GithubApiPullRequestFile } from "@/lib/github/pull-requests-api";
import {
  splitPullRequestFilePath,
  toPullRequestFileChange,
  toPullRequestFiles,
} from "@/lib/pull-request-files";

function makeFile(overrides: Partial<GithubApiPullRequestFile> = {}): GithubApiPullRequestFile {
  return {
    filename: "src/components/dashboard/pull-request-detail.tsx",
    status: "modified",
    additions: 34,
    deletions: 1,
    blob_url: "https://github.com/guchi-apps/issue-deck/blob/abc/src/x.tsx",
    ...overrides,
  };
}

describe("toPullRequestFileChange", () => {
  it("追加・削除・改名はそのまま区別する", () => {
    expect(toPullRequestFileChange("added")).toBe("added");
    expect(toPullRequestFileChange("removed")).toBe("removed");
    expect(toPullRequestFileChange("renamed")).toBe("renamed");
  });

  it("滅多に出ない種別・未知の値は「変更」へ寄せる", () => {
    expect(toPullRequestFileChange("modified")).toBe("modified");
    expect(toPullRequestFileChange("copied")).toBe("modified");
    expect(toPullRequestFileChange("changed")).toBe("modified");
    expect(toPullRequestFileChange("unknown-status")).toBe("modified");
  });
});

describe("toPullRequestFiles", () => {
  it("画面が使う形へ移し替える", () => {
    const [file] = toPullRequestFiles([makeFile({ status: "added", deletions: 0 })]);
    expect(file).toEqual({
      path: "src/components/dashboard/pull-request-detail.tsx",
      change: "added",
      additions: 34,
      deletions: 0,
      blobUrl: "https://github.com/guchi-apps/issue-deck/blob/abc/src/x.tsx",
      previousPath: null,
    });
  });

  it("改名は変更前のパスを残す", () => {
    const [file] = toPullRequestFiles([
      makeFile({ status: "renamed", previous_filename: "src/old.ts" }),
    ]);
    expect(file.change).toBe("renamed");
    expect(file.previousPath).toBe("src/old.ts");
  });

  it("GitHubが返した順を変えない", () => {
    const files = toPullRequestFiles([
      makeFile({ filename: "z.ts" }),
      makeFile({ filename: "a.ts" }),
    ]);
    expect(files.map((file) => file.path)).toEqual(["z.ts", "a.ts"]);
  });
});

describe("splitPullRequestFilePath", () => {
  it("フォルダとファイル名に分ける", () => {
    expect(splitPullRequestFilePath("src/lib/github/pull-requests-api.ts")).toEqual({
      directory: "src/lib/github/",
      name: "pull-requests-api.ts",
    });
  });

  it("リポジトリ直下のファイルはフォルダを空にする", () => {
    expect(splitPullRequestFilePath("README.md")).toEqual({ directory: "", name: "README.md" });
  });
});
