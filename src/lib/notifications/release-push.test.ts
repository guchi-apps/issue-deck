import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { fetchLatestRelease, fetchReleaseNotesFile } from "@/lib/github/release-api";
import { isPushConfigured, sendPushNotification } from "@/lib/notifications/push";
import {
  buildReleasePushPayload,
  decideReleasePush,
  parseReleaseNotes,
  RELEASE_PUSH_EMPTY_BODY,
  releasePushMaxAgeHours,
  releasePushSweepIntervalMinutes,
  resetReleasePushSweepIntervalForTest,
  runReleasePushSweep,
} from "@/lib/notifications/release-push";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/notifications/push", () => ({
  isPushConfigured: vi.fn(() => true),
  sendPushNotification: vi.fn(async () => ({ sent: 1, removed: 0, failed: 0 })),
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "token") }));
vi.mock("@/lib/github/release-api", () => ({
  fetchLatestRelease: vi.fn(async () => null),
  fetchReleaseNotesFile: vi.fn(async () => null),
}));

const NOW = new Date("2026-09-02T09:00:00.000Z");

const REPOSITORY = {
  id: "r1",
  fullName: "guchi-apps/issue-deck",
  ownerLogin: "guchi-apps",
  name: "issue-deck",
  installationId: "inst-cuid",
  installation: { installationId: 123 },
};

const LATEST = {
  tagName: "v4.75.0",
  name: "v4.75.0",
  htmlUrl: "https://github.com/guchi-apps/issue-deck/releases/tag/v4.75.0",
  publishedAt: "2026-09-02T08:55:00.000Z",
};

const NOTES = [
  "<!-- リリースのたびに自動生成されます。手で編集しないでください -->",
  "",
  "# v4.75.0",
  "",
  "- リリースの完了がPush通知で届くようになりました",
  "",
  "**使い方**",
  "",
  "1. 設定の「通知」で受け取りを開始します。",
].join("\n");

/** 巡回が触るDBのメソッドだけをその場で生やす。戻り値は個々のテストで差し替える */
function stubDb(overrides: {
  subscriptionCount?: number;
  repositories?: unknown[];
  /** 前回記録したタグ。undefinedなら「記録が無い」（＝`create`が通る） */
  recordedTagName?: string;
  /** 席取りの`updateMany`が更新できた件数 */
  reserveCount?: number;
}) {
  const create = vi.fn(async () => {
    // 行があるリポジトリでは、実DBと同じく一意制約で落ちる
    if (overrides.recordedTagName !== undefined) throw new Error("Unique constraint failed");
    return {};
  });
  const updateMany = vi.fn(async () => ({ count: overrides.reserveCount ?? 1 }));
  const findUnique = vi.fn(async () =>
    overrides.recordedTagName === undefined ? null : { tagName: overrides.recordedTagName },
  );
  Object.assign(db, {
    pushSubscription: {
      count: vi.fn(async () => overrides.subscriptionCount ?? 1),
      findMany: vi.fn(async () => [{ id: "s1", endpoint: "e", p256dh: "p", auth: "a" }]),
    },
    repository: { findMany: vi.fn(async () => overrides.repositories ?? []) },
    releasePushNotice: { create, updateMany, findUnique },
  });
  return { create, updateMany, findUnique };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetReleasePushSweepIntervalForTest();
  vi.mocked(isPushConfigured).mockReturnValue(true);
  vi.mocked(fetchLatestRelease).mockResolvedValue(LATEST);
  vi.mocked(fetchReleaseNotesFile).mockResolvedValue(NOTES);
});

describe("releasePushSweepIntervalMinutes", () => {
  it("未設定・不正な値は既定の5分", () => {
    expect(releasePushSweepIntervalMinutes(undefined)).toBe(5);
    expect(releasePushSweepIntervalMinutes("")).toBe(5);
    expect(releasePushSweepIntervalMinutes("あ")).toBe(5);
    expect(releasePushSweepIntervalMinutes("-1")).toBe(5);
  });

  it("0は「巡回しない」として通す", () => {
    expect(releasePushSweepIntervalMinutes("0")).toBe(0);
  });
});

