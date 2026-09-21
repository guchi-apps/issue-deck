import { readFile } from "node:fs/promises";
import path from "node:path";

import { callClaudeMessages } from "@/lib/claude/request";
import type { ImageExtractResult } from "@/lib/image-extract-format";
import { UPLOADED_IMAGE_DIR, UPLOADED_IMAGE_TRASH_DIR } from "@/lib/images/image-storage";
import { extractUploadedImageFilenames } from "@/lib/uploaded-images";

/** 1回に送る画像の上限。読み取りの消費は枚数に比例するため絞る */
export const MAX_EXTRACT_IMAGES = 4;

/** 1枚あたりの上限。Anthropic APIが受け付ける画像の上限（5MB）に合わせる */
export const MAX_EXTRACT_IMAGE_BYTES = 5 * 1024 * 1024;

/** 変更内容は多くても20件ほど。出力を抑えて本文が膨らむのを防ぐ */
const MAX_ITEMS = 20;
const MAX_TOKENS = 1024;

export type ImageExtractErrorCode = "no_images" | "too_many_images" | "image_too_large" | "image_not_found" | "nothing_extracted";

/** 利用者へそのまま出してよい文言を持つエラー。`code`は画面が状態を分けるためのもの */
export class ImageExtractError extends Error {
  constructor(
    readonly code: ImageExtractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImageExtractError";
  }
}

const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * 画像URLの並びを、アップロード済みのファイル名へ直す。
 *
 * **URLをそのまま取りに行かない。** 受け取るのはUUIDファイル名の形式に合うものだけで、
 * それ以外は無視する（任意のURL・パスを読ませない。パストラバーサルの防波堤は
 * `uploaded-images.ts`の正規表現が担う）。同じ画像は1枚にまとめる。
 */
export function resolveImageFilenames(urls: string[]): string[] {
  const filenames = urls.flatMap((url) => extractUploadedImageFilenames(url).slice(0, 1));
  return [...new Set(filenames)];
}

async function loadImage(filename: string): Promise<{ mediaType: string; data: string }> {
  const buffer = await readFile(path.join(UPLOADED_IMAGE_DIR, filename))
    .catch(() => readFile(path.join(UPLOADED_IMAGE_TRASH_DIR, filename)))
    .catch(() => null);
  if (!buffer) {
    throw new ImageExtractError("image_not_found", "添付した画像が見つかりませんでした。添付し直してください");
  }
  if (buffer.byteLength > MAX_EXTRACT_IMAGE_BYTES) {
    throw new ImageExtractError(
      "image_too_large",
      "画像が大きすぎて読み取れません（5MBまで）。書き込み画面で保存し直すか、小さい画像に差し替えてください",
    );
  }
  const extension = filename.slice(filename.lastIndexOf(".") + 1);
  return { mediaType: MEDIA_TYPE_BY_EXTENSION[extension], data: buffer.toString("base64") };
}

/** 書き込み済みの画像から変更内容を読み取らせるプロンプト。画像はこの文の前に並べる */
export function buildImageExtractPrompt(imageCount: number): string {
  return `添付した${imageCount}枚の画像は、GitHub Issueを作る人がアプリの画面などに書き込みを加えたものです。書き込み（赤丸・矢印・線・×印・取り消し線・番号・記号・手書きや入力した文字など）が指している箇所を読み取り、「何をどう変えてほしいか」を1件1行の日本語にしてください。

ルール:
- 1件は「対象（画面の部品・文言・位置）」と「変更内容（削除・変更・追加・移動など）」がわかる文にし、根拠にした書き込みを括弧で添える（例: 「保存」ボタンを右下から右上へ移動する（赤い矢印））。
- 元の画像にもともと写っている文字や画面そのものは変更内容にしない。書き込みから読み取れることだけを書く。
- 書き込みが無い、または意図が読み取れないときは推測で埋めない。読み取れない書き込みが残っているときは"unreadable"をtrueにする。
- 画像が複数あるときは、文頭に「（画像1）」のように何枚目かを付ける。
- 件数は多くても${MAX_ITEMS}件まで。

出力は前置きや説明・コードフェンスを一切付けず、以下の形式のJSONのみを出力してください。
{"items": ["変更内容1", "変更内容2"], "unreadable": false}`;
}

function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

/** AIの応答本文から結果を取り出す。形が違うときは例外（呼び出し元が502にする） */
export function parseImageExtractResponse(text: string): ImageExtractResult {
  const parsed: unknown = JSON.parse(extractJsonText(text));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("AIの応答の形式が不正です");
  }
  const { items, unreadable } = parsed as { items?: unknown; unreadable?: unknown };
  if (!Array.isArray(items)) {
    throw new Error("AIの応答の形式が不正です");
  }
  return {
    items: items
      .filter((item): item is string => typeof item === "string" && item.trim() !== "")
      .slice(0, MAX_ITEMS),
    unreadable: unreadable === true,
  };
}

type AnthropicMessageResponse = {
  content?: { type: string; text?: string }[];
};

/**
 * 添付画像の書き込みから変更内容をAIに読み取らせる。
 *
 * 呼び出しごとにプラン枠を消費するため、呼び出し元でボタン操作の明示的なトリガーに限定すること
 * （画像の添付・保存のたびに自動で呼ばない）。
 */
export async function generateImageExtract(
  token: string,
  imageUrls: string[],
): Promise<ImageExtractResult> {
  const filenames = resolveImageFilenames(imageUrls);
  if (filenames.length === 0) {
    throw new ImageExtractError("no_images", "読み取る画像がありません");
  }
  if (filenames.length > MAX_EXTRACT_IMAGES) {
    throw new ImageExtractError(
      "too_many_images",
      `一度に読み取れるのは${MAX_EXTRACT_IMAGES}枚までです。画像を減らしてください`,
    );
  }

  const images = await Promise.all(filenames.map(loadImage));

  const { response: res, json } = await callClaudeMessages<AnthropicMessageResponse>({
    feature: "issue_image_extract",
    token,
    body: {
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: [
            ...images.map((image) => ({
              type: "image",
              source: { type: "base64", media_type: image.mediaType, data: image.data },
            })),
            { type: "text", text: buildImageExtractPrompt(images.length) },
          ],
        },
      ],
    },
  });

  if (!res.ok) {
    throw new Error(`AIによる画像の読み取りに失敗しました (${res.status})`);
  }

  const text = json?.content?.find((block) => block.type === "text")?.text;
  if (!text) {
    throw new Error("AIの応答から読み取り結果を取得できませんでした");
  }

  const result = parseImageExtractResponse(text);
  if (result.items.length === 0 && !result.unreadable) {
    throw new ImageExtractError(
      "nothing_extracted",
      "書き込みから変更内容を読み取れませんでした。書き込みが分かる画像か確認してください",
    );
  }
  return result;
}
