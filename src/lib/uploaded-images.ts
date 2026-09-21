import type { UploadedImage, UploadedImageUsage, UploadedImageSummary } from "@/types/uploaded-image";

/**
 * アップロードAPI（`POST /api/issues/images`）が発行するUUIDファイル名の**中身**。
 *
 * 完全一致の検証（`UPLOADED_IMAGE_FILENAME_PATTERN`）と、本文からの抽出
 * （`extractUploadedImageFilenames`）が同じものを読むための素。**写さないこと**——
 * 片方だけ緩んだ瞬間に、検証側ならパストラバーサルの穴、抽出側なら「使っている画像を
 * 未使用と判定して消す」事故になる。
 */
const UPLOADED_IMAGE_FILENAME_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(?:png|jpg|gif|webp|svg)";

/**
 * アップロードAPI（`POST /api/issues/images`）が発行するUUIDファイル名の形式。
 *
 * **一覧・配信・削除の3つの受け口がこの1つを共有する。** 配信（`GET`）は共有シークレットでも
 * 読める（#2967）ので、この形式に合う名前しか受け付けないことがパストラバーサルの防波堤に
 * なっている（docs/code-map.md「画像・アーティファクトはVPSのローカルディスクに置く」）。
 * 片方だけ緩めると防波堤が崩れるため、正規表現を各ファイルへ写さずここから読む。
 */
export const UPLOADED_IMAGE_FILENAME_PATTERN = new RegExp(`^${UPLOADED_IMAGE_FILENAME_SOURCE}$`);

export function isUploadedImageFilename(filename: string): boolean {
  return UPLOADED_IMAGE_FILENAME_PATTERN.test(filename);
}

/**
 * 本文（Issueの本文・コメント）に画像が貼られているかを粗く絞り込むための語（#2475）。
 * DBを`body LIKE '%...%'`で引くときの部分文字列で、抽出そのものは
 * `extractUploadedImageFilenames`が行う。
 */
export const UPLOADED_IMAGE_URL_PATH = "/api/issues/images/";

/**
 * 本文に出てくるアップロード画像のファイル名を集める（#2475）。
 *
 * **ホスト名では絞らない。** 本文へ書き込まれるURLは`getRequestOrigin`が組み立てた絶対URLで、
 * アップロードしたときのアクセス経路（本番ホスト・LANのIP・sslip.ioのホスト名）がそのまま
 * 残るため、オリジンは1つに決まらない。
 *
 * **迷ったら拾う側に倒す。** 誤って「使用中」と判定したときの損はディスクが減らないことだけ、
 * 取りこぼしたときの損は使っている画像の消失なので、`![](...)`の記法もHTMLの`<img>`も
 * クエリ付きのURLも、極端には文中に裸で書かれたファイル名も、まとめてUUIDの並びで拾う。
 */
export function extractUploadedImageFilenames(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.match(new RegExp(UPLOADED_IMAGE_FILENAME_SOURCE, "g"));
  if (!matches) return [];
  return [...new Set(matches)];
}

/**
 * 画像のURL（クエリ付きも可）がSVGを指しているか（#3286）。SVGは透明な地と固有の寸法を持たない
 * ことがあるため、サムネイル・拡大表示の見せ方（市松の地・書き込みの非表示）を分ける判定に使う。
 */
