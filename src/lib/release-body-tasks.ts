import type { ReleaseCheckLineRecord } from "@/lib/release-check";

/**
 * GitHub Release本文のMarkdownタスクリスト（`- [ ]` / `- [x]`）を、リリース履歴の項目チェックの
 * **正**として読み書きする純粋関数（#4374）。
 *
 * - 行の識別子（`key`）は、PRの参照（GitHub自動生成の`... in <URL>`）か、取り出せない手書きの行では
 *   本文そのもの。**並び順の添字は使わない**ので、並べ替え・他の行の編集・文言変更の影響を受けない。
 * - 失敗版から引き継いだ変更は、修正版のRelease本文へ`<!-- issue-deck:key=... -->`付きの行として
 *   書き足す。行末の目印が`key`になるので、表示文言を手で直しても同じ行を指し続ける。
 * - 更新は**該当する行の先頭（`* ` → `- [x] `）だけ**を書き換える。ほかの行・説明・リンクは1文字も
 *   触らない。
 */

const GENERATED_BULLET_CONTENT = /^(.+?)\s+by\s+@\S+\s+in\s+(\S+)\s*$/;
const KEY_MARKER = /\s*<!--\s*issue-deck:key=(.*?)\s*-->\s*$/;
const BULLET_LINE = /^(\s*)[*-]\s+(?:\[([ xX])\]\s+)?(.*)$/;

export type ReleaseBodyTask = {
  /** 本文の何行目か（0始まり） */
  lineIndex: number;
  text: string;
  key: string;
  /** タスクリストの行ならチェック状態。通常の箇条書き（`* ...`）は`null` */
  checked: boolean | null;
  /** 引き継ぎ項目として書き足した行（`<!-- issue-deck:key=... -->`付き） */
  carried: boolean;
};

function stripCr(raw: string): { core: string; cr: string } {
  return raw.endsWith("\r") ? { core: raw.slice(0, -1), cr: "\r" } : { core: raw, cr: "" };
}

function parseLine(raw: string, lineIndex: number): ReleaseBodyTask | null {
  const { core } = stripCr(raw);
  const match = BULLET_LINE.exec(core);
  if (!match) return null;
  const mark = match[2];
  let content = match[3].trim();

  const markerMatch = KEY_MARKER.exec(content);
  if (markerMatch) {
    content = content.slice(0, markerMatch.index).trim();
    if (!content) return null;
    return {
      lineIndex,
      text: content,
      key: markerMatch[1],
      checked: mark === undefined ? null : mark !== " ",
      carried: true,
    };
  }

  const generated = GENERATED_BULLET_CONTENT.exec(content);
  const text = (generated ? generated[1] : content).trim();
  if (!text) return null;
  return {
    lineIndex,
    text,
    key: generated ? generated[2] : text,
    checked: mark === undefined ? null : mark !== " ",
    carried: false,
  };
}

/** 本文の箇条書き行（`* `・`- `・`- [ ] `・`- [x] `）をすべて取り出す */
export function parseReleaseBodyTasks(body: string | null): ReleaseBodyTask[] {
  if (!body) return [];
  const tasks: ReleaseBodyTask[] = [];
  body.split("\n").forEach((raw, index) => {
    const task = parseLine(raw, index);
    if (task) tasks.push(task);
  });
  return tasks;
}

function rewriteLine(raw: string, checked: boolean): string {
  const { core, cr } = stripCr(raw);
  const match = BULLET_LINE.exec(core);
  if (!match) return raw;
  return `${match[1]}- [${checked ? "x" : " "}] ${match[3]}${cr}`;
}

export type ReleaseBodyToggleInput = {
  key: string;
  checked: boolean;
  /** 本文に行が無いとき（引き継ぎ項目の初回）に書き足す表示文言 */
  text?: string;
  /** 引き継ぎ元の版（`v1.2.3`）。指定があるときだけ行を書き足せる */
  carriedFrom?: string;
};

export type ReleaseBodyToggleResult =
  | { ok: true; body: string; changed: boolean }
  | { ok: false; reason: "line_not_found" };

function carriedHeading(carriedFrom: string): string {
  return `### ${carriedFrom}から引き継いだ変更`;
}

/**
 * `key`の行のチェックを`checked`にした本文を返す。**同じ`key`の行はすべて同じ項目**（同じPRが本文へ
 * 複数回載ることがある。#4287）として揃える。`key`の行が無く、`text`と`carriedFrom`があるときは、
 * 引き継ぎ用の見出しの下へ行を書き足す。
 */
