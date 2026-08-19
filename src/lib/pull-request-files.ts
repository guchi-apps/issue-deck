import type { GithubApiPullRequestFile } from "@/lib/github/pull-requests-api";
import type { PullRequestFile, PullRequestFileChange } from "@/types/pull-request";

/** 変更の種別ごとの表示名。1行の左端に置くため、いずれも2文字に揃えている */
export const PULL_REQUEST_FILE_CHANGE_LABEL: Record<PullRequestFileChange, string> = {
  added: "追加",
  modified: "変更",
  removed: "削除",
  renamed: "改名",
};

/**
 * GitHubの`status`を画面表示用の種別へ寄せる（#1987）。
 *
 * `copied`・`changed`・`unchanged`は滅多に出ないうえ、読む側の判断（どこを触ったPRか）を
 * 変えないため`modified`へ寄せる。未知の値も同じ扱いにして、種別が増えたときに画面が
 * 空欄になるのを防ぐ。
 */
export function toPullRequestFileChange(status: string): PullRequestFileChange {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

/**
 * 変更ファイル一覧のAPIレスポンスを画面用の形へ変換する（#1987）。
 *
 * **並べ替えない。** GitHubの「Files changed」と同じ順のままにして、両方を見比べたときに
 * 同じ位置に同じファイルが並ぶようにする。
 */
export function toPullRequestFiles(files: GithubApiPullRequestFile[]): PullRequestFile[] {
  return files.map((file) => ({
    path: file.filename,
    change: toPullRequestFileChange(file.status),
    additions: file.additions,
    deletions: file.deletions,
    blobUrl: file.blob_url,
    previousPath: file.previous_filename ?? null,
  }));
}

/**
 * パスをフォルダ部分とファイル名に分ける（#1987）。画面はフォルダを淡く、ファイル名を濃く出し、
 * 横幅が足りないときに先に削られるのがフォルダ側になるようにしている。
 */
export function splitPullRequestFilePath(path: string): { directory: string; name: string } {
  const index = path.lastIndexOf("/");
  if (index < 0) return { directory: "", name: path };
  return { directory: path.slice(0, index + 1), name: path.slice(index + 1) };
}
