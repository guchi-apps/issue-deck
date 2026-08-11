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
    expect(resolveDispatchMode({ from: "Ready", to: "Planning", labels: [] })).toBe("plan");
    expect(resolveDispatchMode({ from: "Ready", to: "Implementation", labels: [] })).toBe("implement");
  });

  it("Ready 以外からの前進は起動しない（報告APIの書き込みで再起動しないため）", () => {
    expect(resolveDispatchMode({ from: "Implementation", to: "Develop PR", labels: [] })).toBeNull();
    expect(resolveDispatchMode({ from: "Develop", to: "Implementation", labels: [] })).toBeNull();
    expect(resolveDispatchMode({ from: "Release", to: "Done", labels: [] })).toBeNull();
  });

  describe("Planning → Implementation（計画の承認）", () => {
    const APPROVAL_PENDING = ["01.planning", "00.check-user", "21.plan-required"];

    it("承認待ちならapprove-planになる", () => {
      expect(
        resolveDispatchMode({ from: "Planning", to: "Implementation", labels: APPROVAL_PENDING }),
      ).toBe("approve-plan");
    });

    it("承認待ちでなければ起動しない（計画の実行中に動かしても実装が始まらない）", () => {
      expect(
        resolveDispatchMode({ from: "Planning", to: "Implementation", labels: ["01.planning"] }),
      ).toBeNull();
    });

    it("00.check-userだけ・21.plan-requiredだけでは起動しない", () => {
      // 前者は質問への回答待ち等、後者は計画の実行中でありどちらも承認の場面ではない
      expect(
        resolveDispatchMode({
          from: "Planning",
          to: "Implementation",
          labels: ["00.check-user"],
        }),
      ).toBeNull();
      expect(
        resolveDispatchMode({
          from: "Planning",
          to: "Implementation",
          labels: ["21.plan-required"],
        }),
      ).toBeNull();
    });

    it("承認待ちでもImplementation以外へ動かしたら起動しない", () => {
      expect(
        resolveDispatchMode({ from: "Planning", to: "Develop PR", labels: APPROVAL_PENDING }),
      ).toBeNull();
      expect(
        resolveDispatchMode({ from: "Planning", to: "Ready", labels: APPROVAL_PENDING }),
      ).toBeNull();
    });
  });

  it("後戻りには何も割り当てない", () => {
    expect(resolveDispatchMode({ from: "Implementation", to: "Ready", labels: [] })).toBeNull();
    expect(resolveDispatchMode({ from: "Done", to: "Ready", labels: [] })).toBeNull();
  });

  it("Ready から起動対象外のStatusへ動かしても起動しない", () => {
    expect(resolveDispatchMode({ from: "Ready", to: "Develop PR", labels: [] })).toBeNull();
    expect(resolveDispatchMode({ from: "Ready", to: "Done", labels: [] })).toBeNull();
    expect(resolveDispatchMode({ from: "Ready", to: "Ready", labels: [] })).toBeNull();
  });

  it("遷移前が不明（null・未知の名前）なら起動しない", () => {
    // Projectへ載せた操作そのものが実行の開始になってしまうため
    expect(resolveDispatchMode({ from: null, to: "Implementation", labels: [] })).toBeNull();
    expect(resolveDispatchMode({ from: "Blocked", to: "Implementation", labels: [] })).toBeNull();
  });

  it("遷移後がnull・未知の名前なら起動しない", () => {
    expect(resolveDispatchMode({ from: "Ready", to: null, labels: [] })).toBeNull();
    expect(resolveDispatchMode({ from: "Ready", to: "Blocked", labels: [] })).toBeNull();
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

  it("承認モードでは計画の承認を伝える", () => {
    const body = dispatchCommentBody({
      mode: "approve-plan",
      senderLogin: "m-guchi",
      toStatus: "Implementation",
    });
    expect(body).toContain("@claude 計画を承認しました。実装を進めてください。");
  });

  it("no-triggerマーカーは付けない（ラベル除去がAppの操作で引き金にならないため）", () => {
    // これを付けると、ラベル除去イベント・コメントのどちらでも起動しなくなる
    for (const mode of ["plan", "implement", "approve-plan"] as const) {
      const body = dispatchCommentBody({ mode, senderLogin: "m-guchi", toStatus: "Implementation" });
      expect(body).not.toContain("issue-deck:no-trigger");
    }
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
