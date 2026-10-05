import type { ReleaseHistoryItem } from "@/lib/github/release-api";
import { compareVersions } from "@/lib/semver-bump";

/**
 * 本番デプロイに失敗してGitHub Releaseが作られなかった版を、リリース履歴へ補う（#4003）。
 *
 * `deploy.yml`の`release`ジョブは`needs: [tag, deploy]`なので、タグを打った後にデプロイが
 * 落ちるとReleaseが作られない。履歴はReleaseの一覧から組み立てていたため、その版（例: v8.34.0）は
 * 説明ごと履歴から消え、修正版（v8.34.1）のRelease本文は`v8.34.0...v8.34.1`の差分だけになる。
 *
 * **タグと`.github/release-notes.md`はデプロイの成否と無関係にGitに残る。** そこでDBへ写さず、
 * 表示のたびにタグから補う。既存のv8.34.0/v8.34.1も同じ経路でそのまま補完される。
 *
 * このファイルは純粋関数だけを置く。GitHubからの取得は`lib/github/unreleased-versions.ts`。
 */

/**
 * GitHub Releaseが無い版の本番デプロイの状態。
 *
 * - `failed` — その版のコミットに対する`deploy.yml`の最新の実行が失敗した
 * - `in_progress` — 実行がまだ終わっていない（終われば`release`ジョブがReleaseを作る）
 * - `unknown` — 実行が見つからない・取れない。**成功とも失敗とも言わない**
 * - `succeeded_without_release` — デプロイは成功したが、Releaseの作成だけが落ちた
 */
export type UnreleasedDeployState = "failed" | "in_progress" | "unknown" | "succeeded_without_release";

/** その版の`.github/release-notes.md`から取り出した、利用者向けの説明 */
export type ReleaseNotesSnapshot =
  | { status: "ok"; changes: string[]; usage: string[] }
  /** 取れなかった。**空欄にせず理由を出す**（成功や「変更なし」に見せないため） */
  | { status: "unavailable"; reason: string };

/** 修正版が前の失敗版から引き継いで本番へ届けた変更（#4003） */
export type CarriedRelease = {
  tagName: string;
  htmlUrl: string;
  deployState: UnreleasedDeployState;
  releaseNotes: ReleaseNotesSnapshot;
  /** 失敗版に含まれていたPRの一覧（GitHubが生成した本文）。取れなければnull */
  body: string | null;
};

/** `1.2.3`形式のタグ（前置の`v`付き）だけを扱う。プレリリースはReleaseの有無と無関係に出ないため */
const PLAIN_VERSION_TAG = /^v\d+\.\d+\.\d+$/;

/** タグ1件（`fetchTagRefs`の結果から`refs/tags/`を落としたもの） */
export type VersionTag = { tagName: string; sha: string };

/** 1リポジトリで、Releaseが無い版として補う上限。古い失敗を延々と遡らないため */
export const UNRELEASED_VERSIONS_PER_REPOSITORY_LIMIT = 5;

