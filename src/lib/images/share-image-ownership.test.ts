import { randomUUID } from "node:crypto";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UPLOADED_IMAGE_DIR } from "@/lib/images/image-storage";
import {
  consumeShareImageUploads,
  loadOwnedShareImages,
  recordShareImageUpload,
  SHARE_IMAGE_OWNER_DIR,
} from "@/lib/images/share-image-ownership";

const created: string[] = [];

async function upload(extension = "png"): Promise<string> {
  const filename = `${randomUUID()}.${extension}`;
  await mkdir(UPLOADED_IMAGE_DIR, { recursive: true });
  await writeFile(path.join(UPLOADED_IMAGE_DIR, filename), "image");
  created.push(filename);
  return filename;
}

const markdown = (filename: string) => `![image](https://example.test/api/issues/images/${filename})`;

afterEach(async () => {
  for (const filename of created.splice(0)) {
    await rm(path.join(UPLOADED_IMAGE_DIR, filename), { force: true });
    await rm(path.join(SHARE_IMAGE_OWNER_DIR, filename), { force: true });
  }
});

describe("loadOwnedShareImages", () => {
  it("本人が共有画面から上げた画像だけを読む", async () => {
    const mine = await upload();
    const others = await upload();
    const unrecorded = await upload();
    await recordShareImageUpload("user-1", mine);
    await recordShareImageUpload("user-2", others);

    const images = await loadOwnedShareImages("user-1", [mine, others, unrecorded].map(markdown).join("\n"));

    expect(images.map((image) => image.filename)).toEqual([mine]);
    expect(images[0].mediaType).toBe("image/png");
  });

  it("SVGと期限切れの記録は読まない", async () => {
    const svg = await upload("svg");
    const old = await upload();
    await recordShareImageUpload("user-1", svg);
    await recordShareImageUpload("user-1", old);
    const past = new Date(Date.now() - 25 * 60 * 60_000);
    await utimes(path.join(SHARE_IMAGE_OWNER_DIR, old), past, past);

    expect(await loadOwnedShareImages("user-1", markdown(svg) + markdown(old))).toEqual([]);
  });

  it("判定後は記録を消す。他人の記録は消さない", async () => {
    const mine = await upload();
    const others = await upload();
    await recordShareImageUpload("user-1", mine);
    await recordShareImageUpload("user-2", others);

    await consumeShareImageUploads("user-1", markdown(mine) + markdown(others));

    expect(await loadOwnedShareImages("user-1", markdown(mine))).toEqual([]);
    expect(await loadOwnedShareImages("user-2", markdown(others))).toHaveLength(1);
  });
});