describe("releasePushMaxAgeHours", () => {
  it("未設定は既定の24時間、0は「新しさを問わない」", () => {
    expect(releasePushMaxAgeHours(undefined)).toBe(24);
    expect(releasePushMaxAgeHours("0")).toBe(0);
    expect(releasePushMaxAgeHours("48")).toBe(48);
  });
});

describe("decideReleasePush", () => {
  const base = { tagName: "v4.75.0", publishedAt: NOW, now: NOW, maxAgeHours: 24 };

  it("記録が無いリポジトリは鳴らさず記録だけする（導入直後の一斉通知を避ける）", () => {
    expect(decideReleasePush({ ...base, recordedTagName: null })).toBe("record");
  });

  it("記録済みのタグと同じなら何もしない", () => {
    expect(decideReleasePush({ ...base, recordedTagName: "v4.75.0" })).toBe("skip");
  });

  it("タグが変わっていれば鳴らす", () => {
    expect(decideReleasePush({ ...base, recordedTagName: "v4.74.0" })).toBe("send");
  });

  it("公開から時間が経ちすぎたリリースは鳴らさず記録だけする", () => {
    const decision = decideReleasePush({
      ...base,
      recordedTagName: "v4.74.0",
      publishedAt: new Date(NOW.getTime() - 25 * 60 * 60_000),
    });
    expect(decision).toBe("record");
  });

  it("`maxAgeHours`が0なら新しさを問わない", () => {
    const decision = decideReleasePush({
      ...base,
      recordedTagName: "v4.74.0",
      publishedAt: new Date(NOW.getTime() - 100 * 60 * 60_000),
      maxAgeHours: 0,
    });
    expect(decision).toBe("send");
  });
});

describe("parseReleaseNotes", () => {
  it("見出しがバージョンと一致したときだけ本文を返す", () => {
    expect(parseReleaseNotes(NOTES, "v4.75.0")).toBe(
      "- リリースの完了がPush通知で届くようになりました",
    );
  });

  it("「使い方」は落とす（OSの通知では何が変わったかを先に見せる）", () => {
    expect(parseReleaseNotes(NOTES, "v4.75.0")).not.toContain("使い方");
  });

  it("`v`の有無は問わない", () => {
    expect(parseReleaseNotes(NOTES, "4.75.0")).not.toBe("");
  });

  it("見出しが別のバージョンなら載せない（古い文面を貼らない）", () => {
    expect(parseReleaseNotes(NOTES, "v4.76.0")).toBe("");
  });

  it("ファイルが無い・見出しが無いときは空", () => {
    expect(parseReleaseNotes(null, "v4.75.0")).toBe("");
    expect(parseReleaseNotes("更新内容だけの本文", "v4.75.0")).toBe("");
  });

  it("長すぎる本文は切って、切ったことが分かるようにする", () => {
    const long = `# v1.0.0\n\n${"あ".repeat(400)}`;
    const body = parseReleaseNotes(long, "v1.0.0");
    expect(body).toHaveLength(301);
    expect(body.endsWith("…")).toBe(true);
  });
});

describe("buildReleasePushPayload", () => {
  it("1行目にリポジトリとバージョン、タップ先はブランチ画面", () => {
    const payload = buildReleasePushPayload({
      repositoryFullName: "guchi-apps/issue-deck",
      tagName: "v4.75.0",
      notes: "- 直しました",
    });
    expect(payload.title).toBe("issue-deck ・ リリース v4.75.0");
    expect(payload.body).toBe("- 直しました");
    // PCの`pane`とスマホの`mscreen`で現在地の持ち方が違うので両方載せる
    expect(payload.url).toBe("/dashboard?pane=flow&mscreen=flow");
    // リリースごとに別の出来事なので、`tag`はバージョンまで含めて一意にする
    expect(payload.tag).toBe("release:guchi-apps/issue-deck@v4.75.0");
  });

  it("更新内容が無くても本文を空にしない（#2683と同じ文面）", () => {
    const payload = buildReleasePushPayload({
      repositoryFullName: "guchi-apps/issue-deck",
      tagName: "v4.75.0",
      notes: "",
    });
    expect(payload.body).toBe(RELEASE_PUSH_EMPTY_BODY);
  });
});

