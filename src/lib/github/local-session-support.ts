import { GithubApiError } from "@/lib/github/github-api-error";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import {
  isSupportedLocalSessionContract,
  parseLocalSessionContractVersion,
} from "@/lib/local-session";

/**
 * ワンクリック起動（画面の「ローカルで開始」）が呼ぶスクリプト。
 * このパスは`scripts/start-local-session.sh`が対象リポジトリ内で探す場所と同じ。
 */
export const LOCAL_START_SCRIPT_PATH = "scripts/start-issue.sh";

/**
 * リポジトリがローカル起動プロトコルに適合しているかを、`scripts/start-issue.sh`の
 * 冒頭マーカーで判定する（#1073）。
 *
 * `claude-issue-dispatch.yml`の存在で判定する`hasClaudeWorkflow`
 * （`src/lib/github/workflow-support.ts`）と同じ位置づけだが、**軸が違う**。あちらは
 * GitHub Actions側の対応で、こちらはローカル起動の対応。導入順が「ワークフロー→ローカル」に
 * なるため、片方だけ対応済みという状態が普通に起きる。流用してはいけない。
 *
 * ファイルの存在だけでは足りない。実際shopping-listは`scripts/start-issue.sh`を持つが
 * `ISSUE_DECK_SKIP_LAN_SETUP`を解釈せず、押すとUACを承認しても待ちから戻らずタブが固まる。
 * マーカーまで見ることで、その最悪ケースをボタンを出す前に弾く。
 *
 * **これがゲートするのは「このPC」（`issuedeck://`）の導線だけ**（#1224）。サブPCへの
 * ディスパッチは、マーカー行を持たないリポジトリを汎用ランチャーで起動できるため、
 * サブPCの申告だけで判定する（`canStartLocalSession`のコメントを参照）。
 *
 * 内容の取得はContents APIで、**存在確認とマーカー確認が1回のリクエストで済む**。
 */
export async function fetchLocalStartScriptSupported(
  owner: string,
  repo: string,
  token: string,
): Promise<boolean> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${LOCAL_START_SCRIPT_PATH}`;
  const res = await githubFetch(url, token);
  if (res.status === 404) return false;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }

  const data: { content?: string; encoding?: string } = await res.json();
  // ディレクトリを指した場合など、contentが返らないことがある。その場合は判定できないので未対応扱い。
  if (typeof data.content !== "string") return false;

  const script = Buffer.from(
    data.content,
    data.encoding === "base64" ? "base64" : "utf-8",
  ).toString("utf-8");

  return isSupportedLocalSessionContract(parseLocalSessionContractVersion(script));
}
