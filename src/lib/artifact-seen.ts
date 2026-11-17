/**
 * アーティファクトを「どの版まで見たか」の記録（#5483）。
 *
 * 計画承認待ち・質問待ちのカードで、**前回見た版から更新されたものだけ**を強調するために、
 * アーティファクトID → 見た版（`publishedAt`）をブラウザのlocalStorageへ持つ。
 * 閲覧者ごとの便宜なので端末をまたがず、保存できない環境では強調なしで動く。
 *
 * アーティファクトIDはcuidで全Issueで一意なので、Issueの識別子は記録に含めない。
 */
import { useSyncExternalStore } from "react";

export const ARTIFACT_SEEN_STORAGE_KEY = "issue-deck:artifact-seen:v1";
/** 記録の上限件数。超えたら古いもの（挿入順の先頭）から消す */
export const ARTIFACT_SEEN_LIMIT = 300;

export type ArtifactSeenMap = Record<string, string>;

type Versioned = { id: string; publishedAt: string };

/** 記録に無い（初めて見る）ものは更新扱いにしない。記録と版が違うものだけが更新あり */
export function isArtifactUpdated(seen: ArtifactSeenMap, artifact: Versioned): boolean {
  const recorded = seen[artifact.id];
  return recorded !== undefined && recorded !== artifact.publishedAt;
}

/** 記録の無いものだけ、今の版を基準として足す。既にあるIDは上書きしない */
export function withBaseline(seen: ArtifactSeenMap, artifacts: Versioned[]): ArtifactSeenMap {
  let next = seen;
  for (const artifact of artifacts) {
    if (next[artifact.id] !== undefined) continue;
    if (next === seen) next = { ...seen };
    next[artifact.id] = artifact.publishedAt;
  }
  return next === seen ? seen : trim(next);
}

/** 見た版として記録する（既に同じなら同じオブジェクトを返す） */
export function withSeen(seen: ArtifactSeenMap, artifact: Versioned): ArtifactSeenMap {
  if (seen[artifact.id] === artifact.publishedAt) return seen;
  // 更新して末尾へ回す（古いものから消えるように）
  const { [artifact.id]: _old, ...rest } = seen;
  void _old;
  return trim({ ...rest, [artifact.id]: artifact.publishedAt });
}

function trim(seen: ArtifactSeenMap): ArtifactSeenMap {
  const keys = Object.keys(seen);
  if (keys.length <= ARTIFACT_SEEN_LIMIT) return seen;
  const next: ArtifactSeenMap = {};
  for (const key of keys.slice(keys.length - ARTIFACT_SEEN_LIMIT)) next[key] = seen[key];
  return next;
}

function parse(raw: string | null): ArtifactSeenMap {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const out: ArtifactSeenMap = {};
    for (const [key, v] of Object.entries(value)) if (typeof v === "string") out[key] = v;
    return out;
  } catch {
    return {};
  }
}

const EMPTY: ArtifactSeenMap = {};
let cache: { raw: string | null; value: ArtifactSeenMap } | null = null;
const listeners = new Set<() => void>();

function readRaw(): string | null {
  try {
    return localStorage.getItem(ARTIFACT_SEEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function getSnapshot(): ArtifactSeenMap {
  const raw = readRaw();
  if (cache && cache.raw === raw) return cache.value;
  cache = { raw, value: parse(raw) };
  return cache.value;
}

function update(change: (seen: ArtifactSeenMap) => ArtifactSeenMap) {
  const current = getSnapshot();
  const next = change(current);
  if (next === current) return;
  try {
    localStorage.setItem(ARTIFACT_SEEN_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 保存できない環境では、このページの間だけメモリ上の記録で動かす
    cache = { raw: readRaw(), value: next };
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === ARTIFACT_SEEN_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** 見た版の記録を読む。サーバー描画では空（強調なし） */
export function useArtifactSeen(): ArtifactSeenMap {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

export function markArtifactSeen(artifact: Versioned): void {
  update((seen) => withSeen(seen, artifact));
}

export function recordArtifactBaseline(artifacts: Versioned[]): void {
  if (artifacts.length === 0) return;
  update((seen) => withBaseline(seen, artifacts));
}