describe("runReleasePushSweep", () => {
  it("新しいリリースを見つけたら鳴らす", async () => {
    const { updateMany } = stubDb({ repositories: [REPOSITORY], recordedTagName: "v4.74.0" });

    const result = await runReleasePushSweep({ now: NOW });

    expect(result.notified).toEqual([
      {
        repositoryFullName: "guchi-apps/issue-deck",
        tagName: "v4.75.0",
        notes: "- リリースの完了がPush通知で届くようになりました",
      },
    ]);
    // **送る前に席を取る**（タグが変わっていることを条件にした更新が席になる）
    expect(updateMany).toHaveBeenCalled();
    expect(sendPushNotification).toHaveBeenCalledOnce();
  });

  it("初めて見るリポジトリは鳴らさずタグだけ記録する", async () => {
    const { create } = stubDb({ repositories: [REPOSITORY] });

    const result = await runReleasePushSweep({ now: NOW });

    expect(result.recorded).toEqual(["guchi-apps/issue-deck"]);
    expect(result.notified).toHaveLength(0);
    expect(create).toHaveBeenCalledWith({
      data: {
        repositoryFullName: "guchi-apps/issue-deck",
        tagName: "v4.75.0",
        publishedAt: new Date(LATEST.publishedAt),
        notifiedAt: null,
      },
    });
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("記録済みのタグと同じなら更新内容も読みに行かない", async () => {
    stubDb({ repositories: [REPOSITORY], recordedTagName: "v4.75.0" });

    const result = await runReleasePushSweep({ now: NOW });

    expect(result.notified).toHaveLength(0);
    expect(fetchReleaseNotesFile).not.toHaveBeenCalled();
  });

  it("席を取れなかったら鳴らさない（巡回が同時に走ったとき）", async () => {
    stubDb({ repositories: [REPOSITORY], recordedTagName: "v4.74.0", reserveCount: 0 });

    expect((await runReleasePushSweep({ now: NOW })).notified).toHaveLength(0);
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("リリースを1度も出していないリポジトリは数にも入れない", async () => {
    stubDb({ repositories: [REPOSITORY] });
    vi.mocked(fetchLatestRelease).mockResolvedValue(null);

    const result = await runReleasePushSweep({ now: NOW });

    expect(result.repositories).toBe(0);
    expect(result.recorded).toHaveLength(0);
  });

  it("更新内容の取得に失敗しても通知そのものは出す", async () => {
    stubDb({ repositories: [REPOSITORY], recordedTagName: "v4.74.0" });
    vi.mocked(fetchReleaseNotesFile).mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runReleasePushSweep({ now: NOW });

    expect(result.notified[0]?.notes).toBe("");
    expect(sendPushNotification).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it("間隔に達するまで巡回しない（GitHubを叩かない）", async () => {
    stubDb({ repositories: [REPOSITORY], recordedTagName: "v4.75.0" });
    await runReleasePushSweep({ now: NOW });
    vi.clearAllMocks();

    const again = await runReleasePushSweep({ now: new Date(NOW.getTime() + 60_000) });

    expect(again.swept).toBe(false);
    expect(fetchLatestRelease).not.toHaveBeenCalled();
  });

  it("購読が1件も無ければGitHubを叩かない", async () => {
    stubDb({ subscriptionCount: 0, repositories: [REPOSITORY] });

    const result = await runReleasePushSweep({ now: NOW });

    expect(result.swept).toBe(true);
    expect(fetchLatestRelease).not.toHaveBeenCalled();
  });

  it("1リポジトリの取得失敗で他リポジトリの通知を止めない", async () => {
    stubDb({
      repositories: [{ ...REPOSITORY, fullName: "guchi-apps/other", name: "other" }, REPOSITORY],
      recordedTagName: "v4.74.0",
    });
    vi.mocked(fetchLatestRelease)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(LATEST);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runReleasePushSweep({ now: NOW });

    expect(result.failedRepositories).toEqual(["guchi-apps/other"]);
    expect(result.notified).toHaveLength(1);
    errorSpy.mockRestore();
  });
});
