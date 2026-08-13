/**
 * 他リポジトリが参照している共有ワークフローのタグ（`@workflows/vN`）を読み取り、
 * issue-deck 側の最新タグと突き合わせるための純粋関数群（#985）。
 *
 * **なぜ要るか。** 共有ワークフローは `uses:` のタグ固定で配っているため、issue-deck 側を
 * 直しても各リポジトリの caller を上げるまで反映されない。上げ忘れても何も起きないので
 * 気づけない。実際 v10 は car-care だけ、v11・v12 は10リポジトリへ手作業で配った。
 *
 * GitHub API へのアクセスは呼び出し側（`src/lib/github/workflow-tags.ts`）が担い、
 * ここは文字列解析と比較だけを持つ。
 */

/** caller が参照している共有ワークフローのタグ（1ファイルぶん） */
export type WorkflowTagRef = {
  /** ワークフローのファイル名（例: `claude-issue-dispatch.yml`） */
  file: string;
  /** `uses:` が指すタグ（例: `workflows/v12`） */
  uses: string;
  /**
   * `prompts-ref` の値。指定が無いファイルでは `null`。
   *
   * **`uses` と同じ値でなければならない。** 片方だけ上げると、新しいワークフローで古い
   * プロンプトが使われる（#1158 で `${PACKAGE_MANAGER}` を足した際、prompts-ref が古いと
   * 未展開のまま渡る状態になった）。
   */
  promptsRef: string | null;
};

/** タグ名（`workflows/v12`）から版数（12）を取り出す。形式が違えば null */
export function parseWorkflowTagVersion(tag: string): number | null {
  const match = /^workflows\/v(\d+)$/.exec(tag);
  if (!match) return null;
  return Number(match[1]);
}

/** `workflows/vN` 形式のタグ一覧から最新（版数が最大のもの）を返す */
export function latestWorkflowTag(tags: string[]): string | null {
  let latest: { tag: string; version: number } | null = null;
  for (const tag of tags) {
    const version = parseWorkflowTagVersion(tag);
    if (version === null) continue;
    if (!latest || version > latest.version) latest = { tag, version };
  }
  return latest?.tag ?? null;
}

/**
 * caller のワークフローYAMLから、参照しているタグを読み取る。
 *
 * YAMLとして構文解析せず正規表現で拾う。`uses:` の値はコメント行にも現れる
 * （どのタグを指すべきかの説明として書かれている）ため、**行頭が `uses:` のものだけ**を
 * 対象にする。
 */
export function extractWorkflowTagRef(file: string, source: string): WorkflowTagRef | null {
  const uses = /^\s*uses:\s*\S+@(workflows\/v\d+)\s*$/m.exec(source);
  if (!uses) return null;

  const promptsRef = /^\s*prompts-ref:\s*(workflows\/v\d+)\s*$/m.exec(source);
  return {
    file,
    uses: uses[1] as string,
    promptsRef: (promptsRef?.[1] as string | undefined) ?? null,
  };
}

/** リポジトリ1件ぶんの判定結果 */
export type WorkflowTagStatus = {
  fullName: string;
  refs: WorkflowTagRef[];
  /** 最新タグより古い参照があるか */
  outdated: boolean;
  /** `uses` と `prompts-ref` が食い違っている参照があるか */
  mismatched: boolean;
};

/**
 * リポジトリの参照状況を判定する。
 *
 * **「古い」と「不一致」は別種の異常として区別する。** 古いだけなら単に改善が届いて
 * いないだけだが、不一致は**新しいワークフローが古いプロンプトで動く**という、
 * どちらのバージョンとも違う組み合わせになる。
 */
export function evaluateWorkflowTags(
  fullName: string,
  refs: WorkflowTagRef[],
  latest: string | null,
): WorkflowTagStatus {
  const latestVersion = latest === null ? null : parseWorkflowTagVersion(latest);

  const outdated = refs.some((ref) => {
    if (latestVersion === null) return false;
    const version = parseWorkflowTagVersion(ref.uses);
    return version !== null && version < latestVersion;
  });

  const mismatched = refs.some((ref) => ref.promptsRef !== null && ref.promptsRef !== ref.uses);

  return { fullName, refs, outdated, mismatched };
}
