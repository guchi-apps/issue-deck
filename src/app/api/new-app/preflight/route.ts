import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { planLocalPortBand } from "@/lib/github/local-port-band-api";
import { findExistingVpsLaunchIssue } from "@/lib/github/new-app-existing-issue";
import { repositoryExists } from "@/lib/github/repositories-api";
import { fetchVpsUsage } from "@/lib/github/vps-inventory-api";
import { withUserGithubToken } from "@/lib/github/with-user-github-token";
import { resolveNewAppInstallationScope } from "@/lib/new-app/installation-scope";
import { LOCAL_PORT_BAND_CONF_PATH } from "@/lib/new-app/local-port-bands";
import { NEW_APP_ORG, newAppKindProfile, type NewAppKind } from "@/lib/new-app/spec";
import {
  chooseAvailablePort,
  describeUsedPorts,
  isHostnameTaken,
} from "@/lib/new-app/vps-inventory";

/**
 * 立ち上げの前に、実物を見ないと分からないことだけを確かめて返す（#2188）。
 *
 * - リポジトリ名が空いているか（GitHub）
 * - ホスト名が空いているか（`guchi-apps/vps`のREADMEとvhostの`ServerName`）
 * - 本番ポートの空き番号（READMEの2つの表から計算する）
 * - ローカルセッションの開発サーバーのポート帯（issue-deckの`scripts/local-repo-ports.conf`）
 * - GitHub Appのインストール対象の選び方（#2248。`selected`のときだけ、ブラウザの手作業Issueに
 *   「インストール対象へ追加する」が入る）
 * - `guchi-apps/vps`に同じ対象のopenなIssueが既にあるか（#2250。あれば押した後も新しく作らず、
 *   そのIssueへコメントする。**押す前に画面へ出しておく**——後から警告だけ出しても、
 *   何が起きたのか分からない）
 *
 * **何も作らない。** 押す前に何度でも呼べるようにしてある。
 *
 * **vpsを読めなかったときは`vpsRead: false`を返して続行する。** 空き番号の提案ができない
 * だけで、人が手で入力すれば立ち上げは進む。ここで失敗にすると、vpsを読む権限が無い状態で
 * ウィザードが一切使えなくなる。
 */

const KINDS = new Set<NewAppKind>(["next-db", "next", "fastapi", "static"]);

export function POST(request: NextRequest) {
  return withGithubApiFeature("new_app_launch", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const repositoryName = typeof payload?.repositoryName === "string" ? payload.repositoryName : "";
  const hostname = typeof payload?.hostname === "string" ? payload.hostname : "";
  const kind: NewAppKind = KINDS.has(payload?.kind) ? payload.kind : "next-db";

  if (!repositoryName && !hostname) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await withUserGithubToken(user, "POST /api/new-app/preflight", async (token) => {
    const repositoryTaken = repositoryName
      ? await repositoryExists(NEW_APP_ORG, repositoryName, token)
      : null;

    const localPortBand = await describeLocalPortBand(token, repositoryName);
    const githubApp = await resolveNewAppInstallationScope(user.id);
    // ホスト名を確かめないとき（パス配下）は共有ホスト名で照合しない
    const existingVpsIssue = await findExistingVpsLaunchIssue(token, {
      appName: repositoryName,
      hostname: hostname || null,
    });

    // ホスト名を確かめないときはvhostを読まない（README だけでポートは決まる）
    const usage = await fetchVpsUsage(token, { includeVhosts: Boolean(hostname) });
    const profile = newAppKindProfile(kind);

    if (!usage) {
      return {
        repository: { name: repositoryName, taken: repositoryTaken },
        hostname: { value: hostname, taken: null },
        port: { suggested: null, note: null },
        localPortBand,
        githubApp,
        existingVpsIssue,
        vpsRead: false,
      };
    }

    const hostnameTaken = hostname ? isHostnameTaken(hostname, usage.hostnames) : null;
    const range = profile.portRange;
    const suggested = range ? chooseAvailablePort(usage.usedPorts, range) : null;

    return {
      repository: { name: repositoryName, taken: repositoryTaken },
      hostname: { value: hostname, taken: hostnameTaken },
      port: {
        suggested,
        note: range ? describeUsedPorts(usage.usedPorts, range) : null,
        used: range
          ? [...usage.usedPorts].filter((port) => port >= range.from && port <= range.to).sort((a, b) => a - b)
          : [],
      },
      localPortBand,
      githubApp,
      existingVpsIssue,
      vpsRead: true,
    };
  });

  if ("errorResponse" in result) {
    return result.errorResponse;
  }
  return NextResponse.json(result.value);
}

export type LocalPortBandPreflight = {
  /** 払い出す予定のベース値。決められなければ`null` */
  base: number | null;
  /** すでに対応表に載っていた */
  alreadyListed: boolean;
  /** 画面に出す1行 */
  note: string;
};

/**
 * ローカルセッションのポート帯の下見（#2225）。
 *
 * **読めなかったときも失敗にしない。** ここは押す前の表示で、実際の払い出しは
 * `POST /api/new-app`が押された時点でもう一度読んで決める（そちらは読めなければ止める）。
 */
async function describeLocalPortBand(
  token: string,
  repositoryName: string,
): Promise<LocalPortBandPreflight> {
  if (!repositoryName) {
    return { base: null, alreadyListed: false, note: "リポジトリ名を決めると払い出す帯が分かります" };
  }
  try {
    const plan = await planLocalPortBand(token, `${NEW_APP_ORG}/${repositoryName}`);
    // **残り枠を添える**（#2487）。エフェメラルポート範囲を避けるため空きは飛び地で10枠に
    // 満たない。尽きてから気付くと立ち上げが止まるので、押す前に見えるようにする。
    const remaining = `残りの帯は ${plan.remainingAfter} 枠`;
    return {
      base: plan.base,
      alreadyListed: plan.alreadyListed,
      note: plan.alreadyListed
        ? `すでに ${LOCAL_PORT_BAND_CONF_PATH} に載っています（ベース値 ${plan.base}。${remaining}）`
        : `ベース値 ${plan.base} を確保します（開発サーバーは ${plan.base} + Issue番号。${remaining}）`,
    };
  } catch (error) {
    console.warn("[POST /api/new-app/preflight] ポート帯を下見できませんでした", error);
    return {
      base: null,
      alreadyListed: false,
      note: `${LOCAL_PORT_BAND_CONF_PATH} を読めませんでした。立ち上げを押すと止まります。`,
    };
  }
}
