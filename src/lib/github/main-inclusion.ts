import { githubGraphql } from "@/lib/github/graphql";

/**
 * developへマージ済みのPRが、mainへ実際に入っているかの判定（#4528）。
 *
 * **first-parentの祖先関係だけでは判定しきれない。** 選んで作り直した候補（#4335）は、PRのマージ差分を
 * `cherry-pick -m 1`で当てるため、developの元のマージコミットはmainの祖先にならない。手作業で作った
 * 候補はコミットの形すら一定でない。そこで祖先関係で「未リリース」と出たPRに限り、次の2つの根拠で
 * mainへ入っているかを確かめる。
 *
 * - `cherry-pick`: mainの本流に、件名が`Merge pull request #N`で親が1つのコミットがある（選択適用の痕跡）
 * - `content`: PRが変更した全ファイルについて、mainのblobがdevelop先端のblobと一致する
 *
 * **PR本文の番号列挙は根拠にしない。** 一致が確かめられないもの（一部だけ一致・ファイルが多すぎる・
 * 取得失敗）は「反映済み」へ倒さず、従来どおり未リリースのまま残す。
 */

export type InclusionState = "included" | "partial" | "not-included" | "unknown";
export type InclusionEvidence = "cherry-pick" | "content";

export type PullRequestInclusion = {
  state: InclusionState;
  evidence: InclusionEvidence | null;
};

/** 1回の問い合わせで照合するPR数・ファイル数の上限。超えたぶんは確かめずに`unknown`にする */
export const MAX_INCLUSION_PULL_REQUESTS = 20;
export const MAX_INCLUSION_FILES_PER_PR = 50;
export const MAX_INCLUSION_FILES_TOTAL = 150;

/** mainの本流コミットのうち、cherry-pickで取り込まれたPR番号を集める */
export function pickedPullRequestNumbers(
  history: readonly { messageHeadline?: string | null; parents?: { totalCount?: number | null } | null }[],
): Set<number> {
  const picked = new Set<number>();
  for (const commit of history) {
    if ((commit.parents?.totalCount ?? 0) !== 1) continue;
    const match = /^Merge pull request #(\d+) from /.exec(commit.messageHeadline ?? "");
    if (match) picked.add(Number(match[1]));
  }
  return picked;
}

/**
 * PRが変更した各ファイルの、mainとdevelop先端のblob OIDから反映状態を決める（純関数）。
 * ファイルが取れていない（`null`）・0件のPRは確かめようがないので`unknown`。
 */
export function classifyByBlobs(
  files: readonly { mainOid: string | null; developOid: string | null }[] | null,
): InclusionState {
  if (files === null || files.length === 0) return "unknown";
  const same = files.filter((file) => file.mainOid === file.developOid).length;
  if (same === files.length) return "included";
  return same === 0 ? "not-included" : "partial";
}

type PullRequestFilesResult = Record<string, { files?: { totalCount?: number; nodes?: ({ path?: string } | null)[] | null } | null } | null>;

/**
 * 反映状態を調べる。`mainOid`・`developOid`はコミットのOID（同じ時点を見るために名前でなく固定する）。
 * 戻り値に無いPRは調べなかったもの（呼び出し側は未リリースのまま扱う）。
 */
export async function resolveMainInclusion(input: {
  owner: string;
  repo: string;
  token: string;
  mainOid: string;
  developOid: string;
  pullRequestNumbers: readonly number[];
  picked: ReadonlySet<number>;
}): Promise<Map<number, PullRequestInclusion>> {
  const { owner, repo, token, mainOid, developOid, picked } = input;
  const result = new Map<number, PullRequestInclusion>();
  const targets: number[] = [];
  for (const number of input.pullRequestNumbers) {
    if (picked.has(number)) result.set(number, { state: "included", evidence: "cherry-pick" });
    else if (targets.length < MAX_INCLUSION_PULL_REQUESTS) targets.push(number);
    else result.set(number, { state: "unknown", evidence: null });
  }
  if (targets.length === 0) return result;

  const unknown = () => {
    for (const number of targets) result.set(number, { state: "unknown", evidence: null });
    return result;
  };

  try {
    const filesQuery = `query($owner: String!, $name: String!, ${targets.map((_, i) => `$n${i}: Int!`).join(", ")}) {
  repository(owner: $owner, name: $name) {
${targets.map((_, i) => `    p${i}: pullRequest(number: $n${i}) { files(first: ${MAX_INCLUSION_FILES_PER_PR}) { totalCount nodes { path } } }`).join("\n")}
  }
}`;
    const filesVariables: Record<string, unknown> = { owner, name: repo };
    targets.forEach((number, i) => (filesVariables[`n${i}`] = number));
    const filesData = await githubGraphql<{ repository: PullRequestFilesResult | null }>(
      token,
      filesQuery,
      filesVariables,
      "main inclusion files",
    );
    if (!filesData.repository) return unknown();

    const pathsByPr = new Map<number, string[] | null>();
    let total = 0;
    targets.forEach((number, i) => {
      const files = filesData.repository?.[`p${i}`]?.files;
      const nodes = files?.nodes;
      const paths = (nodes ?? []).flatMap((node) => (typeof node?.path === "string" ? [node.path] : []));
      const complete = Array.isArray(nodes) && (files?.totalCount ?? 0) === paths.length && paths.length > 0;
      if (!complete || total + paths.length > MAX_INCLUSION_FILES_TOTAL) {
        pathsByPr.set(number, null);
        return;
      }
      total += paths.length;
      pathsByPr.set(number, paths);
    });

    const allPaths = [...new Set([...pathsByPr.values()].flatMap((paths) => paths ?? []))];
    const blobs = new Map<string, { mainOid: string | null; developOid: string | null }>();
    if (allPaths.length > 0) {
      const declarations = allPaths.flatMap((_, i) => [`$m${i}: String!`, `$d${i}: String!`]).join(", ");
      const selections = allPaths.flatMap((_, i) => [
        `    m${i}: object(expression: $m${i}) { ... on Blob { oid } }`,
        `    d${i}: object(expression: $d${i}) { ... on Blob { oid } }`,
      ]);
      const blobQuery = `query($owner: String!, $name: String!, ${declarations}) {
  repository(owner: $owner, name: $name) {
${selections.join("\n")}
  }
}`;
      const blobVariables: Record<string, unknown> = { owner, name: repo };
      allPaths.forEach((path, i) => {
        blobVariables[`m${i}`] = `${mainOid}:${path}`;
        blobVariables[`d${i}`] = `${developOid}:${path}`;
      });
      const blobData = await githubGraphql<{ repository: Record<string, { oid?: string } | null> | null }>(
        token,
        blobQuery,
        blobVariables,
        "main inclusion blobs",
      );
      if (!blobData.repository) return unknown();
      allPaths.forEach((path, i) => {
        blobs.set(path, {
          mainOid: blobData.repository?.[`m${i}`]?.oid ?? null,
          developOid: blobData.repository?.[`d${i}`]?.oid ?? null,
        });
      });
    }

    for (const number of targets) {
      const paths = pathsByPr.get(number) ?? null;
      const state = classifyByBlobs(paths === null ? null : paths.map((path) => blobs.get(path) ?? { mainOid: null, developOid: "?" }));
      result.set(number, { state, evidence: state === "included" ? "content" : null });
    }
    return result;
  } catch (error) {
    console.warn(`[resolveMainInclusion] ${owner}/${repo}:`, error);
    return unknown();
  }
}