export function applyReleaseBodyTaskToggle(
  body: string | null,
  input: ReleaseBodyToggleInput,
): ReleaseBodyToggleResult {
  const source = body ?? "";
  const lines = source.split("\n");
  const matches = parseReleaseBodyTasks(source).filter((task) => task.key === input.key);

  if (matches.length > 0) {
    let changed = false;
    for (const task of matches) {
      if (task.checked === input.checked) continue;
      lines[task.lineIndex] = rewriteLine(lines[task.lineIndex], input.checked);
      changed = true;
    }
    return { ok: true, body: lines.join("\n"), changed };
  }

  if (!input.text || !input.carriedFrom) return { ok: false, reason: "line_not_found" };

  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const newLine = `- [${input.checked ? "x" : " "}] ${input.text.replace(/\r?\n/g, " ")} <!-- issue-deck:key=${input.key} -->`;
  const heading = carriedHeading(input.carriedFrom);
  const headingIndex = lines.findIndex((line) => stripCr(line).core.trim() === heading);

  if (headingIndex >= 0) {
    let insertAt = headingIndex + 1;
    for (let i = headingIndex + 1; i < lines.length; i += 1) {
      const { core } = stripCr(lines[i]);
      if (BULLET_LINE.test(core)) insertAt = i + 1;
      else if (core.trim() !== "") break;
    }
    lines.splice(insertAt, 0, newLine + (eol === "\r\n" ? "\r" : ""));
    return { ok: true, body: lines.join("\n"), changed: true };
  }

  const trimmedEnd = source.replace(/\s+$/, "");
  const prefix = trimmedEnd ? `${trimmedEnd}${eol}${eol}` : "";
  return { ok: true, body: `${prefix}${heading}${eol}${newLine}${eol}`, changed: true };
}

/**
 * 通常の箇条書き（`* ...`）をすべてタスクリストへ変換する（移行・新規リリース生成と同じ形）。
 * `checkedKeys`にある行は`- [x]`、それ以外は`- [ ]`。**すでにタスクリストの行（GitHub側の状態）は
 * 触らない**ので、DBの旧記録でGitHubのチェックを上書きしない。
 */
export function convertBulletsToTasks(
  body: string,
  checkedKeys: ReadonlySet<string>,
): { body: string; convertedCount: number } {
  const lines = body.split("\n");
  let convertedCount = 0;
  for (const task of parseReleaseBodyTasks(body)) {
    if (task.checked !== null) continue;
    lines[task.lineIndex] = rewriteLine(lines[task.lineIndex], checkedKeys.has(task.key));
    convertedCount += 1;
  }
  return { body: lines.join("\n"), convertedCount };
}

/**
 * 画面が使う確認記録（`ReleaseCheckLineRecord`）を、リリース本文から組み立てる。
 *
 * **本文のタスクリストが正。** チェック済みの行（`- [x]`）が記録になる。通常の箇条書きのまま
 * の行と、本文に行がまだ無い項目（引き継ぎ項目）だけ、旧DBの記録（ユーザーごとの
 * `ReleaseCheckLine`。複数ユーザーぶんは和集合）をフォールバックに使う。本文にタスクの行があれば
 * 旧記録は見ない（GitHubの状態を優先し、旧記録で上書きしない）。
 */
export function buildCheckLineRecordsFromBodies(
  entries: readonly { repoFullName: string; tagName: string; body: string | null; publishedAt: string | null; deployState?: unknown }[],
  legacy: readonly ReleaseCheckLineRecord[],
): ReleaseCheckLineRecord[] {
  const records: ReleaseCheckLineRecord[] = [];
  const legacyByRelease = new Map<string, ReleaseCheckLineRecord[]>();
  for (const record of legacy) {
    const id = `${record.repoFullName} ${record.tagName}`;
    legacyByRelease.set(id, [...(legacyByRelease.get(id) ?? []), record]);
  }

  for (const entry of entries) {
    // Releaseが無い版にはGitHub本文が無く、同期済みとして扱わない
    if (entry.deployState !== undefined) continue;
    const tasks = parseReleaseBodyTasks(entry.body);
    const taskKeys = new Set<string>();
    const emitted = new Set<string>();
    for (const task of tasks) {
      if (task.checked === null) continue;
      taskKeys.add(task.key);
      if (task.checked && !emitted.has(task.key)) {
        emitted.add(task.key);
        records.push({
          repoFullName: entry.repoFullName,
          tagName: entry.tagName,
          lineKey: task.key,
          checkedAt: entry.publishedAt ?? new Date(0).toISOString(),
        });
      }
    }
    for (const record of legacyByRelease.get(`${entry.repoFullName} ${entry.tagName}`) ?? []) {
      if (taskKeys.has(record.lineKey) || emitted.has(record.lineKey)) continue;
      emitted.add(record.lineKey);
      records.push(record);
    }
  }
  return records;
}