/** `refs/tags/v1.2.3`の一覧から、`v1.2.3`形式のタグだけを取り出す */
export function toVersionTags(refs: readonly { ref: string; sha: string }[]): VersionTag[] {
  return refs
    .map((ref) => ({ tagName: ref.ref.replace(/^refs\/tags\//, ""), sha: ref.sha }))
    .filter((tag) => PLAIN_VERSION_TAG.test(tag.tagName));
}

function byVersionAsc(a: string, b: string): number {
  return compareVersions(a, b) ?? a.localeCompare(b);
}

/**
 * Releaseが無いタグのうち、取得済みのReleaseの範囲に入るものを新しい順に返す。
 *
 * **取得したReleaseのうち最も古い版より新しいタグだけを見る。** それより古いタグは、Releaseを
 * ページ単位で取っている都合で「取っていないだけ」のものと区別できない。Releaseが1件も無い
 * リポジトリ（リリースの流れを持たないもの）では何も補わない。
 */
export function selectUnreleasedTags(
  tags: readonly VersionTag[],
  releases: readonly Pick<ReleaseHistoryItem, "tagName">[],
  limit = UNRELEASED_VERSIONS_PER_REPOSITORY_LIMIT,
): VersionTag[] {
  const releasedVersions = releases.map((release) => release.tagName).filter((tag) => PLAIN_VERSION_TAG.test(tag));
  if (releasedVersions.length === 0) return [];
  const oldest = [...releasedVersions].sort(byVersionAsc)[0];
  const released = new Set(releases.map((release) => release.tagName));
  return tags
    .filter((tag) => !released.has(tag.tagName) && (compareVersions(tag.tagName, oldest) ?? 0) > 0)
    .sort((a, b) => byVersionAsc(b.tagName, a.tagName))
    .slice(0, limit);
}

/** そのタグの直前の版（差分の起点）。無ければnull */
export function findPreviousVersionTag(tags: readonly VersionTag[], tagName: string): string | null {
  const older = tags
    .map((tag) => tag.tagName)
    .filter((name) => (compareVersions(name, tagName) ?? 0) < 0)
    .sort(byVersionAsc);
  return older.at(-1) ?? null;
}

/** `deploy.yml`の実行1件から状態を決める。実行が無ければ`unknown` */
export function resolveUnreleasedDeployState(
  run: { status: string; conclusion: string | null } | null,
): UnreleasedDeployState {
  if (!run) return "unknown";
  if (run.status !== "completed") return "in_progress";
  if (run.conclusion === "success") return "succeeded_without_release";
  if (run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "startup_failure") {
    return "failed";
  }
  // cancelled等は失敗とも成功とも言えない
  return "unknown";
}

/**
 * `.github/release-notes.md`から、その版の説明を取り出す。
 *
 * 照合は`parseReleaseNotes`（`notifications/release-push.ts`）・`signaly-notify.sh`と同じで、
 * **見出し`# v1.2.3`がその版と一致したときだけ使う。** 文面が生成されなかったリリースでは
 * ファイルが更新されず前の版の文面が残る（v8.34.1のファイルは見出しがv8.34.0のまま）ため、
 * 一致を見ないと前の版の説明をこの版のものとして出してしまう。
 */
export function parseReleaseNotesSnapshot(raw: string | null, tagName: string): ReleaseNotesSnapshot {
  if (raw === null) {
    return { status: "unavailable", reason: "この版には説明ファイル（.github/release-notes.md）がありません" };
  }
  const lines = raw.split(/\r?\n/).filter((line) => !/^\s*<!--.*-->\s*$/.test(line));
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  const heading = lines.length > 0 ? /^#\s*(\S+)\s*$/.exec(lines[0]) : null;
  if (!heading) {
    return { status: "unavailable", reason: "説明ファイルに版の見出しがありません" };
  }
  if (heading[1].replace(/^v/, "") !== tagName.replace(/^v/, "")) {
    return {
      status: "unavailable",
      reason: `説明ファイルの見出しが${heading[1]}のままで、この版の説明は生成されていません`,
    };
  }

  const rest = lines.slice(1);
  const usageAt = rest.findIndex((line) => line.trim() === "**使い方**");
  const changeLines = usageAt === -1 ? rest : rest.slice(0, usageAt);
  const usageLines = usageAt === -1 ? [] : rest.slice(usageAt + 1);
  const changes = changeLines
    .map((line) => line.trim().replace(/^(?:[-*・])\s*/, "").trim())
    .filter((line) => line !== "");
  const usage = usageLines.map((line) => line.trim()).filter((line) => line !== "");
  if (changes.length === 0 && usage.length === 0) {
    return { status: "unavailable", reason: "説明ファイルに本文がありません" };
  }
  return { status: "ok", changes, usage };
}

/** 失敗版と、その変更を本番へ届けた（と思われる）後の版の組 */
export type RecoveryLinkCandidate = { failed: string; recovery: string };

/**
 * 失敗版ごとに、その変更を本番へ届けた後の版の候補を決める（1リポジトリぶん）。
 *
 * mainは積み上がっていくので、失敗版の変更は**それより後で最初にデプロイが成功した版**と一緒に
 * 本番へ出る。版番号の隣接ではなくデプロイの状態で決める（v8.34.0→v8.34.1失敗→v8.34.2成功なら、
 * v8.34.0とv8.34.1の両方がv8.34.2へ紐付く）。デプロイ中・結果不明の版は届けた版とみなさず、
 * その先の成功を待つ。**候補は呼び出し側がGitの祖先関係で確かめてから使う**（`applyRecoveryLinks`）。
 */
export function planRecoveryLinks(
  entries: readonly Pick<ReleaseHistoryItem, "tagName" | "deployState">[],
): RecoveryLinkCandidate[] {
  const ordered = entries
    .filter((entry) => PLAIN_VERSION_TAG.test(entry.tagName))
    .sort((a, b) => byVersionAsc(a.tagName, b.tagName));
  const pairs: RecoveryLinkCandidate[] = [];
  let pending: string[] = [];
  for (const entry of ordered) {
    if (entry.deployState === "failed") {
      pending.push(entry.tagName);
      continue;
    }
    if (entry.deployState === undefined || entry.deployState === "succeeded_without_release") {
      for (const failed of pending) pairs.push({ failed, recovery: entry.tagName });
      pending = [];
    }
  }
  return pairs;
}

/**
 * 確かめた組を履歴へ書き込む。失敗版には後継（`recoveredBy`）を、届けた版には引き継いだ変更
 * （`carriedOver`）を付ける。
 *
 * **引き継ぐのは失敗版それ自身の説明とPRだけ。** 失敗版が前の失敗版から引き継いだものは
 * 持たせないので、修正を何度繰り返しても同じ項目は届けた版に1回ずつしか載らない。
 */
export function applyRecoveryLinks(
  entries: readonly ReleaseHistoryItem[],
  verified: readonly RecoveryLinkCandidate[],
): ReleaseHistoryItem[] {
  if (verified.length === 0) return [...entries];
  const byTag = new Map(entries.map((entry) => [entry.tagName, entry]));
  const recoveredBy = new Map(verified.map((pair) => [pair.failed, pair.recovery]));
  const carried = new Map<string, CarriedRelease[]>();
  for (const pair of [...verified].sort((a, b) => byVersionAsc(a.failed, b.failed))) {
    const failed = byTag.get(pair.failed);
    if (!failed?.deployState || !byTag.has(pair.recovery)) continue;
    const list = carried.get(pair.recovery) ?? [];
    list.push({
      tagName: failed.tagName,
      htmlUrl: failed.htmlUrl,
      deployState: failed.deployState,
      releaseNotes: failed.releaseNotes ?? { status: "unavailable", reason: "説明を取得できませんでした" },
      body: failed.body,
    });
    carried.set(pair.recovery, list);
  }
  return entries.map((entry) => {
    const recovery = recoveredBy.get(entry.tagName);
    const carriedOver = carried.get(entry.tagName);
    if (!recovery && !carriedOver) return entry;
    return {
      ...entry,
      ...(recovery ? { recoveredBy: recovery } : {}),
      ...(carriedOver ? { carriedOver } : {}),
    };
  });
}

/** 引き継いだ変更の説明1行を、行チェック（#2982）の識別子にする。PRの参照と衝突しないよう版を前置する */
export function carriedNoteLineKey(tagName: string, text: string): string {
  return `${tagName}:${text}`;
}
