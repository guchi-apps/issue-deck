/**
 * `guchi-apps/vps`から、ポートとホスト名の使用状況を取ってくる（#2188）。**サーバー専用。**
 *
 * 解析そのものは`lib/new-app/vps-inventory.ts`（純粋関数）が持つ。ここは取得だけを担う。
 *
 * **読むのは2つ。** READMEの2つの表（ポートとドメインの一次情報）と、
 * `apache/sites-available/`の各vhostの`ServerName`／`ServerAlias`。
 * vhostは**ファイル名がホスト名と一致しない**（`wordpress.conf`の`ServerName`は
 * `blog.gucchii.com`）ため、中身を読む必要がある。
 *
 * **読めなかったときは例外にせず`null`を返す。** 空き番号を自動で決められないだけで、
 * 人が手で入力すれば立ち上げは進められる。ここで止めると、vpsリポジトリを読む権限が
 * 無いだけでウィザードが一切使えなくなる。
 */

import { fetchAllPages } from "@/lib/github/pagination";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import {
  collectHostnameUsage,
  parseVpsInventory,
  usedPorts,
  type VpsHostnameUsage,
  type VpsInventory,
} from "@/lib/new-app/vps-inventory";

const VPS_OWNER = "guchi-apps";
const VPS_REPO = "vps";

/** vhostを全部読むと数十リクエストになるため、`.conf`だけに絞ったうえで上限を置く。 */
const MAX_VHOST_FILES = 60;

export type VpsUsage = {
  inventory: VpsInventory;
  hostnames: VpsHostnameUsage;
  usedPorts: Set<number>;
};

/**
 * ファイルの中身を取る。
 *
 * **`Accept: application/vnd.github.raw`は使えない。** `githubFetch`が`Accept`を
 * `application/vnd.github+json`で上書きするため（`request.ts`の取り決め）、返ってくるのは
 * 常にJSON。base64の`content`を自分で戻す。
 */
async function fetchTextContent(path: string, token: string): Promise<string | null> {
  const res = await githubFetch(
    `${GITHUB_API}/repos/${VPS_OWNER}/${VPS_REPO}/contents/${path}`,
    token,
  );
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as { content?: string; encoding?: string } | null;
  if (!json?.content || json.encoding !== "base64") return null;
  return Buffer.from(json.content, "base64").toString("utf8");
}

/**
 * vpsリポジトリの現況を読む。取れなければ`null`。
 *
 * vhostの取得は1件でも失敗したらその1件を飛ばす（READMEの表だけでもポートは決まる）。
 */
export async function fetchVpsUsage(
  token: string,
  options: { includeVhosts?: boolean } = {},
): Promise<VpsUsage | null> {
  const readme = await fetchTextContent("README.md", token);
  if (readme === null) return null;

  const inventory = parseVpsInventory(readme);

  let vhostContents: string[] = [];
  // ホスト名を見ないとき（ポートの空きだけが要るとき）はvhostを読まない。
  // 1ファイル1リクエストなので、要らない場面で十数回叩かない
  if (options.includeVhosts === false) {
    return {
      inventory,
      hostnames: collectHostnameUsage(inventory, []),
      usedPorts: usedPorts(inventory),
    };
  }

  try {
    const entries = await fetchAllPages<{ name: string; type: string }>(
      `${GITHUB_API}/repos/${VPS_OWNER}/${VPS_REPO}/contents/apache/sites-available?per_page=100`,
      token,
    );
    // **`-le-ssl.conf`は読まない。** certbotが作る443側の複製で、`ServerName`は
    // 対になる`:80`のvhostと同じ。読む数がほぼ半分になる
    const files = entries
      .filter(
        (entry) =>
          entry.type === "file" &&
          entry.name.endsWith(".conf") &&
          !entry.name.endsWith("-le-ssl.conf"),
      )
      .slice(0, MAX_VHOST_FILES);
    const contents = await Promise.all(
      files.map((file) => fetchTextContent(`apache/sites-available/${file.name}`, token)),
    );
    vhostContents = contents.filter((content): content is string => content !== null);
  } catch {
    // vhostが読めなくてもREADMEの表だけで判定を続ける（ホスト名の重複検知は弱くなる）
    vhostContents = [];
  }

  return {
    inventory,
    hostnames: collectHostnameUsage(inventory, vhostContents),
    usedPorts: usedPorts(inventory),
  };
}
