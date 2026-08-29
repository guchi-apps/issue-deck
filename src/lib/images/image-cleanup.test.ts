import { describe, expect, it } from "vitest";

import {
  decideImageCleanup,
  decideTrashPurge,
  decideTrashRestore,
  imageCleanupSweepIntervalMinutes,
  IMAGE_CLEANUP_SWEEP_DEFAULT_INTERVAL_MINUTES,
  imageTrashDays,
  IMAGE_COMMENT_SCAN_OVERLAP_MS,
  isImageScanComplete,
  nextCommentScanCursor,
} from "@/lib/images/image-cleanup";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-29T00:00:00.000Z");

function file(filename: string, agoDays: number) {
  return { filename, modifiedAtMs: NOW.getTime() - agoDays * DAY };
}

function baseParams() {
  return {
    files: [file("old.png", 60), file("recent.png", 1)],
    referencedFilenames: new Set<string>(),
    enabled: true,
    retentionDays: 30,
    scanCompletedAt: new Date(NOW.getTime() - DAY),
    referenceCountBefore: 100,
    referenceCountAfter: 100,
    now: NOW,
  };
}

describe("decideImageCleanup", () => {
  it("参照が無く保持期間を過ぎたものだけをゴミ箱へ回す", () => {
    expect(decideImageCleanup(baseParams())).toEqual({ toTrash: ["old.png"], skipped: null });
  });

  it("参照が1件でもあれば触らない", () => {
    const decision = decideImageCleanup({
      ...baseParams(),
      referencedFilenames: new Set(["old.png"]),
    });
    expect(decision.toTrash).toEqual([]);
  });

  it("設定がOFFなら何もしない", () => {
    expect(decideImageCleanup({ ...baseParams(), enabled: false })).toEqual({
      toTrash: [],
      skipped: "disabled",
    });
  });

  it("参照の索引が一巡していなければ何もしない", () => {
    expect(decideImageCleanup({ ...baseParams(), scanCompletedAt: null })).toEqual({
      toTrash: [],
      skipped: "scan_incomplete",
    });
  });

  it("索引が一巡した後にアップロードされた画像は、保持期間を過ぎていても触らない", () => {
    const decision = decideImageCleanup({
      ...baseParams(),
      // 一巡したのが60日前で、画像は50日前（＝一巡より後）にアップロードされた
      scanCompletedAt: new Date(NOW.getTime() - 60 * DAY),
      files: [file("uploaded-after-scan.png", 50)],
    });
    expect(decision).toEqual({ toTrash: [], skipped: "scan_older_than_upload" });
  });

  it("この巡回で参照が急に減っていたら、削除を丸ごと見送る（連携解除のカスケード対策）", () => {
    const decision = decideImageCleanup({
      ...baseParams(),
      referenceCountBefore: 100,
      referenceCountAfter: 40,
    });
    expect(decision).toEqual({ toTrash: [], skipped: "reference_drop" });
  });

  it("参照がもともと0件のとき（初回）は、減ったとは見なさない", () => {
    const decision = decideImageCleanup({
      ...baseParams(),
      referenceCountBefore: 0,
      referenceCountAfter: 0,
    });
    expect(decision.toTrash).toEqual(["old.png"]);
  });
});

describe("decideTrashRestore / decideTrashPurge", () => {
  const trashFiles = [file("found-later.png", 5), file("still-unused.png", 40)];

  it("ゴミ箱に入れた後で参照が見つかったものは戻す", () => {
    expect(
      decideTrashRestore({
        trashFiles,
        referencedFilenames: new Set(["found-later.png"]),
      }),
    ).toEqual(["found-later.png"]);
  });

  it("ゴミ箱で猶予を過ぎたものだけを完全に削除する", () => {
    expect(
      decideTrashPurge({
        trashFiles,
        referencedFilenames: new Set<string>(),
        trashDays: 30,
        now: NOW,
      }),
    ).toEqual(["still-unused.png"]);
  });

  it("猶予を過ぎていても、参照が見つかったものは完全削除しない", () => {
    expect(
      decideTrashPurge({
        trashFiles,
        referencedFilenames: new Set(["still-unused.png"]),
        trashDays: 30,
        now: NOW,
      }),
    ).toEqual([]);
  });
});

describe("isImageScanComplete", () => {
  const scanned = { imageCommentScanAt: NOW, lastSyncedAt: NOW };

  it("全リポジトリを読み終えて、読み残しも失敗も無いときだけ完了とする", () => {
    expect(
      isImageScanComplete({ repositories: [scanned], hasPendingPages: false, hasErrors: false }),
    ).toBe(true);
  });

  it("1つでも未読・読み残し・失敗があれば完了としない", () => {
    expect(
      isImageScanComplete({
        repositories: [scanned, { imageCommentScanAt: null, lastSyncedAt: NOW }],
        hasPendingPages: false,
        hasErrors: false,
      }),
    ).toBe(false);
    expect(
      isImageScanComplete({ repositories: [scanned], hasPendingPages: true, hasErrors: false }),
    ).toBe(false);
    expect(
      isImageScanComplete({ repositories: [scanned], hasPendingPages: false, hasErrors: true }),
    ).toBe(false);
  });

  it("リポジトリが1つも無い状態を「全部読み終えた」と読み替えない", () => {
    expect(
      isImageScanComplete({ repositories: [], hasPendingPages: false, hasErrors: false }),
    ).toBe(false);
  });
});

describe("nextCommentScanCursor", () => {
  it("読み終えた最後のコメントの更新時刻から少し戻した値にする（境界の取りこぼし対策）", () => {
    const last = new Date("2026-08-29T10:00:00.000Z");
    expect(nextCommentScanCursor(last, null)?.getTime()).toBe(
      last.getTime() - IMAGE_COMMENT_SCAN_OVERLAP_MS,
    );
  });

  it("1件も読まなかったときはカーソルを動かさない", () => {
    const previous = new Date("2026-08-01T00:00:00.000Z");
    expect(nextCommentScanCursor(null, previous)).toBe(previous);
  });

  it("戻した結果が前回より古くなるならカーソルを巻き戻さない", () => {
    const previous = new Date("2026-08-29T10:00:00.000Z");
    const last = new Date("2026-08-29T10:00:10.000Z");
    expect(nextCommentScanCursor(last, previous)).toBe(previous);
  });
});

describe("設定値の読み取り", () => {
  it("未設定・空文字・不正な値では既定値へ落とす", () => {
    expect(imageCleanupSweepIntervalMinutes(undefined)).toBe(
      IMAGE_CLEANUP_SWEEP_DEFAULT_INTERVAL_MINUTES,
    );
    expect(imageCleanupSweepIntervalMinutes(" ")).toBe(
      IMAGE_CLEANUP_SWEEP_DEFAULT_INTERVAL_MINUTES,
    );
    expect(imageCleanupSweepIntervalMinutes("-1")).toBe(
      IMAGE_CLEANUP_SWEEP_DEFAULT_INTERVAL_MINUTES,
    );
    expect(imageCleanupSweepIntervalMinutes("0")).toBe(0);
    expect(imageTrashDays("7")).toBe(7);
  });
});
