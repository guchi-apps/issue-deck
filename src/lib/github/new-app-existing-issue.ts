/**
 * 立ち上げの前後で「`guchi-apps/vps`に同じ対象のIssueが既に開いていないか」を見る（#2250）。
 *
 * 判定そのものは純粋関数（[`lib/new-app/launch-marker.ts`](../new-app/launch-marker.ts)）で、
 * ここはIOだけ。**下見（preflight）と実行（launch）の両方から同じ関数を呼ぶ**——押す前に
 * 画面へ出す判定と、押した後に起票をやめる判定が食い違わないようにするため。
 */

import { GithubApiError } from "@/lib/github/github-api-error";
import { fetchOpenIssuesForRepo } from "@/lib/github/issues-api";
import {
  findExistingLaunchIssue,
  type ExistingLaunchIssue,
} from "@/lib/new-app/launch-marker";
import { NEW_APP_VPS_REPOSITORY } from "@/lib/new-app/spec";

/**
 * `guchi-apps/vps`のopenなIssueから、この立ち上げと同じ対象のものを1件返す。
 *
 * **読めなかったときは`null`。** 判定できないことを理由に起票を止めると、必要なIssueが
 * 1件も無いまま立ち上げが終わる方の損失が大きい（重複は人が閉じられるが、欠落は気付かれない）。
 * 401だけは投げ直して`withUserGithubToken`にトークンの更新を任せる。
 */
export async function findExistingVpsLaunchIssue(
  token: string,
  input: {
    /** 立ち上げるリポジトリ名（`aide-bot`） */
    appName: string;
    /** 公開するホスト名。**サブドメインのときだけ渡す**（共有ホスト名では照合しない） */
    hostname: string | null;
  },
): Promise<ExistingLaunchIssue | null> {
  if (!input.appName) return null;
  const [owner, repo] = NEW_APP_VPS_REPOSITORY.split("/");
  try {
    const issues = await fetchOpenIssuesForRepo(owner, repo, token);
    return findExistingLaunchIssue(
      issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        htmlUrl: issue.html_url,
      })),
      {
        targetRepository: NEW_APP_VPS_REPOSITORY,
        appName: input.appName,
        hostname: input.hostname,
      },
    );
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 401) throw error;
    console.warn("[new-app] guchi-apps/vps のopenなIssueを読めませんでした", error);
    return null;
  }
}
