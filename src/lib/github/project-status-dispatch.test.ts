import { afterEach, describe, expect, it } from "vitest";

import {
  dispatchCommentBody,
  isDispatchedStatusKey,
  isOwnAppSender,
  posterMarker,
  resolveDispatchMode,
} from "@/lib/github/project-status-dispatch";

const ORIGINAL_SLUG = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;

afterEach(() => {
  if (ORIGINAL_SLUG === undefined) {
    delete process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
  } else {
    process.env.NEXT_PUBLIC_GITHUB_APP_SLUG = ORIGINAL_SLUG;
  }
});

describe("resolveDispatchMode", () => {
  it("Ready からの遷移だけを起動する", () => {
    expect(resolveDispatchMode("Ready", "Planning")).toBe("plan");
    expect(resolveDispatchMode("Ready", "Implementation")).toBe("implement");
  });

  it("Ready 以外からの前進は起動しない（報告APIの書き込みで再起動しないため）", () => {
    expect(resolveDispatchMode("Planning", "Implementation")).toBeNull();
    expect(resolveDispatchMode("Implementation", "Develop PR")).toBeNull();
    expect(resolveDispatchMode("Develop", "Implementation")).toBeNull();
  });

  it("後戻りには何も割り当てない", () => {
    expect(resolveDispatchMode("Implementation", "Ready")).toBeNull();
    expect(resolveDispatchMode("Done", "Ready")).toBeNull();
  });

  it("Ready から起動対象外のStatusへ動かしても起動しない", () => {
    expect(resolveDispatchMode("Ready", "Develop PR")).toBeNull();
    expect(resolveDispatchMode("Ready", "Done")).toBeNull();
    expect(resolveDispatchMode("Ready", "Ready")).toBeNull();
  });

  it("遷移前が不明（null・未知の名前）なら起動しない", () => {
    // Projectへ載せた操作そのものが実行の開始になってしまうため
    expect(resolveDispatchMode(null, "Implementation")).toBeNull();
    expect(resolveDispatchMode("Blocked", "Implementation")).toBeNull();
  });

  it("遷移後がnull・未知の名前なら起動しない", () => {
    expect(resolveDispatchMode("Ready", null)).toBeNull();
    expect(resolveDispatchMode("Ready", "Blocked")).toBeNull();
  });
});

describe("isOwnAppSender", () => {
  it("issue-deck自身のGitHub Appならtrue", () => {
    process.env.NEXT_PUBLIC_GITHUB_APP_SLUG = "issue-deck";
    expect(isOwnAppSender("issue-deck[bot]")).toBe(true);
  });

  it("人間・他のBotはfalse", () => {
    process.env.NEXT_PUBLIC_GITHUB_APP_SLUG = "issue-deck";
    expect(isOwnAppSender("m-guchi")).toBe(false);
    expect(isOwnAppSender("github-actions[bot]")).toBe(false);
    expect(isOwnAppSender("claude[bot]")).toBe(false);
    expect(isOwnAppSender(undefined)).toBe(false);
  });

  it("slug未設定なら誰もアプリ扱いしない（人間の操作を取りこぼさない）", () => {
    delete process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
    expect(isOwnAppSender("issue-deck[bot]")).toBe(false);
    expect(isOwnAppSender("undefined[bot]")).toBe(false);
  });
});

describe("isDispatchedStatusKey", () => {
  it("起動によってのみ到達する段階だけtrue", () => {
    expect(isDispatchedStatusKey("planning")).toBe(true);
    expect(isDispatchedStatusKey("implementation")).toBe(true);
  });

  it("PRのイベントで進む段階・未着手はfalse", () => {
    expect(isDispatchedStatusKey("ready")).toBe(false);
    expect(isDispatchedStatusKey("develop-pr")).toBe(false);
    expect(isDispatchedStatusKey("develop")).toBe(false);
    expect(isDispatchedStatusKey("release")).toBe(false);
    expect(isDispatchedStatusKey("done")).toBe(false);
  });
});

describe("dispatchCommentBody", () => {
  it("modeに応じた@claude指示と、起点がカンバンであることを書く", () => {
    const body = dispatchCommentBody({
      mode: "implement",
      senderLogin: "m-guchi",
      toStatus: "Implementation",
    });
    expect(body).toContain("@claude 実装を開始してください");
    expect(body).toContain("Implementation");
  });

  it("計画モードでは計画立案を依頼する", () => {
    const body = dispatchCommentBody({ mode: "plan", senderLogin: "m-guchi", toStatus: "Planning" });
    expect(body).toContain("@claude 計画を立案してください");
    expect(body).not.toContain("実装を開始");
  });

  it("投稿者マーカーを必ず末尾に置く（ワークフローがtail -n1で読むため）", () => {
    const body = dispatchCommentBody({
      mode: "implement",
      senderLogin: "m-guchi",
      toStatus: "Implementation",
    });
    expect(body.endsWith(posterMarker("m-guchi"))).toBe(true);
  });

  it("issue-deck-sourceマーカーを含める（コメントの出所を画面で判別するため）", () => {
    const body = dispatchCommentBody({
      mode: "implement",
      senderLogin: "m-guchi",
      toStatus: "Implementation",
    });
    expect(body).toContain("<!-- issue-deck-source:project-status-dispatch -->");
  });

  it("ワークフロー側と同じ正規表現で投稿者を復元できる", () => {
    const body = dispatchCommentBody({
      mode: "plan",
      senderLogin: "some-user",
      toStatus: "Planning",
    });
    // reusable-issue-dispatch.yml の grep -oP '(?<=<!-- issue-deck:posted-by:)\S+(?= -->)' 相当
    const matches = [...body.matchAll(/<!-- issue-deck:posted-by:(\S+) -->/g)];
    expect(matches.at(-1)?.[1]).toBe("some-user");
  });
});
