/**
 * ローカルセッションのポート帯（`scripts/local-repo-ports.conf`）の払い出し（#2225）。**サーバー専用。**
 *
 * 解析と採番そのものは`lib/new-app/local-port-bands.ts`（純粋関数）が持つ。ここは
 * GitHubから対応表を読むことと、1行足すPull Requestを作ることだけを担う。
 *
 * **なぜIssueではなくPull Requestなのか。** 追記の内容は「現状の最大 + 1000」で機械的に
 * 決まり、変更は1行。Issueにして実装セッションを起こすと、立ち上げのたびに1行のために
 * エージェントを1回動かすことになる（CLAUDE.md「同じ作業が繰り返し発生するものは、その
 * 作業をなくすIssueを立てる」）。develop向けPRなので`claude-review-develop.yml`が
 * CIの完了を待って自動マージする。
 *
 * **対応表を読めなかったときは例外を投げる。** `guchi-apps/vps`の読み取り（`vps-inventory-api.ts`）と
 * 違い、こちらは黙って飛ばすと帯が未確保のまま立ち上げが終わり、#2213と同じ漏れが再発する。
 * 呼び出し側は**何も作る前に**これを確かめる。
 */

import { GithubApiError } from "@/lib/github/github-api-error";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import {
  EPHEMERAL_PORT_RANGE_END,
  EPHEMERAL_PORT_RANGE_START,
  LOCAL_PORT_BAND_CONF_PATH,
  MAX_LOCAL_PORT_BASE,
  appendLocalPortBand,
  chooseNextLocalPortBase,
  countRemainingLocalPortBases,
  findLocalPortBand,
  parseLocalPortBands,
} from "@/lib/new-app/local-port-bands";

const OWNER = "guchi-apps";
const REPO = "issue-deck";
const BASE_BRANCH = "develop";

async function requestJson<T>(
  url: string,
  token: string,
  method: "GET" | "POST" | "PUT",
  body?: unknown,
): Promise<T> {
  const res = await githubFetch(url, token, { method, body });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type LocalPortBandPlan = {
  /** このリポジトリに使うベース値 */
  base: number;
  /** すでに対応表に載っていた（＝追記も Pull Request も要らない） */
  alreadyListed: boolean;
  /**
   * この帯を確保した後に、あと何リポジトリぶん配れるか（#2487）。
   *
   * エフェメラルポート範囲を避けるため空きは飛び地で、残りは10枠に満たない。尽きてから
   * 気付くと立ち上げが止まるので、下見の時点で画面へ出す。
   */
  remainingAfter: number;
  /** developにある対応表の中身とblob SHA。`alreadyListed`のときは使わない */
  conf: { content: string; sha: string };
};

/**
 * `develop`の対応表を読み、このリポジトリに払い出す帯を決める。**まだ何も作らない。**
 *
 * 帯を決められないとき（対応表を読めない・上限に達した）は`GithubApiError`ではなく
 * `Error`を投げる。呼び出し側はこれを「立ち上げを始める前に止める理由」として扱う。
 */
export async function planLocalPortBand(
  token: string,
  repositoryFullName: string,
): Promise<LocalPortBandPlan> {
  const url = `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${LOCAL_PORT_BAND_CONF_PATH}?ref=${BASE_BRANCH}`;
  const file = await requestJson<{ content?: string; encoding?: string; sha?: string }>(
    url,
    token,
    "GET",
  );
  if (!file.content || file.encoding !== "base64" || !file.sha) {
    throw new Error(`${LOCAL_PORT_BAND_CONF_PATH} を読み取れませんでした。`);
  }
  const content = Buffer.from(file.content, "base64").toString("utf8");
  const bands = parseLocalPortBands(content);

  const remaining = countRemainingLocalPortBases(bands);

  const existing = findLocalPortBand(bands, repositoryFullName);
  if (existing !== null) {
    return {
      base: existing,
      alreadyListed: true,
      remainingAfter: remaining,
      conf: { content, sha: file.sha },
    };
  }

  const base = chooseNextLocalPortBase(bands);
  if (base === null) {
    throw new Error(
      `ローカルセッションのポート帯に空きがありません（上限 ${MAX_LOCAL_PORT_BASE}。${EPHEMERAL_PORT_RANGE_START}〜${EPHEMERAL_PORT_RANGE_END} はエフェメラルポート範囲なので配れません）。${LOCAL_PORT_BAND_CONF_PATH} の帯を割り直してください。`,
    );
  }
  return {
    base,
    alreadyListed: false,
    // この帯を1つ使うぶんを引く
    remainingAfter: remaining - 1,
    conf: { content, sha: file.sha },
  };
}

export type OpenedPullRequest = {
  number: number;
  htmlUrl: string;
  /** `guchi-apps/issue-deck#124` */
  reference: string;
};

/**
 * 対応表へ1行足すPull Requestを作る。
 *
 * ブランチが既にある場合（押し直し）は作り直さず、そのまま更新を試みる。
 */
export async function openLocalPortBandPullRequest(
  token: string,
  params: {
    branch: string;
    /** 追記するリポジトリ（`guchi-apps/kakei-report`） */
    repositoryFullName: string;
    base: number;
    comment: string;
    commitMessage: string;
    title: string;
    body: string;
    conf: { content: string; sha: string };
  },
): Promise<OpenedPullRequest> {
  const head = await requestJson<{ object: { sha: string } }>(
    `${GITHUB_API}/repos/${OWNER}/${REPO}/git/ref/heads/${BASE_BRANCH}`,
    token,
    "GET",
  );

  const createRef = await githubFetch(`${GITHUB_API}/repos/${OWNER}/${REPO}/git/refs`, token, {
    method: "POST",
    body: { ref: `refs/heads/${params.branch}`, sha: head.object.sha },
  });
  // 422 は「すでにある」。押し直しのときはそのブランチへ載せる
  if (!createRef.ok && createRef.status !== 422) {
    const detail = await createRef.text().catch(() => "");
    throw new GithubApiError(
      createRef.status,
      `GitHub API request failed: ${createRef.status} refs/heads/${params.branch} ${detail}`,
    );
  }

  const updated = appendLocalPortBand(params.conf.content, {
    repository: params.repositoryFullName,
    base: params.base,
    comment: params.comment,
  });
  await requestJson(
    `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${LOCAL_PORT_BAND_CONF_PATH}`,
    token,
    "PUT",
    {
      message: params.commitMessage,
      content: Buffer.from(updated, "utf8").toString("base64"),
      sha: params.conf.sha,
      branch: params.branch,
    },
  );

  const pull = await requestJson<{ number: number; html_url: string }>(
    `${GITHUB_API}/repos/${OWNER}/${REPO}/pulls`,
    token,
    "POST",
    { title: params.title, head: params.branch, base: BASE_BRANCH, body: params.body },
  );
  return {
    number: pull.number,
    htmlUrl: pull.html_url,
    reference: `${OWNER}/${REPO}#${pull.number}`,
  };
}