export function isSvgImageUrl(url: string): boolean {
  return /\.svg(?:[?#].*)?$/i.test(url);
}

/** SVGの先頭として読める範囲。XML宣言・コメント・DOCTYPEの後ろに`<svg`が来るまでを見る */
export const SVG_HEAD_SCAN_BYTES = 64 * 1024;

/**
 * 文字列の先頭がSVG文書として読めるか（#3286）。
 *
 * アップロードAPIがSVGを受け付けるときの入口の確認で、**中身の無害化ではない**（無害化は配信の
 * CSPが担う。`app/api/issues/images/[filename]/route.ts`）。拡張子・MIMEだけを信じて、
 * HTMLなど別物をSVGとして保存してしまうのを避ける。XML宣言・コメント・DOCTYPEは読み飛ばす。
 * **正規表現の入れ子の繰り返しは使わない**（空白が長い入力で指数的に遅くなるため、切り出しで進める）。
 */
export function looksLikeSvg(head: string): boolean {
  let text = head.replace(/^\uFEFF/, "");
  for (;;) {
    text = text.trimStart();
    if (text.startsWith("<?")) {
      const end = text.indexOf("?>");
      if (end === -1) return false;
      text = text.slice(end + 2);
    } else if (text.startsWith("<!--")) {
      const end = text.indexOf("-->");
      if (end === -1) return false;
      text = text.slice(end + 3);
    } else if (/^<!DOCTYPE/i.test(text)) {
      const firstClose = text.indexOf(">");
      const subsetOpen = text.indexOf("[");
      const end =
        subsetOpen !== -1 && (firstClose === -1 || subsetOpen < firstClose)
          ? text.indexOf("]>")
          : firstClose;
      if (end === -1) return false;
      text = text.slice(text.indexOf(">", end) + 1);
    } else {
      break;
    }
  }
  return /^<svg[\s>/]/.test(text);
}

/** `uploads/images/`から読んだファイル1件ぶんの生の情報 */
export type UploadedImageFile = {
  filename: string;
  size: number;
  /** ファイルの更新時刻（エポックミリ秒） */
  modifiedAtMs: number;
};

/**
 * ディレクトリの読み取り結果を画面へ出す一覧に整える（#2462）。
 *
 * アップロードAPIが作った名前でないファイル（手で置いたもの・作りかけ）は落とす。
 * 並びは**新しい順**——消したくなるのは直前に貼った画像であることが多い。
 * 更新時刻が同じものはファイル名で並べ、取得のたびに順序が入れ替わらないようにする。
 *
 * `usage`は参照の索引（`UploadedImageReference`）から決まる（#2475）。索引がまだ一巡して
 * いない間は`"unknown"`（確認中）で、**`"unused"`（未使用）とは別に扱う**——判定できて
 * いないものを未使用と出すと、消してよいと読めてしまう。
 */
export function buildUploadedImageList(
  files: UploadedImageFile[],
  options: {
    /** ファイル名 → その画像を貼っている参照元 */
    referencesByFilename?: Map<string, UploadedImage["references"]>;
    /** 参照の索引が全リポジトリぶん一巡し終わっているか */
    scanCompleted?: boolean;
  } = {},
): UploadedImage[] {
  const { referencesByFilename, scanCompleted = false } = options;

  return files
    .filter((file) => isUploadedImageFilename(file.filename))
    .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs || a.filename.localeCompare(b.filename))
    .map((file) => {
      const references = referencesByFilename?.get(file.filename) ?? [];
      const usage: UploadedImageUsage =
        references.length > 0 ? "used" : scanCompleted ? "unused" : "unknown";
      return {
        filename: file.filename,
        url: `/api/issues/images/${file.filename}`,
        size: file.size,
        uploadedAt: new Date(file.modifiedAtMs).toISOString(),
        usage,
        references,
      };
    });
}

/** 一覧に添えるファイルサイズ。KB未満は1KBに丸める（0KBと出すと壊れて見えるため） */
export function formatUploadedImageSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(size / 1024))}KB`;
}

/** 容量サマリーの合計に使う書式。合計は必ずMB表記（KBと混ざると大小を比べにくい） */
export function formatUploadedImageTotal(size: number): string {
  if (size >= 1024 * 1024 * 1024) return `${(size / (1024 * 1024 * 1024)).toFixed(2)}GB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 「次の巡回で何枚が対象になるか」を数える（#2475）。
 *
 * **サーバー側の判定（`decideImageCleanup`）と同じ条件で書くこと。** 画面に出す予告と実際に
 * 消えるものが食い違うと、予告が信用されなくなる。違いは、設定のON/OFFと参照の急減を
 * 見ないところだけ（どちらも画面に出したい数とは別の話）。
 */
export function selectCleanupTargets(
  images: UploadedImage[],
  options: { retentionDays: number; scanCompletedAt: string | null; now: Date },
): UploadedImage[] {
  const { retentionDays, scanCompletedAt, now } = options;
  if (scanCompletedAt === null) return [];
  const scanCompletedAtMs = new Date(scanCompletedAt).getTime();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

  return images.filter((image) => {
    if (image.usage !== "unused") return false;
    const uploadedAtMs = new Date(image.uploadedAt).getTime();
    if (now.getTime() - uploadedAtMs < retentionMs) return false;
    return uploadedAtMs < scanCompletedAtMs;
  });
}

/** 枚数とバイト数を1つにまとめる（サマリーの表示に使う） */
export function totalUploadedImageSize(images: UploadedImage[]): number {
  return images.reduce((total, image) => total + image.size, 0);
}

/**
 * 容量サマリー（#2475）。使用中／未使用／確認中／ゴミ箱の4つに分けて枚数とバイト数を出す。
 *
 * ゴミ箱（`uploads/images/.trash/`）は一覧には出さないが、**容量には数える**——
 * 消したのに空き容量が増えていないように見えるのを避けるため。
 */
export function summarizeUploadedImages(
  images: UploadedImage[],
  trashFiles: UploadedImageFile[],
): UploadedImageSummary {
  const empty = { count: 0, size: 0 };
  const summary: UploadedImageSummary = {
    total: { ...empty },
    used: { ...empty },
    unused: { ...empty },
    unknown: { ...empty },
    trashed: { ...empty },
  };

  for (const image of images) {
    summary.total.count += 1;
    summary.total.size += image.size;
    const bucket = summary[image.usage];
    bucket.count += 1;
    bucket.size += image.size;
  }

  for (const file of trashFiles) {
    summary.total.count += 1;
    summary.total.size += file.size;
    summary.trashed.count += 1;
    summary.trashed.size += file.size;
  }

  return summary;
}
